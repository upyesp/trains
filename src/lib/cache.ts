import type { Board } from './types';

/** A cached board plus the moment it was fetched (epoch ms). */
export interface CacheEntry {
  board: Board;
  asAt: number;
}

/** The outcome of an upstream fetch: either a fresh board, or a failure. */
export type FetchResult = { ok: true; board: Board } | { ok: false };

/**
 * What the proxy should serve to a client, per the stale-while-error policy (ADR-0003):
 * - `fresh` — serve the just-fetched board, not stale.
 * - `stale` — upstream failed, but a cached board exists; serve it, flagged stale, with its original timestamp.
 * - `unavailable` — upstream failed and there is nothing cached.
 */
export type ServeDecision =
  | { status: 'fresh'; board: Board; asAt: number }
  | { status: 'stale'; board: Board; asAt: number }
  | { status: 'unavailable' };

export function selectBoardToServe(
  cache: CacheEntry | null,
  fetched: FetchResult,
  now: number,
): ServeDecision {
  if (fetched.ok) {
    return { status: 'fresh', board: fetched.board, asAt: now };
  }

  if (cache) {
    return { status: 'stale', board: cache.board, asAt: cache.asAt };
  }

  return { status: 'unavailable' };
}
