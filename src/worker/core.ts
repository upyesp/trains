import { selectToServe } from '../lib/cache';
import type { CacheEntry } from '../lib/cache';
import type { Board, BoardKind, BoardResponse, ServiceDetail } from '../lib/types';
import { parseBoardRequest, parseContactRequest, parseServiceRequest } from './router';
import type { ContactInput } from './router';
import type { RttFetchOutcome, ServiceFetchOutcome } from './rtt';

export interface WorkerResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchRtt = (
  ctx: { crs: string; kind: BoardKind; callsAt: string | null },
) => Promise<RttFetchOutcome>;

export type FetchService = (id: string) => Promise<ServiceFetchOutcome>;

/**
 * Per-isolate key/value cache. The board and service paths share one store per
 * isolate (keys are namespaced `board:` / `service:`); each value is a
 * `CacheEntry<unknown>` that the serve path narrows to its own payload type.
 */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export interface ServeConfig {
  /** Freshness window for the per-station cache, in seconds (ADR-0003: 30). */
  ttlSec: number;
  /** Origins allowed to call the API cross-origin (reflected on a match). */
  allowedOrigins: readonly string[];
}

/** Fixed CORS baseline sent whenever a response is CORS-enabled. */
const CORS_BASE: Record<string, string> = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '86400',
  // Always vary on Origin so a cached allowed-origin response is never served
  // to a different origin (matters under any shared/edge caching).
  vary: 'Origin',
};

/**
 * Resolve CORS headers for a request given its Origin header and the configured
 * allowlist. Returns null when the Origin is not allowed, so the browser blocks
 * the response (CORS is enforced client-side; we just omit the header).
 *
 * A `*` entry opens the API to any origin. Otherwise the matched origin is
 * reflected verbatim — never combine a finite allowlist with credentials and
 * `*`. Pure of I/O, so fully unit-testable.
 */
export function corsHeaders(
  origin: string | null,
  allowed: readonly string[],
): Record<string, string> | null {
  if (allowed.includes('*')) {
    return { ...CORS_BASE, 'access-control-allow-origin': '*' };
  }
  if (origin && allowed.includes(origin)) {
    return { ...CORS_BASE, 'access-control-allow-origin': origin };
  }
  return null;
}

/**
 * Parse a comma-separated `CORS_ORIGIN` env var into an allowlist. Whitespace
 * is trimmed and blanks dropped. Returns [] when unset/empty (callers apply a
 * production default).
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Orchestrate one board request end-to-end: parse -> per-station cache (TTL) ->
 * fetch RTT -> map -> stale-while-error. Pure of platform: the RTT fetcher,
 * the cache, the clock, and the CORS allowlist are all injected, so this is
 * fully unit-testable without Cloudflare. Returns a plain response descriptor;
 * the adapter builds the real `Response`.
 */
export async function serveBoard(
  input: {
    method: string;
    pathname: string;
    search: Record<string, string | undefined>;
    origin: string | null;
  },
  deps: { fetchRtt: FetchRtt; cache: CacheStore; now: number; config: ServeConfig },
): Promise<WorkerResponse> {
  const cors = corsHeaders(input.origin, deps.config.allowedOrigins);

  // CORS preflight: always 204; browsers proceed only if we echoed the origin.
  if (input.method === 'OPTIONS') {
    return { status: 204, headers: cors ?? {}, body: null };
  }

  const parsed = parseBoardRequest(input.method, input.pathname, input.search);
  if (!parsed.ok) {
    const status =
      parsed.reason === 'method-not-allowed'
        ? 405
        : parsed.reason === 'bad-kind' || parsed.reason === 'bad-calls-at'
          ? 400
          : 404;
    return json(status, { error: parsed.reason }, cors);
  }

  const { crs, kind, callsAt } = parsed.request;
  // The "calling at" filter is part of the cache identity: a filtered and an
  // unfiltered board for the same station are different boards and must not
  // shadow each other under the shared per-station TTL cache.
  const cacheKey = `board:${crs}:${kind}:${callsAt ?? '-'}`;
  // The shared store holds CacheEntry<unknown>; the namespaced key guarantees
  // this entry is a Board, so the cast is sound.
  const cached = (await deps.cache.get(cacheKey)) as CacheEntry<Board> | null;

  // Fresh cache hit: serve without calling RTT (the 30s cross-request dedup).
  if (cached && deps.now - cached.asAt < deps.config.ttlSec * 1000) {
    return json(200, { board: cached.data, asAt: cached.asAt, stale: false }, cors);
  }

  const fetched = await deps.fetchRtt({ crs, kind, callsAt });
  const decision = selectToServe<Board>(cached, fetched, deps.now);

  if (decision.status === 'unavailable') {
    return json(503, { error: 'unavailable' }, cors);
  }

  if (decision.status === 'fresh') {
    await deps.cache.set(cacheKey, { data: decision.data, asAt: decision.asAt });
  }

  return json(
    200,
    {
      board: decision.data,
      asAt: decision.asAt,
      stale: decision.status === 'stale',
    } satisfies BoardResponse,
    cors,
  );
}

/**
 * Orchestrate one service-detail request: parse -> per-service cache (TTL) ->
 * fetch RTT -> map -> stale-while-error. A 404 from RTT is definitive, so it is
 * returned immediately and never served from a stale cache; other upstream
 * failures fall back to stale-while-error like the board. Pure of platform.
 */
