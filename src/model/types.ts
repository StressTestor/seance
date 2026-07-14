// The normalized wire contract. Mirrors the Rust `seance-core::model` serde
// output byte-for-byte (camelCase fields, `kind`-tagged union). Pure types.
//
// Fields marked UNTRUSTED carry agent-authored text (commands, output, roasts)
// and MUST only ever be rendered via textContent — never innerHTML. See dom.ts.

export type SentinelAction = "allow" | "warn" | "block" | "detect" | string;
export type HookPhase = "pre" | "post";
export type GhostDecision = "deny" | "pass" | string;
export type GhostCategory =
  | "cred-access"
  | "pipe-to-shell"
  | "destructive"
  | "persistence"
  | "network-exfil"
  | "unknown"
  | string;

export interface ShadowProbe {
  mutation: string; // UNTRUSTED
  decision: string; // UNTRUSTED
  bypass: boolean;
}

export interface ShadowReport {
  probes: ShadowProbe[];
  bypassFound: boolean;
}

export interface GhostLeg {
  tsMs: number;
  tool: string;
  command: string; // UNTRUSTED
  decision: GhostDecision;
  category?: GhostCategory;
  roast?: string; // UNTRUSTED
  roastId?: string;
  shadow?: ShadowReport;
  callId?: string;
  toolUseId?: string;
}

export interface SentinelLeg {
  timestamp: string;
  toolName: string;
  action: SentinelAction;
  reason?: string; // UNTRUSTED
  matchedRule?: string; // UNTRUSTED
  mode: string;
  callId?: string;
  toolUseId?: string;
  hookPhase?: HookPhase;
}

export interface GoverningCall {
  kind: "governing";
  key: string;
  callId?: string;
  toolUseId?: string;
  tsMs: number;
  ghost?: GhostLeg;
  pre?: SentinelLeg;
  post: SentinelLeg[]; // denied calls => [] (expected, not missing)
}

export interface LooseEvent {
  kind: "loose";
  key: string;
  tsMs: number;
  source: "ghost" | "sentinel";
  ghost?: GhostLeg;
  sentinel?: SentinelLeg;
}

export type SeanceEvent = GoverningCall | LooseEvent;

export interface SeanceBatch {
  events: SeanceEvent[];
  seq: number;
  dropped?: string[]; // keys the frontend should remove (merge absorbed them)
}

/** The verdict a row displays, derived from whichever legs are present. */
export type Verdict = "deny" | "pass" | "loose";

export function verdictOf(ev: SeanceEvent): Verdict {
  // The security decision (deny vs pass) read from whichever leg carries it.
  // This is ORTHOGONAL to whether the event could be joined: a loose (unjoined)
  // event still has a real decision on its ghost/sentinel leg and must report it
  // — otherwise, on an install whose sentinel/ghost predate the id fields, every
  // denial correlates to nothing and silently reads as neither deny nor pass
  // (the denied counter stuck at 0 while the log is full of blocks). Joined-ness
  // is a separate axis, tracked via ev.kind === "loose" at the render layer.
  const g = ev.ghost?.decision;
  if (g === "deny") return "deny";
  if (g === "pass") return "pass";
  // No ghost leg: fall back to the sentinel leg's action (pre for a governing
  // call, the lone sentinel leg for a loose one).
  const a = ev.kind === "governing" ? ev.pre?.action : ev.sentinel?.action;
  if (a === "block") return "deny";
  if (a) return "pass"; // allow / warn / detect — evaluated, not blocked
  return "loose"; // no decision-bearing leg at all (a degenerate/empty call)
}

/** Whether a shadow bypass was found on this event (the alarm state). Shadow
 * findings live on the ghost leg regardless of the event kind. */
export function hasBypass(ev: SeanceEvent): boolean {
  return !!ev.ghost?.shadow?.bypassFound;
}
