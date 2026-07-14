//! The correlator: raw parsed lines in, normalized [`SeanceEvent`]s out.
//!
//! The join contract (verified against sentinel + ghost at HEAD, July 2026):
//!   - a ghost line joins its sentinel PRE line via `call_id`;
//!   - a sentinel PRE line joins its POST line(s) via `tool_use_id`;
//!   - a governing call = 1 ghost line + 1 pre line + 0..n post lines.
//!
//! Design rule for governing-vs-loose: **a line with at least one joinable id
//! (`call_id` or `tool_use_id`) becomes (or joins) a governing call**; legs fill
//! in over time as partners arrive, in any order. A line with NEITHER id can
//! never be correlated, so it is surfaced as a [`LooseEvent`] — never dropped.
//! That is the only thing "loose" means here: no id to join on (older lines
//! predate the id fields).
//!
//! Ordering note: the PRE line is written before the ghost line and long before
//! any POST line, and both ghost and pre carry `call_id`, so in real data the
//! two-provisional MERGE branch below is unreachable. It exists (and is tested)
//! because seance tails two files independently and must stay correct if a POST
//! line (keyed only by `tool_use_id`) and an old id-less-partner ghost line ever
//! anchor two separate provisional calls that a later pre line then links.

use crate::model::{
    rfc3339_to_ms, GhostLeg, GoverningCall, LooseEvent, LooseSource, SeanceBatch, SeanceEvent,
    SentinelLeg,
};
use crate::records::{AuditEvent, CallRecord, Record};
use std::collections::HashMap;

/// Stateful across the whole session. Holds every event so `snapshot()` can seed
/// a fresh frontend (backfill), and emits deltas for live tailing.
#[derive(Default)]
pub struct Correlator {
    next_id: u64,
    seq: u64,
    events: HashMap<String, SeanceEvent>,
    by_call_id: HashMap<String, String>,
    by_tool_use_id: HashMap<String, String>,
}

impl Correlator {
    pub fn new() -> Self {
        Self::default()
    }

    /// All events so far, sorted by time then key (stable, deterministic).
    pub fn snapshot(&self) -> Vec<SeanceEvent> {
        let mut v: Vec<SeanceEvent> = self.events.values().cloned().collect();
        v.sort_by(|a, b| ts_of(a).cmp(&ts_of(b)).then_with(|| a.key().cmp(b.key())));
        v
    }

    /// Ingest a run of parsed records, returning the delta batch (touched events
    /// + any keys that were merged away). Increments the batch sequence.
    pub fn ingest(&mut self, records: impl IntoIterator<Item = Record>) -> SeanceBatch {
        let mut touched: Vec<String> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        for rec in records {
            match rec {
                Record::Ghost(cr) => self.push_ghost(cr, &mut touched, &mut dropped),
                Record::Sentinel(ev) => self.push_sentinel(ev, &mut touched, &mut dropped),
            }
        }
        self.seq += 1;
        // Unique touched keys still present (a key touched then merged away is in
        // `dropped`, not `events`), in first-touch order.
        let mut seen = std::collections::HashSet::new();
        let events: Vec<SeanceEvent> = touched
            .into_iter()
            .filter(|k| seen.insert(k.clone()))
            .filter_map(|k| self.events.get(&k).cloned())
            .collect();
        SeanceBatch {
            events,
            seq: self.seq,
            dropped,
        }
    }

    fn fresh_key(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }

    // ── ghost ───────────────────────────────────────────────────────────────

