// Client-side history of calling-points (service detail) pages visited.
//
// Lives ENTIRELY in localStorage and is never sent anywhere (see the Privacy
// page). The pure logic below — expiry, dedupe, ordering, cap — takes and
// returns plain arrays so it can be unit-tested in Node (no DOM); the thin
// storage wrappers (loadHistory / saveHistory / recordServiceVisit /
// clearHistory) sit on top.
//
// Entries expire after TWO WEEKS, by two clocks:
//   - when they were VISITED ("visited in the last two weeks"), and
//   - the service's RUNNING DATE — RTT only serves service details for ~two
//     weeks, so an entry whose train ran earlier would link to a dead page.

import type { ServiceDetail } from './types';

export const HISTORY_KEY = 'viptrains:history';
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // two weeks
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  /** RTT service uniqueIdentity — the dedupe key (re-visiting a service bumps
   *  it to the top rather than duplicating). */
  id: string;
  /** Scheduled origin station name. */
  origin: string;
  /** Scheduled final destination name. */
  destination: string;
  /** Train Operating Company. */
  operator: string;
  /** ISO scheduled departure at the origin — the service's running date, used
   *  for the RTT two-week expiry. Naive UK-local ISO, sliced/compared loosely. */
  originTime: string;
  /** The calling-points page URL (/service/?id=…), stored so the list links
   *  straight back to it. */
  url: string;
  /** epoch ms of the visit. */
  visitedAt: number;
}

/** Is an entry still within the two-week window? Both clocks must be fresh: the
 *  visit (the list is "visited in the last two weeks") and the running date
 *  (RTT won't serve an older service). A missing/unparseable originTime falls
 *  back to the visit clock alone. Pure. */
export function isLive(e: HistoryEntry, now: number): boolean {
  if (now - e.visitedAt > MAX_AGE_MS) return false;
  const runMs = Date.parse(e.originTime);
  if (!Number.isNaN(runMs) && now - runMs > MAX_AGE_MS) return false;
  return true;
}

/** Drop expired entries. Pure: returns a new array (order preserved). */
export function prune(entries: readonly HistoryEntry[], now: number): HistoryEntry[] {
  return entries.filter((e) => isLive(e, now));
}

/** Newest visit first. Pure: returns a new array. */
export function sortByRecent(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.visitedAt - a.visitedAt);
}

/** Record a visit: upsert by id (a repeat visit replaces the old entry with a
 *  fresh timestamp at the top), prune expired entries, then cap the length.
 *  Pure: returns the new list, newest first. */
export function recordVisit(
  entries: readonly HistoryEntry[],
  entry: HistoryEntry,
  now: number,
): HistoryEntry[] {
  const without = entries.filter((e) => e.id !== entry.id);
  const next = sortByRecent([entry, ...without]);
  return prune(next, now).slice(0, MAX_ENTRIES);
}

/** Remove a single entry by id. Pure: returns a new array. */
export function withoutEntry(entries: readonly HistoryEntry[], id: string): HistoryEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** Runtime shape guard for data read back from localStorage (which may hold
 *  anything — older schemas, hand-edited JSON, garbage). */
export function isValidEntry(e: unknown): e is HistoryEntry {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.origin === 'string' &&
    typeof o.destination === 'string' &&
    typeof o.operator === 'string' &&
    typeof o.originTime === 'string' &&
    typeof o.url === 'string' &&
    typeof o.visitedAt === 'number' &&
    Number.isFinite(o.visitedAt)
  );
}

// ---- Thin localStorage wrappers (browser only; not unit-tested) ----

/** Read, validate and prune the history. Returns newest-first, or [] on any
 *  storage/parse error (private mode, disabled storage, corrupt JSON). */
export function loadHistory(): HistoryEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(HISTORY_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return sortByRecent(prune(parsed.filter(isValidEntry), Date.now()));
}

/** Persist the list. Silently no-ops if storage is unavailable/full (the page
 *  keeps working for the session; history just won't survive a reload). */
export function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* storage disabled or quota exceeded — nothing to do */
  }
}

/** Record a visit to a service's calling-points page (called from the service
 *  page once its detail has loaded). No-ops on storage errors. */
export function recordServiceVisit(d: ServiceDetail): void {
  if (!d.id || !d.origin) return;
  const entry: HistoryEntry = {
    id: d.id,
    origin: d.origin,
    destination: d.destination,
    operator: d.operator,
    originTime: d.points[0]?.scheduledTime ?? '',
    url: `/service/?id=${encodeURIComponent(d.id)}`,
    visitedAt: Date.now(),
  };
  saveHistory(recordVisit(loadHistory(), entry, Date.now()));
}

/** Empty the history. */
export function clearHistory(): void {
  saveHistory([]);
}