export async function serveServiceDetail(
  input: {
    method: string;
    pathname: string;
    search: Record<string, string | undefined>;
    origin: string | null;
  },
  deps: { fetchService: FetchService; cache: CacheStore; now: number; config: ServeConfig },
): Promise<WorkerResponse> {
  const cors = corsHeaders(input.origin, deps.config.allowedOrigins);

  if (input.method === 'OPTIONS') {
    return { status: 204, headers: cors ?? {}, body: null };
  }

  const parsed = parseServiceRequest(input.method, input.pathname, input.search);
  if (!parsed.ok) {
    const status =
      parsed.reason === 'method-not-allowed' ? 405 : parsed.reason === 'bad-id' ? 400 : 404;
    return json(status, { error: parsed.reason }, cors);
  }

  const { id } = parsed.request;
  const cacheKey = `service:${id}`;
  const cached = (await deps.cache.get(cacheKey)) as CacheEntry<ServiceDetail> | null;

  if (cached && deps.now - cached.asAt < deps.config.ttlSec * 1000) {
    return json(200, { detail: cached.data, asAt: cached.asAt, stale: false }, cors);
  }

  const fetched = await deps.fetchService(id);

  if (!fetched.ok) {
    // A 404 means the service identity is unknown/expired — definitive. Never
    // mask it with a stale cached detail.
    if (fetched.notFound) return json(404, { error: 'not-found' }, cors);
    const decision = selectToServe<ServiceDetail>(cached, { ok: false }, deps.now);
    if (decision.status === 'unavailable') return json(503, { error: 'unavailable' }, cors);
    return json(200, { detail: decision.data, asAt: decision.asAt, stale: true }, cors);
  }

  await deps.cache.set(cacheKey, { data: fetched.data, asAt: deps.now });
  return json(200, { detail: fetched.data, asAt: deps.now, stale: false }, cors);
}

export type SendContactEmail = (request: ContactInput) => Promise<{ ok: boolean }>;

/** In-isolate sliding-window hit log per client IP (see createRateLimitStore). */
export type RateLimitStore = Map<string, number[]>;

export interface ContactConfig {
  /** Site base URL, used for the no-JS success redirect. */
  siteBase: string;
  /** Sliding-window throttle for form submissions, per client IP. */
  rateWindowMs: number;
  rateLimitMax: number;
}

/**
 * Sliding-window rate limiter, keyed by client IP. Pure of I/O. Returns true
 * when the caller is over the limit (and records nothing); false otherwise
 * (recording the hit). Stale hits fall out of the window, so the log is
 * self-pruning per key; orphaned keys are harmless in-memory.
 */
export function rateLimited(
  store: RateLimitStore,
  ip: string,
  now: number,
  windowMs: number,
  max: number,
): boolean {
  const cutoff = now - windowMs;
  const hits = (store.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) {
    store.set(ip, hits);
    return true;
  }
  hits.push(now);
  store.set(ip, hits);
  return false;
}

/**
 * Orchestrate one contact-form submission: parse -> validate -> per-IP rate
 * limit -> email -> respond. The email sender and the clock are injected, so
 * this is fully unit-testable. JSON responses for API-style requests; a 303
 * redirect to the site's success page when the request came from a native
 * (no-JS) form post (those send Accept: text/html).
 */
export async function serveContact(
  input: {
    method: string;
    pathname: string;
    body: string | null;
    origin: string | null;
    ip: string | null;
    acceptsHtml: boolean;
  },
  deps: {
    sendEmail: SendContactEmail;
    rateLimits: RateLimitStore;
    now: number;
    config: ServeConfig & ContactConfig;
  },
): Promise<WorkerResponse> {
  const cors = corsHeaders(input.origin, deps.config.allowedOrigins);

  // CORS preflight: always 204; browsers proceed only if we echoed the origin.
  if (input.method === 'OPTIONS') {
    return { status: 204, headers: cors ?? {}, body: null };
  }

  const parsed = parseContactRequest(input.method, input.pathname, input.body);
  if (!parsed.ok) {
    const status =
      parsed.reason === 'method-not-allowed' ? 405 : parsed.reason === 'bad-request' ? 400 : 404;
    return json(status, { error: parsed.reason, issues: parsed.issues ?? [] }, cors);
  }

  // Valid submissions only spend the throttle budget; honeypot hits and bad
  // payloads return before this point.
  if (
    rateLimited(
      deps.rateLimits,
      input.ip ?? 'unknown',
      deps.now,
      deps.config.rateWindowMs,
      deps.config.rateLimitMax,
    )
  ) {
    return json(429, { error: 'rate-limited' }, cors);
  }

  const sent = await deps.sendEmail(parsed.request);
  if (!sent.ok) {
    return json(503, { error: 'email-failed' }, cors);
  }

  // No-JS fallback: bounce to the site's success page rather than dumping JSON.
  if (input.acceptsHtml) {
    return {
      status: 303,
      headers: { location: `${deps.config.siteBase}/contact?sent=1`, ...(cors ?? {}) },
      body: null,
    };
  }
  return json(200, { ok: true }, cors);
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

function json(
  status: number,
  body: unknown,
  cors: Record<string, string> | null,
): WorkerResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(cors ?? {}) },
    body,
  };
}
