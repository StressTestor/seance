// séance — bootstrap. Assembles the shell, seeds from backfill, then tails live.
// The frontend never touches the filesystem: all data arrives over the Tauri
// event bridge as already-joined, normalized events.

import "./styles.css";
import { el, txt, clear } from "./render/dom";
import { Store } from "./store/store";
import { Presence } from "./render/presence";
import { Timeline } from "./render/timeline";
import { Controls } from "./filter/controls";
import { compile, emptyFilter, type FilterState } from "./filter/filter";
import { backfill, fetchStatus, onBatch } from "./bridge/tauri";
import { hasBypass, verdictOf } from "./model/types";

function mount(): void {
  const app = document.getElementById("app")!;
  clear(app);

  // ── presence header ──
  const orb = el("div", { class: "presence", "aria-hidden": "true" });
  const vignette = el("div", { class: "frame-vignette", "aria-hidden": "true" });
  const counters = {
    denies: el("b", { class: "count deny" }, "0"),
    roasts: el("b", { class: "count roast" }, "0"),
    bypass: el("b", { class: "count bypass" }, "0"),
    loose: el("b", { class: "count loose" }, "0"),
  };
  const tailingDot = el("span", { class: "tailing-dot", "aria-hidden": "true" });
  const statusLine = el("span", { class: "status-line" }, "reading the veil…");

  const header = el(
    "header",
    { class: "presence-header grimoire" },
    el(
      "div",
      { class: "brand" },
      orb,
      el(
        "div",
        { class: "brand-text" },
        el("h1", { class: "wordmark" }, "séance"),
        el("div", { class: "tagline" }, "what your agent has been up to"),
      ),
    ),
    el(
      "div",
      { class: "counters" },
      counterChip(counters.denies, "denied"),
      counterChip(counters.roasts, "roasts"),
      counterChip(counters.bypass, "bypass"),
      counterChip(counters.loose, "loose"),
      el("div", { class: "tailing" }, tailingDot, statusLine),
    ),
  );

  // ── filter bar ──
  let filterState: FilterState = emptyFilter();
  const controls = new Controls((patch) => {
    filterState = { ...filterState, ...patch };
    timeline.setPredicate(compile(filterState));
  });
  const filterBar = controls.build();

  // ── timeline (hero) ──
  const timelineEl = el("div", { class: "timeline" });
  const presence = new Presence(orb, vignette);
  const timeline = new Timeline(timelineEl, presence);

  const empty = el(
    "div",
    { class: "empty-state" },
    el("div", { class: "empty-orb", "aria-hidden": "true" }, "◌"),
    el("div", {}, "the veil is quiet. nothing's tried anything yet."),
    el("div", { class: "empty-sub" }, "run a hooked tool call and the spirits will talk. they ALL talk eventually XX"),
  );
  timelineEl.appendChild(empty);

  app.appendChild(vignette);
  app.appendChild(header);
  app.appendChild(filterBar);
  app.appendChild(timelineEl);

  // ── data wiring ──
  const store = new Store();
  const tally = { denies: 0, roasts: 0, bypass: 0, loose: 0 };

  function recount(): void {
    tally.denies = tally.roasts = tally.bypass = tally.loose = 0;
    for (const ev of store.all()) {
      if (ev.kind === "loose") tally.loose++;
      if (verdictOf(ev) === "deny") tally.denies++;
      if (ev.ghost?.roast) tally.roasts++;
      if (hasBypass(ev)) tally.bypass++;
    }
    counters.denies.textContent = String(tally.denies);
    counters.roasts.textContent = String(tally.roasts);
    counters.bypass.textContent = String(tally.bypass);
    counters.loose.textContent = String(tally.loose);
    counters.bypass.parentElement?.classList.toggle("live-alarm", tally.bypass > 0);
  }

  store.subscribe((delta) => {
    if (empty.parentElement) empty.remove();
    for (const ev of [...delta.added, ...delta.patched]) controls.observe(ev);
    // Recompute counts from the authoritative store so merges/drops stay exact.
    recount();
    timeline.applyDelta(delta);
  });

  // Design preview: outside Tauri with ?demo, seed representative events so the
  // visual system can be worked on / screenshotted in a plain browser. Never
  // runs in the real app (backfill() there returns real data; this is skipped).
  if (typeof window !== "undefined" && location.search.includes("demo")) {
    void import("./demo").then(({ demoEvents }) => {
      const seed = demoEvents();
      empty.remove();
      store.seed(seed);
      for (const ev of seed) controls.observe(ev);
      timeline.seed(seed);
      recount();
      clear(statusLine);
      statusLine.appendChild(txt("demo preview — synthetic data"));
    });
    return;
  }

  // Live FIRST (so nothing between backfill and subscribe is missed), then seed.
  onBatch((batch) => store.ingest(batch)).then(async () => {
    const seed = await backfill();
    if (seed.length) {
      if (empty.parentElement) empty.remove();
      store.seed(seed);
      for (const ev of seed) controls.observe(ev);
      timeline.seed(seed);
      recount();
    }
    refreshStatus(tailingDot, statusLine);
    window.setInterval(() => refreshStatus(tailingDot, statusLine), 4000);
  });
}

function counterChip(value: HTMLElement, label: string): HTMLElement {
  return el("div", { class: "counter-chip" }, value, el("span", { class: "counter-label" }, label));
}

async function refreshStatus(dot: HTMLElement, line: HTMLElement): Promise<void> {
  const s = await fetchStatus();
  if (!s) {
    dot.classList.remove("live");
    clear(line);
    line.appendChild(txt("standalone (no backend) — design preview"));
    return;
  }
  const both = s.sentinelExists && s.ghostExists;
  dot.classList.toggle("live", both);
  clear(line);
  const skipped = s.skipped > 0 ? ` · ${s.skipped} skipped` : "";
  line.appendChild(
    txt(
      `${s.sentinelExists ? "sentinel" : "sentinel(absent)"} · ${
        s.ghostExists ? "ghost" : "ghost(absent)"
      } · tailing${skipped}`,
    ),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
