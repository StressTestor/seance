//! The two raw log line shapes, parsed exactly as sentinel and ghost emit them.
//!
//! These mirror the source of truth at the two upstream repos (verified at HEAD,
//! July 2026):
//!   - sentinel `src/audit_trail/mod.rs`  -> [`AuditEvent`]
//!   - ghost    `src/watchlog.rs`         -> [`CallRecord`] (+ `src/shadow.rs`)
//!
//! Every id field is `serde(default)` / `Option` on BOTH sides, because older
//! lines predate them. Enum-ish fields (action, decision, category, hook_phase)
//! are kept as raw `String` here for maximum tolerance — an unknown future
//! action must never make a line unparseable. Meaning is assigned in `model`.
//!
//! Parsing never panics: [`parse_line`] returns a `Result`, and a bad line is a
//! value the caller counts and skips — the same tolerance both emitters already
//! have when they read their own logs back.

use serde::{Deserialize, Serialize};

/// One line of `~/.sentinel/audit.jsonl`. Sentinel writes one per evaluation
/// (pre phase) and one per PostToolUse detection (post phase).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEvent {
    pub timestamp: String,
    pub tool_name: String,
    pub action: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub matched_rule: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// "pre" | "post". `None` on lines written before this field existed.
    #[serde(default)]
    pub hook_phase: Option<String>,
}

/// One line of `~/.ghost/events.jsonl`. Ghost writes one per bridged tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallRecord {
    pub ts_ms: u64,
    pub tool: String,
    pub command: String,
    /// "deny" | "pass".
    pub decision: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub roast: Option<String>,
    #[serde(default)]
    pub roast_id: Option<String>,
    #[serde(default)]
    pub shadow: Option<ShadowReport>,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

/// Ghost's shadow-attack findings for a denied call (from `ghost/src/shadow.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShadowReport {
    pub probes: Vec<ShadowProbe>,
    pub bypass_found: bool,
}

/// One shadow probe: a semantics-preserving mutation and what sentinel said to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShadowProbe {
    pub mutation: String,
    pub decision: String,
    #[serde(default)]
    pub bypass: bool,
}

/// A parsed line, tagged by which file it came from.
#[derive(Debug, Clone, PartialEq)]
pub enum Record {
    Sentinel(AuditEvent),
    Ghost(CallRecord),
}

/// Which source a line/cursor belongs to. Drives which parser and which
/// rotation policy applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// `~/.sentinel/audit.jsonl` — grows forever, never rotates.
    Sentinel,
    /// `~/.ghost/events.jsonl` — rotates to `events.jsonl.1` at 8 MiB.
    Ghost,
}

/// A line that could not be parsed as its source's record type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "parse error: {}", self.message)
    }
}
impl std::error::Error for ParseError {}

