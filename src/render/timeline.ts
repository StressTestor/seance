// The timeline tab: a virtualized dense event log. The old design mounted every
// event as a live DOM row (~100k nodes, sluggish, memory-heavy); this keeps
// ~35 nodes regardless of event count. Fixed row (24px) + fixed drawer (224px)
// heights make windowing pure arithmetic — no measurement, no estimation:
//   first = floor(scrollTop / rowH), corrected by the drawer height when the
//   expanded row sits above the viewport, overscan on both edges, and two
//   spacer divs standing in for everything off-screen.
// Filtering runs on DATA (a linear pass over the store's flat feed producing a
// filtered array) — never by toggling visibility on live nodes.
//
// UNTRUSTED text (command, roast, rule, reason, probe mutation/decision) reaches
// the DOM only via txt()/textContent — the <pre> included. Computed color and
// borders go through setStyles(); structure/layout lives in timeline.css.

import "./timeline.css";
import { clear, el, frag, setStyles, txt } from "./dom";
import {
  CATEGORY_COLORS,
  EMBER,
  FAINT,
  HEX,
  INK,
  INK_DIM,
  SMOKE,
  SPECTRAL,
  TOXIC,
  catColor,
  verdictColor,
} from "./theme";
import { compile, emptyFilter, isEmptyFilter } from "../filter/filter";
import type { FilterState, VerdictFilter } from "../filter/filter";
import type { FlatEvent } from "../model/view";

const ROW_H = 24; // px — must stay in lockstep with --seance-row-h
const DET_H = 224; // px — must stay in lockstep with --seance-drawer-h
const OVERSCAN = 8; // rows rendered beyond each viewport edge
const LIST_H_FALLBACK = 700; // px, until the list has a measurable clientHeight
const FRESH_MS = 900; // row-land duration — a fresh mark expires with it
const SEARCH_DEBOUNCE_MS = 120;

/** Verdict chip roster. `all` clears the slot; the rest toggle. */
const VERDICTS: readonly { label: string; key: VerdictFilter; accent: string }[] = [
  { label: "all", key: null, accent: HEX },
  { label: ">:[ deny", key: "deny", accent: EMBER },
  { label: "(¬‿¬) pass", key: "pass", accent: SPECTRAL },
  { label: "◌ loose", key: "loose", accent: INK_DIM },
  { label: "☓ bypass", key: "bypass", accent: TOXIC },
];

export class TimelineView {
  /** Root element for the tab: the filter bar + the fixed-height scroll list + the footer. */
  readonly el: HTMLElement;

  private data: readonly (FlatEvent | null)[] = [];
  private filtered: FlatEvent[] = []; // newest-first — derived, never mutated in place
  private total = 0; // non-tombstone events in the feed
  private filter: FilterState = emptyFilter();
  private expandedKey: string | null = null; // one drawer at a time
  private freshUntil = new Map<string, number>(); // key → Date.now() deadline for row-land

  private readonly list: HTMLElement;
  private readonly topPadEl: HTMLElement;
  private readonly winEl: HTMLElement;
  private readonly bottomPadEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly toolSel: HTMLSelectElement;
  private readonly shownEl: HTMLElement;
  private readonly footCountText: Text;
  private readonly verdictChips: { btn: HTMLElement; key: VerdictFilter; accent: string }[];
  private readonly catChips: { btn: HTMLElement; name: string; color: string }[];

  private toolsSig = "\u0000unset"; // sentinel ≠ any real signature, so the first sync always builds
  private raf = 0;
  private debounce = 0;

