// Cloudflare Worker adapter — the thin platform layer over the pure core.
// All logic lives in ../src/worker (parse + map + orchestrate); this file just
// wires Cloudflare bindings: the bearer token (secret), fetch, and the clock.
//
// Token MUST live here as a secret, never in the client (ADR-0004 / RTT terms):
//   wrangler secret put RTT_TOKEN
// For local dev, put it in worker/.dev.vars (gitignored).

import { createMemoryCacheStore, serveBoard } from '../src/worker/core';
import { parseRetryAfter, parseRttResult } from '../src/worker/rtt';
import type { RttFetchOutcome } from '../src/worker/rtt';
import type { BoardKind } from '../src/lib/types';

interface Env {
  RTT_TOKEN: string;
  RTT_API_VERSION?: string;
  RTT_API_BASE?: string;
  TIME_WINDOW?: string;
  TTL_SEC?: string;
}

// One cache per Worker isolate (see core.createMemoryCacheStore).
const cache = createMemoryCacheStore();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const search: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      search[key] = value;
    });

    const result = await serveBoard(
      { method: request.method, pathname: url.pathname, search },
      {
        fetchRtt: makeRttFetcher(env),
        cache,
        now: Date.now(),
        config: { ttlSec: Number(env.TTL_SEC ?? 30) },
      },
    );

    const body = result.body === null ? null : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers: result.headers });
  },
};

function makeRttFetcher(env: Env) {
  const apiBase = env.RTT_API_BASE ?? 'https://data.rtt.io';
  const version = env.RTT_API_VERSION;
  const token = env.RTT_TOKEN;
  const timeWindow = Number(env.TIME_WINDOW ?? 120);

  return async ({ crs, kind }: { crs: string; kind: BoardKind }): Promise<RttFetchOutcome> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (version) headers.Version = version;
    const url = `${apiBase}/gb-nr/location?code=${encodeURIComponent(crs)}&timeWindow=${timeWindow}`;

    try {
      const res = await fetch(url, { headers });
      const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 204) {
        return { ok: true, board: { station: crs, kind, services: [] } };
      }
      if (res.status === 200) {
        return parseRttResult(200, await res.json(), retryAfterSec, { crs, kind });
      }
      return parseRttResult(res.status, null, retryAfterSec, { crs, kind });
    } catch {
      // Network failure / abort -> let the orchestrator serve stale or 503.
      return { ok: false };
    }
  };
}
