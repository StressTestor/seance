//! Rotation-aware polling.
//!
//! sentinel's `audit.jsonl` never rotates (it grows forever), so it uses a plain
//! incremental tail with an offset-past-EOF / truncation / missing-file guard.
//!
//! ghost's `events.jsonl` rotates at 8 MiB: it is renamed to `events.jsonl.1`
//! (replacing any prior `.1`) and a fresh empty `events.jsonl` is created. On a
//! rotation we must drain the tail of the OLD file (now `.1`) that we hadn't yet
//! consumed, then restart the main file from offset 0 — otherwise the lines
//! written to `events.jsonl` between our last poll and the rotation are lost.
//!
//! Rotation is detected two ways, both necessary:
//!   - inode changed  => a new file was swapped in (the rename+create path).
//!   - `len < offset` => the file shrank => truncated/replaced under the same
//!     inode (an `open(O_TRUNC)` style rotator).

use crate::tail::{tail_from, TailResult};
use std::ffi::OsString;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Where we are in one watched file. `inode == 0` means "never read / unknown"
/// (so inode-change detection can't false-positive on the first read).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileCursor {
    pub path: PathBuf,
    pub offset: u64,
    pub inode: u64,
    pub len_seen: u64,
}

impl FileCursor {
    /// A fresh cursor at the start of `path`, nothing read yet.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        FileCursor {
            path: path.into(),
            offset: 0,
            inode: 0,
            len_seen: 0,
        }
    }
}

/// What the current on-disk state means relative to a cursor.
#[derive(Debug, PartialEq, Eq)]
pub enum RotationVerdict {
    /// Same inode, `len >= offset`: a normal incremental tail.
    Fresh,
    /// inode changed, or `len < offset`: the file was replaced/truncated.
    Rotated,
    /// The file does not exist right now (transient, e.g. mid-rotation).
    Missing,
}

/// Lines read this poll plus the cursor to persist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollResult {
    /// Chronological within this poll: old-file leftovers first, then new lines.
    pub lines: Vec<String>,
    pub cursor: FileCursor,
}

/// The `.1` sibling of a rotating log, built by appending `.1` to the file name
/// (matching ghost's own `events.jsonl -> events.jsonl.1` scheme exactly).
pub fn rotated_sibling(path: &Path) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// Classify the current on-disk state of `cursor.path` against the cursor.
pub fn classify(cursor: &FileCursor) -> std::io::Result<RotationVerdict> {
    match std::fs::metadata(&cursor.path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RotationVerdict::Missing),
        Err(e) => Err(e),
        Ok(m) => {
            let (ino, len) = (m.ino(), m.len());
            // Rotated if the inode changed (a new file was swapped in) OR the
            // file shrank below our offset (truncated/replaced under one inode).
            let inode_changed = cursor.inode != 0 && ino != cursor.inode;
            let shrank = len < cursor.offset;
            if inode_changed || shrank {
                Ok(RotationVerdict::Rotated)
            } else {
                Ok(RotationVerdict::Fresh)
            }
        }
    }
}

fn advanced(cursor: &FileCursor, t: &TailResult) -> FileCursor {
    FileCursor {
        path: cursor.path.clone(),
        offset: t.new_offset,
        inode: t.inode,
        len_seen: t.file_len,
    }
}

/// Poll the sentinel log (no rotation; grows forever). Truncation or a swapped
/// inode is handled defensively as "restart from 0"; a momentarily-missing file
/// yields nothing and resets the inode so the next read re-anchors.
pub fn poll_sentinel(cursor: &FileCursor) -> std::io::Result<PollResult> {
    match classify(cursor)? {
        RotationVerdict::Fresh => {
            let t = tail_from(&cursor.path, cursor.offset)?;
            Ok(PollResult {
                lines: t.lines.clone(),
                cursor: advanced(cursor, &t),
            })
        }
        RotationVerdict::Rotated => {
            let t = tail_from(&cursor.path, 0)?;
            Ok(PollResult {
                lines: t.lines.clone(),
                cursor: advanced(cursor, &t),
            })
        }
        RotationVerdict::Missing => Ok(PollResult {
            lines: Vec::new(),
            cursor: FileCursor {
                inode: 0,
                ..cursor.clone()
            },
        }),
    }
}

