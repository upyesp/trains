# Arrivals tab: presentation and linked calling-points behaviour

The station board has two tabs — Departures and Arrivals — that share one
mapper, one row builder and one calling-points page. Direction is a
presentation choice made in the mapper (ADR-0004 §4): departures pair the
departure time with the destination, arrivals pair the arrival time with the
origin. The shared machinery made several departures-shaped details leak into
the Arrivals tab where they read wrong. This ADR pins the Arrivals tab's
specific requirements.

## Context

On the Arrivals tab the row's headline station is the train's ORIGIN (where it
came from), not its destination; the board station is the journey's end. Four
leaks hurt:

1. The desktop column header says **"Destination"** over a column whose entries
   are origins — wrong word for what the column holds.
2. The line under the station name shows the train's **total origin→destination
   duration** ("4h 3m from London Waterloo to Exeter St Davids · 6 coaches").
   Useful on Departures (it is the journey the reader is about to make), but an
   arrival already happened — the useful fact is when the journey STARTED, i.e.
   the train's planned departure from its origin.
3. Clicking a row opens the calling-points page anchored on the board station
   (`?from=<CRS>`), with everything before it collapsed behind "Show earlier
   calling points". Right for Departures (you care about what's ahead of you);
   backwards for Arrivals — the train has already done the earlier stops, which
   is exactly what an arrivals user wants to inspect.
4. Switching tab is client-side only and wrote nothing down, so a refresh (or a
   shared/bookmarked URL) always landed back on Departures.

## Decision

1. **Column heading**: the board column header reads "From" on the Arrivals tab
   and "Destination" on the Departures tab. The static page ships the
   Departures default; the board client swaps the heading whenever the active
   kind changes (initial load included).
2. **Under-name line on Arrivals**: the total duration is replaced by the
   train's planned start time at its origin —
   "This is the 13:50 from London Waterloo to Exeter St Davids · 6 coaches".
   The Departures tab keeps "4h 3m from … · 6 coaches" unchanged. The start
   time is the origin endpoint's advertised time, mapped once in the Worker
   (`Service.originDeparture`, arrivals only); without it the line falls back
   to the duration wording rather than showing a gap.
3. **Calling-points page from Arrivals**: the row link carries `&dir=arrivals`,
   and the calling-points page starts with the earlier calling points EXPANDED
   (disclosure open) when that parameter is present. Departures links and every
   other entry path keep the current collapsed default, and the disclosure
   stays user-toggleable as before (animated open/close unchanged).
4. **Tab survives refresh**: the active tab is part of the board URL as
   `?dir=arrivals` (departures is the default and keeps a clean URL). Tab
   switches update the URL via `history.replaceState` — no reload, no history
   spam — and the initial load reads it. Sharing or refreshing an Arrivals view
   reopens Arrivals. The existing `?callsAt=` filter combines with it (real
   navigations preserve other parameters).

## Consequences

- `Service` gains an arrivals-only optional field (`originDeparture`); the row
  builder becomes direction-aware (kind is passed to `boardRowsHtml`), and the
  platform page — departures-only — is unaffected by its default.
- The calling-points page's disclosure default is now entry-path-dependent:
  `?dir=arrivals` means "expanded at first paint". Every other path (departures
  links, history entries, pasted plain `?id=` URLs) is unchanged.
- `?dir=arrivals` is meaningful on both boards and calling-points pages; on the
  boards page it selects the tab, on the calling-points page it selects the
  disclosure default — one parameter, two presentation defaults, both derived
  from "the user came from / is looking at arrivals".
- Refresh, bookmark, and share of an Arrivals board behave like Departures
  always have; no server-side change is needed beyond the new mapped field.
