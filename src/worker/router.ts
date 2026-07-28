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
