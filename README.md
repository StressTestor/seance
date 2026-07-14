# séance 🔮

**Read-only observability for the [sentinel](https://github.com/StressTestor/sentinel) / [ghost](https://github.com/StressTestor/ghost) agent-security stack.** Consult the spirits about what your agent has been up to.

> sentinel **blocks**. ghost **roasts**. séance **shows you the aftermath.**

séance is a small Tauri desktop app that tails the two JSONL logs the stack
already writes, **joins** them into a single correlated timeline, and renders it
in an occult/punk séance you can actually read — deny vs pass vs shadow-bypass vs
loose events, each with its own visual grammar, the roasts displayed with the
respect they deserve.

It is **read-only by construction**. It cannot modify the enforcement layer —
not the policy, not the hooks, not the logs — even if its own UI were fully
compromised. See [Security](#security-read-only-is-structural).

---

## The triad

| tool | job | writes |
|---|---|---|
| **sentinel** | the security authority. A PreToolUse/PostToolUse hook that **blocks** dangerous agent tool calls. | `~/.sentinel/audit.jsonl` — one `AuditEvent` per evaluation |
| **ghost** | offense bolted onto defense. Wraps sentinel, **roasts** every block in a punk/occult voice, and shadow-probes denials for policy bypasses. | `~/.ghost/events.jsonl` — one `CallRecord` per bridged call |
| **séance** | the observer. Tails + joins both logs and **shows the aftermath.** | nothing. ever. |

## The join contract

séance stitches the two logs back together using the correlation ids the stack
stamps on every line:

```
ghost line  ──(call_id)──▶  sentinel PRE line  ──(tool_use_id)──▶  sentinel POST line(s)
```

- **ghost ↔ sentinel-pre** join on **`call_id`** — the UUID ghost mints per
  bridged call and hands sentinel via the `SENTINEL_CALL_ID` env var.
- **sentinel-pre ↔ sentinel-post** join on **`tool_use_id`** — the id Claude
  Code puts in *both* hook phases' payloads for one tool call.

A **governing call** is therefore **one ghost line + one sentinel pre line +
zero-or-more post lines.**

Two facts séance renders deliberately, so they read as signal not noise:

- **A denied call produces NO post line.** Claude Code does not fire PostToolUse
  when PreToolUse denies (observed on Claude Code **2.1.207**; undocumented
  upstream). séance shows this as the *expected* state — `⊘ no post-hook line —
  call was denied` — never as missing data.
- **Older lines predate the id fields.** Every id is optional in both emitters.
  A line with no id to join on is surfaced as a **loose / unjoined** event,
  visually distinct (dashed sigil bar, `◌ UNJOINED`) — **never dropped.**

## Data sources

| file | shape | rotation |
|---|---|---|
| `~/.sentinel/audit.jsonl` | `timestamp, tool_name, action, reason?, matched_rule?, mode, call_id?, tool_use_id?, hook_phase?` | none — grows forever, tailed incrementally |
| `~/.ghost/events.jsonl` (+ `.jsonl.1`) | `ts_ms, tool, command, decision, category?, roast?, roast_id?, shadow?, call_id?, tool_use_id?` | rotates to `.jsonl.1` at 8 MiB; séance drains the old file's tail across the boundary |

## Architecture

```
crates/seance-core/   pure Rust. tail · rotation · parse · join · offset persistence.
                      No Tauri, no watcher — the whole correctness core is unit-tested
                      on any platform (77 tests).
src-tauri/            the Tauri 2.x desktop shell. Owns the notify file-watcher (+ poll
                      fallback) and a wall-clock timer; reads the logs with std::fs and
                      streams normalized, already-joined events to the webview.
src/                  vanilla TS + Vite frontend. The correlated timeline, the living
                      "presence", filters/search. Never touches the filesystem.
```

The backend does the join once, in Rust, and the frontend only ever receives a
normalized discriminated union (`GoverningCall | LooseEvent`). Malformed lines
are counted and skipped, never fatal — the same tolerance both emitters have.

## Security: read-only is structural

séance is designed so it **cannot** modify the enforcement layer, by construction
rather than by policy:

- **The webview has no filesystem API at all.** No `tauri-plugin-fs`, no
  `withGlobalTauri`; its capability grants only event-*listen*. A compromised or
  prompt-injected webview has no `readFile`/`writeFile` primitive to call — it
  can only receive the events the backend chose to emit.
- **The backend never opens anything for writing** on the log path. Log access
  goes through `seance-core`, which only ever calls `File::open` (read) + stat.
  There is no `write`/`create`/`truncate`/`remove`/`rename` anywhere in the
  log-reading modules — and **CI greps to keep it that way** (the "structural
  read-only guard"). séance's *own* small offset-state file is the only thing it
  writes, and only into its own OS app-data dir.
- **No network, no shell, no updater.** None are dependencies; the CSP's
  `connect-src` is `self ipc:` only, so the webview cannot fetch or exfiltrate.
- **Untrusted payloads are text, always.** Commands, tool output, and roasts are
  agent-authored. The frontend builds DOM with `createElement` + `textContent`
  exclusively — never `innerHTML` — and a strict CSP (`script-src 'self'`, no
  `unsafe-inline`) is the backstop.

## Build & run

Prerequisites: a recent **Rust** toolchain, **Node 20+**, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(macOS: Xcode command-line tools). Primary target is **macOS (Apple Silicon)**.

```bash
npm install
npm run tauri dev      # or: cargo tauri dev   — live-reload dev build
npm run tauri build    # or: cargo tauri build — a signed-ready .app / .dmg
```

Point it at a live stack: install sentinel + ghost (see their repos), let your
agent make a few hooked tool calls, and séance shows the joined timeline within
~1s of each call landing.

### Working on just the core

```bash
cargo test -p seance-core          # the tail/rotation/join correctness suite
cargo clippy -p seance-core --all-targets -- -D warnings
```

### Working on just the UI

```bash
npm run dev                        # vite dev server
# open http://localhost:1420/?demo  to preview with synthetic data (no backend)
```

## Notes

- **Offset persistence:** séance remembers where it left off per file (keyed on
  inode). sentinel's log resumes from the saved offset. ghost's log resumes
  verbatim, so if a rotation happened while séance was closed it drains the
  unconsumed tail of `events.jsonl.1` on the next poll instead of losing it.
  Delete `tail_state.json` in the app-data dir to replay full history.
- **The display face** is the system-serif fallback stack (no bundled/remote
  font — the strict CSP forbids font CDNs and we ship zero binary font assets).

## License

Dual-licensed under either of [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT)
at your option, matching sentinel.
