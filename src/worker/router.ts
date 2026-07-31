import type { BoardKind } from '../lib/types';

export interface BoardRequest {
  crs: string;
  kind: BoardKind;
  /** Optional "calling at" filter (CRS). Null when no filter is requested. */
  callsAt: string | null;
}

export type ParseResult =
  | { ok: true; request: BoardRequest }
  | { ok: false; reason: 'not-found' | 'method-not-allowed' | 'bad-kind' | 'bad-calls-at' };

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

  return { ok: true, request: { crs, kind: kindRaw, callsAt } };
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
