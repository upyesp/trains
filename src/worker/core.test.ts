import { describe, expect, it } from 'vitest';
import {
  corsHeaders,
  createMemoryCacheStore,
  parseAllowedOrigins,
  serveBoard,
  serveServiceDetail,
} from './core';
import type { FetchRtt, FetchService } from './core';
import type { Board, ServiceDetail } from '../lib/types';

const ORIGIN = 'https://www.viptrains.org';

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
        coaches: null,
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
      return { ok: true, data: outcome };
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

const cfg = { ttlSec: 30, allowedOrigins: [ORIGIN] };

describe('corsHeaders', () => {
  it('reflects an allowlisted origin verbatim', () => {
    const h = corsHeaders(ORIGIN, [ORIGIN]);
    expect(h?.['access-control-allow-origin']).toBe(ORIGIN);
  });

  it("returns a wildcard when '*' is allowlisted", () => {
    const h = corsHeaders('https://evil.example', [ORIGIN, '*']);
    expect(h?.['access-control-allow-origin']).toBe('*');
  });

  it('omits CORS headers (null) for a non-allowlisted origin', () => {
    expect(corsHeaders('https://evil.example', [ORIGIN])).toBeNull();
  });

  it('omits CORS headers when no Origin header is present (allowlist mode)', () => {
    expect(corsHeaders(null, [ORIGIN])).toBeNull();
  });

  it('always sends Vary: Origin', () => {
    expect(corsHeaders(ORIGIN, [ORIGIN])?.['vary']).toBe('Origin');
    expect(corsHeaders('https://evil.example', ['*'])?.['vary']).toBe('Origin');
  });

  it('always sends the method/header/max-age baseline', () => {
    const h = corsHeaders(ORIGIN, [ORIGIN]);
    expect(h?.['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(h?.['access-control-allow-headers']).toBe('Content-Type');
    expect(h?.['access-control-max-age']).toBe('86400');
  });
});

describe('parseAllowedOrigins', () => {
  it('returns [] for undefined', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });
  it('parses a single origin', () => {
    expect(parseAllowedOrigins(ORIGIN)).toEqual([ORIGIN]);
  });
  it('parses a comma-separated allowlist, trimming whitespace', () => {
    expect(parseAllowedOrigins(' https://a.com , https://b.com ')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
  it('drops blanks and trailing commas', () => {
    expect(parseAllowedOrigins('https://a.com,,')).toEqual(['https://a.com']);
  });
});

describe('serveBoard', () => {
  it('answers a CORS preflight with 204 + reflected origin, without calling RTT', async () => {
    const cache = createMemoryCacheStore();
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'OPTIONS', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache, now: 0, config: cfg },
    );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toBe('Origin');
    expect(ff.calls()).toBe(0);
  });

  it('answers a preflight 204 but sends no Allow-Origin for a disallowed origin', async () => {
    const res = await serveBoard(
      { method: 'OPTIONS', pathname: '/board/WAT', search: {}, origin: 'https://evil.example' },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 404 for an unknown path', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/nope', search: {}, origin: ORIGIN },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a bad kind', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: { kind: 'x' }, origin: ORIGIN },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(400);
  });

  it('fetches, returns, and caches the board on a cache miss', async () => {
    const cache = createMemoryCacheStore();
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache, now: 1000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: board(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(1);
    expect(await cache.get('board:WAT:departures:-')).toEqual({ data: board(), asAt: 1000 });
  });

  it('serves a fresh cache hit without calling RTT, preserving the original timestamp', async () => {
    const cache = createMemoryCacheStore();
    await cache.set('board:WAT:departures:-', { data: board(), asAt: 1000 });
    const ff = okFetch(board());
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache, now: 5000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: board(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(0);
  });

  it('refetches once the cache is older than the TTL', async () => {
    const cache = createMemoryCacheStore();
    await cache.set('board:WAT:departures:-', { data: board(), asAt: 1000 });
    const ff = okFetch(board());
    // age = 40000ms > 30s TTL
    await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache, now: 41000, config: cfg },
    );
    expect(ff.calls()).toBe(1);
  });

  it('serves stale (flagged) with the original timestamp when upstream fails', async () => {
    const cache = createMemoryCacheStore();
    const cached = board();
    await cache.set('board:WAT:departures:-', { data: cached, asAt: 1000 });
    const ff = failFetch();
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache, now: 41000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ board: cached, asAt: 1000, stale: true });
  });

  it('returns 503 when upstream fails and nothing is cached', async () => {
    const ff = failFetch();
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: ff.fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(503);
  });

  it('attaches CORS + JSON headers to a normal response', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: ORIGIN },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('omits Allow-Origin when the request Origin is not allowlisted', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: {}, origin: 'https://evil.example' },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 400 for a bad callsAt CRS', async () => {
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: { callsAt: 'X' }, origin: ORIGIN },
      { fetchRtt: okFetch(board()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad-calls-at' });
  });

  it('threads the callsAt filter to the RTT fetcher under a distinct cache key', async () => {
    const cache = createMemoryCacheStore();
    const b = board();
    const seen: Array<{ crs: string; kind: string; callsAt: string | null }> = [];
    const fetchRtt: FetchRtt = async (ctx) => {
      seen.push({ crs: ctx.crs, kind: ctx.kind, callsAt: ctx.callsAt });
      return { ok: true, data: b };
    };
    const res = await serveBoard(
      { method: 'GET', pathname: '/board/WAT', search: { callsAt: 'CLJ' }, origin: ORIGIN },
      { fetchRtt, cache, now: 1000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ crs: 'WAT', kind: 'departures', callsAt: 'CLJ' }]);
    // A filtered board is cached under its own key, never shadowing the
    // unfiltered board for the same station under the shared per-station TTL.
    expect(await cache.get('board:WAT:departures:CLJ')).toEqual({ data: b, asAt: 1000 });
    expect(await cache.get('board:WAT:departures:-')).toBeNull();
  });
});

