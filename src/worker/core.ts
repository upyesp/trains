import { selectBoardToServe } from '../lib/cache';
import type { CacheEntry } from '../lib/cache';
import type { BoardKind, BoardResponse } from '../lib/types';
import { parseBoardRequest } from './router';
import type { RttFetchOutcome } from './rtt';

export interface WorkerResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchRtt = (ctx: { crs: string; kind: BoardKind }) => Promise<RttFetchOutcome>;

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export interface ServeConfig {
  /** Freshness window for the per-station cache, in seconds (ADR-0003: 30). */
  ttlSec: number;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '86400',
};

/**
 * Orchestrate one board request end-to-end: parse -> per-station cache (TTL) ->
 * fetch RTT -> map -> stale-while-error. Pure of platform: the RTT fetcher,
 * the cache, and the clock are all injected, so this is fully unit-testable
 * without Cloudflare. Returns a plain response descriptor; the adapter builds
 * the real `Response`.
 */
export async function serveBoard(
  input: { method: string; pathname: string; search: Record<string, string | undefined> },
  deps: { fetchRtt: FetchRtt; cache: CacheStore; now: number; config: ServeConfig },
): Promise<WorkerResponse> {
  if (input.method === 'OPTIONS') {
    return { status: 204, headers: { ...CORS_HEADERS }, body: null };
  }

  const parsed = parseBoardRequest(input.method, input.pathname, input.search);
  if (!parsed.ok) {
    const status =
      parsed.reason === 'method-not-allowed' ? 405 : parsed.reason === 'bad-kind' ? 400 : 404;
    return json(status, { error: parsed.reason });
  }

  const { crs, kind } = parsed.request;
  const cacheKey = `board:${crs}:${kind}`;
  const cached = await deps.cache.get(cacheKey);

  // Fresh cache hit: serve without calling RTT (the 30s cross-request dedup).
  if (cached && deps.now - cached.asAt < deps.config.ttlSec * 1000) {
    return json(200, { board: cached.board, asAt: cached.asAt, stale: false });
  }

  const fetched = await deps.fetchRtt({ crs, kind });
  const decision = selectBoardToServe(cached, fetched, deps.now);

  if (decision.status === 'unavailable') {
    return json(503, { error: 'unavailable' });
  }

  if (decision.status === 'fresh') {
    await deps.cache.set(cacheKey, { board: decision.board, asAt: decision.asAt });
  }

  return json(200, {
    board: decision.board,
    asAt: decision.asAt,
    stale: decision.status === 'stale',
  } satisfies BoardResponse);
}

/**
 * In-isolate memory cache. Persists across requests within a single Worker
 * isolate (giving cross-request dedup for the TTL window). Not shared across
 * isolates/regions; upgrade to the Cache API if global dedup is needed later.
 */
export function createMemoryCacheStore(): CacheStore {
  const store = new Map<string, CacheEntry>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, entry) {
      store.set(key, entry);
    },
  };
}

function json(status: number, body: unknown): WorkerResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    body,
  };
}