  constructor() {
    // ── filter bar ──
    this.verdictChips = VERDICTS.map(({ label, key, accent }) => {
      const btn = el("button", { class: "tl-chip" }, label);
      btn.addEventListener("click", () => {
        this.mutateFilter((f) => {
          f.verdict = key !== null && f.verdict !== key ? key : null;
        });
      });
      return { btn, key, accent };
    });

    this.catChips = Object.keys(CATEGORY_COLORS).map((name) => {
      const color = CATEGORY_COLORS[name];
      const btn = el("button", { class: "tl-cat", title: name });
      btn.addEventListener("click", () => {
        this.mutateFilter((f) => {
          f.cats = f.cats.includes(name) ? f.cats.filter((c) => c !== name) : [...f.cats, name];
        });
      });
      return { btn, name, color };
    });

    this.toolSel = el("select", { class: "tl-tool", "aria-label": "filter by tool" }) as HTMLSelectElement;
    this.toolSel.addEventListener("change", () => {
      this.mutateFilter((f) => {
        f.tool = this.toolSel.value;
      });
    });

    this.searchEl = el("input", { class: "tl-search", "aria-label": "search events" }) as HTMLInputElement;
    this.searchEl.type = "text";
    this.searchEl.placeholder = "⌕ search the aftermath…";
    this.searchEl.addEventListener("input", () => {
      const value = this.searchEl.value;
      window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(
        () =>
          this.mutateFilter((f) => {
            f.text = value;
          }),
        SEARCH_DEBOUNCE_MS,
      );
    });

    this.shownEl = el("span", { class: "tl-shown" }, "0 / 0");

    const bar = el(
      "div",
      { class: "tl-filterbar" },
      el("div", { class: "tl-chipgroup" }, ...this.verdictChips.map((c) => c.btn)),
      el("div", { class: "tl-chipgroup" }, ...this.catChips.map((c) => c.btn)),
      this.toolSel,
      this.searchEl,
      this.shownEl,
    );

    // ── the windowed list: spacer / visible slice / spacer ──
    this.topPadEl = el("div", { class: "tl-spacer", "aria-hidden": "true" });
    this.winEl = el("div", { class: "tl-window" });
    this.bottomPadEl = el("div", { class: "tl-spacer", "aria-hidden": "true" });
    this.list = el("div", { class: "tl-list" }, this.topPadEl, this.winEl, this.bottomPadEl);
    // Scroll work is throttled to one re-window per animation frame.
    this.list.addEventListener("scroll", () => this.scheduleWindow());
    // Re-window when the list gets (re)sized — covers tab remounts, where
    // clientHeight goes 0 → real, and window resizes.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.scheduleWindow()).observe(this.list);
    }

    // ── footer ──
    this.footCountText = txt("0 EVENTS :: 0 ROWS IN DOM ");
    const footer = el(
      "div",
      { class: "tl-footer" },
      el("span", { class: "tl-foot-count" }, this.footCountText, el("b", {}, "// WINDOWED")),
      el("span", { class: "tl-foot-hints" }, "[1] séance · [2] timeline · [/] search · [esc] clear"),
      el("span", { class: "tl-foot-note" }, "NEWEST FIRST :: LIVE EVENTS LAND ON TOP"),
    );

