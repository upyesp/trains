import { describe, expect, it } from 'vitest';
import { createMemoryCacheStore, serveBoard } from './core';
import type { FetchRtt } from './core';
import type { Board } from '../lib/types';

function board(): Board {
  return {
    station: 'WAT',
    kind: 'departures',
    services: [
      {
        id: 's1',
        scheduledTime: '2026-07-27T08:05:00+01:00',
        expectedTime: '2026-07-27T08:05:00+01:00',
        platform: null,
        destination: 'Weymouth',
        operator: 'SWR',
        cancelled: false,
      },
    ],
  };
}

function okFetch(outcome: Board): { fetch: FetchRtt; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      n++;
      return { ok: true, board: outcome };
    },
    calls: () => n,
  };
}

function failFetch(): { fetch: FetchRtt; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      n++;
      return { ok: false };
    },
    calls: () => n,
  };
}

const cfg = { ttlSec: 30 };

describe('serveBoard', () => {
  it('answers a CORS preflight with 204 and CORS headers, without calling RTT', async () => {
    const cache = createMemoryCacheStore();
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'OPTIONS', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache, now: 0, config: cfg },
    );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(ff.calls()).toBe(0);
  });

  it('returns 404 for an unknown path', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/nope', search: {} },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a bad kind', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: { kind: 'x' } },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(400);
  });

  it('fetches, returns, and caches the board on a cache miss', async () => {
    const cache = createMemoryCacheStore();
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache, now: 1000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: board(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(1);
    expect(await cache.get('board:WAT:departures')).toEqual({ board: board(), asAt: 1000 });
  });

  it('serves a fresh cache hit without calling RTT, preserving the original timestamp', async () => {
    const cache = createMemoryCacheStore();
    await cache.set('board:WAT:departures', { board: board(), asAt: 1000 });
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache, now: 5000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: board(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(0);
  });

  it('refetches once the cache is older than the TTL', async () => {
    const cache = createMemoryCacheStore();
    await cache.set('board:WAT:departures', { board: board(), asAt: 1000 });
    const ff = okFetch(board());
    // age = 40000ms > 30s TTL
    await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache, now: 41000, config: cfg },
    );
    expect(ff.calls()).toBe(1);
  });

  it('serves stale (flagged) with the original timestamp when upstream fails', async () => {
    const cache = createMemoryCacheStore();
    const cached = board();
    await cache.set('board:WAT:departures', { board: cached, asAt: 1000 });
    const ff = failFetch();
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache, now: 41000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: cached, asAt: 1000, stale: true });
  });

  it('returns 503 when upstream fails and nothing is cached', async () => {
    const ff = failFetch();
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: ff.fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(503);
  });

  it('attaches CORS + JSON headers to a normal response', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {} },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['content-type']).toContain('application/json');
  });
});
