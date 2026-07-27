# Research: Real-Time Trains (RTT) NG API

Investigation of RTT's API as the data source for the live board, captured
before building the Cloudflare Worker proxy and the Astro data layer. Every
claim is traced to RTT's own OpenAPI spec.

- **Date:** 2026-07-27 (environment clock)
- **Primary source:** the OpenAPI 3.1.1 spec — [`realtimetrains/api-specification`](https://github.com/realtimetrains/api-specification), file `specification/main.yml` (API `version: "2.0"`). Rendered docs: <https://realtimetrains.github.io/api-specification/>. Portal: <https://api-portal.rtt.io>.
- Research done from the public spec; **no account/token was available**, so entitlement-gated behaviour is inferred and flagged below where it matters.

---

## TL;DR — three things that change our plan

1. **The API we referenced in ADR-0001 is being decommissioned.** The legacy `api.rtt.io` portal (HTTP Basic auth) closes registrations and **shuts down on "31st September 2026"** (sic — Sept has 30 days; treat as end of Sept 2026) [[api.rtt.io landing](https://api.rtt.io/)]. The active API is the **next-generation ("NG")** API at base URL **`https://data.rtt.io`**, managed via <https://api-portal.rtt.io>. **ADR-0001's technical specifics (host + auth) are now wrong and must be updated.**
2. **Auth is a Bearer token, not HTTP Basic.** The spec *explicitly mandates* a server-side proxy: *"It is a requirement that no token is placed in a distributable user application… If we identify a token is in a downstream user application, it will be revoked."* This is direct, citable validation of our GitHub Pages + Cloudflare Worker split (**ADR-0003**).
3. **Our DTO maps almost 1:1** to RTT's `NetworkRailLocationLineUpObject`. Platform provisional/confirmed maps exactly (`platform.planned` → provisional, `platform.actual` → confirmed). The new work is a thin **`RTT → Board` mapper** plus departures/arrivals selection (there is no direction parameter).

---

## 1. API basics

| | Value | Source |
|---|---|---|
| Base URL | `https://data.rtt.io` | `servers:` in spec |
| Auth | `Authorization: Bearer <token>` (HTTP Bearer) | `securitySchemes.BearerToken` |
| Versioning | `Version` header or `?version=` query, ISO date e.g. `2026-04-09` | `VersionHeader`/`VersionQuery` |
| Rate limiting | `X-RateLimit-Limit-<dim>` / `X-RateLimit-Remaining-<dim>` where dim ∈ `Minute,Hour,Day,Week`; `429` + `Retry-After` on excess | spec `info.description` |
| Token model | Either a long-life **access token**, or a **refresh token** exchanged for a short-life access token via `GET /api/get_access_token` → `{ token, entitlements, validUntil }` | spec `info.description`, `/api/get_access_token` |

**Entitlements of note** (from `info.description`): `allowDetailed` (detailed mode), `showEstimateTimeIfNoReport` (RTT computes an estimated time when a service hasn't reported — feeds our expected-time fallback). The free tier is "personal, non-commercial use"; paid plans exist.

---

## 2. Endpoints we will use

### 2a. Live board — `GET /gb-nr/location`  *(primary)*

Chosen over the generic `/rtt/location` because it returns the **Network-Rail-specific** lineup (`NetworkRailLocationLineUpObject`) — which carries the **headcode** (`trainReportingIdentity`), STP indicator, and stock/allowance metadata — while including every core field we need. UK mainline is the `gb-nr` namespace.

**Query parameters** (spec, `/gb-nr/location`):
- `code` *(required, string)* — any short or long code; namespace is implied `gb-nr`. **A bare CRS works**, e.g. `code=CLJ`. (Contrast: the generic `/rtt/location` wants a namespaced code `gb-nr:CLJ`.)
- `timeFrom` / `timeTo` *(ISO 8601 datetime; tz optional, defaults to the location's local tz)* — window. If `timeFrom` omitted → now; if `timeTo` omitted → **+60 min**. Max window **23h59m**. Mutually exclusive with `timeWindow`.
- `timeWindow` *(int, default 60)* — minutes from `timeFrom`. Mutually exclusive with `timeTo`.
- `filterFrom` / `filterTo` *(optional short/long code)* — restrict to services previously calling at / subsequently calling at a location. **`filterTo` gives us "trains going to X" for free.**
- `detailed` *(bool)* — detailed mode (needs `allowDetailed`).
- `stpFilter` *(regex `^[WVSC]{1,4}$`)* — WTT/VAR/STP/CAN filter; **detailed mode only**.

**Response `200`** (spec):
```
{ systemStatus, query:{location, timeFrom, timeTo, stpFilter?}, reasons, services: NetworkRailLocationLineUpObject[] }
```
- **`204`** = valid query, **no services** (empty board — *not* an error; our mapper returns an empty `services` array).
- **`400`** = invalid query (bad code etc.).

**So our Worker call is:** `GET https://data.rtt.io/gb-nr/location?code=<CRS>&timeWindow=<N>` with `Authorization: Bearer …`.

### 2b. Station reference list — `GET /data/locations_ungrouped`

Returns `{ locations: [{ namespace, description, shortCode, longCode, uniqueIdentity }] }`. `shortCode` is the **CRS** (e.g. `CLJ`). **Available from API version `2026-04-09` onwards** (send the `Version` header).

Caveat: **ungrouped** — a multi-platform station like Clapham Junction returns **5 separate objects sharing the same `shortCode`** (different `longCode`s). For our combobox we must **dedupe by `shortCode`** to one entry per CRS. Requires auth → fetch **server-side/build-time**, group, and commit a static `stations.json` (matches our "bundled static station list" decision).

### 2c. Token + introspection — `GET /api/get_access_token`, `GET /api/info`

- `GET /api/get_access_token` (refresh token as Bearer) → `{ token, entitlements, validUntil }`. If we hold a refresh token, the **Worker must cache the access token until just before `validUntil`** and re-exchange automatically.
- `GET /api/info` → current entitlements + API version (useful for a startup health check).

### 2d. Single service — `GET /gb-nr/service` (later)

For a future service detail / "why delayed" drill-down (`uniqueIdentity` → full `ServiceLocations` with reasons). Out of scope for v1.

---

## 3. Data model → our DTO mapping

RTT's `NetworkRailLocationLineUpObject` (one **service-at-this-location** = one board row). Times and platform live in `temporalData` and `locationMetadata`.

| Our `Service` field | RTT path | Notes |
|---|---|---|
| `id` | `scheduleMetadata.uniqueIdentity` | e.g. `gb-nr:L01525:2026-10-26`. Stable per service-day — ideal diff key. |
| `scheduledTime` | **departures:** `temporalData.departure.scheduleAdvertised`  ·  **arrivals:** `temporalData.arrival.scheduleAdvertised` | GBTT time. **Full ISO datetime**, not `HH:MM`. |
| `expectedTime` | `temporalData.{departure\|arrival}.realtimeForecast` ?? `.realtimeEstimate` ?? `scheduledTime` | `realtimeEstimate` needs the `showEstimateTimeIfNoReport` entitlement; without it, unreported services fall back to schedule (= "on time"). |
| `destination` | **departures:** `destination[last].location.description`  ·  **arrivals:** `origin[…].location.description` | The "other end". For arrivals this is really the **origin** — see §4. |
| `operator` | `scheduleMetadata.operator.name` | Spec warns: **do not cache `name` by operator `code`** (branding may differ). |
| `platform.number` | `locationMetadata.platform.actual` ?? `.planned` | |
| `platform.state` | `actual` present → `'confirmed'`; else (only `planned`) → `'provisional'`; neither → `null` | **Exact match** to our provisional/confirmed model. |
| `cancelled` | `temporalData.displayAs === 'CANCELLED'` (cross-check `departure.isCancelled`) | Other `displayAs` values: `CALL`, `PASS`, `STARTS`, `TERMINATES`, `DIVERTED`. |

**Useful extras available** (not in our DTO yet, defer unless wanted): `scheduleMetadata.operator.code`, `trainReportingIdentity` (headcode, e.g. `1L40`), `temporalData.departure.realtimeAdvertisedLateness` (**delay in minutes, precomputed** — could cross-check our diffBoards swing), `status` (`APPROACHING`/`AT_PLATFORM`/`DEPARTING`…), `reasons` (`{type:DELAY\|CANCEL, code, shortText, longText}`).

**System health** — `systemStatus`:
- `rttCore`: `OK` | `REALTIME_DEGRADED` | `SCHEDULE_ONLY` — `SCHEDULE_ONLY` means we're effectively getting the timetable with no realtime; worth surfacing as a degraded notice.
- `realtimeNetworkRail`: `OK` | `REALTIME_DATA_LIMITED` | `REALTIME_DATA_NONE`.

---

## 4. Departures vs arrivals — there is no parameter

Neither `/rtt/location` nor `/gb-nr/location` takes a direction. The lineup returns **every service at the location**, each carrying **both** `temporalData.arrival` and `temporalData.departure`. Direction is therefore a **mapper/presentation choice**:

- **Departures board** → services with an **advertised departure** (`scheduledCallType`/`realtimeCallType` ∈ `ADVERTISED_OPEN`, `ADVERTISED_SET_DOWN`, `ADVERTISED_PICK_UP`; `displayAs` ∈ `CALL`, `STARTS`), **sorted by departure time**, showing **destination**. Exclude `PASS` (through-services that don't call).
- **Arrivals board** → advertised **arrival**, sorted by arrival time, showing **origin**.

**DTO implication:** our `Service.destination` field is really "the other end". For an arrivals board it holds the origin. Options: (a) keep the field named `destination` and let the board `kind` ('departures'|'arrivals') govern the label, or (b) rename to something direction-neutral like `towards`/`endPoint`. Recommend (a) for now — minimal churn; the UI labels it per board kind.

---

## 5. Implications & recommended next actions

1. **ADR-0001 needs updating.** It cites `api.rtt.io` + HTTP Basic; the reality is `data.rtt.io` + Bearer token, and the legacy portal is decommissioning end-of-Sept-2026. Recommend a short **ADR-0004** ("RTT NG API: data.rtt.io + Bearer") that supersedes ADR-0001's *technical specifics* while keeping its *choice* (RTT over LDBWS) and commitments (non-commercial, contact support for volume, attribution). The proxy mandate also strengthens ADR-0003 — worth a one-line cross-reference.

2. **Refine `src/lib/types.ts`.** Document times as full ISO 8601 datetimes (our `diffBoards` already `Date.parse`es them — compatible). Note the `expectedTime` fallback chain and the destination/origin duality in JSDoc. No structural change required for the core fields.

3. **New seam to TDD: `mapLocationLineUp(response, kind): Board`.** Pure function, RTT response → our `Board`. Testable slices: a normal departure; platform provisional vs confirmed vs none; delay (expected ≠ scheduled); cancellation (`displayAs=CANCELLED`); departures-vs-arrivals selection; `204` → empty board; the `expectedTime` fallback chain. This is the natural next TDD target after the Worker fetch exists.

4. **Station list bundling.** Build-time/one-off Worker call to `/data/locations_ungrouped` (Version `2026-04-09`), **dedupe by `shortCode`**, emit a committed `stations.json` (`{crs, name}[]`) consumed by the combobox. Keep it small/curated if the full list is huge.

5. **Rate-limit + failure handling.** Our 30 s per-station cache (ADR-0003) keeps RTT call volume very low. On `429` (honour `Retry-After`) or fetch error, the Worker returns **stale-while-error** via our existing `selectBoardToServe`. Optionally back off the client refresh cadence when `Retry-After` is large.

---

## 6. Open questions (need a real token to confirm)

- **Entitlements on the free tier** — does it include `/gb-nr/location` and `showEstimateTimeIfNoReport`? (Likely yes for core, but unverified.)
- **Do we receive a long-life access token or a refresh token?** Determines whether the Worker needs the `/api/get_access_token` refresh loop.
- **Actual rate-limit values** (Minute/Hour/Day/Week ceilings) for the free tier — returned in headers on first call.
- **`code=CLJ` (short CRS) behaviour on `/gb-nr/location`** — spec says "any short or long code" and examples use longCodes; CRS should work but is unverified against the live API.
