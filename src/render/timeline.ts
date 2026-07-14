// The timeline: the hero view. A live-tail layout — oldest at top, newest at the
// bottom, auto-scrolling like a terminal/`ghost watch` feed (deliberately chosen
// over newest-first so live appends are a single appendChild with no reordering
// and no scroll jank). Rows are keyed; a late post line patches in place.

import { buildRow, patchRow } from "./row";
import { el } from "./dom";
import { dayKey, dayLabel } from "../util/time";
import type { Presence } from "./presence";
import type { StoreDelta } from "../store/store";
import type { SeanceEvent } from "../model/types";

type Predicate = (ev: SeanceEvent) => boolean;

export class Timeline {
  private rowEl = new Map<string, HTMLElement>();
  private evByKey = new Map<string, SeanceEvent>();
  private lastDayKey = Number.NaN;
  private pred: Predicate = () => true;

  constructor(
    private container: HTMLElement,
    private presence: Presence,
  ) {}

  setPredicate(p: Predicate): void {
    this.pred = p;
    for (const [key, row] of this.rowEl) {
      const ev = this.evByKey.get(key);
      row.hidden = ev ? !this.pred(ev) : true;
    }
  }

  /** Seed from the backfill snapshot — no presence animation. */
  seed(events: SeanceEvent[]): void {
    const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
    for (const ev of sorted) this.addRow(ev);
    this.scrollToBottom();
  }

  /** Apply a live delta: drop merged rows, patch existing, append new. */
  applyDelta(delta: StoreDelta): void {
    const near = this.nearBottom();
    for (const key of delta.dropped) this.removeRow(key);
    for (const ev of delta.patched) {
      const row = this.rowEl.get(ev.key);
      if (row) {
        this.evByKey.set(ev.key, ev);
        patchRow(row, ev);
        row.hidden = !this.pred(ev);
        this.presence.pulseLatePost(row);
      } else {
        this.addRow(ev);
      }
    }
    for (const ev of delta.added) {
      this.addRow(ev);
      this.presence.react(ev);
    }
    if (near) this.scrollToBottom();
  }

  private addRow(ev: SeanceEvent): void {
    this.insertDividerIfNeeded(ev.tsMs);
    const row = buildRow(ev);
    row.hidden = !this.pred(ev);
    this.rowEl.set(ev.key, row);
    this.evByKey.set(ev.key, ev);
    this.container.appendChild(row);
  }

  private removeRow(key: string): void {
    const row = this.rowEl.get(key);
    if (row) row.remove();
    this.rowEl.delete(key);
    this.evByKey.delete(key);
  }

  private insertDividerIfNeeded(tsMs: number): void {
    const dk = dayKey(tsMs);
    if (dk !== this.lastDayKey && Number.isFinite(dk)) {
      this.container.appendChild(
        el("div", { class: "day-divider" }, `── ${dayLabel(tsMs)} ──`),
      );
      this.lastDayKey = dk;
    }
  }

  private nearBottom(): boolean {
    const c = this.container;
    return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
