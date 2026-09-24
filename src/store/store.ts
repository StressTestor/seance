// In-memory event store. Two faces:
//   1. the delta API (added/patched/dropped) the presence + live wiring use;
//   2. a flat, render-ready list (`flatList()`) the virtualized timeline and the
//      dashboard scan — maintained incrementally so a read is O(1) to obtain and
//      a single linear pass (filter / aggregate) is all any consumer ever does.
// No DOM knowledge, and — the point of this redesign — it holds ONE flattened
// copy per event, not the ~100k rendered rows the old design kept in the DOM and
// not a second nested copy: `pos` indexes into the single `flat` feed.

import type { SeanceBatch, SeanceEvent } from "../model/types";
import { flatView, type FlatEvent } from "../model/view";

export interface StoreDelta {
  added: SeanceEvent[];
  patched: SeanceEvent[];
  dropped: string[];
}

export type Subscriber = (d: StoreDelta) => void;

export class Store {
  // Arrival-order flat feed. Drops leave a `null` hole (merges are rare); every
  // consumer already does a linear pass, so the null-skip is free. Arrival order
  // tracks time order — the Rust backfill snapshot is pre-sorted and live batches
  // append newer events — so newest-first is just iterating this from the end.
  private flat: (FlatEvent | null)[] = [];
  private pos = new Map<string, number>(); // key -> index into `flat`; also the has()-check
  private subs = new Set<Subscriber>();

  /** Seed from the backfill snapshot without emitting a delta (no animation). */
  seed(events: SeanceEvent[]): void {
    for (const ev of events) this.upsert(ev);
  }

  /** Ingest a live batch, emitting the resulting delta to subscribers. */
  ingest(batch: SeanceBatch): void {
    const added: SeanceEvent[] = [];
    const patched: SeanceEvent[] = [];
    const dropped = batch.dropped ?? [];
    for (const key of dropped) this.remove(key);
    for (const ev of batch.events) {
      if (this.pos.has(ev.key)) patched.push(ev);
      else added.push(ev);
      this.upsert(ev);
    }
    if (added.length || patched.length || dropped.length) {
      const delta: StoreDelta = { added, patched, dropped };
      for (const s of this.subs) s(delta);
    }
  }

  private upsert(ev: SeanceEvent): void {
    const fv = flatView(ev);
    const at = this.pos.get(ev.key);
    if (at === undefined) {
      this.pos.set(ev.key, this.flat.length);
      this.flat.push(fv);
    } else {
      this.flat[at] = fv; // patch in place — same slot, no reorder
    }
  }

  private remove(key: string): void {
    const at = this.pos.get(key);
    if (at !== undefined) {
      this.flat[at] = null; // tombstone; consumers skip nulls
      this.pos.delete(key);
    }
  }

  subscribe(cb: Subscriber): void {
    this.subs.add(cb);
  }

  /** The flat feed (arrival order, may contain null tombstones). Consumers pass
   * over it once — filtering, windowing, or aggregating — and skip nulls. */
  flatList(): readonly (FlatEvent | null)[] {
    return this.flat;
  }

  get size(): number {
    return this.pos.size;
  }
}
