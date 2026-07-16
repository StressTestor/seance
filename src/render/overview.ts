// Overview — the at-a-glance command center. Every panel renders from the
// precomputed DashboardModel (store/aggregates.ts); nothing here ever walks the
// event list. The host calls update() throttled while the tab is visible, and
// the panel bodies are small and fixed-size, so a fresh rebuild per call is
// cheaper than diffing and can't leak stale nodes.
//
// UNTRUSTED text (commands, roasts, probe mutations, the most-wanted command)
// reaches the DOM only via txt() — never innerHTML. Computed styling (bar
// geometry, aggregate-driven colors, glows) goes through setStyles().
// Structure + static color live in overview.css.

import "./overview.css";
import { el, txt, clear, setStyles } from "./dom";
import { CATEGORIES, type DashboardModel } from "../store/aggregates";
import { catColor, EMBER, SPECTRAL, TOXIC, AMBER, INK, INK_DIM } from "./theme";
import type { FilterState } from "../filter/filter";
import type { PresenceView } from "./presence";

export class OverviewView {
  readonly el: HTMLElement;

  private readonly onNav: (f: Partial<FilterState>) => void;
  private readonly pulseEl: HTMLElement;
  private readonly catsEl: HTMLElement;
  private readonly healthEl: HTMLElement;
  private readonly denialsEl: HTMLElement;
  private readonly bypassEl: HTMLElement;
  /** Hero counters grid — the ONLY hero child we rebuild. The presence node
   * next to it is never touched after mount; it animates itself. */
  private readonly countersEl: HTMLElement;

  constructor(opts: {
    /** The shared presence — we embed its hero orb. The orb, its LAST line,
     * and the typed roast all live INSIDE the node createHero returns;
     * presence owns them (setLast/typeRoast are the host's calls, not ours). */
    presence: PresenceView;
    /** Cross-nav to the Timeline with a filter preset; the host wires the tab
     * switch + filter application. */
    onNav: (f: Partial<FilterState>) => void;
  }) {
    this.onNav = opts.onNav;
    this.pulseEl = el("section", { class: "panel ov-pulse" });
    this.catsEl = el("section", { class: "panel ov-cats" });
    this.healthEl = el("section", { class: "panel ov-health" });
    this.denialsEl = el("section", { class: "panel ov-denials" });
    this.bypassEl = el("section", { class: "panel ov-bypass" });
    this.countersEl = el("div", { class: "ov-counters" });
    const hero = el(
      "section",
      { class: "ov-hero" },
      opts.presence.createHero(216),
      this.countersEl,
    );
    this.el = el(
      "div",
      { class: "overview" },
      this.pulseEl,
      this.catsEl,
      hero,
      this.denialsEl,
      this.healthEl,
      this.bypassEl,
    );
  }

  /** Rebuild all panels + hero counters from the dashboard model. Throttled by
   * the host; never on the scroll hot path. */
  update(model: DashboardModel): void {
    const now = Date.now();
    this.renderCounters(model);
    this.renderPulse(model);
    this.renderCats(model);
    this.renderHealth(model);
    this.renderDenials(model, now);
    this.renderBypass(model, now);
  }

  // ── hero counters (2×2 under the orb) ────────────────────────────────────

  private renderCounters(m: DashboardModel): void {
    clear(this.countersEl);
    const defs = [
      { label: "denied", value: m.nDeny, color: EMBER, spark: m.sparks.deny, alarmed: false },
      { label: "roasts", value: m.nRoast, color: INK, spark: m.sparks.roast, alarmed: false },
      // bypass counter goes loud (toxic border + glow) the moment it's nonzero
      { label: "bypass", value: m.nByp, color: TOXIC, spark: m.sparks.byp, alarmed: m.nByp > 0 },
      { label: "loose", value: m.nLoose, color: INK_DIM, spark: m.sparks.loose, alarmed: false },
    ];
    for (const d of defs) {
      const max = Math.max(1, ...d.spark);
      const spark = el("div", { class: "ov-counter-spark", "aria-hidden": "true" });
      for (const v of d.spark) {
        spark.appendChild(
          setStyles(el("div"), {
            height: `${Math.max(1, Math.round((v / max) * 8))}px`,
            background: d.color,
          }),
        );
      }
      this.countersEl.appendChild(
        el(
          "div",
          { class: `ov-counter${d.alarmed ? " alarmed" : ""}` },
          setStyles(el("b", { class: "ov-counter-num" }, fmt(d.value)), { color: d.color }),
          spark,
          el("span", { class: "ov-counter-label" }, d.label),
        ),
      );
    }
  }

  // ── pulse — activity, last 24h ────────────────────────────────────────────

