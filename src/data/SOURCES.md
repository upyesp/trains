# Station data — source & licence

The station list used by this site (CRS codes, names, coordinates) is derived from:

- **[davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations)** —
  which itself derives from **[Trainline EU's stations dataset](https://github.com/trainline-eu/stations)**
  and their sources. It enumerates the stations queryable through the National
  Rail Darwin API (the GB mainline network), matching this site's `gb-nr` scope.

## Licence: ODbL 1.0

Both the source dataset (`stations-source.json`) and our derived list
(`stations.json`) are licensed under the **[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/)**.

Per ODbL you may freely use and adapt this data provided you:

- attribute the sources above (**davwheat**, **Trainline EU**, and their sources), and
- share any adapted database under the same ODbL licence.

Station names and CRS codes are factual data.

## Files

- `src/data/stations-source.json` — verbatim upstream file (ODbL), committed for
  reproducibility and attribution.
- `src/data/stations.json` — derived list imported at build time for SSG paths.
- `public/stations.json` — identical copy, fetched by the station combobox at runtime.

## Regenerating

After updating `stations-source.json`, regenerate the derived files:

```sh
node scripts/gen-stations.mjs
```

This rewrites `src/data/stations.json` and `public/stations.json` identically.
