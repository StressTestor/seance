// In-memory event store: arrival-indexed by key, with live/dropped deltas.
// No DOM knowledge. The timeline subscribes and mutates rows from deltas.

import type { SeanceBatch, SeanceEvent } from "../model/types";

export interface StoreDelta {
  added: SeanceEvent[];
  patched: SeanceEvent[];
  dropped: string[];
}

export type Subscriber = (d: StoreDelta) => void;

export class Store {
  private byKey = new Map<string, SeanceEvent>();
  private subs = new Set<Subscriber>();

  /** Seed from the backfill snapshot without emitting a delta (no animation). */
  seed(events: SeanceEvent[]): void {
    for (const ev of events) this.byKey.set(ev.key, ev);
  }

  /** Ingest a live batch, emitting the resulting delta to subscribers. */
  ingest(batch: SeanceBatch): void {
    const added: SeanceEvent[] = [];
    const patched: SeanceEvent[] = [];
    const dropped = batch.dropped ?? [];
    for (const key of dropped) this.byKey.delete(key);
    for (const ev of batch.events) {
      if (this.byKey.has(ev.key)) patched.push(ev);
      else added.push(ev);
      this.byKey.set(ev.key, ev);
    }
    if (added.length || patched.length || dropped.length) {
      const delta: StoreDelta = { added, patched, dropped };
      for (const s of this.subs) s(delta);
    }
  }

  subscribe(cb: Subscriber): void {
    this.subs.add(cb);
  }

  get(key: string): SeanceEvent | undefined {
    return this.byKey.get(key);
  }

  all(): SeanceEvent[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}
