//! End-to-end pipeline test: real files → tail → parse → correlate → persist,
//! including a mid-stream ghost rotation and a simulated app restart resuming
//! from persisted offsets. This exercises exactly the sequence the Tauri layer's
//! `AppState::poll_once` runs — but with no Tauri, so it runs anywhere.

use seance_core::model::SeanceEvent;
use seance_core::records::{parse_line, Source};
use seance_core::rotation::{poll_ghost, poll_sentinel, rotated_sibling, FileCursor};
use seance_core::{Correlator, TailState};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// One poll cycle over both files — the same shape as `AppState::poll_once`.
fn poll_cycle(
    corr: &mut Correlator,
    state: &mut TailState,
    sentinel: &mut FileCursor,
    ghost: &mut FileCursor,
    state_path: &Path,
) -> Vec<SeanceEvent> {
    let mut records = Vec::new();
    if let Ok(r) = poll_sentinel(sentinel) {
        for line in &r.lines {
            if let Ok(rec) = parse_line(Source::Sentinel, line) {
                records.push(rec);
            }
        }
        *sentinel = r.cursor.clone();
        state.update(&r.cursor);
    }
    if let Ok(r) = poll_ghost(ghost) {
        for line in &r.lines {
            if let Ok(rec) = parse_line(Source::Ghost, line) {
                records.push(rec);
            }
        }
        *ghost = r.cursor.clone();
        state.update(&r.cursor);
    }
    let batch = corr.ingest(records);
    state.save(state_path).unwrap();
    batch.events
}

fn append(path: &Path, line: &str) {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(f, "{line}").unwrap();
}

fn inode(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.ino()).unwrap_or(0)
}

fn governing<'a>(events: &'a [SeanceEvent], key: &str) -> &'a seance_core::GoverningCall {
    match events.iter().find(|e| e.key() == key).unwrap() {
        SeanceEvent::Governing(g) => g,
        _ => panic!("expected governing"),
    }
}

#[test]
fn full_pipeline_joins_a_call_survives_rotation_and_resumes_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let sdir = dir.path().join(".sentinel");
    let gdir = dir.path().join(".ghost");
    std::fs::create_dir_all(&sdir).unwrap();
    std::fs::create_dir_all(&gdir).unwrap();
    let audit = sdir.join("audit.jsonl");
    let events = gdir.join("events.jsonl");
    let state_path = dir.path().join("tail_state.json");

    // ── a real hooked call lands: sentinel pre, then ghost, then a post ──
    append(
        &audit,
        r#"{"timestamp":"2026-07-14T00:08:46.331+00:00","tool_name":"Bash","action":"allow","mode":"enforce","call_id":"c1","tool_use_id":"t1","hook_phase":"pre"}"#,
    );
    append(
        &events,
        r#"{"ts_ms":1783987726334,"tool":"Bash","command":"aws s3 ls","decision":"pass","call_id":"c1","tool_use_id":"t1"}"#,
    );

    let mut corr = Correlator::new();
    let mut state = TailState::default();
    let mut sc = FileCursor::new(audit.clone());
    let mut gc = FileCursor::new(events.clone());

    let out = poll_cycle(&mut corr, &mut state, &mut sc, &mut gc, &state_path);
    assert_eq!(out.len(), 1, "one governing call");
    let key = out[0].key().to_string();
    let call = governing(&out, &key);
    assert!(call.ghost.is_some() && call.pre.is_some());
    assert!(call.post.is_empty());

    // ── the post line arrives later ──
    append(
        &audit,
        r#"{"timestamp":"2026-07-14T00:08:46.538+00:00","tool_name":"PostToolUse","action":"detect","reason":"secret shape","mode":"enforce","tool_use_id":"t1","hook_phase":"post"}"#,
    );
    let out = poll_cycle(&mut corr, &mut state, &mut sc, &mut gc, &state_path);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].key(), key, "same governing call patched");
    assert_eq!(
        governing(&out, &key).post.len(),
        1,
        "post joined via tool_use_id"
    );

    // ── ghost rotates mid-session; a call spanning the boundary is not lost ──
    append(
        &events,
        r#"{"ts_ms":2,"tool":"Bash","command":"pre-rot","decision":"deny","call_id":"c2","tool_use_id":"t2"}"#,
    );
    // rotate: current -> .1, fresh main with a new line
    std::fs::rename(&events, rotated_sibling(&events)).unwrap();
    append(
        &events,
        r#"{"ts_ms":3,"tool":"Bash","command":"post-rot","decision":"pass","call_id":"c3","tool_use_id":"t3"}"#,
    );

    let out = poll_cycle(&mut corr, &mut state, &mut sc, &mut gc, &state_path);
    let cmds: Vec<String> = out
        .iter()
        .filter_map(|e| match e {
            SeanceEvent::Governing(g) => g.ghost.as_ref().map(|gh| gh.command.clone()),
            _ => None,
        })
        .collect();
    assert!(
        cmds.contains(&"pre-rot".to_string()),
        "the pre-rotation line survived: {cmds:?}"
    );
    assert!(
        cmds.contains(&"post-rot".to_string()),
        "post-rotation line read"
    );

    // ── simulate an app restart: reload state, re-seed cursors, poll ──
    // sentinel resolves against the current inode; ghost resumes verbatim so a
    // rotation-while-down can be recovered (see the dedicated test below).
    let reloaded = TailState::load(&state_path);
    let mut sc2 = reloaded.resolve(&audit, inode(&audit));
    let mut gc2 = reloaded.resume(&events);
    let mut corr2 = Correlator::new();
    let mut state2 = reloaded;

    // nothing new since the last save -> a restart re-emits nothing.
    let out = poll_cycle(&mut corr2, &mut state2, &mut sc2, &mut gc2, &state_path);
    assert!(out.is_empty(), "restart resumes from offset, no re-emit");

    // a brand-new call after restart is picked up.
    append(
        &audit,
        r#"{"timestamp":"2026-07-14T00:09:00.000+00:00","tool_name":"Read","action":"allow","mode":"enforce","call_id":"c9","tool_use_id":"t9","hook_phase":"pre"}"#,
    );
    let out = poll_cycle(&mut corr2, &mut state2, &mut sc2, &mut gc2, &state_path);
    assert_eq!(out.len(), 1, "new post-restart call is tailed");
    assert_eq!(
        governing(&out, out[0].key())
            .pre
            .as_ref()
            .unwrap()
            .call_id
            .as_deref(),
        Some("c9")
    );
}

