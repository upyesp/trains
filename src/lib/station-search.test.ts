import { describe, it, expect } from 'vitest';
import { searchStations, type Station } from './station-search';

const s = (crs: string, name: string): Station => ({
  crs,
  name,
  country: 'england',
  lat: null,
  long: null,
});

// Name-sorted, mirroring how the real list is generated.
const LIST: Station[] = [
  s('EUS', 'London Euston'),
  s('KGX', "London King's Cross"),
  s('PAD', 'London Paddington'),
  s('MAN', 'Manchester Piccadilly'),
  s('PBO', 'Peterborough'),
  s('PNZ', 'Penzance'),
  s('RDG', 'Reading'),
];

describe('searchStations', () => {
  it('returns the first `limit` stations for an empty query', () => {
    expect(searchStations(LIST, '', 3)).toEqual(LIST.slice(0, 3));
  });

  it('ranks an exact CRS match first, case-insensitively', () => {
    const r = searchStations(LIST, 'pad', 10);
    expect(r[0]).toEqual(expect.objectContaining({ crs: 'PAD' }));
  });

  it('ranks CRS-code prefixes ahead of name-only matches', () => {
    // "p" -> CRS prefix: PAD, PBO, PNZ; name-only: MAN (Piccadilly)
    const r = searchStations(LIST, 'p', 10).map((x) => x.crs);
    const firstNonCrs = r.findIndex((c) => !c.startsWith('P'));
    const lastCrs = r.map((c) => c.startsWith('P')).lastIndexOf(true);
    expect(firstNonCrs).toBeGreaterThan(lastCrs);
  });

  it('matches by name substring when CRS does not match', () => {
    expect(searchStations(LIST, 'manchester', 10)).toEqual([
      expect.objectContaining({ crs: 'MAN' }),
    ]);
  });

  it('is case-insensitive', () => {
    expect(searchStations(LIST, 'reading', 10)).toEqual(
      searchStations(LIST, 'READING', 10),
    );
  });

  it('respects the limit', () => {
    // "london" matches three London stations
    expect(searchStations(LIST, 'london', 1)).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchStations(LIST, 'zzzzz', 10)).toEqual([]);
  });

  it('breaks rank ties alphabetically by name', () => {
    // All three "London …" names tie at rank 2 (name starts with the query).
    const names = searchStations(LIST, 'london', 10).map((x) => x.name);
    expect(names).toEqual(['London Euston', "London King's Cross", 'London Paddington']);
  });
});
