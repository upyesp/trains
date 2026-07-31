// Cloudflare Worker adapter — the thin platform layer over the pure core.
// All logic lives in ../src/worker (parse + map + orchestrate + auth); this file
// just wires Cloudflare bindings: the refresh token (secret), fetch, and the clock.
//
// RTT uses a refresh-token model (ADR-0004 / research §2c): the long-lived
// REFRESH token is held as a secret here and is NEVER sent to board/service
// endpoints. It is exchanged for a short-lived access token via
// /api/get_access_token (cached until just before `validUntil`), and the access
// token authorises every /gb-nr/* call. On a 401 we drop the cached access token
// and retry once.
//
// Two routes share one authed-GET helper:
//   GET /board/<CRS>   -> serveBoard   (/gb-nr/location)
//   GET /service?id=…  -> serveServiceDetail (/gb-nr/service)
//
// Token MUST live here as a secret, never in the client (RTT terms):
//   wrangler secret put RTT_TOKEN        # paste the REFRESH token
// For local dev, put it in worker/.dev.vars (gitignored).

import {
  createMemoryCacheStore,
  parseAllowedOrigins,
  serveBoard,
  serveServiceDetail,
} from '../src/worker/core';
import { parseRetryAfter, parseRttResult, parseServiceResult } from '../src/worker/rtt';
import type { RttFetchOutcome, ServiceFetchOutcome } from '../src/worker/rtt';
import { createMemoryAccessTokenStore, getAccessToken } from '../src/worker/auth';
import type { AccessTokenStore, FetchAccessToken } from '../src/worker/auth';
import type { BoardKind } from '../src/lib/types';

interface Env {
  RTT_TOKEN: string; // refresh token
  RTT_API_VERSION?: string;
  RTT_API_BASE?: string;
  TIME_WINDOW?: string;
  TTL_SEC?: string;
  CORS_ORIGIN?: string; // comma-separated allowlist; defaults to production site
}

// One cache per route per Worker isolate (see core.createMemoryCacheStore).
// Keys are namespaced (`board:` / `service:`) so they never collide.
const boardCache = createMemoryCacheStore();
const serviceCache = createMemoryCacheStore();
const authStore = createMemoryAccessTokenStore();

/** Origins allowed by CORS. Defaults to the production site; override via CORS_ORIGIN. */
const PRODUCTION_ORIGIN = 'https://www.viptrains.org';
function resolveAllowedOrigins(raw: string | undefined): string[] {
  const parsed = parseAllowedOrigins(raw);
  return parsed.length > 0 ? parsed : [PRODUCTION_ORIGIN];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const search: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      search[key] = value;
    });

    const input = {
      method: request.method,
      pathname: url.pathname,
      search,
      origin: request.headers.get('Origin'),
    };
    const config = {
      ttlSec: Number(env.TTL_SEC ?? 30),
      allowedOrigins: resolveAllowedOrigins(env.CORS_ORIGIN),
    };
    const now = Date.now();
    const authedGet = makeAuthedGet(env, authStore);

    // /service (exact) is the service-detail route; everything else falls
    // through to the board route, which 404s unknown paths.
    const result =
      url.pathname === '/service'
        ? await serveServiceDetail(input, {
            fetchService: makeServiceFetcher(authedGet),
            cache: serviceCache,
            now,
            config,
          })
        : await serveBoard(input, {
            fetchRtt: makeBoardFetcher(env, authedGet),
            cache: boardCache,
            now,
            config,
          });

    const body = result.body === null ? null : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers: result.headers });
  },
};

/**
 * Build a single authenticated-GET helper shared by the board and service
 * routes. Handles the access-token exchange + the one-shot 401 refresh-retry, so
 * both routes get identical auth behaviour without duplicating the loop.
 * Returns null on network failure (callers treat that as a plain fetch error).
 */
function makeAuthedGet(env: Env, authStore: AccessTokenStore) {
  const apiBase = env.RTT_API_BASE ?? 'https://data.rtt.io';
  const version = env.RTT_API_VERSION;
  const refreshToken = env.RTT_TOKEN;

  const fetchAuth: FetchAccessToken = async () => {
    try {
      const res = await fetch(`${apiBase}/api/get_access_token`, {
        headers: { Authorization: `Bearer ${refreshToken}` },
      });
      return { status: res.status, body: await res.json() };
    } catch {
      return null;
    }
  };

  async function doGet(
    path: string,
  ): Promise<{ status: number; body: unknown; retryAfterSec: number | null } | null> {
    const at = await getAccessToken({ fetchAuth, store: authStore, now: Date.now() });
    if (!at) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${at.token}` };
    if (version) headers.Version = version;
    try {
      const res = await fetch(`${apiBase}${path}`, { headers });
      const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 204) return { status: 204, body: null, retryAfterSec };
      if (res.status === 200) return { status: 200, body: await res.json(), retryAfterSec };
      return { status: res.status, body: null, retryAfterSec };
    } catch {
      return null;
    }
  }

  return async (path: string) => {
    let raw = await doGet(path);
    if (!raw) return null;

    // Access token expired early (clock skew / revocation): force a refresh and
    // retry once before giving up -> falls back to stale-while-error / 503.
    if (raw.status === 401) {
      await authStore.clear();
      raw = await doGet(path);
    }
    return raw;
  };
}

/** Board route fetcher: /gb-nr/location with the "calling at" filter mapping. */
function makeBoardFetcher(
  env: Env,
  authedGet: (path: string) => Promise<{ status: number; body: unknown; retryAfterSec: number | null } | null>,
) {
  const timeWindow = Number(env.TIME_WINDOW ?? 120);

  return async (ctx: { crs: string; kind: BoardKind; callsAt: string | null }): Promise<RttFetchOutcome> => {
    // The optional "calling at" filter is applied upstream by RTT: departures
    // keep trains that SUBSEQUENTLY call there (filterTo); arrivals keep trains
    // that PREVIOUSLY called there (filterFrom). One call either way — RTT knows
    // the full calling pattern, so this costs no extra requests.
    const params = new URLSearchParams();
    params.set('code', ctx.crs);
    params.set('timeWindow', String(timeWindow));
    if (ctx.callsAt) {
      params.set(ctx.kind === 'departures' ? 'filterTo' : 'filterFrom', ctx.callsAt);
    }
    const raw = await authedGet(`/gb-nr/location?${params.toString()}`);
    return raw ? parseRttResult(raw.status, raw.body, raw.retryAfterSec, ctx) : { ok: false };
  };
}

/** Service-detail route fetcher: /gb-nr/service?uniqueIdentity=<id>. */
function makeServiceFetcher(
  authedGet: (path: string) => Promise<{ status: number; body: unknown; retryAfterSec: number | null } | null>,
) {
  return async (id: string): Promise<ServiceFetchOutcome> => {
    const params = new URLSearchParams();
    params.set('uniqueIdentity', id);
    const raw = await authedGet(`/gb-nr/service?${params.toString()}`);
    return raw ? parseServiceResult(raw.status, raw.body, raw.retryAfterSec, id) : { ok: false };
  };
}
