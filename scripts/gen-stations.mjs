// Derive the canonical UK mainline station list from the ODbL source dataset
// (src/data/stations-source.json — from davwheat/uk-railway-stations, itself
// derived from Trainline EU's stations dataset) into two IDENTICAL files:
//
//   src/data/stations.json   — build-time import (SSG paths + name lookups)
//   public/stations.json     — runtime fetch for the station combobox
//
// Writing both from one pass keeps the build and the browser from drifting.
// The derived data inherits the source's ODbL licence; see src/data/SOURCES.md.
//
//   node scripts/gen-stations.mjs
//
// Plain JavaScript (.mjs) — no TypeScript syntax.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(
  readFileSync(resolve(root, 'src/data/stations-source.json'), 'utf8'),
);

const seen = new Set();
const stations = raw
  .filter((s) => typeof s.crsCode === 'string' && /^[A-Za-z]{3}$/.test(s.crsCode))
  .map((s) => ({
    crs: String(s.crsCode).toUpperCase(),
    name: String(s.stationName ?? '').trim(),
    country: String(s.constituentCountry ?? '').trim().toLowerCase(),
    lat: typeof s.lat === 'number' ? s.lat : null,
    long: typeof s.long === 'number' ? s.long : null,
  }))
  .filter((s) => {
    if (!s.name || seen.has(s.crs)) return false;
    seen.add(s.crs);
    return true;
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const json = JSON.stringify(stations);
const canonical = resolve(root, 'src/data/stations.json');
const runtime = resolve(root, 'public/stations.json');
mkdirSync(dirname(runtime), { recursive: true });
writeFileSync(canonical, json);
writeFileSync(runtime, json);

const byCountry = stations.reduce((acc, s) => {
  acc[s.country] = (acc[s.country] ?? 0) + 1;
  return acc;
}, {});

console.log(`wrote ${stations.length} stations`);
console.log('  by country:', byCountry);
console.log(`  ${canonical}`);
console.log(`  ${runtime}`);
console.log(`  ${(json.length / 1024).toFixed(1)} KiB raw`);
