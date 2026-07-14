// The only two Tauri surfaces the app touches: invoke() for the initial backfill
// + status, and listen() for live batches. Isolated here so an API change moves
// one file. Includes a graceful no-Tauri fallback so `vite dev` in a plain
// browser (for design work) shows an empty, non-crashing shell.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SeanceBatch, SeanceEvent } from "../model/types";

const EVENT_NAME = "seance://event";

/** Are we actually running inside a Tauri webview? */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface Status {
  skipped: number;
  sentinelPath: string;
  ghostPath: string;
  sentinelExists: boolean;
  ghostExists: boolean;
}

export async function backfill(): Promise<SeanceEvent[]> {
  if (!inTauri()) return [];
  try {
    return await invoke<SeanceEvent[]>("backfill");
  } catch {
    return [];
  }
}

export async function fetchStatus(): Promise<Status | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<Status>("status");
  } catch {
    return null;
  }
}

export async function onBatch(cb: (b: SeanceBatch) => void): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  return listen<SeanceBatch>(EVENT_NAME, (e) => cb(e.payload));
}
