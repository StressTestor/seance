//! Offset persistence across app restarts.
//!
//! A tiny JSON file (written by the Tauri layer into the OS app-data dir) keyed
//! by file path, storing `{inode, offset, len_seen}`. On restart we resolve a
//! starting [`FileCursor`] per file:
//!   - inode matches  => resume from the stored offset.
//!   - inode differs  => the file was rotated/replaced while we were down =>
//!     DISCARD the offset and restart from 0 (the anti-skip rule: never seek
//!     past a fresh file's start).
//!
//! Writes are atomic (temp + rename) so a crash mid-write can't corrupt state;
//! worst case we resume from the previous poll's offset and re-emit a few lines,
//! which the join layer dedupes by identity anyway.

use crate::rotation::FileCursor;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// The persisted tail state for every watched file.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailState {
    /// Schema version for forward-compat.
    pub version: u32,
    /// key = the file's path string.
    pub cursors: HashMap<String, Saved>,
}

/// One persisted cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    pub inode: u64,
    pub offset: u64,
    pub len_seen: u64,
}

impl TailState {
    /// Load state from `path`. A missing or corrupt file yields the default
    /// (empty) state — never a panic, never an error the caller must handle.
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Atomically persist state: write a temp file then rename over `path`.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)
    }

    /// Record where a file's cursor now sits (call after every successful poll).
    pub fn update(&mut self, cursor: &FileCursor) {
        self.cursors.insert(
            cursor.path.to_string_lossy().into_owned(),
            Saved {
                inode: cursor.inode,
                offset: cursor.offset,
                len_seen: cursor.len_seen,
            },
        );
    }

    /// Resume cursor for a ROTATING source (ghost): return the persisted cursor
    /// verbatim (persisted inode + offset), letting `poll_ghost`'s rotation logic
    /// decide what happened. This is what makes a rotation that occurred *while
    /// seance was closed* recoverable: on the next poll the persisted (old) inode
    /// won't match the fresh main, so `poll_ghost` takes its Rotated branch and
    /// drains the unconsumed tail of `.1` before reading the new file — instead of
    /// silently losing those lines. Unknown path -> a fresh cursor at offset 0.
    pub fn resume(&self, path: &Path) -> FileCursor {
        let key = path.to_string_lossy().into_owned();
        match self.cursors.get(&key) {
            Some(s) => FileCursor {
                path: path.into(),
                offset: s.offset,
                inode: s.inode,
                len_seen: s.len_seen,
            },
            None => FileCursor::new(path),
        }
    }

    /// Resolve a starting cursor for a NON-rotating source (sentinel) given the
    /// file's CURRENT inode, invalidating (restart-from-0) on any inode mismatch.
    /// (There is no `.1` to drain for sentinel, so an inode change means the file
    /// was replaced/truncated externally and restarting from 0 is correct.)
    pub fn resolve(&self, path: &Path, current_inode: u64) -> FileCursor {
        let key = path.to_string_lossy().into_owned();
        match self.cursors.get(&key) {
            Some(s) if s.inode == current_inode && current_inode != 0 => FileCursor {
                path: path.into(),
                offset: s.offset,
                inode: s.inode,
                len_seen: s.len_seen,
            },
            // unknown path OR inode changed OR unknown inode -> start at 0.
            _ => FileCursor {
                path: path.into(),
                offset: 0,
                inode: current_inode,
                len_seen: 0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(path: &str, inode: u64, offset: u64) -> TailState {
        let mut s = TailState::default();
        s.cursors.insert(
            path.to_string(),
            Saved {
                inode,
                offset,
                len_seen: offset,
            },
        );
        s
    }

    #[test]
    fn roundtrip_save_then_load() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        let s = state_with("/x/audit.jsonl", 7, 128);
        s.save(&p).unwrap();
        assert_eq!(TailState::load(&p), s);
    }

    #[test]
    fn resolve_hit_resumes_offset() {
        let s = state_with("/x/audit.jsonl", 7, 128);
        let cur = s.resolve(Path::new("/x/audit.jsonl"), 7);
        assert_eq!(cur.offset, 128);
        assert_eq!(cur.inode, 7);
    }

    #[test]
    fn resolve_inode_changed_resets_to_zero() {
        // the anti-skip test: a file replaced while we were down must restart.
        let s = state_with("/x/audit.jsonl", 7, 128);
        let cur = s.resolve(Path::new("/x/audit.jsonl"), 999);
        assert_eq!(cur.offset, 0, "must not seek past a fresh file");
        assert_eq!(cur.inode, 999, "re-anchor on the new inode");
    }

    #[test]
    fn resolve_unknown_path_starts_at_zero() {
        let s = TailState::default();
        let cur = s.resolve(Path::new("/x/new.jsonl"), 3);
        assert_eq!(cur.offset, 0);
        assert_eq!(cur.inode, 3);
    }

    #[test]
    fn resolve_unknown_current_inode_starts_at_zero() {
        // inode 0 means we couldn't stat yet; never resume against it.
        let s = state_with("/x/audit.jsonl", 7, 128);
        let cur = s.resolve(Path::new("/x/audit.jsonl"), 0);
        assert_eq!(cur.offset, 0);
    }

    #[test]
    fn corrupt_state_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        std::fs::write(&p, b"{ not json at all").unwrap();
        assert_eq!(TailState::load(&p), TailState::default());
    }

    #[test]
    fn atomic_save_leaves_no_tmp_and_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("state.json");
        state_with("/x/a.jsonl", 1, 10).save(&p).unwrap();
        assert!(p.exists());
        assert!(
            !p.with_extension("json.tmp").exists(),
            "no .tmp left behind"
        );
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert!(v.get("cursors").is_some());
    }

    #[test]
    fn resume_returns_persisted_cursor_verbatim() {
        // ghost resume keeps the persisted inode (even if it no longer matches
        // the current file) so poll_ghost can detect the rotation and drain .1.
        let s = state_with("/x/events.jsonl", 7, 128);
        let cur = s.resume(Path::new("/x/events.jsonl"));
        assert_eq!(cur.offset, 128);
        assert_eq!(cur.inode, 7, "persisted inode kept, not invalidated");
    }

    #[test]
    fn resume_unknown_path_is_fresh() {
        let cur = TailState::default().resume(Path::new("/x/events.jsonl"));
        assert_eq!(cur.offset, 0);
        assert_eq!(cur.inode, 0);
    }

    #[test]
    fn update_records_the_cursor() {
        let mut s = TailState::default();
        s.update(&FileCursor {
            path: "/x/a.jsonl".into(),
            offset: 42,
            inode: 9,
            len_seen: 42,
        });
        let cur = s.resolve(Path::new("/x/a.jsonl"), 9);
        assert_eq!(cur.offset, 42);
    }
}
