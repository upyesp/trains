// Stale-while-error decision for any cached value (boards and service details).
// Generic over the cached payload so the same pure policy serves both: a board
// (per-station, /board) and a service-detail (per-service, /service).

/** A cached value plus the moment it was fetched (epoch ms). */
export interface CacheEntry<T = unknown> {
  data: T;
  asAt: number;
}

/** The outcome of an upstream fetch: either a fresh value, or a failure. */
export type FetchResult<T> = { ok: true; data: T } | { ok: false };

/**
 * What the proxy should serve to a client, per the stale-while-error policy (ADR-0003):
 * - `fresh` — serve the just-fetched value, not stale.
 * - `stale` — upstream failed, but a cached value exists; serve it, flagged stale, with its original timestamp.
 * - `unavailable` — upstream failed and there is nothing cached.
 */
export type ServeDecision<T> =
  | { status: 'fresh'; data: T; asAt: number }
  | { status: 'stale'; data: T; asAt: number }
  | { status: 'unavailable' };

/**
 * Decide what to serve given a (possibly null) cache entry and a fresh fetch
 * result. Pure of I/O, so fully unit-testable. Used by both the board and the
 * service-detail serve paths.
 */
export function selectToServe<T>(
  cache: CacheEntry<T> | null,
  fetched: FetchResult<T>,
  now: number,
): ServeDecision<T> {
  if (fetched.ok) {
    return { status: 'fresh', data: fetched.data, asAt: now };
  }

  if (cache) {
    return { status: 'stale', data: cache.data, asAt: cache.asAt };
  }

  return { status: 'unavailable' };
}
