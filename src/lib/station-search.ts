// Pure station-search ranking + the Station record shape.
//
// This module imports NO data, so it is safe to bundle into client code without
// dragging the full (~2,600 row) station list into every page. The combobox
// fetches public/stations.json at runtime and calls searchStations() on it.

export interface Station {
  crs: string;
  name: string;
  country: string;
  lat: number | null;
  long: number | null;
}

/**
 * Rank stations for a combobox query. Lower rank = more relevant:
 *   0  exact CRS code match
 *   1  CRS code starts with the query
 *   2  name starts with the query
 *   3  name contains the query
 * Equal ranks break alphabetically by name. An empty query returns the first
 * `limit` stations as-given (callers should pass a name-sorted list).
 */
export function searchStations(
  list: readonly Station[],
  query: string,
  limit = 50,
): Station[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);

  const matches: Array<{ s: Station; r: number }> = [];
  for (const s of list) {
    const name = s.name.toLowerCase();
    const crs = s.crs.toLowerCase();
    let r = -1;
    if (crs === q) r = 0;
    else if (crs.startsWith(q)) r = 1;
    else if (name.startsWith(q)) r = 2;
    else if (name.includes(q)) r = 3;
    if (r >= 0) matches.push({ s, r });
  }
  matches.sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name, 'en'));
  return matches.slice(0, limit).map((m) => m.s);
}
