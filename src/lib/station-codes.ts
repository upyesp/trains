// Client-side loader for official three-letter station codes.
//
// RTT's responses don't carry CRS codes, so names like "London Waterloo" are
// resolved to their codes ("WAT") from the bundled stations.json — the same
// data the search combobox fetches. Loaded once per page; modules call
// loadStationCrs() (or onStationCrsReady) and re-render when it settles.

export interface StationEntry {
  name: string;
  crs: string;
}

let stations: StationEntry[] | null = null;
let crsByStation: Map<string, string> | null = null;
let stationsPromise: Promise<StationEntry[]> | null = null;

function siteBase(): string {
  // Astro replaces import.meta.env.BASE_URL with the configured base ("/" here).
  return (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
}

/** Fetch (once) the bundled stations list from stations.json. */
export function loadStations(): Promise<StationEntry[]> {
  if (!stationsPromise) {
    stationsPromise = fetch(`${siteBase()}/stations.json`, { cache: 'force-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<StationEntry[]>) : []))
      .then((list) => {
        stations = list.filter((s) => s?.name && s?.crs);
        crsByStation = new Map(stations.map((s) => [s.name.toLowerCase(), s.crs]));
        return stations;
      })
      .catch(() => {
        stations = [];
        crsByStation = new Map();
        return stations;
      });
  }
  return stationsPromise;
}

/** Load (once) and index stations: lowercased name -> CRS code. */
export function loadStationCrs(): Promise<Map<string, string>> {
  return loadStations().then(() => crsByStation ?? new Map());
}

/** The official code for a station name, once the list has loaded (else undefined). */
export function stationCrs(name: string): string | undefined {
  return crsByStation?.get(name.toLowerCase());
}

/** The station name for a CRS code, once the list has loaded (else undefined). */
export function stationNameByCrs(crs: string): string | undefined {
  const needle = crs.toLowerCase();
  return stations?.find((s) => s.crs.toLowerCase() === needle)?.name;
}

/** Station name with its official code, e.g. "London Waterloo (WAT)" — the
 *  convention used by other train sites. The code is appended only when the
 *  bundled stations list knows the station. */
export function stationLabel(name: string): string {
  const crs = stationCrs(name);
  return crs ? `${name} (${crs})` : name;
}

/** Resolve the codes list and call `cb` once it's ready (for re-renders). */
export function onStationCrsReady(cb: () => void): void {
  void loadStations().then(cb);
}
