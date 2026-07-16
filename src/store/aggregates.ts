// Dashboard aggregates. A single pure O(n) pass over the store's flat feed,
// producing everything the Overview tab renders. NOT on the hot path: the caller
// runs this only while Overview is visible and throttles it (scroll re-windows
// the timeline, it never recomputes this). One linear pass over 100k events is a
// few ms — imperceptible at the throttled cadence — and it stays exact (the
// time-windowed buckets are relative to `now`, so recompute-on-read can't drift
// the way incrementally-maintained now-relative buckets would).

import type { FlatEvent } from "../model/view";

/** Fixed category order — the dashboard always shows all six. */
export const CATEGORIES = [
  "cred-access",
  "pipe-to-shell",
  "destructive",
  "persistence",
  "network-exfil",
  "unknown",
] as const;

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const N_BUCKETS = 48; // half-hour activity bars over 24h
const N_SPARK = 12; // sparkline buckets over 24h

export interface Bucket {
  d: number;
  p: number;
  b: number;
}

export interface Sparklines {
  deny: number[];
  roast: number[];
  byp: number[];
  loose: number[];
}

export interface DashboardModel {
  total: number;
  nDeny: number;
  nPass: number;
  nLoose: number;
  nByp: number;
  nRoast: number;
  joined: number;
  catCounts: Record<string, number>;
  tools: string[];
  buckets: Bucket[]; // length 48, oldest → now
  bucketMax: number;
  sparks: Sparklines; // each length 12
  denyRateNow: number; // 0..1 over the last hour
  denyRatePrev: number; // 0..1 over the hour before that
  mostWantedCmd: string; // most-denied command (UNTRUSTED)
  mostWantedN: number;
  denials: FlatEvent[]; // up to 2 most-recent denies that carry a roast, newest first
  latestBypass: FlatEvent | null;
  last: FlatEvent | null; // newest event overall (for the presence LAST line)
}

/** Compute the whole dashboard model in one pass. `now` is injected so the caller
 * owns the clock (keeps this pure/testable and avoids a forbidden Date.now here
 * for callers that need determinism). */
export function computeDashboard(flat: readonly (FlatEvent | null)[], now: number): DashboardModel {
  let nDeny = 0,
    nPass = 0,
    nLoose = 0,
    nByp = 0,
    nRoast = 0,
    joined = 0,
    total = 0;
  const catCounts: Record<string, number> = {};
  for (const c of CATEGORIES) catCounts[c] = 0;
  const tools = new Set<string>();
  const buckets: Bucket[] = Array.from({ length: N_BUCKETS }, () => ({ d: 0, p: 0, b: 0 }));
  const sparks: Sparklines = {
    deny: new Array(N_SPARK).fill(0),
    roast: new Array(N_SPARK).fill(0),
    byp: new Array(N_SPARK).fill(0),
    loose: new Array(N_SPARK).fill(0),
  };
  const denyByCmd = new Map<string, number>();
  let mostWantedCmd = "—",
    mostWantedN = 0;
  let dNow = 0,
    tNow = 0,
    dPrev = 0,
    tPrev = 0;
  const denials: FlatEvent[] = [];
  let latestBypass: FlatEvent | null = null;
  let last: FlatEvent | null = null;

  for (const e of flat) {
    if (!e) continue; // tombstone
    total++;
    last = e; // arrival order ⇒ the final one set is the newest
    tools.add(e.tool);
    if (e.loose) nLoose++;
    else joined++;
    if (e.verdict === "deny") nDeny++;
    else if (e.verdict === "pass") nPass++;
    if (e.roast) nRoast++;
    if (e.bypass) {
      nByp++;
      latestBypass = e;
    }
    if (e.cat) catCounts[e.cat] = (catCounts[e.cat] ?? 0) + 1;

    if (e.verdict === "deny") {
      const n = (denyByCmd.get(e.command) ?? 0) + 1;
      denyByCmd.set(e.command, n);
      if (n > mostWantedN) {
        mostWantedN = n;
        mostWantedCmd = e.command;
      }
      if (e.roast) {
        denials.push(e); // newest wins — keep only the last two, in newest-first order below
        if (denials.length > 2) denials.shift();
      }
    }

    const age = now - e.tsMs;
    if (age >= 0 && age < DAY_MS) {
      const b = buckets[N_BUCKETS - 1 - Math.floor(age / (DAY_MS / N_BUCKETS))];
      if (e.bypass) b.b++;
      else if (e.verdict === "deny") b.d++;
      else b.p++;
      const si = N_SPARK - 1 - Math.floor(age / (DAY_MS / N_SPARK));
      if (e.verdict === "deny") sparks.deny[si]++;
      if (e.roast) sparks.roast[si]++;
      if (e.bypass) sparks.byp[si]++;
      if (e.loose) sparks.loose[si]++;
    }
    if (age >= 0 && age < HOUR_MS) {
      tNow++;
      if (e.verdict === "deny") dNow++;
    } else if (age >= HOUR_MS && age < 2 * HOUR_MS) {
      tPrev++;
      if (e.verdict === "deny") dPrev++;
    }
  }

  const bucketMax = Math.max(1, ...buckets.map((b) => b.d + b.p + b.b));
  denials.reverse(); // newest first

  return {
    total,
    nDeny,
    nPass,
    nLoose,
    nByp,
    nRoast,
    joined,
    catCounts,
    tools: [...tools].sort(),
    buckets,
    bucketMax,
    sparks,
    denyRateNow: tNow ? dNow / tNow : 0,
    denyRatePrev: tPrev ? dPrev / tPrev : 0,
    mostWantedCmd,
    mostWantedN,
    denials,
    latestBypass,
    last,
  };
}