  private renderPulse(m: DashboardModel): void {
    clear(this.pulseEl);
    const rising = m.denyRateNow > m.denyRatePrev + 0.02;
    const falling = m.denyRateNow < m.denyRatePrev - 0.02;
    const trend = setStyles(
      el(
        "span",
        { class: "ov-trend" },
        `DENY RATE ${Math.round(m.denyRateNow * 100)}% ${rising ? "▲" : falling ? "▼" : "—"} 1H`,
      ),
      { color: rising ? EMBER : falling ? SPECTRAL : INK_DIM },
    );
    this.pulseEl.appendChild(
      el(
        "div",
        { class: "ov-pulse-head" },
        el("div", { class: "panel-title" }, "activity :: last 24h"),
        trend,
      ),
    );

    // 48 half-hour stacked bars, bottom-up pass → deny → bypass. Scale is
    // 48px-per-bucketMax inside the 52px lane (the reference's headroom for
    // the 1px stack gaps). A real bypass never rounds away: min-height 2px.
    const lane = el("div", { class: "ov-bars" });
    const sc = 48 / m.bucketMax;
    for (const b of m.buckets) {
      lane.appendChild(
        el(
          "div",
          { class: "ov-bar", title: `${b.d} deny · ${b.p} pass · ${b.b} bypass` },
          setStyles(el("div", { class: "ov-bar-pass" }), { height: `${Math.round(b.p * sc)}px` }),
          setStyles(el("div", { class: "ov-bar-deny" }), { height: `${Math.round(b.d * sc)}px` }),
          setStyles(el("div", { class: "ov-bar-byp" }), {
            height: `${b.b ? Math.max(2, Math.round(b.b * sc)) : 0}px`,
          }),
        ),
      );
    }
    this.pulseEl.appendChild(lane);

    this.pulseEl.appendChild(
      el(
        "div",
        { class: "ov-axis" },
        el("span", {}, "−24H"),
        el("span", {}, "−12H"),
        el("span", { class: "now" }, "▲ NOW"),
      ),
    );

    const total = Math.max(1, m.total);
    const ratio = el(
      "div",
      { class: "ov-ratio" },
      setStyles(el("div", { class: "ov-ratio-deny" }), {
        width: `${((m.nDeny / total) * 100).toFixed(1)}%`,
      }),
      // same honesty rule as the bars: a bypass segment never vanishes while
      // one exists, and never fakes a sliver while none do
      setStyles(el("div", { class: "ov-ratio-byp" }), {
        width: m.nByp ? `${Math.max(0.4, (m.nByp / total) * 100).toFixed(1)}%` : "0%",
      }),
      setStyles(el("div", { class: "ov-ratio-pass" }), {
        width: `${((m.nPass / total) * 100).toFixed(1)}%`,
      }),
    );
    const legend = el(
      "span",
      { class: "ov-legend" },
      el("b", { class: "deny" }, fmt(m.nDeny)),
      " DENY / ",
      el("b", { class: "pass" }, fmt(m.nPass)),
      " PASS / ",
      el("b", { class: "byp" }, fmt(m.nByp)),
      " BYP ",
      el("span", { class: "peak" }, `// PEAK ${fmt(m.bucketMax)}/30M`),
    );
    this.pulseEl.appendChild(el("div", { class: "ov-ratio-row" }, ratio, legend));
  }

  // ── cats — what it reached for ────────────────────────────────────────────

  private renderCats(m: DashboardModel): void {
    clear(this.catsEl);
    this.catsEl.appendChild(
      el("div", { class: "panel-title ov-cats-title" }, "what it reached for"),
    );
    const maxCat = Math.max(1, ...Object.values(m.catCounts));
    for (const name of CATEGORIES) {
      const count = m.catCounts[name] ?? 0;
      const color = catColor(name);
      const row = el(
        "div",
        { class: "ov-cat-row", role: "button", title: "filter timeline to this category" },
        setStyles(el("span", { class: "ov-cat-swatch" }), {
          background: color,
          "box-shadow": `0 0 6px ${color}`,
        }),
        el("span", { class: "ov-cat-name" }, name),
        el(
          "div",
          { class: "ov-cat-track" },
          setStyles(el("div", { class: "ov-cat-fill" }), {
            width: `${Math.round((count / maxCat) * 100)}%`,
            background: color,
            "box-shadow": `0 0 6px ${color}`,
          }),
        ),
        el("span", { class: "ov-cat-count" }, fmt(count)),
      );
      row.addEventListener("click", () => this.onNav({ cats: [name] }));
      this.catsEl.appendChild(row);
    }
    this.catsEl.appendChild(
      el(
        "div",
        { class: "ov-wanted" },
        el("span", { class: "ov-wanted-label" }, "MOST WANTED"),
        el("span", { class: "ov-wanted-cmd" }, txt(m.mostWantedCmd)), // UNTRUSTED
        el("span", { class: "ov-wanted-n" }, `×${fmt(m.mostWantedN)}`),
      ),
    );
  }

  // ── health — the join ─────────────────────────────────────────────────────

