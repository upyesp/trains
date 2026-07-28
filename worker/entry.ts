// Cloudflare Worker adapter — the thin platform layer over the pure core.
// All logic lives in ../src/worker (parse + map + orchestrate + auth); this file
// just wires Cloudflare bindings: the refresh token (secret), fetch, and the clock.
//
// RTT uses a refresh-token model (ADR-0004 / research §2c): the long-lived
// REFRESH token is held as a secret here and is NEVER sent to board endpoints.
// It is exchanged for a short-lived access token via /api/get_access_token (cached
// until just before `validUntil`), and the access token authorises board calls.
// On a 401 we drop the cached access token and retry once.
//
// Token MUST live here as a secret, never in the client (RTT terms):
//   wrangler secret put RTT_TOKEN        # paste the REFRESH token
// For local dev, put it in worker/.dev.vars (gitignored).

import {
  createMemoryCacheStore,
  parseAllowedOrigins,
  serveBoard,
} from '../src/worker/core';
import { parseRetryAfter, parseRttResult } from '../src/worker/rtt';
import type { RttFetchOutcome } from '../src/worker/rtt';
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

// One cache per Worker isolate (see core.createMemoryCacheStore).
const cache = createMemoryCacheStore();
const authStore = createMemoryAccessTokenStore();

/** Origins allowed by CORS. Defaults to the production site; override via CORS_ORIGIN. */
const PRODUCTION_ORIGIN = 'https://trains.upyesp.org';
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

    const result = await serveBoard(
      {
        method: request.method,
        pathname: url.pathname,
        search,
        origin: request.headers.get('Origin'),
      },
      {
        fetchRtt: makeRttFetcher(env, authStore),
        cache,
        now: Date.now(),
        config: {
          ttlSec: Number(env.TTL_SEC ?? 30),
          allowedOrigins: resolveAllowedOrigins(env.CORS_ORIGIN),
        },
      },
    );

    const body = result.body === null ? null : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers: result.headers });
  },
};

function makeRttFetcher(env: Env, authStore: AccessTokenStore) {
  const apiBase = env.RTT_API_BASE ?? 'https://data.rtt.io';
  const version = env.RTT_API_VERSION;
  const refreshToken = env.RTT_TOKEN;
  const timeWindow = Number(env.TIME_WINDOW ?? 120);

  // Exchange the refresh token for a short-lived access token (cached in authStore).
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

  // Fetch the board with a given access token; null on network failure.
  const fetchBoardRaw = async (
    accessToken: string,
    ctx: { crs: string; kind: BoardKind },
  ): Promise<{ status: number; body: unknown; retryAfterSec: number | null } | null> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (version) headers.Version = version;
    const url = `${apiBase}/gb-nr/location?code=${encodeURIComponent(ctx.crs)}&timeWindow=${timeWindow}`;
    try {
      const res = await fetch(url, { headers });
      const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
      if (res.status === 204) return { status: 204, body: null, retryAfterSec };
      if (res.status === 200) return { status: 200, body: await res.json(), retryAfterSec };
      return { status: res.status, body: null, retryAfterSec };
    } catch {
      return null;
    }
  };

  return async (ctx: { crs: string; kind: BoardKind }): Promise<RttFetchOutcome> => {
    const at = await getAccessToken({ fetchAuth, store: authStore, now: Date.now() });
    if (!at) return { ok: false };

    let raw = await fetchBoardRaw(at.token, ctx);
    if (!raw) return { ok: false };

    // Access token expired early (clock skew / revocation): force a refresh and
    // retry once before giving up -> falls back to stale-while-error / 503.
    if (raw.status === 401) {
      await authStore.clear();
      const at2 = await getAccessToken({ fetchAuth, store: authStore, now: Date.now() });
      if (!at2) return { ok: false };
      raw = await fetchBoardRaw(at2.token, ctx);
      if (!raw) return { ok: false };
    }

    return parseRttResult(raw.status, raw.body, raw.retryAfterSec, ctx);
  };
}
