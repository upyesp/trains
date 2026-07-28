// Bundled UK mainline station list (CRS + display name).
//
// v1 ships a curated seed of major termini and regional hubs so the combobox
// search and the per-station SSG shells (/stations/<crs>) work end-to-end.
// TODO: bundle the full CORPUS/NaPTAN CRS list (~2,500 stations) as a static
// asset so every station is searchable and deep-linkable.

export interface Station {
  crs: string;
  name: string;
}

export const STATIONS: readonly Station[] = [
  { crs: 'KGX', name: "London King's Cross" },
  { crs: 'STP', name: 'London St Pancras International' },
  { crs: 'EUS', name: 'London Euston' },
  { crs: 'PAD', name: 'London Paddington' },
  { crs: 'WAT', name: 'London Waterloo' },
  { crs: 'LST', name: 'London Liverpool Street' },
  { crs: 'VIC', name: 'London Victoria' },
  { crs: 'LBG', name: 'London Bridge' },
  { crs: 'MYB', name: 'London Marylebone' },
  { crs: 'CST', name: 'London Cannon Street' },
  { crs: 'CHX', name: 'London Charing Cross' },
  { crs: 'FST', name: 'London Fenchurch Street' },
  { crs: 'BHM', name: 'Birmingham New Street' },
  { crs: 'MAN', name: 'Manchester Piccadilly' },
  { crs: 'LDS', name: 'Leeds' },
  { crs: 'YRK', name: 'York' },
  { crs: 'EDB', name: 'Edinburgh Waverley' },
  { crs: 'GLC', name: 'Glasgow Central' },
  { crs: 'GLQ', name: 'Glasgow Queen Street' },
  { crs: 'NCL', name: 'Newcastle' },
  { crs: 'BRI', name: 'Bristol Temple Meads' },
  { crs: 'CDF', name: 'Cardiff Central' },
  { crs: 'SOU', name: 'Southampton Central' },
  { crs: 'BTN', name: 'Brighton' },
  { crs: 'RDG', name: 'Reading' },
  { crs: 'CBG', name: 'Cambridge' },
  { crs: 'OXF', name: 'Oxford' },
  { crs: 'NOT', name: 'Nottingham' },
  { crs: 'SHF', name: 'Sheffield' },
  { crs: 'CRE', name: 'Crewe' },
  { crs: 'DBY', name: 'Derby' },
  { crs: 'NWI', name: 'Norwich' },
  { crs: 'INV', name: 'Inverness' },
  { crs: 'ABD', name: 'Aberdeen' },
  { crs: 'SWA', name: 'Swansea' },
  { crs: 'DON', name: 'Doncaster' },
  { crs: 'PBO', name: 'Peterborough' },
  { crs: 'PMS', name: 'Portsmouth & Southsea' },
];

/** Look up a station by CRS code (case-insensitive). */
export function findStation(crs: string): Station | undefined {
  const upper = crs.toUpperCase();
  return STATIONS.find((s) => s.crs === upper);
}

/** Case-insensitive name-or-CRS search, best for the combobox. */
export function searchStations(query: string, limit = 50): Station[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...STATIONS].slice(0, limit);
  return STATIONS.filter(
    (s) => s.name.toLowerCase().includes(q) || s.crs.toLowerCase().includes(q),
  ).slice(0, limit);
}
