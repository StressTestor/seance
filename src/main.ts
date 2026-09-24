// séance v3 — "the wall talks back". Bootstrap: builds the app shell (FX layer,
// header with real tabs, the two tab views), wires the store's live feed to the
// virtualized timeline + the throttled dashboard + the reactive presence, and
// tails the backend. The frontend never touches the filesystem — all data
// arrives over the Tauri bridge as already-joined, normalized events.

import "./styles.css";
import { el, txt, clear } from "./render/dom";
import { Store } from "./store/store";
import { computeDashboard, type DashboardModel } from "./store/aggregates";
import { PresenceView } from "./render/presence";
import { TimelineView } from "./render/timeline";
import { OverviewView } from "./render/overview";
import { emptyFilter, type FilterState } from "./filter/filter";
import { flatView, type FlatEvent } from "./model/view";
import { backfill, fetchStatus, onBatch } from "./bridge/tauri";

type Tab = "overview" | "timeline";

function mount(): void {
  const app = document.getElementById("app")!;
  clear(app);

  // ── ambient FX overlays (disabled by .calm / reduced-motion via CSS) ──
  const scan = el("div", { class: "fx-scanlines", "aria-hidden": "true" });
  const crt = el("div", { class: "fx-crt", "aria-hidden": "true" });
  const vignette = el("div", { class: "fx-vignette", "aria-hidden": "true" });

  // ── presence (shared: hero orb on overview, mini orb in the header) ──
  const presence = new PresenceView();
  presence.setVignetteEl(vignette);
  const miniOrb = presence.createMini(30);

  // ── views ──
  let tab: Tab = "overview";
  const timeline = new TimelineView();
  const overview = new OverviewView({
    presence,
    onNav: (f: Partial<FilterState>) => {
      timeline.setFilter({ ...emptyFilter(), ...f });
      showTab("timeline");
    },
  });

  // ── header ──
  const tabCount = el("span", { class: "tab-count" }, "0");
  const tabOverview = tabButton("◉", "séance", null, () => showTab("overview"));
  const tabTimeline = tabButton("≣", "timeline", tabCount, () => showTab("timeline"));
  const bypassAlarm = el(
    "button",
    { class: "bypass-alarm", title: "a shadow probe evaded sentinel — see it in the timeline" },
    "☓ 0 BYPASS",
  );
  bypassAlarm.addEventListener("click", () => {
    timeline.setFilter({ ...emptyFilter(), verdict: "bypass" });
    showTab("timeline");
  });
  const statusDot = el("span", { class: "status-dot", "aria-hidden": "true" });
  const statusLine = el("span", {}, "reading the veil…");
  const uptime = el("span", { class: "uptime" }, "00:00:00");

  const header = el(
    "header",
    { class: "app-header" },
    el(
      "div",
      { class: "brand" },
      el(
        "h1",
        { class: "wordmark" },
        "séance",
        el("span", { class: "wordmark-ghost", "aria-hidden": "true" }, "séance"),
      ),
      el("div", { class: "subtag" }, "v3 // the wall talks back"),
    ),
    el("nav", { class: "tabs" }, tabOverview.el, tabTimeline.el),
    el("div", { class: "header-spacer" }),
    el(
      "div",
      { class: "header-right" },
      miniOrb,
      bypassAlarm,
      el("div", { class: "status" }, statusDot, statusLine, uptime),
      el(
        "span",
        { class: "sticker", title: "séance never writes to the logs — it can only observe" },
        "HANDS OFF · EYES ONLY",
      ),
    ),
  );

  const content = el("div", { class: "tab-content" });
  app.append(scan, crt, vignette, header, content);

  function showTab(next: Tab): void {
    tab = next;
    tabOverview.el.classList.toggle("active", next === "overview");
    tabTimeline.el.classList.toggle("active", next === "timeline");
    miniOrb.classList.toggle("shown", next === "timeline");
    clear(content);
    content.appendChild(next === "overview" ? overview.el : timeline.el);
    // re-trigger the tab-in animation
    content.style.animation = "none";
    void content.offsetWidth;
    content.style.animation = "";
    if (next === "overview") refreshDashboard();
  }

  // ── data + wiring ──
  const store = new Store();
  let lastRoast = "";
  let dashDirty = false;
  let dashTimer = 0;
  let lastModel: DashboardModel | null = null; // reused by the status poll — don't recompute

  function refreshDashboard(): void {
    const model = computeDashboard(store.flatList(), Date.now());
    lastModel = model;
    tabCount.textContent = model.total.toLocaleString("en-US");
    bypassAlarm.textContent = `☓ ${model.nByp.toLocaleString("en-US")} BYPASS`;
    bypassAlarm.classList.toggle("on", model.nByp > 0);
    presence.setLast(model.last);
    if (model.denials[0]?.roast && model.denials[0].roast !== lastRoast) {
      lastRoast = model.denials[0].roast;
      presence.typeRoast(lastRoast);
    }
    if (tab === "overview") overview.update(model);
  }

  /** Throttle dashboard recompute to ~2Hz; it is never on the scroll hot path. */
  function scheduleDashboard(): void {
    if (dashTimer) {
      dashDirty = true;
      return;
    }
    refreshDashboard();
    dashTimer = window.setTimeout(() => {
      dashTimer = 0;
      if (dashDirty) {
        dashDirty = false;
        scheduleDashboard();
      }
    }, 500);
  }

  store.subscribe((delta) => {
    timeline.setData(store.flatList());
    for (const ev of delta.added) timeline.markFresh(ev.key);
    // React to the loudest freshly-landed event (bypass > deny > pass).
    const fresh = delta.added.map(flatView);
    const loud = pickLoudest(fresh);
    if (loud) presence.react(loud);
    scheduleDashboard();
  });

  // ── keyboard ──
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (e.key === "1") showTab("overview");
    else if (e.key === "2") showTab("timeline");
    else if (e.key === "/") {
      e.preventDefault();
      if (tab !== "timeline") showTab("timeline");
      timeline.focusSearch();
    } else if (e.key === "Escape") timeline.clearFilters();
    else if (e.key === "c") document.body.classList.toggle("calm");
  });

  // ── status (backend presence + honest dark-join signal) ──
  async function refreshStatus(): Promise<void> {
    const s = await fetchStatus();
    if (!s) {
      statusDot.classList.remove("live", "dark");
      clear(statusLine);
      statusLine.appendChild(txt("standalone — design preview"));
      return;
    }
    const both = s.sentinelExists && s.ghostExists;
    // Reuse the dashboard's last pass (refreshed on every delta); recomputing the
    // whole aggregate over all events just for the dot color is wasteful.
    const model = lastModel ?? computeDashboard(store.flatList(), Date.now());
    const dark = both && model.joined === 0 && model.total > 0;
    statusDot.classList.toggle("live", both && !dark);
    statusDot.classList.toggle("dark", dark);
    clear(statusLine);
    const src = `${s.sentinelExists ? "sentinel" : "sentinel(absent)"}·${s.ghostExists ? "ghost" : "ghost(absent)"}`;
    statusLine.appendChild(txt(dark ? `${src} :: no correlated calls (ids absent?)` : `${src} :: TAILING`));
  }

  // uptime clock (textContent on a retained node — never a re-render)
  const t0 = Date.now();
  const pad = (n: number) => String(n).padStart(2, "0");
  window.setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    uptime.textContent = ` ${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }, 1000);

  showTab("overview");

  // Live FIRST (so nothing between backfill and subscribe is missed), then seed.
  onBatch((batch) => store.ingest(batch)).then(async () => {
    const seed = await backfill();
    if (seed.length) store.seed(seed);
    timeline.setData(store.flatList());
    refreshDashboard();
    refreshStatus();
    window.setInterval(refreshStatus, 4000);
  });
}

function tabButton(
  glyph: string,
  label: string,
  count: HTMLElement | null,
  onClick: () => void,
): { el: HTMLElement } {
  const node = el(
    "button",
    { class: "tab" },
    el("span", { class: "tab-glyph", "aria-hidden": "true" }, glyph),
    label,
    ...(count ? [txt(" "), count] : []),
  );
  node.addEventListener("click", onClick);
  return { el: node };
}

/** The loudest event to react to: a bypass outranks a deny outranks a pass. */
function pickLoudest(events: FlatEvent[]): FlatEvent | null {
  let best: FlatEvent | null = null;
  const rank = (e: FlatEvent) => (e.bypass ? 3 : e.verdict === "deny" ? 2 : 1);
  for (const e of events) if (!best || rank(e) > rank(best)) best = e;
  return best;
}

// A minimal error boundary: a read-only observability tool must never fail to a
// silent blank window (release builds ship no devtools). Any uncaught startup or
// runtime error is surfaced as text in the shell instead. textContent-only, so
// it can't itself be an injection vector.
function showFatal(label: string, detail: string): void {
  const app = document.getElementById("app") ?? document.body;
  if (!app || document.querySelector(".fatal-diag")) return; // show the first error only, never stack
  const box = document.createElement("pre");
  box.className = "fatal-diag";
  box.textContent = `séance hit an error (${label}):\n${detail}`;
  app.appendChild(box);
}
window.addEventListener("error", (e) => showFatal("error", `${e.message}\n${e.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", (e) =>
  showFatal("unhandledrejection", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)),
);

function boot(): void {
  try {
    mount();
  } catch (err) {
    showFatal("mount", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