function detail(id = 'gb-nr:L1:2026-07-27'): ServiceDetail {
  return {
    id,
    origin: 'London Waterloo',
    destination: 'Weymouth',
    operator: 'SWR',
    coaches: 8,
    cancelled: false,
    points: [
      { station: 'London Waterloo', scheduledTime: '2026-07-27T08:05:00+01:00', expectedTime: '2026-07-27T08:05:00+01:00', platform: { number: '1', state: 'confirmed' }, cancelled: false },
      { station: 'Weymouth', scheduledTime: '2026-07-27T10:02:00+01:00', expectedTime: '2026-07-27T10:02:00+01:00', platform: null, cancelled: false },
    ],
  };
}

function okServiceFetch(d: ServiceDetail): { fetch: FetchService; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      n++;
      return { ok: true, data: d };
    },
    calls: () => n,
  };
}

function notFoundServiceFetch(): FetchService {
  return async () => ({ ok: false, notFound: true });
}

function failServiceFetch(): { fetch: FetchService; calls: () => number } {
  let n = 0;
  return {
    fetch: async () => {
      n++;
      return { ok: false };
    },
    calls: () => n,
  };
}

describe('serveServiceDetail', () => {
  const ID = 'gb-nr:L1:2026-07-27';

  it('answers a CORS preflight with 204 + reflected origin, without calling RTT', async () => {
    const ff = okServiceFetch(detail());
    const res = await serveServiceDetail(
      { method: 'OPTIONS', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: ff.fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ff.calls()).toBe(0);
  });

  it('fetches, returns, and caches the detail on a cache miss', async () => {
    const cache = createMemoryCacheStore();
    const ff = okServiceFetch(detail());
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: ff.fetch, cache, now: 1000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ detail: detail(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(1);
    expect(await cache.get(`service:${ID}`)).toEqual({ data: detail(), asAt: 1000 });
  });

  it('serves a fresh cache hit without calling RTT, preserving the original timestamp', async () => {
    const cache = createMemoryCacheStore();
    await cache.set(`service:${ID}`, { data: detail(), asAt: 1000 });
    const ff = okServiceFetch(detail());
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: ff.fetch, cache, now: 5000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ detail: detail(), asAt: 1000, stale: false });
    expect(ff.calls()).toBe(0);
  });

  it('returns 404 immediately (not stale) when RTT says the service is not found', async () => {
    const cache = createMemoryCacheStore();
    await cache.set(`service:${ID}`, { data: detail(), asAt: 1000 }); // a stale entry exists
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: notFoundServiceFetch(), cache, now: 41000, config: cfg },
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not-found' });
  });

  it('serves stale (flagged) when a transient upstream failure occurs and a cache exists', async () => {
    const cache = createMemoryCacheStore();
    const cached = detail();
    await cache.set(`service:${ID}`, { data: cached, asAt: 1000 });
    const ff = failServiceFetch();
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: ff.fetch, cache, now: 41000, config: cfg },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ detail: cached, asAt: 1000, stale: true });
  });

  it('returns 503 when upstream fails and nothing is cached', async () => {
    const ff = failServiceFetch();
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: ff.fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 when the id is missing/invalid', async () => {
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: {}, origin: ORIGIN },
      { fetchService: okServiceFetch(detail()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad-id' });
  });

  it('returns 404 for any path other than exactly /service', async () => {
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service/x', search: { id: ID }, origin: ORIGIN },
      { fetchService: okServiceFetch(detail()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.status).toBe(404);
  });

  it('attaches CORS + JSON headers to a normal response', async () => {
    const res = await serveServiceDetail(
      { method: 'GET', pathname: '/service', search: { id: ID }, origin: ORIGIN },
      { fetchService: okServiceFetch(detail()).fetch, cache: createMemoryCacheStore(), now: 0, config: cfg },
    );
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
