// Pure formatting helpers used by the Astro client. No DOM types.

/**
 * Render a board time as "HH:MM".
 *
 * Our DTO times are UK-local-as-written in naive ISO ("2026-07-28T11:45:00").
 * We display them VERBATIM rather than converting to the viewer's timezone - a
 * UK board should read 11:45 whether you're in London or Lahore - so we slice
 * the ISO string directly, avoiding any Date/timezone reinterpretation.
 */
export function fmtTime(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * Render the Worker's "as at" epoch-ms timestamp as "HH:MM".
 * `asAt` is a real UTC instant, so local-timezone rendering is appropriate here.
 */
export function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Render a duration in minutes as "1h 23m" / "45m" / "2h". Empty string for
 * null, undefined, or non-positive values. Shared by the board (per-service
 * origin→destination duration) and the service-detail journey time.
 */
export function fmtDurationMin(mins: number | null | undefined): string {
  if (mins == null || mins <= 0 || !Number.isFinite(mins)) return '';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins) % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