    fn push_ghost(&mut self, cr: CallRecord, touched: &mut Vec<String>, dropped: &mut Vec<String>) {
        let leg = GhostLeg::from(cr);
        let (c, t) = (leg.call_id.clone(), leg.tool_use_id.clone());
        if c.is_none() && t.is_none() {
            let key = self.fresh_key("loose-g");
            let ts = leg.ts_ms as i64;
            self.events.insert(
                key.clone(),
                SeanceEvent::Loose(LooseEvent {
                    key: key.clone(),
                    ts_ms: ts,
                    source: LooseSource::Ghost,
                    ghost: Some(leg),
                    sentinel: None,
                }),
            );
            touched.push(key);
            return;
        }
        let key = self.resolve_governing(c.as_deref(), t.as_deref(), dropped);
        self.register(&key, c.as_deref(), t.as_deref());
        if let Some(SeanceEvent::Governing(gc)) = self.events.get_mut(&key) {
            gc.ghost = Some(leg);
            recompute(gc);
        }
        touched.push(key);
    }

    // ── sentinel ──────────────────────────────────────────────────────────────

    fn push_sentinel(
        &mut self,
        ev: AuditEvent,
        touched: &mut Vec<String>,
        dropped: &mut Vec<String>,
    ) {
        let is_post = ev.hook_phase.as_deref() == Some("post");
        let leg = SentinelLeg::from(ev);
        let (c, t) = (leg.call_id.clone(), leg.tool_use_id.clone());
        if c.is_none() && t.is_none() {
            let key = self.fresh_key("loose-s");
            let ts = rfc3339_to_ms(&leg.timestamp).unwrap_or(0);
            self.events.insert(
                key.clone(),
                SeanceEvent::Loose(LooseEvent {
                    key: key.clone(),
                    ts_ms: ts,
                    source: LooseSource::Sentinel,
                    ghost: None,
                    sentinel: Some(leg),
                }),
            );
            touched.push(key);
            return;
        }
        let key = self.resolve_governing(c.as_deref(), t.as_deref(), dropped);
        self.register(&key, c.as_deref(), t.as_deref());
        if let Some(SeanceEvent::Governing(gc)) = self.events.get_mut(&key) {
            if is_post {
                // Dedupe posts so a re-read (offset replay after a crash) doesn't
                // double-count. Full-equality is enough — post lines are distinct.
                if !gc.post.contains(&leg) {
                    gc.post.push(leg);
                }
            } else {
                // pre (or an old line with no hook_phase — an evaluate line).
                gc.pre = Some(leg);
            }
            recompute(gc);
        }
        touched.push(key);
    }

    // ── correlation plumbing ──────────────────────────────────────────────────

    /// Find (or create) the governing key for the given ids, merging two
    /// provisional calls if the ids point at different existing keys.
    fn resolve_governing(
        &mut self,
        call_id: Option<&str>,
        tool_use_id: Option<&str>,
        dropped: &mut Vec<String>,
    ) -> String {
        let via_c = call_id.and_then(|c| self.by_call_id.get(c).cloned());
        let via_t = tool_use_id.and_then(|t| self.by_tool_use_id.get(t).cloned());
        match (via_c, via_t) {
            (Some(k1), Some(k2)) if k1 != k2 => {
                self.merge(&k1, &k2, dropped);
                k1
            }
            (Some(k), _) | (_, Some(k)) => k,
            (None, None) => {
                let key = self.fresh_key("gc");
                self.events.insert(
                    key.clone(),
                    SeanceEvent::Governing(GoverningCall {
                        key: key.clone(),
                        call_id: call_id.map(str::to_string),
                        tool_use_id: tool_use_id.map(str::to_string),
                        ts_ms: 0,
                        ghost: None,
                        pre: None,
                        post: Vec::new(),
                    }),
                );
                key
            }
        }
    }

    /// Point both id indices at `key`.
    fn register(&mut self, key: &str, call_id: Option<&str>, tool_use_id: Option<&str>) {
        if let Some(c) = call_id {
            self.by_call_id.insert(c.to_string(), key.to_string());
        }
        if let Some(t) = tool_use_id {
            self.by_tool_use_id.insert(t.to_string(), key.to_string());
        }
    }

