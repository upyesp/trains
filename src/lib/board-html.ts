// Shared board presentation: row HTML and change announcements, used by the
// station-board client, the calling-points client, and the platform page.
//
// Each field renders as a labelled <div> inside an <li> (see StationBoard.astro).
// The board is a real <ol> of service cards - not a <table> - so the layout is
// fully responsive (cards on phones) without CSS display:block tricks that can
// drop table semantics in some screen readers (ADR-0002). Field order in the
// DOM is time, destination, platform, status: logical for screen readers, and
// the desktop grid reads them into columns in that same order.

import { fmtDurationMin, fmtTime } from './format';
import { esc, platformChip } from './html';
import { stationLabel } from './station-codes';
import type { Board, MeaningfulChange, Platform, Service } from './types';

function delayMinutes(s: Service): number {
  // The recorded actual (once the train has passed) beats the forecast.
  const sched = Date.parse(s.scheduledTime);
  const exp = Date.parse(s.actualTime ?? s.expectedTime);
  if (Number.isNaN(sched) || Number.isNaN(exp)) return 0;
  return Math.round((exp - sched) / 60_000);
}

/** The enclosing cell (platformCell) carries the screen-reader label and
 *  wraps the shared chip (src/lib/html), which owns the visible caption.
 *  When `crs` is given the chip number links to that station's platform page. */
function platformCell(p: Platform | null, crs: string | null): string {
  // This visually-hidden label is the one screen readers announce; the visible
  // "Platform" caption now lives inside the chip (platformChip).
  const srLabel = p
    ? '<span class="visually-hidden">Platform: </span>'
    : '<span class="visually-hidden">Platform not allocated</span>';
  const href =
    p && crs
      ? `/platform/?station=${encodeURIComponent(crs)}&platform=${encodeURIComponent(p.number)}`
      : undefined;
  return `<div class="svc-plat">${srLabel}${platformChip(p, href)}</div>`;
}

function timeCell(s: Service): string {
  const sched = fmtTime(s.scheduledTime);
  if (s.cancelled) return `<div class="svc-time"><span class="time">${esc(sched)}</span></div>`;
  const exp = fmtTime(s.expectedTime);
  if (sched !== exp) {
    // Visually-hidden words disambiguate the two times for screen readers:
    // "Scheduled 08:05 expected 08:11" rather than two bare numbers.
    return `<div class="svc-time"><span class="time"><span class="visually-hidden">Scheduled </span><span class="sched">${esc(sched)}</span><span class="arrow" aria-hidden="true">↘</span><span class="visually-hidden"> expected </span><span class="exp">${esc(exp)}</span></span></div>`;
  }
  return `<div class="svc-time"><span class="time">${esc(exp)}</span></div>`;
}

function destCell(s: Service, crs: string | null): string {
  const journey = s.journeyMins != null ? fmtDurationMin(s.journeyMins) : '';
  // The board's journey time is the train's FULL origin→destination run.
  // Say so explicitly ("from … to …", with the official codes) so it can't be
  // mistaken for the remaining journey from this station.
  const route =
    journey && s.origin && s.finalDestination
      ? ` from ${esc(stationLabel(s.origin))} to ${esc(stationLabel(s.finalDestination))}`
      : '';
  const coaches = s.coaches != null ? `${s.coaches} ${s.coaches === 1 ? 'coach' : 'coaches'}` : '';
  const meta = [journey + route, coaches].filter(Boolean).map(esc).join(' · ');
  const metaHtml = meta ? `<span class="coaches">${meta}</span>` : '';
  // `from` tells the service page which station the user was viewing, so its
  // header and calling-points list can anchor on that station (not the origin).
  const params: Record<string, string> = { id: s.id };
  if (crs) params.from = crs;
  const href = `/service/?${new URLSearchParams(params).toString()}`;
  return `<div class="svc-dest"><span class="dest"><a class="svc-link" href="${href}"><span class="dest-name">${esc(s.destination)}</span> <span class="visually-hidden">view calling points for this service</span></a>${metaHtml}<span class="toc">${esc(s.operator)}</span></span></div>`;
}

function statusCell(s: Service): string {
  if (s.cancelled) return '<div class="svc-status"><span class="chip cancel">Cancelled</span></div>';
  const mins = delayMinutes(s);
  if (mins > 0) return `<div class="svc-status"><span class="chip delay">+${mins} min</span></div>`;
  // Unreported: the expected time is just the timetable — "no chip = on time"
  // would be a lie, so say so (RTT's own boards show "No report").
  if (s.noReport && !s.actualTime) {
    return '<div class="svc-status"><span class="chip no-report">No report</span></div>';
  }
  // On time: no chip (conventional for boards); the absence reads as "on time".
  return '<div class="svc-status"></div>';
}

function rowHtml(s: Service, crs: string | null, showPlatform = true): string {
  const cls = s.cancelled ? 'svc is-cancelled' : 'svc';
  // Only the station name is a link — not the whole row — so it's obvious
  // and hard to trigger accidentally (same pattern as calling-point stops).
  const plat = showPlatform ? platformCell(s.platform, crs) : '';
  return `<li class="svc-item"><div class="${cls}">${timeCell(s)}${destCell(s, crs)}${statusCell(s)}${plat}</div></li>`;
}

/** All rows of a board as HTML, in the given order. `crs` (when given) makes
 *  each row's platform chip link to that station's platform page. `showPlatform`
 *  is false on the platform page, where every service shares one platform so
 *  the column is dropped entirely (Time / Destination / Status only). */
export function boardRowsHtml(services: Service[], crs: string | null, showPlatform = true): string {
  return services.map((s) => rowHtml(s, crs, showPlatform)).join('');
}

// ---- Announcement phrasing (mirrors diffBoards output) ----

function describePlatform(p: Platform | null): string {
  if (!p) return 'no platform is allocated';
  if (p.state === 'at-platform') return `at platform ${p.number}`;
  if (p.state === 'confirmed') return `platform confirmed — platform ${p.number}`;
  return `provisional platform ${p.number}`;
}

/** Human phrases for meaningful changes, e.g. "The 08:05 departure to Leeds
 *  has been cancelled." (used by every board-style page's polite live region). */
export function describeChanges(changes: MeaningfulChange[], board: Board): string[] {
  const byId = new Map(board.services.map((s) => [s.id, s]));
  const noun = board.kind === 'arrivals' ? 'arrival' : 'departure';
  const out: string[] = [];
  for (const c of changes) {
    const svc = byId.get(c.serviceId);
    if (!svc) continue;
    const when = fmtTime(svc.scheduledTime);
    const dest = svc.destination;
    switch (c.type) {
      case 'cancellation':
        out.push(`The ${when} ${noun} to ${dest} has been cancelled.`);
        break;
      case 'platform-change':
        out.push(`The ${when} ${noun} to ${dest}: ${describePlatform(c.to)}.`);
        break;
      case 'delay': {
        const exp = fmtTime(svc.expectedTime);
        const verb = c.minutesSwing >= 5 ? 'is delayed, now expected at' : 'is running earlier, now expected at';
        out.push(`The ${when} ${noun} to ${dest} ${verb} ${exp}.`);
        break;
      }
    }
  }
  return out;
}

/** Two boards are the same view when station and kind match (diffable). */
export function sameKey(a: Board, b: Board): boolean {
  return a.station === b.station && a.kind === b.kind;
}
