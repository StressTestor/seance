# ARCHITECTURE — séance

Read-only desktop observer for the sentinel / ghost agent-security stack. Tails
two JSONL logs, joins them into one correlated timeline, and renders it. Never
writes to the logs — read-only by construction.

## Overview

séance is a Tauri desktop app. A Rust core (`seance-core`) tails + correlates the
logs; the Tauri layer (`src-tauri`) owns all filesystem access and emits joined
events over the event bridge; a vanilla-TypeScript frontend (`src/`) renders a
two-tab UI (Overview dashboard + virtualized Timeline). No frontend framework.

> sentinel **blocks**. ghost **roasts**. séance **shows you the aftermath.**

## Stack

| layer | tech | role |
|---|---|---|
| core | Rust (`crates/seance-core`) | tail two JSONL logs, correlate into `SeanceEvent`s |
| shell | Tauri v2 (`src-tauri`) | filesystem (read-only), backfill + live event bridge |
| frontend | TypeScript + hand-written CSS, Vite | the UI — no framework, `createElement`/`textContent` only |

## Directory tree

```
crates/seance-core/src/
  tail.rs rotation.rs state.rs   # follow + resume the two logs
  records.rs model.rs            # parse sentinel/ghost lines -> typed records
  join.rs                        # the correlator: ghost + sentinel-pre + post -> one call
src-tauri/src/
  lib.rs main.rs                 # Tauri commands: backfill (snapshot) + status; live emit
src/
  main.ts                        # bootstrap: shell, tabs, live wiring, keyboard, error boundary
  model/
    types.ts                     # the wire model (nested tagged union) + verdictOf/hasBypass
    view.ts                      # flatView(): nested SeanceEvent -> flat FlatEvent (the render seam)
  store/
    store.ts                     # one flat render-ready feed, maintained incrementally
    aggregates.ts                # computeDashboard(): one-pass dashboard model
  filter/filter.ts               # FilterState + compiled predicate (filter-on-data)
  render/
    dom.ts                       # el()/txt()/setStyles()/clear() — the ONLY node factory
    theme.ts                     # data-driven color constants
    timeline.ts + .css           # the virtualized Timeline tab
    overview.ts + .css           # the Overview dashboard tab
    presence.ts + .css           # the living orb (LED-face state machine, typed roasts)
  styles.css                     # tokens, keyframes, app shell, header/tabs, FX layer
```

## Key patterns

**Data flow (frontend).** Tauri bridge → `Store.ingest`/`seed` → one flat
`FlatEvent[]` feed (`flatList()`), maintained incrementally (push on add, replace
on patch, tombstone on drop — all O(1)). Consumers each do a single linear pass:
the Timeline filters + windows it; `computeDashboard()` aggregates it. The store
holds ONE flattened copy per event — no nested second copy, no rendered rows.

**Virtualized timeline.** Fixed 24px rows + a fixed 224px detail drawer ⇒ pure
arithmetic windowing: only the visible slice (~35 rows) is ever in the DOM
regardless of event count. Scroll is rAF-throttled; filtering runs on the data
array, never by toggling visibility on live DOM nodes. This is the fix for the
old design's memory bloat + sluggish filter/tab switches.

**Dashboard aggregates.** `computeDashboard()` is one O(n) pass producing every
Overview panel (counts, 24h activity buckets, sparklines, deny-rate trend,
join-health, category breakdown, denials, bypass). Called throttled (~2Hz) and
only while Overview is visible — never on the scroll hot path. The status poll
reuses the last computed model.

**XSS model (load-bearing).** All agent-authored text (commands, roasts, reasons,
rules, probe strings) is UNTRUSTED and reaches the DOM only via `textContent`
through `dom.ts` — never `innerHTML`. Computed/trusted values (sizes, colors,
animation strings) go through `setStyles()`. The strict CSP (`script-src 'self'`,
no `unsafe-inline` scripts) is the backstop, not the primary defense.

**Read-only is structural.** The webview has no filesystem API (capabilities grant
only event listen). The backend only ever `File::open`s the logs (CI greps to
keep the log-reading pipeline write-free). The UI carries no control that acts on
the stack — every control filters or navigates. `HANDS OFF · EYES ONLY`.

## The join contract

```
ghost line ──(call_id)──▶ sentinel PRE line ──(tool_use_id)──▶ sentinel POST line(s)
```

A **governing call** = 1 ghost line + 1 sentinel pre line + 0..n post lines,
correlated on `call_id`/`tool_use_id`. A line with neither id is **loose**
(unjoined) — surfaced, never dropped. A denied call produces no post line (Claude
Code does not fire PostToolUse on a deny) — rendered as the expected state, not
missing data. Verdict (deny/pass) and joined-ness are orthogonal: a loose event
still reports its real decision.

## Data sources

| file | writer | shape |
|---|---|---|
| `~/.sentinel/audit.jsonl` | sentinel | one `AuditEvent` per evaluation (pre/post) |
| `~/.ghost/events.jsonl` | ghost | one `CallRecord` per bridged call (with roast, shadow probes) |

séance's own only write: an offset-state file in its OS app-data dir
(`~/Library/Application Support/com.stresstestor.seance/tail_state.json`).

## Commands

| command | what |
|---|---|
| `npm run build` | `tsc --noEmit` + `vite build` (frontend gate) |
| `npx tauri build` | build the macOS `.app` + `.dmg` (runs the frontend build first) |
| `npx tauri dev` | dev webview with hot-reload + devtools |
| `cargo test -p seance-core` | the correlator's test suite |

## Gotchas

| problem | cause | fix |
|---|---|---|
| join 100% dark (all loose) | installed sentinel/ghost predate the id fields | rebuild + reinstall both from id-emitting HEAD |
| blank window on a fresh build | occasional stale first-build embed | rebuild; an error boundary now surfaces real runtime errors as text instead of a silent blank |
| timeline shows only recent events | persisted tail offset resumes mid-log | delete `tail_state.json` to force a full re-backfill |
| release build has no devtools | Tauri release default | the in-app error boundary + `tauri dev` for the console |

_Last updated: 2026-07-16 (v3 redesign: two-tab dashboard + virtualized timeline)._
