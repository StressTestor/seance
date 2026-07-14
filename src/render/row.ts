// Timeline row construction + in-place patching. All untrusted text goes through
// txt() (see dom.ts). A row is keyed by ev.key; a late post line patches only the
// .post-slot subtree, never the whole row.

import { clear, el, frag, txt } from "./dom";
import { clockTime } from "../util/time";
import type { GhostCategory, SeanceEvent, SentinelLeg, ShadowReport } from "../model/types";
import { hasBypass, verdictOf } from "../model/types";

const CATEGORY_LABEL: Record<string, string> = {
  "cred-access": "CRED-ACCESS",
  "pipe-to-shell": "PIPE-TO-SHELL",
  destructive: "DESTRUCTIVE",
  persistence: "PERSISTENCE",
  "network-exfil": "NETWORK-EXFIL",
  unknown: "UNKNOWN",
};

function verdictChip(ev: SeanceEvent): HTMLElement {
  const v = verdictOf(ev);
  const label = v === "deny" ? ">:[ DENY" : v === "pass" ? "(¬‿¬) pass" : "◌ UNJOINED";
  return el("span", { class: "chip", "data-verdict": v }, label);
}

function categoryBadge(cat?: GhostCategory): HTMLElement | null {
  if (!cat) return null;
  const label = CATEGORY_LABEL[cat] ?? cat.toUpperCase();
  return el(
    "span",
    { class: "cat-badge", "data-category": cat },
    el("span", { class: "cat-dot", "aria-hidden": "true" }),
    label,
  );
}

/** The command/tool the agent reached for, as a one-line preview. */
function previewText(ev: SeanceEvent): string {
  const g = ev.ghost;
  if (g?.command) return g.command;
  const sen = ev.kind === "governing" ? ev.pre : ev.sentinel;
  return sen?.reason ?? "(no command)";
}

function toolName(ev: SeanceEvent): string {
  const g = ev.ghost;
  const sen = ev.kind === "governing" ? ev.pre : ev.sentinel;
  return g?.tool ?? sen?.toolName ?? "unknown";
}

function shadowTable(shadow: ShadowReport): HTMLElement {
  const rows = shadow.probes.map((p) =>
    el(
      "tr",
      { class: p.bypass ? "probe bypass" : "probe" },
      el("td", { class: "mut" }, txt(p.mutation)),
      el("td", { class: "dec" }, txt(p.decision)),
      el("td", { class: "flag" }, p.bypass ? "☠ BYPASS" : "held"),
    ),
  );
  return el(
    "div",
    { class: "shadow-block" },
    el(
      "div",
      { class: "detail-label" },
      shadow.bypassFound ? "⚠ shadow red-team — a mutation EVADED sentinel" : "shadow red-team — all held",
    ),
    el(
      "table",
      { class: "shadow-table" },
      el(
        "thead",
        {},
        el("tr", {}, el("th", {}, "mutation"), el("th", {}, "verdict"), el("th", {}, "")),
      ),
      el("tbody", {}, frag(...rows)),
    ),
  );
}

function postLeg(p: SentinelLeg): HTMLElement {
  return el(
    "div",
    { class: "post-leg" },
    el("span", { class: "post-action", "data-action": p.action }, txt(p.action)),
    el("span", { class: "post-reason" }, txt(p.reason ?? "")),
    p.matchedRule ? el("span", { class: "post-rule" }, txt(p.matchedRule)) : null,
  );
}

/** The post-findings section — including the deny's EXPECTED absent note. */
function postSlot(ev: SeanceEvent): HTMLElement {
  const slot = el("div", { class: "post-slot" });
  fillPostSlot(slot, ev);
  return slot;
}

function fillPostSlot(slot: HTMLElement, ev: SeanceEvent): void {
  clear(slot);
  slot.appendChild(el("div", { class: "detail-label" }, "post findings"));
  const post = ev.kind === "governing" ? ev.post : [];
  if (post.length > 0) {
    for (const p of post) slot.appendChild(postLeg(p));
    return;
  }
  // No post line. If this call was DENIED, that is expected (PostToolUse does
  // not fire on a deny — pinned against Claude Code 2.1.207). Otherwise it is
  // simply awaiting the post phase.
  const denied = verdictOf(ev) === "deny";
  slot.appendChild(
    el(
      "div",
      { class: denied ? "post-note expected" : "post-note awaiting" },
      denied
        ? "⊘ no post-hook line — call was denied (this is expected)"
        : "… awaiting post phase",
    ),
  );
}

export function buildRow(ev: SeanceEvent): HTMLElement {
  const v = verdictOf(ev);
  const bypass = hasBypass(ev);
  const g = ev.ghost;
  const sen = ev.kind === "governing" ? ev.pre : ev.sentinel;

  const header = el(
    "button",
    { class: "row-header", "aria-expanded": "false", title: "expand" },
    el("span", { class: "gutter", "aria-hidden": "true" }),
    verdictChip(ev),
    bypass ? el("span", { class: "chip bypass-chip" }, "☓ BYPASS") : null,
    el(
      "span",
      { class: "row-main" },
      el("span", { class: "tool" }, txt(toolName(ev))),
      categoryBadge(g?.category),
      el("span", { class: "preview" }, txt(previewText(ev))),
    ),
    el("span", { class: "time" }, clockTime(ev.tsMs)),
    el("span", { class: "chevron", "aria-hidden": "true" }, "▸"),
  );

  // The roast — ghost's voice, given the drama it deserves.
  const roastEl = g?.roast
    ? el("blockquote", { class: "roast", "data-roast-id": g.roastId ?? "" }, txt(g.roast))
    : null;

  const ruleEl =
    sen?.matchedRule || sen?.reason
      ? el(
          "div",
          { class: "rule-line" },
          sen?.matchedRule ? el("code", { class: "rule" }, txt(sen.matchedRule)) : null,
          sen?.reason ? el("span", { class: "reason" }, txt(sen.reason)) : null,
        )
      : null;

  const body = el(
    "div",
    { class: "row-body", hidden: true },
    roastEl,
    ruleEl,
    g?.shadow ? shadowTable(g.shadow) : null,
    postSlot(ev),
    g?.command
      ? el(
          "div",
          { class: "mono-wrap" },
          el("div", { class: "detail-label" }, "command"),
          el("pre", { class: "mono-block" }, txt(g.command)),
        )
      : null,
  );

  const row = el(
    "div",
    {
      class: "row",
      "data-key": ev.key,
      "data-verdict": v,
      "data-category": g?.category ?? "",
    },
    header,
    body,
  );
  if (bypass) row.classList.add("bypass");
  if (ev.kind === "loose") row.classList.add("loose");

  header.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    header.setAttribute("aria-expanded", String(open));
    header.classList.toggle("expanded", open);
  });

  return row;
}

/** Patch an already-rendered row in place when a late post line (or a merge)
 * updates its event. Only the post slot + bypass state change; the command and
 * roast above are untouched, so no scroll jump. */
export function patchRow(row: HTMLElement, ev: SeanceEvent): void {
  const slot = row.querySelector<HTMLElement>(".post-slot");
  if (slot) fillPostSlot(slot, ev);
  if (hasBypass(ev)) row.classList.add("bypass");
}
