//! # seance-core
//!
//! The pure correctness core of **seance**, the read-only observability leg of
//! the sentinel/ghost agent-security stack. Everything here is platform-neutral
//! and I/O touches only `std::fs` reads, so the whole thing is unit-testable on
//! any machine — no Tauri, no webview, no file watcher.
//!
//! Pipeline:
//! 1. [`rotation::poll_ghost`] / [`rotation::poll_sentinel`] tail a log file
//!    incrementally from a byte offset, handling ghost's `events.jsonl.1`
//!    rotation and returning the new [`rotation::FileCursor`] to persist.
//! 2. [`records::parse_line`] turns each raw JSONL line into a typed record
//!    (a malformed line is a counted skip, never a panic).
//! 3. [`join::Correlator`] correlates ghost lines to sentinel pre lines by
//!    `call_id` and pre lines to post lines by `tool_use_id`, emitting the
//!    normalized [`model::SeanceEvent`] stream the webview renders.
//! 4. [`state::TailState`] persists per-file offsets across restarts, keyed on
//!    inode so a rotated-while-down file restarts instead of skipping data.
//!
//! The Tauri shell (`src-tauri`) is a thin wrapper that owns the `notify` file
//! watcher and the poll timer, and emits batches to the webview — it holds no
//! correlation logic of its own.

pub mod join;
pub mod model;
pub mod records;
pub mod rotation;
pub mod state;
pub mod tail;

pub use join::Correlator;
pub use model::{GoverningCall, LooseEvent, SeanceBatch, SeanceEvent};
pub use records::{parse_line, Record, Source};
pub use rotation::{poll_ghost, poll_sentinel, FileCursor};
pub use state::TailState;
