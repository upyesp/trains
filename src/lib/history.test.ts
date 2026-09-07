import { describe, it, expect } from 'vitest';
import {
  MAX_AGE_MS,
  isLive,
  prune,
  sortByRecent,
  recordVisit,
  withoutEntry,
  isValidEntry,
  type HistoryEntry,
} from './history';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** An entry whose train runs at `runIso` and was visited `visitDaysAgo` ago. */
function entry(
  id: string,
  opts: { runIso?: string; visitDaysAgo?: number; visitedAt?: number } = {},
): HistoryEntry {
  const visitDaysAgo = opts.visitDaysAgo ?? 0;
  return {
    id,
    origin: 'A',
    destination: 'B',
    operator: 'OP',
    originTime: opts.runIso ?? '2026-08-11T08:00:00',
    url: `/service/?id=${id}`,
    visitedAt: opts.visitedAt ?? NOW - visitDaysAgo * DAY,
  };
}

describe('isLive', () => {
  it('is live when both the visit and the running date are within two weeks', () => {
    expect(isLive(entry('1', { runIso: '2026-08-11T08:00:00', visitDaysAgo: 1 }), NOW)).toBe(true);
  });

  it('expires when the visit was more than two weeks ago', () => {
    expect(isLive(entry('1', { visitDaysAgo: 15 }), NOW)).toBe(false);
  });

  it('expires when the service ran more than two weeks ago (RTT limit)', () => {
    // Visited today, but the train ran 15 days ago → dead link.
    expect(isLive(entry('1', { runIso: '2026-07-26T08:00:00', visitDaysAgo: 0 }), NOW)).toBe(false);
  });

  it('keeps a just-visited old-ish service until it crosses two weeks', () => {
    expect(isLive(entry('1', { runIso: '2026-07-30T08:00:00', visitDaysAgo: 0 }), NOW)).toBe(true);
  });

  it('falls back to the visit clock alone when originTime is missing', () => {
    expect(isLive(entry('1', { runIso: '', visitDaysAgo: 1 }), NOW)).toBe(true);
    expect(isLive(entry('1', { runIso: '', visitDaysAgo: 15 }), NOW)).toBe(false);
  });
});

describe('prune', () => {
  it('drops only expired entries and preserves order', () => {
    const a = entry('a', { runIso: '2026-08-11T08:00:00', visitDaysAgo: 1 });
    const b = entry('b', { visitDaysAgo: 20 }); // expired visit
    const c = entry('c', { runIso: '2026-07-01T08:00:00', visitDaysAgo: 0 }); // expired run
    expect(prune([a, b, c], NOW)).toEqual([a]);
  });
});

describe('sortByRecent', () => {
  it('orders newest visit first', () => {
    const old = entry('old', { visitedAt: 1000 });
    const newer = entry('new', { visitedAt: 5000 });
    const mid = entry('mid', { visitedAt: 3000 });
    expect(sortByRecent([old, newer, mid]).map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the input', () => {
    const input = [entry('old', { visitedAt: 1000 }), entry('new', { visitedAt: 5000 })];
    sortByRecent(input);
    expect(input.map((e) => e.id)).toEqual(['old', 'new']);
  });
});

describe('recordVisit', () => {
  it('prepends a new visit, newest first', () => {
    const a = entry('a', { visitDaysAgo: 2 });
    const b = entry('b', { visitDaysAgo: 5 });
    const got = recordVisit([a, b], entry('c', { visitedAt: NOW }), NOW);
    expect(got.map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('upserts: a repeat visit bumps the existing entry to the top with a fresh timestamp', () => {
    const a = entry('a', { visitDaysAgo: 1 });
    const b = entry('b', { visitDaysAgo: 3 });
    const revisited = { ...entry('b'), visitedAt: NOW };
    const got = recordVisit([a, b], revisited, NOW);
    expect(got.map((e) => e.id)).toEqual(['b', 'a']);
    expect(got[0]!.visitedAt).toBe(NOW);
    expect(got.filter((e) => e.id === 'b')).toHaveLength(1);
  });

  it('prunes entries that have expired since the last visit', () => {
    const fresh = entry('fresh', { runIso: '2026-08-11T08:00:00', visitDaysAgo: 1 });
    const expired = entry('expired', { visitDaysAgo: 20 });
    const got = recordVisit([fresh, expired], entry('new', { visitedAt: NOW }), NOW);
    expect(got.map((e) => e.id)).toEqual(['new', 'fresh']);
  });

  it('caps the list at 100 entries (oldest dropped first)', () => {
    const HOUR = 60 * 60 * 1000;
    // e0 newest (NOW-1h) … e109 oldest (NOW-110h ≈ 4.6 days, all within window)
    const many = Array.from({ length: 110 }, (_, i) =>
      entry(`e${i}`, { visitedAt: NOW - (i + 1) * HOUR }),
    );
    const got = recordVisit(many, entry('brandnew', { visitedAt: NOW }), NOW);
    expect(got).toHaveLength(100);
    expect(got[0]!.id).toBe('brandnew');
    expect(got.find((e) => e.id === 'e109')).toBeUndefined(); // oldest dropped
    expect(got.at(-1)!.id).toBe('e98');                       // oldest survivor
  });
});

describe('withoutEntry', () => {
  it('removes only the matching id', () => {
    const a = entry('a');
    const b = entry('b');
    expect(withoutEntry([a, b], 'a')).toEqual([b]);
  });
  it('is a no-op for an unknown id', () => {
    const a = entry('a');
    expect(withoutEntry([a], 'zzz')).toEqual([a]);
  });
});

describe('isValidEntry', () => {
  const good = entry('x');
  it('accepts a well-formed entry', () => {
    expect(isValidEntry(good)).toBe(true);
  });
  it('rejects non-objects', () => {
    expect(isValidEntry(null)).toBe(false);
    expect(isValidEntry('x')).toBe(false);
    expect(isValidEntry([])).toBe(false);
  });
  it('rejects entries with wrong-typed or missing fields', () => {
    expect(isValidEntry({ ...good, id: 5 })).toBe(false);
    expect(isValidEntry({ ...good, visitedAt: 'x' })).toBe(false);
    expect(isValidEntry({ ...good, visitedAt: NaN })).toBe(false);
    expect(isValidEntry({ ...good, origin: undefined })).toBe(false);
  });
  it('accepts the optional board-station fields (newer entries)', () => {
    expect(
      isValidEntry({ ...good, boardStation: 'Andover', boardTime: '2026-08-11T09:21:00' }),
    ).toBe(true);
    // Older entries without the fields still validate (rendered from origin).
    expect(isValidEntry({ ...good, boardStation: undefined, boardTime: undefined })).toBe(true);
  });
  it('rejects wrongly-typed board fields', () => {
    expect(isValidEntry({ ...good, boardStation: 5 })).toBe(false);
    expect(isValidEntry({ ...good, boardTime: 7 })).toBe(false);
  });
});

describe('MAX_AGE_MS', () => {
  it('is exactly fourteen days', () => {
    expect(MAX_AGE_MS).toBe(14 * DAY);
  });
});
