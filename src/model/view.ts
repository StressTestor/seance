// The flat view-model. séance's wire model is a nested tagged union
// (GoverningCall = ghost + pre + post legs, or LooseEvent), but every render
// surface — the virtualized row, the dashboard, the presence — wants one flat
// shape it can read without re-deriving verdicts and digging through legs.
// flatView() is that single seam: nested SeanceEvent in, flat FlatEvent out.
//
// UNTRUSTED fields (command, roast, rule, reason, and the probe strings reached
// through `shadow`) carry agent-authored text and MUST only ever reach the DOM
// via textContent (see render/dom.ts). This module only *reads* them.

import type { SeanceEvent, SentinelLeg, ShadowReport, Verdict } from "./types";
import { hasBypass, verdictOf } from "./types";

export interface FlatEvent {
  key: string;
  tsMs: number;
  // deny | pass read from the ghost/sentinel leg, joined or not; "loose" here only
  // means no decision-bearing leg at all. Ask `loose` below whether it joined.
  verdict: Verdict;
  bypass: boolean; // a shadow probe evaded sentinel
  loose: boolean; // unjoined — no id to correlate (orthogonal to verdict)
  tool: string;
  command: string; // UNTRUSTED
  cat: string; // category, or "" — always a string so filters/aggregates are simple
  roast?: string; // UNTRUSTED — ghost's voice, only on a deny
  rule?: string; // UNTRUSTED — sentinel matched_rule
  reason?: string; // UNTRUSTED — sentinel reason
  callId?: string;
  toolUseId?: string;
  postLegs: SentinelLeg[]; // [] for a deny (expected) or a loose event
  shadow?: ShadowReport; // shadow red-team probes, when ghost ran them
}

/** Project a nested SeanceEvent onto the flat shape the render layer consumes. */
export function flatView(ev: SeanceEvent): FlatEvent {
  const g = ev.ghost;
  const sen = ev.kind === "governing" ? ev.pre : ev.sentinel;
  return {
    key: ev.key,
    tsMs: ev.tsMs,
    verdict: verdictOf(ev),
    bypass: hasBypass(ev),
    loose: ev.kind === "loose",
    tool: g?.tool ?? sen?.toolName ?? "unknown",
    command: g?.command ?? sen?.reason ?? "(no command)",
    cat: g?.category ?? "",
    roast: g?.roast,
    rule: sen?.matchedRule,
    reason: sen?.reason,
    callId: g?.callId ?? sen?.callId,
    toolUseId: g?.toolUseId ?? sen?.toolUseId,
    postLegs: ev.kind === "governing" ? ev.post : [],
    shadow: g?.shadow,
  };
}
