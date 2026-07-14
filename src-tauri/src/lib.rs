//! seance — Tauri desktop shell.
//!
//! This layer is deliberately thin: all correlation lives in `seance-core`. Here
//! we only (1) own the `notify` file watcher + a wall-clock poll timer, (2) read
//! the two log files with `std::fs` (READ-ONLY, structurally — see below), and
//! (3) emit normalized batches to the webview.
//!
//! ## Structural read-only (the security posture)
//!
//! Tauri capabilities gate the JS→backend IPC bridge, NOT native `std::fs`. So
//! "read-only" is enforced in code, in one place:
//!   - the webview is granted NO fs plugin (see `capabilities/default.json`), so
//!     a compromised/XSS'd webview has zero file API — it can only *receive*
//!     events;
//!   - the backend only ever constructs paths under `$HOME/.sentinel` and
//!     `$HOME/.ghost`, and reads them via `seance-core`, which only ever calls
//!     `File::open` (read). There is no `write`/`create`/`truncate`/`remove`
//!     anywhere in this crate or `seance-core` — CI greps for those to keep it
//!     that way.
//!
//! Untrusted log payloads (commands, tool output, roasts) are delivered as event
//! data and rendered as text by the frontend; the strict CSP is the backstop.

use seance_core::model::SeanceEvent;
use seance_core::records::{parse_line, Source};
use seance_core::rotation::{poll_ghost, poll_sentinel, FileCursor, PollResult};
use seance_core::{Correlator, SeanceBatch, TailState};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// The Tauri event name carrying live [`SeanceBatch`]es to the webview.
const EVENT_NAME: &str = "seance://event";

/// Belt-and-suspenders poll cadence. The `notify` watcher makes tailing
/// *responsive*; this timer makes it *correct* even if the OS coalesces or drops
/// a filesystem event (FSEvents can).
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// One watched source: which file, which rotation policy, its live cursor.
struct Watched {
    source: Source,
    cursor: FileCursor,
}

impl Watched {
    fn poll(&mut self) -> std::io::Result<PollResult> {
        match self.source {
            Source::Ghost => poll_ghost(&self.cursor),
            Source::Sentinel => poll_sentinel(&self.cursor),
        }
    }
}

/// Everything the poll loop and the `backfill` command share.
struct AppState {
    correlator: Correlator,
    tail_state: TailState,
    sentinel: Watched,
    ghost: Watched,
    state_path: PathBuf,
    /// Count of lines that failed to parse (malformed / torn), surfaced for
    /// diagnostics — never fatal, exactly the tolerance both emitters have.
    skipped: u64,
}

type Shared = Arc<Mutex<AppState>>;

/// `$HOME`, or the current dir as a last resort (mirrors sentinel/ghost).
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn sentinel_log() -> PathBuf {
    home().join(".sentinel").join("audit.jsonl")
}
fn ghost_log() -> PathBuf {
    home().join(".ghost").join("events.jsonl")
}

impl AppState {
    /// Seed the SENTINEL cursor: resolve against the current inode, restarting
    /// from 0 on an inode change (sentinel never rotates, so that means the file
    /// was replaced/truncated externally — there is no `.1` to drain).
    fn seed_sentinel(tail_state: &TailState, path: PathBuf) -> FileCursor {
        let inode = std::fs::metadata(&path).map(inode_of).unwrap_or(0);
        tail_state.resolve(&path, inode)
    }

    fn new(state_path: PathBuf) -> Self {
        let tail_state = TailState::load(&state_path);
        let sentinel = Watched {
            source: Source::Sentinel,
            cursor: Self::seed_sentinel(&tail_state, sentinel_log()),
        };
        let ghost = Watched {
            source: Source::Ghost,
            // Resume the ghost cursor verbatim: if a rotation happened while
            // seance was closed, poll_ghost's Rotated branch drains the `.1`
            // tail we hadn't consumed instead of losing it.
            cursor: tail_state.resume(&ghost_log()),
        };
        AppState {
            correlator: Correlator::new(),
            tail_state,
            sentinel,
            ghost,
            state_path,
            skipped: 0,
        }
    }

    /// Poll BOTH files once, feed new lines to the correlator, persist offsets,
    /// and return the merged delta batch (empty `events` if nothing new).
    fn poll_once(&mut self) -> SeanceBatch {
        let mut records = Vec::new();
        for w in [&mut self.sentinel, &mut self.ghost] {
            let Ok(result) = w.poll() else { continue };
            for line in &result.lines {
                match parse_line(w.source, line) {
                    Ok(rec) => records.push(rec),
                    Err(_) => self.skipped += 1,
                }
            }
            w.cursor = result.cursor.clone();
            self.tail_state.update(&result.cursor);
        }
        let batch = self.correlator.ingest(records);
        // Best-effort persistence; a failure just means we may re-read a few
        // lines next launch (the correlator dedupes).
        let _ = self.tail_state.save(&self.state_path);
        batch
    }
}