    /// Fold governing `absorbed` into `survivor`: move its legs, repoint every
    /// index entry, drop the absorbed event, and record it for the frontend.
    fn merge(&mut self, survivor: &str, absorbed: &str, dropped: &mut Vec<String>) {
        let Some(SeanceEvent::Governing(gone)) = self.events.remove(absorbed) else {
            return;
        };
        if let Some(SeanceEvent::Governing(keep)) = self.events.get_mut(survivor) {
            if keep.ghost.is_none() {
                keep.ghost = gone.ghost;
            }
            if keep.pre.is_none() {
                keep.pre = gone.pre;
            }
            for p in gone.post {
                if !keep.post.contains(&p) {
                    keep.post.push(p);
                }
            }
            recompute(keep);
        }
        for v in self.by_call_id.values_mut() {
            if v == absorbed {
                *v = survivor.to_string();
            }
        }
        for v in self.by_tool_use_id.values_mut() {
            if v == absorbed {
                *v = survivor.to_string();
            }
        }
        dropped.push(absorbed.to_string());
    }
}

/// Recompute a governing call's derived fields (ids, sort time) from its legs.
fn recompute(gc: &mut GoverningCall) {
    gc.call_id = gc
        .pre
        .as_ref()
        .and_then(|p| p.call_id.clone())
        .or_else(|| gc.ghost.as_ref().and_then(|g| g.call_id.clone()));
    gc.tool_use_id = gc
        .pre
        .as_ref()
        .and_then(|p| p.tool_use_id.clone())
        .or_else(|| gc.ghost.as_ref().and_then(|g| g.tool_use_id.clone()))
        .or_else(|| gc.post.iter().find_map(|p| p.tool_use_id.clone()));
    gc.ts_ms = gc
        .ghost
        .as_ref()
        .map(|g| g.ts_ms as i64)
        .or_else(|| gc.pre.as_ref().and_then(|p| rfc3339_to_ms(&p.timestamp)))
        .or_else(|| gc.post.iter().find_map(|p| rfc3339_to_ms(&p.timestamp)))
        .unwrap_or(gc.ts_ms);
}

