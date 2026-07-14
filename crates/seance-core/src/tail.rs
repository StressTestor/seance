//! Incremental tail: frame raw bytes into complete lines, leave a partial
//! trailing line for next poll, report the new offset. Pure and testable — takes
//! a `Path` + offset, no globals, no clock, no watcher.
//!
//! The record parser lives in [`crate::records`]; this module never parses JSON,
//! so its tests need nothing but byte buffers.

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// Result of reading complete lines from a file starting at some offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailResult {
    /// Complete, newline-stripped lines (raw JSONL text — NOT parsed here).
    pub lines: Vec<String>,
    /// Byte offset AFTER the last complete line. A partial trailing line is not
    /// counted, so next poll re-reads it once it is completed.
    pub new_offset: u64,
    /// File length at read time (the caller uses it for rotation checks).
    pub file_len: u64,
    /// `st_ino` at read time (the caller uses it to detect a swapped-in file).
    pub inode: u64,
}

/// Read complete newline-terminated lines from `path` starting at `offset`.
///
/// A partial (non-newline-terminated) trailing line is NOT returned and does NOT
/// advance the offset. If `offset` is at or past EOF, reads nothing (defensive:
/// the caller's rotation check in [`crate::rotation`] is the real guard).
pub fn tail_from(path: &Path, offset: u64) -> io::Result<TailResult> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    let file_len = meta.len();
    let inode = meta.ino();

    if offset >= file_len {
        return Ok(TailResult {
            lines: Vec::new(),
            new_offset: offset.min(file_len),
            file_len,
            inode,
        });
    }

    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf)?; // bounded: this is only the per-poll delta

    let (lines, consumed) = split_complete_lines(&buf);
    Ok(TailResult {
        lines,
        new_offset: offset + consumed as u64,
        file_len,
        inode,
    })
}

/// Split a byte buffer into (complete lines, bytes consumed through the last
/// `\n`). Bytes after the final `\n` are a partial line and are not consumed.
/// Invalid UTF-8 is decoded lossily so a torn multibyte char never errors here —
/// the downstream JSON parse of that lossy string simply fails and is skipped.
pub fn split_complete_lines(buf: &[u8]) -> (Vec<String>, usize) {
    let mut lines = Vec::new();
    let mut consumed = 0usize;
    let mut start = 0usize;
    for (i, &b) in buf.iter().enumerate() {
        if b == b'\n' {
            let mut end = i;
            if end > start && buf[end - 1] == b'\r' {
                end -= 1; // tolerate CRLF
            }
            lines.push(String::from_utf8_lossy(&buf[start..end]).into_owned());
            consumed = i + 1;
            start = i + 1;
        }
    }
    (lines, consumed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── split_complete_lines: pure, no fs ──────────────────────────────────

    #[test]
    fn split_empty() {
        assert_eq!(split_complete_lines(b""), (vec![], 0));
    }

    #[test]
    fn split_one_complete() {
        assert_eq!(split_complete_lines(b"a\n"), (vec!["a".to_string()], 2));
    }

    #[test]
    fn split_two_complete() {
        assert_eq!(
            split_complete_lines(b"a\nb\n"),
            (vec!["a".to_string(), "b".to_string()], 4)
        );
    }

    #[test]
    fn split_trailing_partial_is_left_unconsumed() {
        // "b" has no newline yet -> not returned, offset stops after "a\n".
        assert_eq!(split_complete_lines(b"a\nb"), (vec!["a".to_string()], 2));
    }

    #[test]
    fn split_crlf_is_tolerated() {
        assert_eq!(split_complete_lines(b"a\r\n"), (vec!["a".to_string()], 3));
    }

    #[test]
    fn split_blank_lines_are_kept() {
        assert_eq!(
            split_complete_lines(b"\n\n"),
            (vec!["".to_string(), "".to_string()], 2)
        );
    }

    #[test]
    fn split_invalid_utf8_is_lossy_never_panics() {
        let (lines, consumed) = split_complete_lines(&[0xff, 0xfe, b'\n']);
        assert_eq!(lines.len(), 1);
        assert_eq!(consumed, 3);
    }

    // ── tail_from: uses tempfiles ──────────────────────────────────────────

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }
    fn append(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn tail_from_zero_reads_all_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        write(&p, b"one\ntwo\nthree\n");
        let r = tail_from(&p, 0).unwrap();
        assert_eq!(r.lines, vec!["one", "two", "three"]);
        assert_eq!(r.new_offset, r.file_len);
    }

    #[test]
    fn tail_resume_offset_returns_only_new_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        write(&p, b"one\ntwo\n");
        let r1 = tail_from(&p, 0).unwrap();
        append(&p, b"three\nfour\n");
        let r2 = tail_from(&p, r1.new_offset).unwrap();
        assert_eq!(r2.lines, vec!["three", "four"]);
    }

    #[test]
    fn tail_offset_at_eof_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        write(&p, b"one\n");
        let len = std::fs::metadata(&p).unwrap().len();
        let r = tail_from(&p, len).unwrap();
        assert!(r.lines.is_empty());
        assert_eq!(r.new_offset, len);
    }

    #[test]
    fn tail_offset_past_eof_is_clamped_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        write(&p, b"one\n");
        let r = tail_from(&p, 9999).unwrap();
        assert!(r.lines.is_empty());
        assert_eq!(r.new_offset, r.file_len, "offset clamps to len");
    }

    #[test]
    fn tail_partial_trailing_line_appears_once_when_completed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jsonl");
        write(&p, b"one\n{\"half\":");
        let r1 = tail_from(&p, 0).unwrap();
        assert_eq!(r1.lines, vec!["one"], "partial line not yet returned");
        append(&p, b"true}\n");
        let r2 = tail_from(&p, r1.new_offset).unwrap();
        assert_eq!(r2.lines, vec![r#"{"half":true}"#]);
    }

    #[test]
    fn tail_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nope.jsonl");
        assert!(tail_from(&p, 0).is_err());
    }
}
