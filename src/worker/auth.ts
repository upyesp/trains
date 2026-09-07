// Access-token exchange for RTT's refresh-token model (ADR-0004 / research §2c).
//
// RTT issues a long-lived REFRESH token (held as a Worker secret in the adapter),
// never sent to board endpoints. It is exchanged for a short-lived access token
// via GET /api/get_access_token -> { token, entitlements, validUntil }, and the
// access token authorises /gb-nr/location calls. This module is pure of platform:
// the fetch, the store, and the clock are all injected, so it is fully unit-testable
// without Cloudflare.

/** A cached access token plus the moment it stops being valid (epoch ms). */
export interface AccessToken {
  token: string;
  expiresAt: number;
}

/** Normalised result of one /api/get_access_token call. */
export type AccessTokenOutcome = { ok: true; token: string; expiresAt: number } | { ok: false };

/** Raw shape the adapter hands us from the exchange endpoint. */
export type AccessTokenRawResult = { status: number; body: unknown };

/** Fetch the exchange response; null on network failure. */
export type FetchAccessToken = () => Promise<AccessTokenRawResult | null>;

/** Per-isolate store for the access token (mirrors the board CacheStore). */
export interface AccessTokenStore {
  get(): Promise<AccessToken | null>;
  set(entry: AccessToken): Promise<void>;
  clear(): Promise<void>;
}

/** Fallback TTL when RTT omits or mangles `validUntil` (1h is a safe ceiling). */
export const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Refresh this far before expiry, so we never serve a token about to lapse. */
export const REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Pure: turn the exchange response into a token + expiry.
 *
 * Defensive about `validUntil` — it may be an ISO datetime, epoch seconds, or
 * epoch milliseconds; an absent or unparseable value falls back to a fixed TTL,
 * so a weird field never breaks the refresh loop (the 401-retry in the adapter
 * is the backstop regardless).
 */
export function parseAccessTokenResult(
  status: number,
  body: unknown,
  now: number,
): AccessTokenOutcome {
  if (status !== 200) return { ok: false };
  const b = body as { token?: unknown; validUntil?: unknown } | null;
  if (!b || typeof b.token !== 'string' || b.token.length === 0) return { ok: false };
  return { ok: true, token: b.token, expiresAt: parseValidUntil(b.validUntil, now) };
}

function parseValidUntil(value: unknown, now: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything below ~year 2001 in ms (1e12) is epoch seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

/**
 * Return a non-expired access token, exchanging via the injected fetcher when the
 * cache is empty or about to expire. Returns null on any failure — the caller
 * then falls back to stale-while-error / 503 via selectBoardToServe.
 */
export async function getAccessToken(deps: {
  fetchAuth: FetchAccessToken;
  store: AccessTokenStore;
  now: number;
  refreshBufferMs?: number;
}): Promise<{ token: string } | null> {
  const buffer = deps.refreshBufferMs ?? REFRESH_BUFFER_MS;
  const cached = await deps.store.get();
  if (cached && deps.now < cached.expiresAt - buffer) {
    return { token: cached.token };
  }

  const raw = await deps.fetchAuth();
  if (!raw) return null;
  const parsed = parseAccessTokenResult(raw.status, raw.body, deps.now);
  if (!parsed.ok) return null;

  await deps.store.set({ token: parsed.token, expiresAt: parsed.expiresAt });
  return { token: parsed.token };
}

/** In-isolate memory store for the access token. */
export function createMemoryAccessTokenStore(): AccessTokenStore {
  let current: AccessToken | null = null;
  return {
    async get() {
      return current;
    },
    async set(entry) {
      current = entry;
    },
    async clear() {
      current = null;
    },
  };
}