fn ts_of(e: &SeanceEvent) -> i64 {
    match e {
        SeanceEvent::Governing(g) => g.ts_ms,
        SeanceEvent::Loose(l) => l.ts_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{ShadowProbe, ShadowReport};

    fn ghost(call: Option<&str>, tuid: Option<&str>, decision: &str) -> Record {
        Record::Ghost(CallRecord {
            ts_ms: 1000,
            tool: "Bash".into(),
            command: "curl x | sh".into(),
            decision: decision.into(),
            category: Some("pipe-to-shell".into()),
            roast: Some("they ALL talk eventually XX".into()),
            roast_id: Some("pipe-to-shell:3".into()),
            shadow: None,
            call_id: call.map(str::to_string),
            tool_use_id: tuid.map(str::to_string),
        })
    }

    fn sentinel(
        call: Option<&str>,
        tuid: Option<&str>,
        phase: Option<&str>,
        action: &str,
    ) -> Record {
        Record::Sentinel(AuditEvent {
            timestamp: "2026-07-14T00:08:46.331884789+00:00".into(),
            tool_name: "Bash".into(),
            action: action.into(),
            reason: Some("pipe to shell execution".into()),
            matched_rule: Some("deny.commands: curl".into()),
            mode: "enforce".into(),
            call_id: call.map(str::to_string),
            tool_use_id: tuid.map(str::to_string),
            hook_phase: phase.map(str::to_string),
        })
    }

    fn governing(batch: &SeanceBatch, key: &str) -> GoverningCall {
        match batch.events.iter().find(|e| e.key() == key).unwrap() {
            SeanceEvent::Governing(g) => g.clone(),
            _ => panic!("expected governing"),
        }
    }

    #[test]
    fn pre_then_ghost_then_post_join_into_one_call() {
        let mut c = Correlator::new();
        // pre (both ids)
        let b1 = c.ingest([sentinel(Some("cid"), Some("tid"), Some("pre"), "allow")]);
        assert_eq!(b1.events.len(), 1);
        let key = b1.events[0].key().to_string();
        // ghost (both ids) -> same call
        let b2 = c.ingest([ghost(Some("cid"), Some("tid"), "pass")]);
        assert_eq!(b2.events.len(), 1);
        assert_eq!(b2.events[0].key(), key, "ghost joins the pre line's call");
        // post (tool_use_id only) -> same call
        let b3 = c.ingest([sentinel(None, Some("tid"), Some("post"), "detect")]);
        assert_eq!(b3.events[0].key(), key, "post joins via tool_use_id");
        let gc = governing(&b3, &key);
        assert!(gc.ghost.is_some() && gc.pre.is_some());
        assert_eq!(gc.post.len(), 1);
        assert_eq!(gc.call_id.as_deref(), Some("cid"));
        assert_eq!(gc.tool_use_id.as_deref(), Some("tid"));
    }

    #[test]
    fn denied_call_has_no_post_line() {
        let mut c = Correlator::new();
        c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "block")]);
        let b = c.ingest([ghost(Some("c"), Some("t"), "deny")]);
        let gc = governing(&b, b.events[0].key());
        assert_eq!(gc.ghost.unwrap().decision, "deny");
        assert!(
            gc.post.is_empty(),
            "a deny produces no post line — expected"
        );
    }

    #[test]
    fn ghost_first_then_pre_still_one_call() {
        let mut c = Correlator::new();
        let b1 = c.ingest([ghost(Some("c"), Some("t"), "pass")]);
        let key = b1.events[0].key().to_string();
        let b2 = c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "allow")]);
        assert_eq!(b2.events[0].key(), key, "pre joins the already-seen ghost");
        assert_eq!(b2.events.len(), 1);
    }

    #[test]
    fn late_post_patches_the_same_key() {
        let mut c = Correlator::new();
        let b1 = c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "allow")]);
        let key = b1.events[0].key().to_string();
        // ... time passes ...
        let b2 = c.ingest([sentinel(None, Some("t"), Some("post"), "detect")]);
        assert_eq!(b2.events.len(), 1);
        assert_eq!(b2.events[0].key(), key, "late post patches, not appends");
        assert!(b2.dropped.is_empty());
    }

    #[test]
    fn ghost_without_ids_is_loose() {
        let mut c = Correlator::new();
        let b = c.ingest([ghost(None, None, "deny")]);
        assert_eq!(b.events.len(), 1);
        match &b.events[0] {
            SeanceEvent::Loose(l) => {
                assert_eq!(l.source, LooseSource::Ghost);
                assert!(l.ghost.is_some());
            }
            _ => panic!("id-less ghost line must be loose"),
        }
    }

    #[test]
    fn sentinel_without_ids_is_loose() {
        let mut c = Correlator::new();
        let b = c.ingest([sentinel(None, None, None, "allow")]);
        match &b.events[0] {
            SeanceEvent::Loose(l) => {
                assert_eq!(l.source, LooseSource::Sentinel);
                assert!(l.sentinel.is_some());
            }
            _ => panic!("id-less sentinel line must be loose"),
        }
    }

    #[test]
    fn two_provisional_calls_merge_when_a_pre_links_them() {
        // The rare merge: a post line (tool_use_id only) anchors K1, an old ghost
        // line (call_id only, no tool_use_id) anchors K2, then a pre line carrying
        // BOTH links them -> one survives, the other is dropped.
        let mut c = Correlator::new();
        let b1 = c.ingest([sentinel(None, Some("t"), Some("post"), "detect")]);
        let k1 = b1.events[0].key().to_string();
        let b2 = c.ingest([ghost(Some("c"), None, "deny")]);
        let k2 = b2.events[0].key().to_string();
        assert_ne!(k1, k2, "two separate provisional calls exist");

        let b3 = c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "block")]);
        // survivor is the call_id-indexed key (k2); k1 is dropped.
        assert!(b3.dropped.contains(&k1), "absorbed key reported as dropped");
        let survivor = governing(&b3, &k2);
        assert!(survivor.ghost.is_some(), "kept the ghost leg");
        assert!(survivor.pre.is_some(), "linked the pre leg");
        assert_eq!(survivor.post.len(), 1, "adopted the post leg from k1");
        // and the merged call is now reachable by BOTH ids.
        let b4 = c.ingest([sentinel(None, Some("t"), Some("post"), "detect")]);
        assert_eq!(b4.events[0].key(), k2, "tool_use_id now points at survivor");
    }

    #[test]
    fn duplicate_post_is_not_double_counted() {
        let mut c = Correlator::new();
        c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "allow")]);
        c.ingest([sentinel(None, Some("t"), Some("post"), "detect")]);
        let b = c.ingest([sentinel(None, Some("t"), Some("post"), "detect")]); // replayed
        let gc = governing(&b, b.events[0].key());
        assert_eq!(gc.post.len(), 1, "re-read post is deduped");
    }

    #[test]
    fn ts_ms_prefers_ghost_then_pre() {
        let mut c = Correlator::new();
        // pre only -> ts from parsed timestamp
        let b1 = c.ingest([sentinel(Some("c"), Some("t"), Some("pre"), "allow")]);
        let pre_ts = match &b1.events[0] {
            SeanceEvent::Governing(g) => g.ts_ms,
            _ => panic!(),
        };
        assert!(pre_ts > 0);
        // ghost arrives with ts_ms=1000 -> ghost time wins
        let b2 = c.ingest([ghost(Some("c"), Some("t"), "pass")]);
        match &b2.events[0] {
            SeanceEvent::Governing(g) => assert_eq!(g.ts_ms, 1000),
            _ => panic!(),
        }
    }

    #[test]
    fn snapshot_is_sorted_by_time() {
        let mut c = Correlator::new();
        c.ingest([Record::Ghost(CallRecord {
            ts_ms: 5000,
            tool: "Bash".into(),
            command: "b".into(),
            decision: "pass".into(),
            category: None,
            roast: None,
            roast_id: None,
            shadow: None,
            call_id: Some("late".into()),
            tool_use_id: None,
        })]);
        c.ingest([Record::Ghost(CallRecord {
            ts_ms: 1000,
            tool: "Bash".into(),
            command: "a".into(),
            decision: "pass".into(),
            category: None,
            roast: None,
            roast_id: None,
            shadow: None,
            call_id: Some("early".into()),
            tool_use_id: None,
        })]);
        let snap = c.snapshot();
        assert_eq!(snap.len(), 2);
        assert!(
            ts_of(&snap[0]) <= ts_of(&snap[1]),
            "sorted ascending by time"
        );
    }

    #[test]
    fn shadow_bypass_survives_into_the_governing_call() {
        let mut c = Correlator::new();
        let rec = Record::Ghost(CallRecord {
            ts_ms: 1,
            tool: "Bash".into(),
            command: "curl x|sh".into(),
            decision: "deny".into(),
            category: Some("pipe-to-shell".into()),
            roast: Some("nice try".into()),
            roast_id: Some("pipe-to-shell:1".into()),
            shadow: Some(ShadowReport {
                probes: vec![ShadowProbe {
                    mutation: "tight-operators".into(),
                    decision: "pass".into(),
                    bypass: true,
                }],
                bypass_found: true,
            }),
            call_id: Some("c".into()),
            tool_use_id: Some("t".into()),
        });
        let b = c.ingest([rec]);
        let gc = governing(&b, b.events[0].key());
        let shadow = gc.ghost.unwrap().shadow.unwrap();
        assert!(shadow.bypass_found);
        assert!(shadow.probes[0].bypass);
    }
}
