// Client-side filtering over the in-memory events. Filtering toggles row
// visibility (the [hidden] attribute) — it never rebuilds rows and never drops
// events from the store, so clearing a filter instantly reveals full history.

import type { SeanceEvent, SentinelAction } from "../model/types";
import { hasBypass, verdictOf } from "../model/types";

export interface FilterState {
  verdict?: "deny" | "pass" | "loose"; // the top-level state chips
  tool?: string;
  action?: SentinelAction;
  categories?: string[]; // any-of; empty/undefined = all
  matchedRule?: string;
  bypassOnly: boolean;
  text: string; // free-text, case-insensitive substring
}

export function emptyFilter(): FilterState {
  return { bypassOnly: false, text: "" };
}

/** Compile a predicate once per filter change; reuse across all rows. */
export function compile(s: FilterState): (ev: SeanceEvent) => boolean {
  const needle = s.text.trim().toLowerCase();
  return (ev) => {
    const g = ev.ghost;
    const sen = ev.kind === "governing" ? ev.pre : ev.sentinel;

    if (s.verdict && verdictOf(ev) !== s.verdict) return false;
    if (s.bypassOnly && !hasBypass(ev)) return false;
    if (s.tool && (g?.tool ?? sen?.toolName) !== s.tool) return false;
    if (s.action && sen?.action !== s.action) return false;
    if (s.categories && s.categories.length && !s.categories.includes(g?.category ?? "")) {
      return false;
    }
    if (s.matchedRule && sen?.matchedRule !== s.matchedRule) return false;

    if (needle) {
      const post = ev.kind === "governing" ? ev.post : [];
      const hay = [
        g?.command,
        g?.roast,
        g?.tool,
        g?.category,
        sen?.reason,
        sen?.matchedRule,
        sen?.toolName,
        sen?.action,
        ...post.map((p) => p.reason),
        ...post.map((p) => p.matchedRule),
      ]
        .filter(Boolean)
        .join("")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };
}
