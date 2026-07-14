//! The normalized event model the backend emits to the webview.
//!
//! The frontend never sees raw ghost/sentinel lines — the [`crate::join`]
//! correlator turns them into a discriminated union: a [`GoverningCall`] (one
//! ghost line + one sentinel pre line + zero-or-more post lines, joined by
//! `call_id` and `tool_use_id`) or a [`LooseEvent`] (a line that can't be
//! joined — an older line lacking the id fields, or a partner not yet seen).
//!
//! serde is `camelCase` and the union is `#[serde(tag = "kind")]` so the JSON
//! matches the TypeScript interfaces in `src/model/types.ts` byte-for-byte.

use crate::records::{AuditEvent, CallRecord, ShadowProbe};
use serde::{Deserialize, Serialize};

/// Parse an RFC3339 timestamp (as sentinel writes) to epoch milliseconds.
/// Returns `None` on anything unparseable — the caller falls back to another
/// leg's time rather than failing.
pub fn rfc3339_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// The ghost leg of a call (from `~/.ghost/events.jsonl`). `command`, `roast`,
/// and shadow `mutation`/`decision` are UNTRUSTED — the frontend renders them
/// as text only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostLeg {
    pub ts_ms: u64,
    pub tool: String,
    pub command: String,
    pub decision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roast_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<ShadowReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
}

/// Shadow findings in the normalized (camelCase) shape. `ShadowProbe` is reused
/// from `records` because its field names (mutation/decision/bypass) are already
/// camelCase-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReport {
    pub probes: Vec<ShadowProbe>,
    pub bypass_found: bool,
}

/// The sentinel leg of a call (from `~/.sentinel/audit.jsonl`). `reason` and
/// `matchedRule` are UNTRUSTED text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentinelLeg {
    pub timestamp: String,
    pub tool_name: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_phase: Option<String>,
}

/// A fully or partially joined governing call: the hero of the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoverningCall {
    /// Stable row identity, frozen at creation (opaque to the frontend).
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Sort/display time (epoch ms): ghost time if known, else the pre line's
    /// parsed timestamp, else a post line's.
    pub ts_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ghost: Option<GhostLeg>,
    /// The `hook_phase == "pre"` sentinel line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre: Option<SentinelLeg>,
    /// Zero-or-more post lines. A DENIED call has NONE — PostToolUse does not
    /// fire on a deny (pinned against Claude Code 2.1.207). The frontend renders
    /// that as the expected state, never as missing data.
    pub post: Vec<SentinelLeg>,
}

/// A line that could not be joined to a governing call. Surfaced, never dropped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LooseEvent {
    pub key: String,
    pub ts_ms: i64,
    pub source: LooseSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ghost: Option<GhostLeg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sentinel: Option<SentinelLeg>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LooseSource {
    Ghost,
    Sentinel,
}

/// The discriminated union carried to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SeanceEvent {
    Governing(GoverningCall),
    Loose(LooseEvent),
}

impl SeanceEvent {
    /// The stable identity of this event (row key on the frontend).
    pub fn key(&self) -> &str {
        match self {
            SeanceEvent::Governing(g) => &g.key,
            SeanceEvent::Loose(l) => &l.key,
        }
    }
}

/// A batch of new/updated events plus keys the frontend should drop (when two
/// provisional governing calls merge, the absorbed key is removed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeanceBatch {
    pub events: Vec<SeanceEvent>,
    pub seq: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub dropped: Vec<String>,
}

impl From<CallRecord> for GhostLeg {
    fn from(c: CallRecord) -> Self {
        GhostLeg {
            ts_ms: c.ts_ms,
            tool: c.tool,
            command: c.command,
            decision: c.decision,
            category: c.category,
            roast: c.roast,
            roast_id: c.roast_id,
            shadow: c.shadow.map(|s| ShadowReport {
                probes: s.probes,
                bypass_found: s.bypass_found,
            }),
            call_id: c.call_id,
            tool_use_id: c.tool_use_id,
        }
    }
}

impl From<AuditEvent> for SentinelLeg {
    fn from(a: AuditEvent) -> Self {
        SentinelLeg {
            timestamp: a.timestamp,
            tool_name: a.tool_name,
            action: a.action,
            reason: a.reason,
            matched_rule: a.matched_rule,
            mode: a.mode,
            call_id: a.call_id,
            tool_use_id: a.tool_use_id,
            hook_phase: a.hook_phase,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_parses_sentinel_format() {
        // exactly what sentinel writes: chrono::Utc::now().to_rfc3339()
        let ms = rfc3339_to_ms("2026-07-14T00:08:46.331884789+00:00").unwrap();
        assert!(ms > 1_700_000_000_000);
    }

    #[test]
    fn rfc3339_bad_input_is_none() {
        assert!(rfc3339_to_ms("not a date").is_none());
        assert!(rfc3339_to_ms("").is_none());
    }

    #[test]
    fn governing_serializes_with_kind_tag_and_camelcase() {
        let ev = SeanceEvent::Governing(GoverningCall {
            key: "k1".into(),
            call_id: Some("c1".into()),
            tool_use_id: Some("t1".into()),
            ts_ms: 123,
            ghost: None,
            pre: None,
            post: vec![],
        });
        let j: serde_json::Value = serde_json::to_value(&ev).unwrap();
        assert_eq!(j["kind"], "governing");
        assert_eq!(j["callId"], "c1");
        assert_eq!(j["toolUseId"], "t1");
        assert_eq!(j["tsMs"], 123);
        assert_eq!(j["post"], serde_json::json!([]));
    }

    #[test]
    fn loose_serializes_with_source() {
        let ev = SeanceEvent::Loose(LooseEvent {
            key: "l1".into(),
            ts_ms: 5,
            source: LooseSource::Ghost,
            ghost: None,
            sentinel: None,
        });
        let j: serde_json::Value = serde_json::to_value(&ev).unwrap();
        assert_eq!(j["kind"], "loose");
        assert_eq!(j["source"], "ghost");
    }

    #[test]
    fn shadow_report_serializes_bypass_found_camelcase() {
        let leg = GhostLeg::from(CallRecord {
            ts_ms: 1,
            tool: "Bash".into(),
            command: "x".into(),
            decision: "deny".into(),
            category: None,
            roast: None,
            roast_id: None,
            shadow: Some(crate::records::ShadowReport {
                probes: vec![],
                bypass_found: true,
            }),
            call_id: None,
            tool_use_id: None,
        });
        let j = serde_json::to_value(&leg).unwrap();
        assert_eq!(j["shadow"]["bypassFound"], true);
    }
}
