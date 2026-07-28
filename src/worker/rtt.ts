import { mapLocationLineUp } from '../lib/mapper';
import type { Board, BoardKind } from '../lib/types';
import type { RTTLocationResponse } from '../lib/rtt';

/** Normalised outcome of one upstream RTT fetch. */
export type RttFetchOutcome = { ok: true; board: Board } | { ok: false; retryAfterSec?: number };

/**
 * Pure: turn a raw RTT HTTP result into our normalised outcome.
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
    return { ok: true, board: { station: ctx.crs, kind: ctx.kind, services: [] } };
  }
  if (status === 200) {
    return { ok: true, board: mapLocationLineUp(body as RTTLocationResponse, ctx.crs, ctx.kind) };
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