/// Poll the ghost log, handling the `events.jsonl -> events.jsonl.1` rotation.
pub fn poll_ghost(cursor: &FileCursor) -> std::io::Result<PollResult> {
    let main = cursor.path.clone();
    let rotated = rotated_sibling(&main);
    let mut out = Vec::new();

    match classify(cursor)? {
        RotationVerdict::Fresh => {
            let t = tail_from(&main, cursor.offset)?;
            out.extend(t.lines.clone());
            Ok(PollResult {
                lines: out,
                cursor: advanced(cursor, &t),
            })
        }
        RotationVerdict::Missing => {
            // The main file is momentarily absent — mid-rotation, the old file is
            // already renamed to `.1` but the fresh main isn't created yet. Do
            // NOTHING and leave the cursor exactly as-is. When the new main
            // appears on a later poll, its new inode makes classify() return
            // Rotated, and the Rotated branch drains the unconsumed tail of `.1`
            // AND reads the new main from 0 in ONE atomic step (advancing the
            // cursor correctly). Draining here instead would strand the cursor
            // (offset still pointing into the old file, inode zeroed), so the very
            // next poll would either re-drain `.1` — duplicate lines, which the
            // correlator can't dedupe for id-less loose rows — or mis-frame the
            // new main from a stale offset. Waiting is the only correct move; the
            // Rotated branch drains `.1` once the fresh main appears.
            Ok(PollResult {
                lines: out,
                cursor: cursor.clone(),
            })
        }
        RotationVerdict::Rotated => {
            // 1. Read whatever we hadn't consumed from the OLD file (now .1).
            //    The `file_len >= offset` guard means: only trust .1 if it is at
            //    least as long as our offset, i.e. it really is our old file and
            //    not a stale/foreign .1 (truncate-in-place leaves no matching .1).
            if rotated.exists() {
                if let Ok(t) = tail_from(&rotated, cursor.offset) {
                    if t.file_len >= cursor.offset {
                        out.extend(t.lines);
                    }
                }
            }
            // 2. Restart the main file from offset 0.
            let t = tail_from(&main, 0)?;
            out.extend(t.lines.clone());
            Ok(PollResult {
                lines: out,
                cursor: advanced(cursor, &t),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }
    fn append(path: &Path, bytes: &[u8]) {
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
    }
    fn inode_of(path: &Path) -> u64 {
        fs::metadata(path).unwrap().ino()
    }

    // ── classify ───────────────────────────────────────────────────────────

    #[test]
    fn classify_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.jsonl");
        write(&p, b"a\nb\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 2,
            inode: inode_of(&p),
            len_seen: 4,
        };
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Fresh);
    }

    #[test]
    fn classify_shrink_is_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.jsonl");
        write(&p, b"a\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 999, // offset past current len
            inode: inode_of(&p),
            len_seen: 999,
        };
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Rotated);
    }

    #[test]
    fn classify_inode_change_is_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.jsonl");
        write(&p, b"a\n");
        let old_inode = inode_of(&p);
        // Rotate the way ghost actually does: rename the old file aside (its inode
        // stays alive on the `.1`), then create a fresh file at the path. Because
        // the old inode is still referenced, the new file is guaranteed a
        // different inode — unlike remove+recreate, which the FS may inode-reuse.
        fs::rename(&p, rotated_sibling(&p)).unwrap();
        write(&p, b"a\nb\n");
        assert_ne!(inode_of(&p), old_inode, "rotation yields a fresh inode");
        let cur = FileCursor {
            path: p.clone(),
            offset: 2,
            inode: old_inode,
            len_seen: 2,
        };
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Rotated);
    }

    #[test]
    fn classify_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gone.jsonl");
        let cur = FileCursor::new(p);
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Missing);
    }

    #[test]
    fn classify_unknown_inode_never_rotated_on_inode_alone() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("g.jsonl");
        write(&p, b"a\nb\n");
        // inode==0 (never read); len(4) >= offset(0) -> Fresh, not Rotated.
        let cur = FileCursor::new(p);
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Fresh);
    }

    // ── poll_ghost ───────────────────────────────────────────────────────────

    #[test]
    fn ghost_normal_append() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        write(&p, b"a\n");
        let r1 = poll_ghost(&FileCursor::new(p.clone())).unwrap();
        assert_eq!(r1.lines, vec!["a"]);
        append(&p, b"b\nc\n");
        let r2 = poll_ghost(&r1.cursor).unwrap();
        assert_eq!(r2.lines, vec!["b", "c"]);
    }

    #[test]
    fn ghost_rotation_midread_drains_dot1_then_reads_new() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let dot1 = rotated_sibling(&p);

        // consume "a\n", leaving "b\nc\n" unconsumed in the current file.
        write(&p, b"a\nb\nc\n");
        let r1 = poll_ghost(&FileCursor::new(p.clone())).unwrap();
        assert_eq!(r1.lines, vec!["a", "b", "c"]);
        // append more, consume only up to a known offset
        append(&p, b"d\n");
        let mut cur = r1.cursor.clone();
        // pretend we only consumed through "a\n" (offset 2) to simulate a gap.
        cur.offset = 2;

        // now rotate: current file -> .1, fresh main with new lines.
        fs::rename(&p, &dot1).unwrap();
        write(&p, b"x\ny\n");

        let r2 = poll_ghost(&cur).unwrap();
        // leftover tail of .1 from offset 2 ("b","c","d") THEN the new lines.
        assert_eq!(r2.lines, vec!["b", "c", "d", "x", "y"]);
        assert_eq!(r2.cursor.inode, inode_of(&p));
        assert_eq!(r2.cursor.offset, r2.cursor.len_seen);
    }

    #[test]
    fn ghost_truncation_same_inode_restarts_from_zero() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        write(&p, b"a\nb\nc\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 6,
            inode: inode_of(&p),
            len_seen: 6,
        };
        // truncate-in-place (same inode), shorter than offset, no matching .1.
        write(&p, b"z\n");
        let r = poll_ghost(&cur).unwrap();
        assert_eq!(r.lines, vec!["z"], ".1 guard yields nothing; main from 0");
    }

    #[test]
    fn ghost_missing_window_is_a_noop_then_recreation_drains_once() {
        // The whole rotation, poll-by-poll: consume "a", rotate so main is
        // momentarily MISSING, then the fresh main appears. The Missing poll must
        // do nothing (data is safe in .1); the recreation poll drains .1's
        // leftover exactly once AND reads the new main — no duplication, no loss.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let dot1 = rotated_sibling(&p);
        write(&p, b"a\nb\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 2, // consumed "a\n"
            inode: inode_of(&p),
            len_seen: 4,
        };

        // 1. rotate: p -> .1, main not yet recreated.
        fs::rename(&p, &dot1).unwrap();
        let r1 = poll_ghost(&cur).unwrap();
        assert!(r1.lines.is_empty(), "Missing poll emits nothing");
        assert_eq!(r1.cursor, cur, "Missing poll leaves the cursor untouched");

        // 2. fresh main appears with a new inode.
        write(&p, b"x\ny\n");
        let r2 = poll_ghost(&r1.cursor).unwrap();
        assert_eq!(
            r2.lines,
            vec!["b", "x", "y"],
            "drains .1 leftover ONCE then reads the new main — no dup, no loss"
        );
        assert_eq!(r2.cursor.inode, inode_of(&p));

        // 3. a third poll must not re-emit anything.
        let r3 = poll_ghost(&r2.cursor).unwrap();
        assert!(r3.lines.is_empty(), "no phantom re-drain on the next poll");
    }

    #[test]
    fn ghost_missing_stays_noop_while_main_absent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        write(&p, b"a\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 2,
            inode: inode_of(&p),
            len_seen: 2,
        };
        fs::rename(&p, rotated_sibling(&p)).unwrap();
        // repeated Missing polls never lose the cursor and never emit.
        let r1 = poll_ghost(&cur).unwrap();
        let r2 = poll_ghost(&r1.cursor).unwrap();
        assert!(r1.lines.is_empty() && r2.lines.is_empty());
        assert_eq!(
            r2.cursor, cur,
            "cursor stable across repeated Missing polls"
        );
    }

    #[test]
    fn ghost_rotated_no_dot1_just_restarts_main() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        write(&p, b"n\n");
        // Model the post-rotation state directly: the cursor holds an inode that
        // does NOT match the current file's, and no `.1` is present. (Constructed
        // rather than via remove+recreate, which the FS may inode-reuse, hiding
        // the change — see classify_inode_change_is_rotated.)
        let cur = FileCursor {
            path: p.clone(),
            offset: 2,
            inode: inode_of(&p).wrapping_add(1), // guaranteed != real inode
            len_seen: 2,
        };
        assert_eq!(classify(&cur).unwrap(), RotationVerdict::Rotated);
        let r = poll_ghost(&cur).unwrap();
        assert_eq!(r.lines, vec!["n"], "restart main from 0 when .1 is absent");
    }

    #[test]
    fn ghost_dot1_shorter_than_offset_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let dot1 = rotated_sibling(&p);
        // a foreign/short .1 that is shorter than our offset must not be read.
        write(&dot1, b"foreign\n");
        write(&p, b"a\nb\n");
        let old = inode_of(&p);
        fs::remove_file(&p).unwrap();
        write(&p, b"fresh\n"); // new inode -> Rotated
        let cur = FileCursor {
            path: p.clone(),
            offset: 100, // larger than the 8-byte foreign .1
            inode: old,
            len_seen: 100,
        };
        let r = poll_ghost(&cur).unwrap();
        assert_eq!(r.lines, vec!["fresh"], "short .1 guarded out");
    }

    #[test]
    fn ghost_ordering_old_leftovers_precede_new() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("events.jsonl");
        let dot1 = rotated_sibling(&p);
        write(&p, b"old1\nold2\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 0,
            inode: inode_of(&p),
            len_seen: 10,
        };
        fs::rename(&p, &dot1).unwrap();
        write(&p, b"new1\n");
        let r = poll_ghost(&cur).unwrap();
        assert_eq!(r.lines, vec!["old1", "old2", "new1"]);
    }

    // ── poll_sentinel ────────────────────────────────────────────────────────

    #[test]
    fn sentinel_normal_append() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("audit.jsonl");
        write(&p, b"a\n");
        let r1 = poll_sentinel(&FileCursor::new(p.clone())).unwrap();
        assert_eq!(r1.lines, vec!["a"]);
        append(&p, b"b\n");
        let r2 = poll_sentinel(&r1.cursor).unwrap();
        assert_eq!(r2.lines, vec!["b"]);
    }

    #[test]
    fn sentinel_truncation_restarts_from_zero() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("audit.jsonl");
        write(&p, b"a\nb\n");
        let cur = FileCursor {
            path: p.clone(),
            offset: 4,
            inode: inode_of(&p),
            len_seen: 4,
        };
        write(&p, b"z\n"); // shrank
        let r = poll_sentinel(&cur).unwrap();
        assert_eq!(r.lines, vec!["z"]);
    }

    #[test]
    fn sentinel_missing_is_empty_and_resets_inode() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("gone.jsonl");
        let cur = FileCursor {
            path: p,
            offset: 5,
            inode: 42,
            len_seen: 5,
        };
        let r = poll_sentinel(&cur).unwrap();
        assert!(r.lines.is_empty());
        assert_eq!(r.cursor.inode, 0);
    }
}