fn inode_of(m: std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.ino()
}

/// Backfill command: the full current joined timeline, for the webview to seed
/// its store on launch. Read-only snapshot; touches no files.
#[tauri::command]
fn backfill(state: State<'_, Shared>) -> Vec<SeanceEvent> {
    state
        .lock()
        .map(|s| s.correlator.snapshot())
        .unwrap_or_default()
}

/// Diagnostics for the header (skipped-line count + which files exist).
#[tauri::command]
fn status(state: State<'_, Shared>) -> serde_json::Value {
    let skipped = state.lock().map(|s| s.skipped).unwrap_or(0);
    serde_json::json!({
        "skipped": skipped,
        "sentinelPath": sentinel_log().to_string_lossy(),
        "ghostPath": ghost_log().to_string_lossy(),
        "sentinelExists": sentinel_log().exists(),
        "ghostExists": ghost_log().exists(),
    })
}

/// Start the native watcher (with a PollWatcher fallback) plus the poll timer on
/// a background thread. Every wake — a filesystem event OR the timer — runs one
/// `poll_once` and emits the delta if non-empty.
fn spawn_watch_loop(app: AppHandle, shared: Shared) {
    use notify::{Config, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};

    // We watch the two DIRECTORIES (not the files) so create/rotate is seen.
    let dirs: Vec<PathBuf> = vec![
        sentinel_log()
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(home),
        ghost_log().parent().map(PathBuf::from).unwrap_or_else(home),
    ];

    let (tx, rx) = mpsc::channel::<()>();

    // Collapse every relevant fs event to a single "wake" tick.
    let make_handler = |tx: mpsc::Sender<()>| {
        move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(
                    ev.kind,
                    EventKind::Create(_)
                        | EventKind::Modify(_)
                        | EventKind::Remove(_)
                        | EventKind::Any
                ) {
                    let _ = tx.send(());
                }
            }
        }
    };

    // Keep the watcher alive for the life of the loop by moving it into the thread.
    enum AnyWatcher {
        Native(RecommendedWatcher),
        Poll(PollWatcher),
    }

    let watcher: Option<AnyWatcher> = (|| {
        // Try the native backend first (FSEvents / inotify).
        match RecommendedWatcher::new(make_handler(tx.clone()), Config::default()) {
            Ok(mut w) => {
                let mut ok = true;
                for d in &dirs {
                    if w.watch(d, RecursiveMode::NonRecursive).is_err() {
                        ok = false;
                        break;
                    }
                }
                if ok {
                    return Some(AnyWatcher::Native(w));
                }
            }
            Err(_) => {}
        }
        // Fallback: PollWatcher re-stats on an interval (size/mtime only).
        let cfg = Config::default()
            .with_poll_interval(POLL_INTERVAL)
            .with_compare_contents(false);
        match PollWatcher::new(make_handler(tx.clone()), cfg) {
            Ok(mut w) => {
                for d in &dirs {
                    let _ = w.watch(d, RecursiveMode::NonRecursive);
                }
                Some(AnyWatcher::Poll(w))
            }
            Err(_) => None, // no watcher; the wall-clock timer still drives polling
        }
    })();

    std::thread::spawn(move || {
        let _keep_alive = watcher; // dropped when the thread ends
                                   // Keep a Sender alive independently of the watcher. If watcher
                                   // construction returned None (native AND poll both failed), the only
                                   // other Senders — the ones cloned into the watcher handlers — never
                                   // existed, so without this the channel would be Disconnected on the very
                                   // first recv and the loop would exit, silently freezing the wall-clock
                                   // fallback. Holding `tx` here means Disconnected can't happen; the timer
                                   // path keeps polling regardless of the watcher.
        let _keep_tx = tx;
        loop {
            // Wake on a fs event OR every POLL_INTERVAL, whichever first. A
            // Disconnected is treated like a Timeout (poll anyway), not a break,
            // so nothing can wedge the loop short of process teardown.
            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(()) | Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                    let batch = match shared.lock() {
                        Ok(mut s) => s.poll_once(),
                        Err(_) => continue,
                    };
                    if !batch.events.is_empty() || !batch.dropped.is_empty() {
                        let _ = app.emit(EVENT_NAME, &batch);
                    }
                }
            }
        }
    });
}

/// The state file lives in the OS app-data dir (e.g. on macOS
/// `~/Library/Application Support/com.stresstestor.seance/tail_state.json`).
fn state_file(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("tail_state.json")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let mut state = AppState::new(state_file(&handle));
            // Prime the correlator once synchronously so `backfill` has data the
            // instant the webview asks (well within the ~1s target).
            let _ = state.poll_once();
            let shared: Shared = Arc::new(Mutex::new(state));
            app.manage(shared.clone());
            spawn_watch_loop(handle, shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backfill, status])
        .run(tauri::generate_context!())
        .expect("error while running seance");
}