  private renderHealth(m: DashboardModel): void {
    clear(this.healthEl);
    const pct = Math.round((m.joined / Math.max(1, m.total)) * 100);
    // honest thresholds: never green while correlation is bad
    const color = pct >= 80 ? SPECTRAL : pct >= 50 ? AMBER : INK_DIM;
    const label =
      pct >= 80
        ? "the join holds"
        : pct >= 50
          ? "the join is fraying"
          : "the join is dark — most lines carry no id";
    this.healthEl.appendChild(el("div", { class: "panel-title" }, "the join"));
    this.healthEl.appendChild(
      el(
        "div",
        { class: "ov-health-row" },
        setStyles(el("b", { class: "ov-health-pct" }, `${pct}%`), { color }),
        setStyles(el("span", { class: "ov-health-label" }, label), { color }),
      ),
    );
    this.healthEl.appendChild(
      el(
        "div",
        { class: "ov-health-track" },
        // fill glows via `0 0 8px currentColor` in css — color carries the glow
        setStyles(el("div", { class: "ov-health-fill" }), {
          width: `${pct}%`,
          background: color,
          color,
        }),
      ),
    );
    this.healthEl.appendChild(
      el(
        "div",
        { class: "ov-health-cap" },
        `${fmt(m.joined)} governing calls correlate · `,
        el("span", { class: "loose" }, `${fmt(m.nLoose)} loose`),
        " (no id — kept, never dropped)",
      ),
    );
  }

  // ── denials — ghost's last words ──────────────────────────────────────────

  private renderDenials(m: DashboardModel, now: number): void {
    clear(this.denialsEl);
    this.denialsEl.appendChild(
      el("div", { class: "panel-title" }, "latest denials :: ghost's last words"),
    );
    if (m.denials.length === 0) {
      this.denialsEl.appendChild(
        el("div", { class: "ov-empty" }, "no denials yet — nothing to exorcise."),
      );
      return;
    }
    for (const d of m.denials) {
      const c = catColor(d.cat);
      const card = el(
        "div",
        { class: "ov-denial", role: "button", title: "open denials in timeline" },
        el("span", { class: "ov-denial-stamp", "aria-hidden": "true" }, "exorcised"),
        el(
          "div",
          { class: "ov-denial-head" },
          el("span", { class: "ov-denial-verdict" }, ">:[ DENY"),
          el("span", { class: "ov-denial-tool" }, txt(d.tool)),
          setStyles(el("span", { class: "ov-denial-dot" }), {
            background: c,
            "box-shadow": `0 0 5px ${c}`,
          }),
          el("span", { class: "ov-denial-cmd" }, txt(d.command)), // UNTRUSTED
        ),
        el("blockquote", { class: "ov-denial-roast" }, txt(d.roast ?? "")), // UNTRUSTED
        el("span", { class: "ov-denial-time" }, ago(d.tsMs, now)),
      );
      card.addEventListener("click", () => this.onNav({ verdict: "deny" }));
      this.denialsEl.appendChild(card);
    }
  }

  // ── bypass — shadow red-team ──────────────────────────────────────────────

  private renderBypass(m: DashboardModel, now: number): void {
    clear(this.bypassEl);
    const b = m.latestBypass;
    this.bypassEl.classList.toggle("alarmed", b !== null);
    if (!b) {
      this.bypassEl.appendChild(el("div", { class: "panel-title" }, "shadow red-team"));
      this.bypassEl.appendChild(
        el("div", { class: "ov-empty" }, "every probe held. sentinel is airtight — for now."),
      );
      return;
    }
    const probes = el("div", { class: "ov-probes" });
    for (const p of b.shadow?.probes ?? []) {
      probes.appendChild(
        el(
          "div",
          { class: "ov-probe" },
          el("span", { class: "ov-probe-mut" }, txt(p.mutation)), // UNTRUSTED
          el("span", { class: "ov-probe-arrow", "aria-hidden": "true" }, "──▶"),
          el(
            "span",
            { class: `ov-probe-flag${p.bypass ? " evaded" : ""}` },
            p.bypass ? "passed — EVADED" : "held",
          ),
        ),
      );
    }
    const btn = el("button", { class: "ov-bypass-btn" }, `▶ all ${fmt(m.nByp)} in timeline`);
    btn.addEventListener("click", () => this.onNav({ verdict: "bypass" }));
    // the crawling tape means sentinel let one through. it stays until the
    // model says otherwise — no dismissing an alarm from a read-only window.
    this.bypassEl.appendChild(el("div", { class: "ov-hazard", "aria-hidden": "true" }));
    this.bypassEl.appendChild(
      el(
        "div",
        { class: "ov-bypass-body" },
        el(
          "div",
          { class: "ov-bypass-head" },
          el("span", { class: "ov-bypass-title" }, "☓ POLICY BYPASS FOUND"),
          el("span", { class: "ov-bypass-time" }, ago(b.tsMs, now)),
        ),
        el("div", { class: "ov-bypass-cmd" }, txt(b.command)), // UNTRUSTED
        probes,
        el(
          "div",
          { class: "ov-bypass-foot" },
          el(
            "span",
            { class: "ov-bypass-note" },
            "a mutation of a denied call slipped past sentinel — the rule has a hole.",
          ),
          btn,
        ),
      ),
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Relative time, coarse on purpose — the dashboard refresh cadence (~2Hz,
 * overview-only) keeps it close enough. */
function ago(tsMs: number, now: number): string {
  const s = Math.max(1, Math.round((now - tsMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
