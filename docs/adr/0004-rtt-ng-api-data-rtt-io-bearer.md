# RTT NG API: data.rtt.io + Bearer token

Supersedes the **technical specifics** of [ADR-0001](0001-data-source-real-time-trains.md) (host and auth), which are stale: the RTT API we depend on has moved from the legacy `api.rtt.io` (HTTP Basic) to the next-generation ("NG") API at **`https://data.rtt.io`** with **Bearer-token auth**, managed via `https://api-portal.rtt.io`. The legacy portal is closed to new registrations and **decommissions at end of September 2026**. ADR-0001's *choice* (RTT over LDBWS) and its *commitments* (non-commercial use, contacting support for a volume arrangement, attribution) remain in force.

## Context

From primary sources — RTT's OpenAPI 3.1.1 spec ([`realtimetrains/api-specification`](https://github.com/realtimetrains/api-specification), API `version: "2.0"`); full detail in [`docs/research/rtt-api.md`](../research/rtt-api.md):

- Base URL `https://data.rtt.io`; `Authorization: Bearer <token>`.
- The spec is **explicit that tokens must never ship in a client app**: *"no token is placed in a distributable user application… If we identify a token is in a downstream user application, it will be revoked."*
- Tokens are either a long-life access token, or a refresh token exchanged for a short-life access token via `GET /api/get_access_token` → `{ token, entitlements, validUntil }`.
- Live board: `GET /gb-nr/location?code=<CRS>&timeWindow=<N>` → `{ services: NetworkRailLocationLineUpObject[] }`; `204` = valid query, empty board (not an error).

## Decision

1. Target **`https://data.rtt.io`** (NG API), not `api.rtt.io`.
2. Authenticate with a **Bearer token held only in the Cloudflare Worker** ([ADR-0003](0003-architecture-pages-plus-cloudflare-worker.md)). The browser must never receive the token — it is forbidden by RTT's terms and would be revoked.
3. Where we hold a refresh token, the Worker runs the `/api/get_access_token` refresh loop and caches the access token until just before `validUntil`.
4. Map fields per `docs/research/rtt-api.md` §3. Platform provisional/confirmed ← `platform.planned` / `platform.actual`. There is **no departures/arrivals parameter** — direction is selected in our `RTT → Board` mapper (departure-time+destination vs arrival-time+origin).

## Consequences

- **The proxy is mandatory, not optional.** This converts ADR-0003's Pages + Worker split from a nice-to-have into a hard requirement imposed by the data source. There is no pure-static path to RTT data with the token in the browser.
- On `429` (rate-limited; honour `Retry-After`) or fetch error, the Worker serves **stale-while-error** (ADR-0003 + `selectBoardToServe`).
- The NG API is versioned by an ISO date (e.g. `2026-04-09`, required for `/data/locations_ungrouped`). We pin a version to insulate against breaking changes.
- Free-tier entitlements (e.g. `showEstimateTimeIfNoReport`, `allowDetailed`) are unverified without a token — flagged in the research doc §6.