#[test]
fn ghost_rotation_while_closed_is_recovered_on_restart() {
    // The narrow-but-real window: seance is CLOSED, ghost rotates, and there were
    // unconsumed lines in the file that became events.jsonl.1. On restart, ghost
    // must drain that .1 tail (not lose it) and then read the fresh main.
    let dir = tempfile::tempdir().unwrap();
    let gdir = dir.path().join(".ghost");
    std::fs::create_dir_all(&gdir).unwrap();
    let events = gdir.join("events.jsonl");
    let audit = dir.path().join("audit.jsonl"); // unused sentinel side
    let state_path = dir.path().join("state.json");

    // session 1: consume one line, persist the cursor, then "close".
    append(
        &events,
        r#"{"ts_ms":1,"tool":"Bash","command":"seen","decision":"pass","call_id":"c1","tool_use_id":"t1"}"#,
    );
    let mut corr = Correlator::new();
    let mut state = TailState::default();
    let mut sc = FileCursor::new(audit.clone());
    let mut gc = FileCursor::new(events.clone());
    let out = poll_cycle(&mut corr, &mut state, &mut sc, &mut gc, &state_path);
    assert_eq!(out.len(), 1);

    // while closed: a line is appended, THEN rotation happens, THEN a fresh line.
    append(
        &events,
        r#"{"ts_ms":2,"tool":"Bash","command":"unconsumed-before-rotation","decision":"deny","call_id":"c2","tool_use_id":"t2"}"#,
    );
    std::fs::rename(&events, rotated_sibling(&events)).unwrap();
    append(
        &events,
        r#"{"ts_ms":3,"tool":"Bash","command":"after-rotation","decision":"pass","call_id":"c3","tool_use_id":"t3"}"#,
    );

    // restart: resume the ghost cursor verbatim, poll once.
    let reloaded = TailState::load(&state_path);
    let mut gc2 = reloaded.resume(&events);
    let mut sc2 = FileCursor::new(audit);
    let mut corr2 = Correlator::new();
    let mut state2 = reloaded;
    let out = poll_cycle(&mut corr2, &mut state2, &mut sc2, &mut gc2, &state_path);

    let cmds: Vec<String> = out
        .iter()
        .filter_map(|e| match e {
            SeanceEvent::Governing(g) => g.ghost.as_ref().map(|gh| gh.command.clone()),
            _ => None,
        })
        .collect();
    assert!(
        cmds.contains(&"unconsumed-before-rotation".to_string()),
        "the line stranded in .1 by a rotation-while-closed is recovered: {cmds:?}"
    );
    assert!(
        cmds.contains(&"after-rotation".to_string()),
        "and the fresh main is read"
    );
}

#[test]
fn malformed_and_legacy_lines_are_tolerated_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let audit = dir.path().join("audit.jsonl");
    let state_path = dir.path().join("state.json");
    // a torn/garbage line, a legacy id-less line, then a good line.
    append(&audit, "{ half written");
    append(
        &audit,
        r#"{"timestamp":"2026-01-01T00:00:00+00:00","tool_name":"Read","action":"allow","mode":"audit"}"#,
    );
    append(
        &audit,
        r#"{"timestamp":"2026-07-14T00:00:00+00:00","tool_name":"Bash","action":"block","mode":"enforce","call_id":"c","tool_use_id":"t","hook_phase":"pre"}"#,
    );

    let mut corr = Correlator::new();
    let mut state = TailState::default();
    let mut sc = FileCursor::new(audit.clone());
    let mut gc = FileCursor::new(dir.path().join("ghost-none.jsonl"));
    let out = poll_cycle(&mut corr, &mut state, &mut sc, &mut gc, &state_path);

    // garbage skipped; legacy line surfaced as loose; good line as governing.
    assert_eq!(out.len(), 2, "loose legacy + governing, garbage dropped");
    let kinds: Vec<&str> = out
        .iter()
        .map(|e| match e {
            SeanceEvent::Governing(_) => "governing",
            SeanceEvent::Loose(_) => "loose",
        })
        .collect();
    assert!(kinds.contains(&"loose"));
    assert!(kinds.contains(&"governing"));
}
