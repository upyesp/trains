import { mapLocationLineUp, mapServiceDetail } from '../lib/mapper';
import type { Board, BoardKind, ServiceDetail } from '../lib/types';
import type { RTTLocationResponse, RTTServiceDetailResponse } from '../lib/rtt';

/** Normalised outcome of one upstream RTT board fetch. */
export type RttFetchOutcome = { ok: true; data: Board } | { ok: false; retryAfterSec?: number };

/** Normalised outcome of one upstream RTT service fetch. A 404 is `notFound`
 * (definitive — callers must NOT serve stale for it); other failures are plain
 * errors and may fall back to stale-while-error. */
export type ServiceFetchOutcome =
  | { ok: true; data: ServiceDetail }
  | { ok: false; notFound?: boolean; retryAfterSec?: number };

/**
 * Pure: turn a raw RTT board HTTP result into our normalised outcome.
 * 200 -> map to Board; 204 -> empty board; anything else (429/4xx/5xx) -> error,
 * carrying Retry-After seconds when RTT provided it (so callers can back off).
 */
export function parseRttResult(
  status: number,
  body: unknown,
  retryAfterSec: number | null,
  ctx: { crs: string; kind: BoardKind; callsAt?: string | null },
): RttFetchOutcome {
  if (status === 204) {
    return { ok: true, data: { station: ctx.crs, kind: ctx.kind, services: [] } };
  }
  if (status === 200) {
    return { ok: true, data: mapLocationLineUp(body as RTTLocationResponse, ctx.crs, ctx.kind) };
  }
  if (status === 429) {
    return { ok: false, retryAfterSec: retryAfterSec ?? undefined };
  }
  return { ok: false };
}

/**
 * Pure: normalise a service uniqueIdentity for RTT's `/gb-nr/service` query.
 *
 * RTT returns `scheduleMetadata.uniqueIdentity` *with* a namespace prefix
 * (`gb-nr:L82949:2026-07-31`), but the `/gb-nr/service?uniqueIdentity=` query
 * param rejects that prefix and wants just `<identity>:<date>`
 * (`L82949:2026-07-31`) — the prefixed form makes RTT return 400, which surfaces
 * as a 503 here. Strip the leading namespace segment when present (three or more
 * colon-separated parts); a bare `<identity>:<date>` is passed through unchanged.
 */
export function serviceQueryIdentity(serviceId: string): string {
  const parts = serviceId.split(':');
  return parts.length >= 3 ? parts.slice(1).join(':') : serviceId;
}

/**
 * Pure: turn a raw RTT service HTTP result into our normalised outcome.
 * 200 -> map to ServiceDetail; 404 -> not-found (definitive, never stale);
 * 429 -> error + Retry-After; anything else -> plain error.
 */
export function parseServiceResult(
  status: number,
  body: unknown,
  retryAfterSec: number | null,
  serviceId: string,
): ServiceFetchOutcome {
  if (status === 200) {
    return { ok: true, data: mapServiceDetail(body as RTTServiceDetailResponse, serviceId) };
  }
  if (status === 404) {
    return { ok: false, notFound: true };
  }
  if (status === 429) {
    return { ok: false, retryAfterSec: retryAfterSec ?? undefined };
  }
  return { ok: false };
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into seconds.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.round((date - Date.now()) / 1000));
}
