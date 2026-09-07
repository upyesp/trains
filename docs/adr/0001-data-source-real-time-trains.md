# Data source: Real-Time Trains (RTT)

> **Status — partially superseded by ADR-0004.** The *choice* of RTT over LDBWS and the commitments below remain in force. Only the *technical specifics* are superseded: RTT now exposes its next-generation API at `https://data.rtt.io` with Bearer-token auth, and the legacy `api.rtt.io` portal decommissions end-of-Sept-2026. See [ADR-0004](0004-rtt-ng-api-data-rtt-io-bearer.md) and `docs/research/rtt-api.md`.

We use Real-Time Trains (RTT) as the upstream data source for live UK mainline departure/arrival boards. We picked RTT over the authoritative National Rail Darwin / LDBWS API for its richer, higher-fidelity real-time data, after weighing the licensing trade-off (see below) and choosing to carry it.

## Considered Options

- **National Rail Darwin / LDBWS** — the authoritative Open Data source (powers nationalrail.co.uk), free within throttle, purpose-built for public consumption. **Rejected** in favour of RTT's richer data, despite LDBWS having the cleaner licensing story. Remains the natural fallback if RTT's terms become untenable.
- **Transport API** — commercial aggregator; rejected on cost at scale.
- **Network Rail Open Data feeds** — raw TRUST/TD messaging; overkill for a departures board.

## Consequences

- **RTT's free portal is non-commercial-use only and not for high-volume use.** This site is public and multi-station, i.e. definitionally high-volume. We accept two commitments that flow from this:
  1. The site stays **genuinely non-commercial** — no ads, paid tiers, or sponsorship. Monetization would breach RTT's terms and is out of scope.
  2. We **contact RTT support to agree a volume arrangement (likely a paid key)** before this serves real public traffic. Do not launch on the free tier.
- We depend on a **third party** (swlines Ltd) whose terms can change; LDBWS migration is the mitigation if they do.
- **Attribution to RTT is required** and must appear in the UI.
- RTT's schema is richer than LDBWS, so a later migration *to* LDBWS would require remapping — this decision is not free to reverse.
