# "Calling at" filter: server-side via RTT filterTo / filterFrom

Adds an optional board filter — "calling at" a chosen station — that narrows the
board to services that stop there. Reflected in the URL (`?callsAt=<CRS>`) so it
can be saved as a browser favourite. Filter is applied **upstream by RTT**, not
client-side.

## Context

A departure board at station A filtered to "calling at X" must include services
that stop at X **anywhere** along their route — final destination *and*
intermediate calling points — not just services whose *destination* is X. A
client-side filter could only see each service's origin/destination endpoint (our
`Service` DTO carries no calling pattern; RTT's `/gb-nr/location` lineup returns
only the endpoints, not the full route).

Getting the full calling pattern per service would mean one `/gb-nr/service`
detail call per row — up to 12 extra calls per board fetch. At the free-tier rate
ceiling of **30/min** (shared, account-wide; research §6) that is infeasible: a
single board refresh would blow the budget, and the 30s cache cannot dedupe it.

RTT's `/gb-nr/location` endpoint already accepts server-side filters (spec,
verified live):

- `filterTo=<CRS>` — keep services that **subsequently** call at `<CRS>`
  (downstream). Used for **departures**.
- `filterFrom=<CRS>` — keep services that **previously** called at `<CRS>`
  (upstream). Used for **arrivals** ("came via").

Both accept a **bare CRS** on `/gb-nr/location` (namespace implied), e.g. `WAT`,
`WOK`.

## Decision

1. The "calling at" filter is applied **by RTT**, by mapping an optional
   `callsAt=<CRS>` query param to `filterTo` (departures) / `filterFrom`
   (arrivals) in the Worker's upstream call. RTT knows each service's full
   calling pattern, so this gives correct semantics at **no extra request**.
2. `callsAt` is part of the per-board **cache identity**
   (`board:<crs>:<kind>:<callsAt>`) so a filtered and an unfiltered board for the
   same station never shadow one another under the shared 30s TTL.
3. The client holds `callsAt` in its board state, sends it on every fetch, and
   keeps the URL in sync with `history.replaceState` (`?callsAt=<CRS>`), so the
   filter survives refresh, reload, and bookmarking. An empty/absent value means
   no filter.
4. The active filter is surfaced accessibly: the `<ol>`'s `aria-label` and a
   polite announcement reflect it, and an empty filtered board states that no
   services call at the selected station (ADR-0002).

## Consequences

- Correct "calling at" semantics (intermediate stops included) without
  per-service detail calls or a DTO change.
- One cache entry per `(station, kind, filter)` triple under the same TTL. With a
  30s cache this keeps RTT call volume low even when many users apply different
  filters; the existing `429` + `Retry-After` → stale-while-error path protects
  under load (ADR-0003).
- The filter is **direction-aware**: departures filter forward (`filterTo`),
  arrivals filter backward (`filterFrom`), which matches how a traveller reads
  each board ("will this departure stop at X?" / "did this arrival come via X?").
- Invalid `callsAt` (not a 3-letter CRS) is rejected with `400 bad-calls-at`;
  the client only ever sends valid CRSs from the station list, so this guards
  hand-edited URLs.
