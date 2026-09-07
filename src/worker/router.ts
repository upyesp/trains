import type { BoardKind } from '../lib/types';

export interface BoardRequest {
  crs: string;
  kind: BoardKind;
  /** Optional "calling at" filter (CRS). Null when no filter is requested. */
  callsAt: string | null;
  /** Optional lookback in minutes (0-180) for the "preceding hour" platform
   *  view; RTT is asked for `timeFrom = now - lookback`. Null = the default
   *  forward-only window. */
  lookback: number | null;
}

export type ParseResult =
  | { ok: true; request: BoardRequest }
  | {
      ok: false;
      reason: 'not-found' | 'method-not-allowed' | 'bad-kind' | 'bad-calls-at' | 'bad-lookback';
    };

/** A service-detail request: a single RTT `uniqueIdentity`. */
export interface ServiceRequest {
  id: string;
}

export type ServiceParseResult =
  | { ok: true; request: ServiceRequest }
  | { ok: false; reason: 'not-found' | 'method-not-allowed' | 'bad-id' };

const CRS = /^[A-Z]{3}$/;
const PREFIX = '/board/';

/**
 * Parse a board request: `GET /board/<CRS>?kind=departures|arrivals&callsAt=<CRS>`.
 * Pure: takes already-split request components so it has no platform dependency.
 * CRS is normalised to uppercase; `kind` defaults to `departures`. The optional
 * `callsAt` ("calling at") filter is a CRS that the Worker maps to RTT's
 * `filterTo` (departures — trains subsequently calling there) / `filterFrom`
 * (arrivals — trains that previously called there); null when absent.
 */
export function parseBoardRequest(
  method: string,
  pathname: string,
  search: Record<string, string | undefined>,
): ParseResult {
  if (!pathname.startsWith(PREFIX)) return { ok: false, reason: 'not-found' };
  if (method !== 'GET') return { ok: false, reason: 'method-not-allowed' };

  const crs = pathname.slice(PREFIX.length).toUpperCase();
  if (!CRS.test(crs)) return { ok: false, reason: 'not-found' };

  const kindRaw = search['kind'] ?? 'departures';
  if (kindRaw !== 'departures' && kindRaw !== 'arrivals') {
    return { ok: false, reason: 'bad-kind' };
  }

  const callsRaw = search['callsAt'];
  const callsAt = callsRaw ? callsRaw.toUpperCase() : null;
  if (callsAt && !CRS.test(callsAt)) {
    return { ok: false, reason: 'bad-calls-at' };
  }

  // Optional lookback (minutes) — the platform view's "preceding hour".
  // Digits only, 0-180; anything else is a client bug, not a route.
  const lookbackRaw = search['lookback'];
  let lookback: number | null = null;
  if (lookbackRaw !== undefined) {
    if (!/^[0-9]{1,3}$/.test(lookbackRaw)) return { ok: false, reason: 'bad-lookback' };
    lookback = Number(lookbackRaw);
    if (lookback > 180) return { ok: false, reason: 'bad-lookback' };
  }

  return { ok: true, request: { crs, kind: kindRaw, callsAt, lookback } };
}

// RTT uniqueIdentity characters: namespace prefix (`gb-nr:`), the identity
// (letters+digits), and the departure date (`-`). Colons separate the parts.
// We accept only these and reject everything else (slashes, spaces, queries).
const SERVICE_ID = /^[A-Za-z0-9:_-]+$/;

/**
 * Parse a service-detail request: `GET /service?id=<uniqueIdentity>`. Pure.
 *
 * The id is an RTT `uniqueIdentity` (e.g. `gb-nr:L01525:2026-07-27`, or the
 * shorter `L01525:2026-07-27`). It is validated against a safe charset rather
 * than a strict shape, so we never reject a valid RTT id while still refusing
 * path/query metacharacters. Empty/absent -> `bad-id`. Only the exact path
 * `/service` is matched; sub-paths are not-found.
 */
export function parseServiceRequest(
  method: string,
  pathname: string,
  search: Record<string, string | undefined>,
): ServiceParseResult {
  if (pathname !== '/service') return { ok: false, reason: 'not-found' };
  if (method !== 'GET') return { ok: false, reason: 'method-not-allowed' };

  const id = search['id'];
  if (!id || !SERVICE_ID.test(id)) return { ok: false, reason: 'bad-id' };

  return { ok: true, request: { id } };
}

// ---- Contact form ----

/** A validated contact-form submission. */
export interface ContactInput {
  name: string;
  email: string;
  message: string;
}

/** One field-level validation failure, for the JSON error body. */
export interface ContactIssue {
  field: 'name' | 'email' | 'message';
  code: 'required' | 'too-long' | 'invalid-email';
}

export type ContactParseResult =
  | { ok: true; request: ContactInput }
  | {
      ok: false;
      reason: 'not-found' | 'method-not-allowed' | 'bad-request';
      /** Field-level failures (present when reason is bad-request). */
      issues?: ContactIssue[];
    };

const NAME_MAX = 100;
const EMAIL_MAX = 254;
const MESSAGE_MAX = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a contact-form submission: `POST /contact` with an
 * `application/x-www-form-urlencoded` body (`name`, `email`, `message`, plus
 * the `website` honeypot field that bots fill in — it must be empty). Pure:
 * takes the already-read body string, so it is fully unit-testable. Native
 * (no-JS) form posts and the JS client both send this shape — urlencoded is a
 * CORS "simple request", so the browser needs no preflight for it.
 */
export function parseContactRequest(
  method: string,
  pathname: string,
  rawBody: string | null,
): ContactParseResult {
  if (pathname !== '/contact') return { ok: false, reason: 'not-found' };
  if (method !== 'POST') return { ok: false, reason: 'method-not-allowed' };

  const params = new URLSearchParams(rawBody ?? '');
  const name = (params.get('name') ?? '').trim();
  const email = (params.get('email') ?? '').trim();
  const message = (params.get('message') ?? '').trim();
  const honeypot = (params.get('website') ?? '').trim();

  // Bots fill the hidden honeypot field; a real user never sees it. Reject
  // without spending rate-limit budget.
  if (honeypot.length > 0) return { ok: false, reason: 'bad-request' };

  const issues: ContactIssue[] = [];
  if (name.length === 0) issues.push({ field: 'name', code: 'required' });
  else if (name.length > NAME_MAX) issues.push({ field: 'name', code: 'too-long' });

  if (email.length === 0) issues.push({ field: 'email', code: 'required' });
  else if (email.length > EMAIL_MAX) issues.push({ field: 'email', code: 'too-long' });
  else if (!EMAIL_RE.test(email)) issues.push({ field: 'email', code: 'invalid-email' });

  if (message.length === 0) issues.push({ field: 'message', code: 'required' });
  else if (message.length > MESSAGE_MAX) issues.push({ field: 'message', code: 'too-long' });

  if (issues.length > 0) return { ok: false, reason: 'bad-request', issues };

  return { ok: true, request: { name, email, message } };
}