    this.el = el("section", { class: "tl-root" }, bar, this.list, footer);
    this.paintChips();
    this.refilter();
    this.renderWindow();
  }

  /** Provide/refresh the data feed (the store's flat list; may contain null
   * tombstones — skipped). Re-derives the filtered array (linear pass over
   * data, NOT the DOM) and re-windows, preserving current scrollTop. Cheap. */
  setData(flat: readonly (FlatEvent | null)[]): void {
    this.data = flat;
    this.refilter();
    this.renderWindow(); // scrollTop untouched — the window re-derives around it
  }

  /** Apply a filter (e.g. dashboard cross-nav). Resets scroll, collapses the drawer. */
  setFilter(f: FilterState): void {
    this.filter = { verdict: f.verdict, cats: [...f.cats], tool: f.tool, text: f.text };
    this.searchEl.value = f.text;
    this.onFilterChanged();
  }

  getFilter(): FilterState {
    const f = this.filter;
    return { verdict: f.verdict, cats: [...f.cats], tool: f.tool, text: f.text };
  }

  focusSearch(): void {
    this.searchEl.focus();
  }

  /** Clear every filter AND the search input's value. */
  clearFilters(): void {
    this.setFilter(emptyFilter());
  }

  /** Mark a just-arrived key so its row plays row-land once when next rendered. */
  markFresh(key: string): void {
    const now = Date.now();
    for (const [k, until] of this.freshUntil) if (until <= now) this.freshUntil.delete(k);
    this.freshUntil.set(key, now + FRESH_MS);
  }

  // ── internals ──────────────────────────────────────────────

  private mutateFilter(mut: (f: FilterState) => void): void {
    mut(this.filter);
    this.onFilterChanged();
  }

  /** Every filter change: collapse the drawer, reset scroll, re-derive, re-window. */
  private onFilterChanged(): void {
    this.expandedKey = null;
    this.list.scrollTop = 0;
    this.paintChips();
    this.refilter();
    this.toolSel.value = this.filter.tool;
    this.renderWindow();
  }

  /** One linear pass over the feed: skip tombstones, collect tools, apply the
   * compiled predicate. Newest-first display = walking the arrival-order feed
   * from the end (the store appends newer events). */
  private refilter(): void {
    const pred = isEmptyFilter(this.filter) ? null : compile(this.filter);
    const out: FlatEvent[] = [];
    const tools = new Set<string>();
    let total = 0;
    for (let i = this.data.length - 1; i >= 0; i--) {
      const e = this.data[i];
      if (e === null) continue;
      total++;
      tools.add(e.tool);
      if (pred === null || pred(e)) out.push(e);
    }
    this.filtered = out;
    this.total = total;
    this.syncToolOptions(tools);
    this.shownEl.textContent = `${fmt(out.length)} / ${fmt(total)}`;
  }

  /** The windowing core. Pure arithmetic off scrollTop; only the visible slice
   * (+overscan) is ever in the DOM, padded by two spacer divs. */
  private renderWindow(): void {
    const f = this.filtered;
    const listH = this.list.clientHeight || LIST_H_FALLBACK;
    const expPos = this.expandedKey === null ? -1 : f.findIndex((e) => e.key === this.expandedKey);
    const totalH = f.length * ROW_H + (expPos >= 0 ? DET_H : 0);
    const st = Math.max(0, Math.min(this.list.scrollTop, Math.max(0, totalH - listH)));

    // First visible row. When the expanded drawer sits above the viewport,
    // scrollTop has already spent its 224px — pay that back before dividing,
    // clamped so the result can't land back on/above the expanded row itself.
    let first: number;
    if (expPos < 0 || st < (expPos + 1) * ROW_H) first = Math.floor(st / ROW_H);
    else first = Math.max(expPos + 1, Math.floor((st - DET_H) / ROW_H));
    first = Math.max(0, first - OVERSCAN);

    const yOf = (i: number): number => i * ROW_H + (expPos >= 0 && i > expPos ? DET_H : 0);
    const topPad = yOf(first);

    const nodes: HTMLElement[] = [];
    const now = Date.now();
    const limit = st + listH + OVERSCAN * ROW_H;
    let y = topPad;
    let i = first;
    while (i < f.length && y < limit) {
      const e = f[i];
      nodes.push(this.buildRow(e, now));
      y += ROW_H;
      if (i === expPos) {
        nodes.push(this.buildDrawer(e));
        y += DET_H;
      }
      i++;
    }
    const domCount = nodes.length; // rows + drawer actually mounted
    if (f.length === 0) nodes.push(this.buildEmpty());

    setStyles(this.topPadEl, { height: `${topPad}px` });
    setStyles(this.bottomPadEl, { height: `${Math.max(0, totalH - y)}px` });
    clear(this.winEl);
    this.winEl.appendChild(frag(...nodes));

    this.footCountText.textContent = `${fmt(this.total)} EVENTS :: ${domCount} ROWS IN DOM `;
  }

  private scheduleWindow(): void {
    if (this.raf !== 0) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderWindow();
    });
  }

  /** One 24px row. Untrusted fields (command, roast) enter via txt() only. */
  private buildRow(e: FlatEvent, now: number): HTMLElement {
    const byp = e.bypass;
    const v = e.verdict;
    const dot = catColor(e.cat);
    const row = el(
      "div",
      { class: "tl-row", role: "button" },
      el("span", { class: "tl-glyph", "aria-hidden": "true" }, byp ? "⚠" : v === "deny" ? "💀" : v === "loose" ? "◌" : "·"),
      el("span", { class: "tl-time" }, fmtTime(e.tsMs)),
      setStyles(el("span", { class: "tl-verdict" }, v === "deny" ? "DENY" : v === "loose" ? "LOOSE" : "pass"), {
        color: verdictColor(v, false),
        "text-shadow": v === "deny" ? "var(--seance-glow-ember)" : "none",
      }),
      byp ? el("span", { class: "tl-bypchip" }, "☓ BYPASS") : null,
      el("span", { class: "tl-toolcell" }, txt(e.tool)),
      setStyles(el("span", { class: "tl-catdot", title: e.cat }), {
        background: dot,
        "box-shadow": `0 0 5px ${dot}`,
      }),
      setStyles(el("span", { class: "tl-cmd" }, txt(e.command)), { color: v === "pass" ? SMOKE : INK }),
      e.roast ? el("span", { class: "tl-roastprev" }, "“", txt(e.roast), "”") : null,
      setStyles(
        el(
          "span",
          { class: "tl-join", title: e.loose ? "loose — no id to correlate" : "governing — ghost ⋈ sentinel joined" },
          e.loose ? "◌" : "⋈",
        ),
        { color: e.loose ? FAINT : SPECTRAL },
      ),
    );

    // Row treatments: governing = solid left border (toxic > ember > muted by
    // verdict); loose = dashed + faded. Background rides a custom property so
    // the CSS :hover can still win over it.
    const styles: Record<string, string | number> = {
      "border-left": e.loose
        ? `2px dashed ${FAINT}`
        : `2px solid ${byp ? TOXIC : v === "deny" ? EMBER : "var(--seance-pass-bar)"}`,
      "--row-bg": byp ? "rgba(196, 249, 46, 0.05)" : v === "deny" ? "var(--seance-panel-raised)" : "transparent",
    };
    if (e.loose) styles.opacity = 0.75;
    if (byp) {
      styles.animation = "strobe-row 1.8s ease-in-out infinite";
    } else {
      const until = this.freshUntil.get(e.key);
      if (until !== undefined) {
        if (now < until) styles.animation = `row-land ${FRESH_MS}ms ease-out 1`;
        else this.freshUntil.delete(e.key); // landed — never replays
      }
    }
    setStyles(row, styles);

    row.addEventListener("click", () => {
      this.expandedKey = this.expandedKey === e.key ? null : e.key; // one open at a time
      this.renderWindow();
    });
    return row;
  }

  /** The 224px detail drawer, inserted right after the expanded row. */
  private buildDrawer(e: FlatEvent): HTMLElement {
    const accent = e.bypass ? TOXIC : catColor(e.cat);
    const denied = e.verdict === "deny";

    const idLine = e.loose
      ? "no call_id — ghost leg only, nothing to correlate"
      : `call_id ${e.callId ?? "?"} :: tool_use_id ${e.toolUseId ?? "?"} :: ghost ⋈ sentinel-pre${
          e.postLegs.length ? ` ⋈ post×${e.postLegs.length}` : ""
        }`;

    // Post findings, or the honest placeholder — an empty post list on a denied
    // call is expected, not missing data. Say so instead of a silent void.
    const postChildren: HTMLElement[] = e.postLegs.length
      ? e.postLegs.map((leg) =>
          el(
            "div",
            { class: "tl-postleg" },
            el("span", { class: "tl-postleg-action" }, txt(leg.action)),
            leg.reason ? el("span", { class: "tl-postleg-reason" }, txt(leg.reason)) : null,
            leg.matchedRule ? el("span", { class: "tl-postleg-rule" }, txt(leg.matchedRule)) : null,
          ),
        )
      : [
          el(
            "div",
            { class: "tl-postnote" },
            denied
              ? "⊘ no post-hook line — call was denied (this is expected)"
              : e.loose
                ? "◌ unjoined — no sentinel legs to show"
                : "… awaiting post phase",
          ),
        ];

    const left = el(
      "div",
      { class: "tl-det-col" },
      el(
        "div",
        { class: "tl-det-join" },
        setStyles(el("span", { class: "tl-det-joinmark" }, e.loose ? "◌ LOOSE" : "⋈ JOINED"), {
          color: e.loose ? INK_DIM : SPECTRAL,
        }),
        el("span", { class: "tl-det-ids" }, txt(idLine)),
      ),
      e.roast
        ? setStyles(el("blockquote", { class: "tl-det-roast" }, txt(e.roast)), {
            "border-left": `2px solid ${accent}`,
          })
        : null,
      e.rule || e.reason
        ? el(
            "div",
            { class: "tl-det-rule" },
            e.rule ? el("code", {}, txt(e.rule)) : null,
            e.reason ? el("span", {}, txt(e.reason)) : null,
          )
        : null,
      el("div", { class: "tl-det-post" }, el("div", { class: "tl-det-label" }, "[ post findings ]"), ...postChildren),
    );

    const right = el(
      "div",
      { class: "tl-det-col" },
      el(
        "div",
        {},
        el("div", { class: "tl-det-label" }, "[ command ]"),
        // UNTRUSTED command — a text node inside the <pre>, never markup.
        el("pre", { class: "tl-det-pre" }, txt(e.command)),
      ),
      e.shadow
        ? el(
            "div",
            { class: "tl-shadow" },
            setStyles(
              el(
                "div",
                { class: "tl-shadow-h" },
                e.shadow.bypassFound ? "⚠ shadow red-team — a mutation EVADED sentinel" : "shadow red-team — all held",
              ),
              { color: e.shadow.bypassFound ? TOXIC : INK_DIM },
            ),
            ...e.shadow.probes.map((p) => {
              const c = p.bypass ? TOXIC : SMOKE;
              return el(
                "div",
                { class: "tl-probe" },
                el("span", { class: "tl-probe-mut" }, txt(p.mutation)),
                setStyles(el("span", {}, txt(p.decision)), { color: c }),
                setStyles(el("span", { class: "tl-probe-flag" }, p.bypass ? "☠ BYPASS" : "held"), { color: c }),
              );
            }),
          )
        : null,
    );

    return setStyles(el("div", { class: "tl-drawer" }, left, right), {
      "border-left": `2px solid ${accent}`,
    });
  }

  private buildEmpty(): HTMLElement {
    const btn = el("button", { class: "tl-clear" }, "✕ clear the circle");
    btn.addEventListener("click", () => this.clearFilters());
    return el(
      "div",
      { class: "tl-empty" },
      el("span", { class: "tl-empty-orb", "aria-hidden": "true" }, "◌ ◌"),
      el("span", { class: "tl-empty-msg" }, "nothing haunts this filter."),
      btn,
    );
  }

  /** Active/inactive chip styling — state-driven color via custom properties so
   * the CSS :hover keeps precedence over the data-set values. */
  private paintChips(): void {
    for (const { btn, key, accent } of this.verdictChips) {
      const active = this.filter.verdict === key;
      setStyles(btn, {
        "--chip-c": active ? (key === null ? INK : accent) : SMOKE,
        "--chip-bg": active ? "rgba(255, 46, 136, 0.06)" : "var(--seance-panel-raised)",
        "--chip-bc": active ? accent : "var(--seance-line)",
        "--chip-glow": active ? (key === null ? "var(--seance-glow-hex)" : `0 0 10px ${accent}55`) : "none",
      });
    }
    for (const { btn, name, color } of this.catChips) {
      const active = this.filter.cats.includes(name);
      setStyles(btn, {
        "--cc": color,
        "--cc-fill": active ? color : "transparent",
        "--cc-bc": active ? color : "#2e2838",
        "--cc-glow": active ? `0 0 8px ${color}` : "none",
      });
    }
  }

  /** Rebuild the tool <select> only when the observed tool set changes. */
  private syncToolOptions(tools: Set<string>): void {
    const sorted = [...tools].sort();
    const sig = sorted.join("\u0000");
    if (sig === this.toolsSig) return;
    this.toolsSig = sig;
    clear(this.toolSel);
    const all = el("option", {}, "all tools") as HTMLOptionElement;
    all.value = "";
    this.toolSel.appendChild(all);
    for (const t of sorted) {
      const opt = el("option", {}, txt(t)) as HTMLOptionElement;
      opt.value = t;
      this.toolSel.appendChild(opt);
    }
    this.toolSel.value = this.filter.tool;
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
