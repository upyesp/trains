// Canonical UK mainline station list + build-time lookup helpers.
//
// The data lives in stations.json, generated from the ODbL stations-source.json
// by scripts/gen-stations.mjs (see SOURCES.md). It is imported here at BUILD
// time for SSG paths and name lookups only. The browser fetches
// /stations.json at runtime instead, so the full list is never inlined into
// each page's HTML.

import type { Station } from '../lib/station-search';
import data from './stations.json';

export type { Station } from '../lib/station-search';

export const STATIONS: readonly Station[] = data as Station[];

/** Curated shortlist for the home page (CRS codes, in display order). */
export const POPULAR_CRS = [
  'KGX', 'EUS', 'PAD', 'WAT', 'LST', 'VIC',
  'BHM', 'MAN', 'LDS', 'EDB', 'GLC', 'BRI',
];

export function findStation(crs: string): Station | undefined {
  const u = crs.toUpperCase();
  return STATIONS.find((it) => it.crs === u);
}