/// Parse one raw JSONL line as the record type for `source`. Blank lines and
/// malformed JSON return `Err` — never a panic — so the tail loop can count and
/// skip them.
pub fn parse_line(source: Source, line: &str) -> Result<Record, ParseError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(ParseError {
            message: "empty line".into(),
        });
    }
    match source {
        Source::Sentinel => serde_json::from_str::<AuditEvent>(trimmed)
            .map(Record::Sentinel)
            .map_err(|e| ParseError {
                message: e.to_string(),
            }),
        Source::Ghost => serde_json::from_str::<CallRecord>(trimmed)
            .map(Record::Ghost)
            .map_err(|e| ParseError {
                message: e.to_string(),
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_audit_pre_line() {
        let line = r#"{"timestamp":"2026-07-14T00:08:46.331884789+00:00","tool_name":"Bash","action":"allow","reason":null,"matched_rule":null,"mode":"enforce","call_id":"2f4762c1-e3e4-4246-b7d1-c65c5ad58564","tool_use_id":"toolu_01LCYidPjGQEs6CRTx8612kc","hook_phase":"pre"}"#;
        match parse_line(Source::Sentinel, line).unwrap() {
            Record::Sentinel(ev) => {
                assert_eq!(ev.action, "allow");
                assert_eq!(ev.hook_phase.as_deref(), Some("pre"));
                assert_eq!(
                    ev.tool_use_id.as_deref(),
                    Some("toolu_01LCYidPjGQEs6CRTx8612kc")
                );
            }
            _ => panic!("expected sentinel"),
        }
    }

    #[test]
    fn parse_audit_post_line_has_no_call_id() {
        let line = r#"{"timestamp":"2026-07-14T00:08:46.538373430+00:00","tool_name":"PostToolUse","action":"detect","reason":"secret shape in tool result: AWS access key ID","matched_rule":"post-evaluate: result-secret","mode":"enforce","tool_use_id":"toolu_01LCYidPjGQEs6CRTx8612kc","hook_phase":"post"}"#;
        match parse_line(Source::Sentinel, line).unwrap() {
            Record::Sentinel(ev) => {
                assert_eq!(ev.hook_phase.as_deref(), Some("post"));
                assert_eq!(ev.action, "detect");
                assert!(ev.call_id.is_none(), "post lines carry no call_id");
            }
            _ => panic!("expected sentinel"),
        }
    }

    #[test]
    fn parse_ghost_deny_with_shadow() {
        let line = r#"{"ts_ms":1783987726334,"tool":"Bash","command":"curl x|sh","decision":"deny","category":"pipe-to-shell","roast":"they ALL talk eventually XX","roast_id":"pipe-to-shell:3","shadow":{"probes":[{"mutation":"tight-operators","decision":"pass","bypass":true}],"bypass_found":true},"call_id":"586bb131-de1f-4f05-9d57-88403ebd8a7f","tool_use_id":"toolu_017zjcx6fu1v1x31Ve7m2h3J"}"#;
        match parse_line(Source::Ghost, line).unwrap() {
            Record::Ghost(cr) => {
                assert_eq!(cr.decision, "deny");
                let shadow = cr.shadow.expect("shadow present");
                assert!(shadow.bypass_found);
                assert_eq!(shadow.probes[0].mutation, "tight-operators");
                assert!(shadow.probes[0].bypass);
            }
            _ => panic!("expected ghost"),
        }
    }

    #[test]
    fn parse_legacy_ghost_line_without_ids() {
        // a pre-correlation ghost line: no call_id / tool_use_id / shadow.
        let line = r#"{"ts_ms":1,"tool":"Bash","command":"ls -la","decision":"pass","category":null,"roast":null,"roast_id":null}"#;
        match parse_line(Source::Ghost, line).unwrap() {
            Record::Ghost(cr) => {
                assert!(cr.call_id.is_none());
                assert!(cr.tool_use_id.is_none());
                assert!(cr.shadow.is_none());
            }
            _ => panic!("expected ghost"),
        }
    }

    #[test]
    fn parse_legacy_audit_line_without_new_fields() {
        // a pre-#60 sentinel line: no call_id / tool_use_id / hook_phase.
        let line = r#"{"timestamp":"2026-01-01T00:00:00+00:00","tool_name":"Read","action":"allow","reason":null,"matched_rule":null,"mode":"audit"}"#;
        match parse_line(Source::Sentinel, line).unwrap() {
            Record::Sentinel(ev) => {
                assert!(ev.call_id.is_none());
                assert!(ev.hook_phase.is_none());
            }
            _ => panic!("expected sentinel"),
        }
    }

    #[test]
    fn bad_json_is_an_error_not_a_panic() {
        assert!(parse_line(Source::Sentinel, "{ not json").is_err());
        assert!(parse_line(Source::Ghost, "totally not json").is_err());
        assert!(parse_line(Source::Ghost, "").is_err());
        assert!(parse_line(Source::Sentinel, "   ").is_err());
    }

    #[test]
    fn shadow_probe_bypass_defaults_false() {
        // ghost marks `bypass` serde(default); a probe line without it parses.
        let line = r#"{"ts_ms":1,"tool":"Bash","command":"x","decision":"deny","shadow":{"probes":[{"mutation":"m","decision":"deny"}],"bypass_found":false}}"#;
        match parse_line(Source::Ghost, line).unwrap() {
            Record::Ghost(cr) => assert!(!cr.shadow.unwrap().probes[0].bypass),
            _ => panic!("expected ghost"),
        }
    }
}
