// Timeline filter state + a compiled predicate over the flat event shape.
// Filtering runs on DATA (a linear pass producing a filtered array the window
// renders from) — never by toggling visibility on live DOM nodes, which was the
// old design's sluggishness. Search matches command/roast/tool/rule/reason/cat.
// "bypass" is a verdict-slot shortcut for "a shadow probe evaded sentinel";
// "loose" filters on joined-ness. Categories are any-of (multi-select).

import type { FlatEvent } from "../model/view";

export type VerdictFilter = "deny" | "pass" | "loose" | "bypass" | null;

export interface FilterState {
  verdict: VerdictFilter;
  cats: string[];
  tool: string;
  text: string;
}

export function emptyFilter(): FilterState {
  return { verdict: null, cats: [], tool: "", text: "" };
}

export function isEmptyFilter(f: FilterState): boolean {
  return f.verdict === null && f.cats.length === 0 && f.tool === "" && f.text.trim() === "";
}

/** Compile a predicate once per filter change; reuse it across the linear scan. */
export function compile(f: FilterState): (e: FlatEvent) => boolean {
  const needle = f.text.trim().toLowerCase();
  return (e) => {
    if (f.verdict === "bypass") {
      if (!e.bypass) return false;
    } else if (f.verdict === "loose") {
      // joined-ness, not the decision: a loose deny must still match "loose"
      // (and "deny" below), so key off the flag rather than e.verdict.
      if (!e.loose) return false;
    } else if (f.verdict && e.verdict !== f.verdict) {
      return false;
    }
    if (f.cats.length && !f.cats.includes(e.cat)) return false;
    if (f.tool && e.tool !== f.tool) return false;
    if (needle) {
      const hay = (
        e.command +
        " " +
        (e.roast ?? "") +
        " " +
        e.tool +
        " " +
        (e.rule ?? "") +
        " " +
        (e.reason ?? "") +
        " " +
        e.cat
      ).toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };
}
