// Client controller for a service detail page. Imported by service/index.astro.
//
// The page is shareable: it reads ?id=<uniqueIdentity> from the URL, fetches the
// service's full public calling pattern from the Worker, and renders an
// accessible list of stop cards (mirroring the station board) - each stop's
// timetable time, expected time ("On time" when unchanged, else the expected
// time; "Cancelled" for cancelled stops) and platform. Refreshes every 30s
// (paused while the tab is hidden) to keep expected times live.
//
// The link from a station board carries ?from=<CRS> (the station the user was
// viewing). The header then shows THAT station's time and name instead of the
// origin's, and the calling-points list starts there: earlier stops are
// collapsed behind a "Show earlier calling points" disclosure button.

import { fmtClock, fmtDurationMin, fmtTime } from '../lib/format';
import { recordServiceVisit } from '../lib/history';
import { esc, platformChip } from '../lib/html';
import { onStationCrsReady, stationCrs, stationLabel } from '../lib/station-codes';
import type { CallingPoint, Platform, ServiceDetail, ServiceDetailResponse } from '../lib/types';

const REFRESH_MS = 30_000;
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

/** Three-linked-circles share glyph (Lucide "share-2"), the standard on
 *  Android, Windows and Linux. */
const SHARE_ANDROID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.42" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

/** Box-with-up-arrow share glyph (Lucide "share"), matching the Safari toolbar
 *  icon on iOS and macOS. */
const SHARE_APPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;

/** Pick the OS-appropriate share icon.  Apple users (iOS / macOS) get the
 *  box-with-arrow glyph that matches Safari's share button; everyone else
 *  gets the three-linked-circles glyph standard on Android and the web. */
function shareIconHtml(): string {
  return /Mac|iPad|iPhone|iPod/.test(navigator.userAgent) ? SHARE_APPLE : SHARE_ANDROID;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format an ISO datetime's DATE as "27 July 2026", slicing the ISO verbatim so
 *  the displayed date never shifts with the viewer's timezone (mirrors fmtTime). */
function fmtDate(iso: string): string {
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Scheduled journey duration between two ISO datetimes, via the shared
 *  fmtDurationMin ("1h 23m"). Empty when the times are missing or not in order. */
function fmtDuration(isoStart: string, isoEnd: string): string {
  const ms = Date.parse(isoEnd) - Date.parse(isoStart);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return fmtDurationMin(Math.round(ms / 60_000));
}

function delayMinutesAt(p: CallingPoint): number {
  // Lateness on ARRIVAL at the final stop: the recorded actual (once passed)
  // beats the forecast.
  const sched = Date.parse(p.scheduledTime);
  const exp = Date.parse(p.actualArrival ?? p.expectedTime);
  if (Number.isNaN(sched) || Number.isNaN(exp)) return 0;
  return Math.round((exp - sched) / 60_000);
}

/** Index of the calling point the user searched from: the first stop whose
 *  station matches the `from` CRS (resolved via the station-codes list, which
 *  may not be loaded on the first render — then this falls back to the origin
 *  and the list re-renders once the codes arrive). Falls back to 0 when `from`
 *  is absent or matches nothing, keeping the origin-centred behaviour. */
function boardPointIndex(d: ServiceDetail, from: string | null): number {
  if (!from) return 0;
  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i]!;
    if (stationCrs(p.station)?.toUpperCase() === from) return i;
  }
  return 0;
}

// ---- Pure HTML builders (escaped; safe against RTT-provided strings) ----

function backLinkHtml(from: string | null): string {
  if (!from) return `<a class="back-link" href="/">← All stations</a>`;
  return `<a class="back-link" href="/stations/${from.toLowerCase()}/">← Back to ${esc(from)} board</a>`;
}

/** Platform rendered with the shared .plat chip, wrapped for the stop card.
 *  When the stop's station code is known the chip number links to that
 *  station's platform board. */
function stopPlatform(p: Platform | null, station: string): string {
  // The visually-hidden label is what AT announces; the chip's own inline
  // "Platform" caption (aria-hidden) is the visible one.
  const srLabel = p
    ? '<span class="visually-hidden">Platform: </span>'
    : '<span class="visually-hidden">Platform not allocated</span>';
  const crs = stationCrs(station);
  const href =
    p && crs ? `/platform/?station=${encodeURIComponent(crs)}&platform=${encodeURIComponent(p.number)}` : undefined;
  return `<div class="stop-plat">${srLabel}${platformChip(p, href)}</div>`;
}

function stopCard(p: CallingPoint, isLast: boolean): string {
  const sched = fmtTime(p.scheduledTime);

  // Top-left: timetable time (struck when this stop is cancelled).
  const timeInner = p.cancelled ? `<s>${esc(sched)}</s>` : esc(sched);
  const timeHtml =
    `<div class="stop-time"><span class="visually-hidden">Timetable </span><span class="time">${timeInner}</span></div>`;

  // Bottom-left: station name, the card's primary text. Only the station
  // name is a link — not the whole card — so it's obvious and hard to
  // trigger accidentally. The visually-hidden hint tells screen-reader
  // users what the link does.
  const href = `/?${new URLSearchParams({ station: p.station }).toString()}`;
  const stationHtml = `<div class="stop-station"><a class="stop-link" href="${href}"><span class="dest">${esc(p.station)}</span> <span class="visually-hidden">show departures from this station</span></a></div>`;

  // Top-right: the live status for this stop. The displayed time is always a
  // DEPARTURE time where the stop has one (matching other train boards):
  //  - "Departed" (departure actual) — the train has LEFT, at the recorded
  //    departure, never the arrival;
  //  - "Expected" — not gone yet: the expected departure (arrival forecast at
  //    the terminus, which has no departure);
  //  - "Completed" (final stop, arrival actual) — the train finishes here;
  //  - no report at all (noReport) — "no live data": the train may be running
  //    late undetected, so we must NOT claim "on time".
  let expHtml: string;
  if (p.cancelled) {
    expHtml = `<div class="stop-exp cancel">Cancelled</div>`;
  } else {
    const schedStr = fmtTime(p.scheduledTime);
    const arr = p.actualArrival ? fmtTime(p.actualArrival) : null;
    const dep = p.actualDeparture ? fmtTime(p.actualDeparture) : null;
    const depSched = p.scheduledDeparture ? fmtTime(p.scheduledDeparture) : null;
    if (isLast && arr) {
      // Terminus: the arrival IS the only time this stop has.
      const cls = arr === schedStr ? 'on-time' : 'delay';
      expHtml = `<div class="stop-exp ${cls}">Completed ${arr === schedStr ? 'on time' : arr}</div>`;
    } else if (dep) {
      // On-time judgement against the scheduled DEPARTURE (the same element).
      const onTime = depSched != null && dep === depSched;
      expHtml = `<div class="stop-exp ${onTime ? 'on-time' : 'delay'}">Departed ${onTime ? 'on time' : dep}</div>`;
    } else if (p.noReport) {
      const pointMs = Date.parse(p.scheduledTime);
      const isPast = Number.isFinite(pointMs) && pointMs < Date.now();
      const prefix = isLast ? 'Completed' : isPast ? 'Departed' : 'Expected';
      expHtml = `<div class="stop-exp no-report">${prefix} — no live data</div>`;
    } else {
      const exp = fmtTime(p.expectedTime);
      const cls = exp === schedStr ? 'on-time' : 'delay';
      expHtml = `<div class="stop-exp ${cls}">Expected ${exp === schedStr ? 'on time' : exp}</div>`;
    }
  }

  return `<li class="stop-item"><div class="stop">${timeHtml}${stationHtml}${expHtml}${stopPlatform(p.platform, p.station)}</div></li>`;
}

function stopsHtml(d: ServiceDetail, boardIdx: number, earlierOpen: boolean): string {
  // A real <ol> (the route is an ordered sequence) of stop cards, mirroring the
  // station board's .svc rows so the two lists share a visual language. The
  // visible "Calling Points" heading (in the header) is the list's accessible
  // name (aria-labelledby); each value also carries a visually-hidden field
  // label for screen readers.
  //
  // When the user came from a mid-journey station, the list STARTS at that
  // station; earlier stops sit in a separate list collapsed behind a
  // disclosure button (APG pattern: aria-expanded + aria-controls, the hidden
  // attribute removes the collapsed stops from the accessibility tree).
  const earlier = d.points.slice(0, boardIdx);
  const rest = d.points.slice(boardIdx);
  const main = rest
    .map((p, i) => stopCard(p, i === rest.length - 1))
    .join('');
  if (boardIdx === 0) return `<ol class="stops" aria-labelledby="stops-title">${main}</ol>`;
  const btn = `<button type="button" class="earlier-btn" id="earlier-btn" aria-expanded="${earlierOpen}" aria-controls="earlier-stops">${earlierOpen ? 'Hide' : 'Show'} earlier calling points</button>`;
  const earlierList = `<ol class="stops earlier-stops" id="earlier-stops" aria-label="Earlier calling points"${earlierOpen ? '' : ' hidden'}>${earlier.map((p) => stopCard(p, false)).join('')}</ol>`;
  return `${btn}${earlierList}<ol class="stops" aria-labelledby="stops-title">${main}</ol>`;
}

function statusChip(d: ServiceDetail): string {
  if (d.cancelled) return `<span class="chip cancel">Cancelled</span>`;
  // Headline delay = the lateness on arrival at the final stop.
  const last = d.points[d.points.length - 1];
  if (last && !last.cancelled) {
    const mins = delayMinutesAt(last);
    if (mins > 0) return `<span class="chip delay">+${mins} min</span>`;
  }
  return '';
}

/** The origin's departure status: past (Departed on time / Departed at HH:MM)
 *  or future (Scheduled HH:MM). Uses the client clock for now. The recorded
 *  departure actual (the origin only departs — it has no arrival) beats the
 *  forecast once the train has gone; with no report at all we say so rather
 *  than claiming "on time". */
function serviceStatus(d: ServiceDetail): string {
  const origin = d.points[0];
  if (!origin || !origin.scheduledTime) return '';
  const sched = origin.scheduledTime;
  const actual = origin.actualDeparture;
  const exp = origin.expectedTime;
  const schedMs = Date.parse(sched);
  if (actual || schedMs <= Date.now()) {
    if (actual) return actual === sched ? 'Departed on time' : `Departed at ${fmtTime(actual)}`;
    if (origin.noReport) return 'Departed — no live data';
    return exp === sched ? 'Departed on time' : `Departed at ${fmtTime(exp)}`;
  }
  return `Scheduled ${fmtTime(sched)}`;
}

/** The next station the train is due to call at — the first calling point
 *  AFTER the origin with no recorded actual whose scheduled time is still in
 *  the future (a stop with an actual is definitely passed, even if it ran
 *  early). The origin itself is skipped: while the train still sits there the
 *  header already shows its departure, so repeating it as "Next stop" wastes
 *  space — the stop after the origin is the useful next call. Null when no
 *  future stop remains (journey completed). */
function nextStop(d: ServiceDetail): CallingPoint | null {
  const now = Date.now();
  for (let i = 1; i < d.points.length; i++) {
    const p = d.points[i]!;
    if (p.actualArrival || p.actualDeparture) continue;
    if (Date.parse(p.scheduledTime) > now) return p;
  }
  return null;
}

function headerHtml(d: ServiceDetail, boardIdx: number): string {
  // The header anchors on the station the user searched from: its timetable
  // time (a departure where it has one — the only element RTT advertises at
  // pass-through stops) and its name with the official code. Searching from
  // the origin renders exactly the old header.
  const board = d.points[boardIdx] ?? d.points[0];
  const boardTime = board ? fmtTime(board.scheduledTime) : '';
  const boardIsLast = board != null && boardIdx >= d.points.length - 1;
  // Journey summary after the operator: scheduled duration · number of stops
  // · coach count. The journey runs from the station the user searched from
  // (boardIdx) to the destination — "Stops" excludes that station (you board
  // there - it's not a stop you travel to); each part drops out when its data
  // is absent. Searching from the origin keeps the full-journey figures.
  const lastScheduled = d.points[d.points.length - 1]?.scheduledTime ?? '';
  const journey = fmtDuration(board?.scheduledTime ?? '', lastScheduled);
  const stopCount = Math.max(0, d.points.length - boardIdx - 1);
  const stops = stopCount > 0 ? `${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}` : '';
  const coaches = d.coaches ? `${d.coaches} ${d.coaches === 1 ? 'coach' : 'coaches'}` : '';
  const sub = [d.operator, journey, stops, coaches].filter(Boolean).map(esc).join(' · ');
  const date = d.points[0] ? fmtDate(d.points[0].scheduledTime) : '';
  const chip = statusChip(d);
  const status = serviceStatus(d);
  const next = nextStop(d);
  const last = d.points[d.points.length - 1];
  const journeyCompleted =
    !next && last != null && (last.actualArrival != null || last.actualDeparture != null || Date.parse(last.scheduledTime) <= Date.now());
  let completionSuffix = '';
  if (journeyCompleted && last) {
    // The recorded actual (if TRUST reported it) is the truth; otherwise the
    // forecast. Only claim a result when we actually have one — with no report
    // at all (noReport and no forecast) there is nothing to say.
    const lastTime =
      last.actualArrival ?? last.actualDeparture ?? (last.expectedTime !== last.scheduledTime ? last.expectedTime : null);
    if (lastTime) {
      const diff = (Date.parse(lastTime) - Date.parse(last.scheduledTime)) / 60_000;
      const completedTime = fmtTime(lastTime);
      if (Math.abs(diff) < 1) completionSuffix = `, completed on time at ${completedTime}`;
      else if (diff > 0) completionSuffix = `, completed late at ${completedTime}`;
      else completionSuffix = `, completed early at ${completedTime}`;
    } else if (last.noReport) {
      completionSuffix = ' — no live data';
    }
  }
  // The page's h1: the board station's time + name to the destination. When
  // the board station IS the destination the service is arriving there, so the
  // heading reads as an arrival instead of a dangling "X to X".
  const boardName = stationLabel(board?.station ?? d.origin);
  let title: string;
  if (boardIsLast) {
    title = boardTime ? `${boardTime} arrival at ${esc(boardName)}` : esc(boardName);
  } else {
    title = `${boardTime ? `${boardTime} ` : ''}${esc(boardName)} to ${esc(stationLabel(d.destination))}`;
  }
  return `
    <h1 class="service-title" id="service-title">${title}</h1>
    <div class="stops-heading">
      <h2 class="stops-title" id="stops-title">Calling Points</h2>
      <button type="button" class="share-btn" aria-label="Share this list of calling points">${shareIconHtml()}</button>
      <span class="share-status" role="status" aria-live="polite"></span>
    </div>
    ${status ? `<p class="service-sub">Status${boardIdx > 0 ? ` (from ${esc(d.origin)})` : ''}: ${status}${completionSuffix}</p>` : ''}
    ${next ? `<p class="service-sub">Next stop: ${esc(stationLabel(next.station))}${next.noReport ? ' — no live data' : `, expected ${fmtTime(next.expectedTime)}`}</p>` : ''}
    ${sub ? `<p class="service-sub">${sub}</p>` : ''}
    ${date ? `<p class="service-date">${date}</p>` : ''}
    ${chip ? `<p class="service-status">${chip}</p>` : ''}`;
}

const NO_ID = 'No service specified. Open a service from a station board.';
const NOT_FOUND = 'We couldn\u2019t find that service. It may have run too long ago, or the link may be wrong.';
const ERROR_MSG = 'Couldn\u2019t load this service. We\u2019ll keep trying.';
const EMPTY = 'No calling points are available for this service.';
const LOADING = 'Loading service\u2026';

interface State {
  id: string | null;
  from: string | null;
  apiBase: string;
  mock: boolean;
  prev: ServiceDetail | null;
  asAtMs: number | null;
  recorded: boolean;
  /** Whether the earlier calling points are expanded. Survives the 30s
   *  re-renders so a user's choice isn't undone by a refresh. */
  earlierOpen: boolean;
}

interface Elements {
  back: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  asOf: HTMLElement;
  staleNote: HTMLElement;
}

export function initServiceDetail(root: HTMLElement): void {
  const apiBase = root.dataset.api ?? DEFAULT_API;
  const mock = root.dataset.mock === 'true';

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const fromParam = params.get('from');
  const from = fromParam && /^[A-Za-z]{3}$/.test(fromParam) ? fromParam.toUpperCase() : null;

  const back = document.getElementById('svc-back');
  const head = document.getElementById('svc-head');
  const body = document.getElementById('svc-body');
  const asOf = document.getElementById('as-of');
  const staleNote = document.getElementById('stale-note');
  if (!back || !head || !body || !asOf || !staleNote) return;
  const els: Elements = { back, head, body, asOf, staleNote };

  const state: State = { id, from, apiBase, mock, prev: null, asAtMs: null, recorded: false, earlierOpen: false };

  els.back.innerHTML = backLinkHtml(state.from);

  async function shareService(): Promise<void> {
    const url = window.location.href;
    const text = `I'm on this train: ${url}`;
    const status = els.head.querySelector('.share-status');
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: document.title, text });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        flashStatus(status, 'Link copied to clipboard');
      } else {
        flashStatus(status, 'Copying the link isn\u2019t available here \u2014 use the address bar.');
      }
    } catch {
      // The user dismissed the native share sheet; nothing to do.
    }
  }

  function flashStatus(el: Element | null, msg: string): void {
    if (!(el instanceof HTMLElement)) return;
    el.textContent = msg;
    window.setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 2500);
  }

  // Share button (delegated on the persistent header; the button itself is
  // re-created every refresh). Web Share API -> native sheet; clipboard copy as
  // a desktop fallback, announced via the button's polite status region.
  els.head.addEventListener('click', (event: Event) => {
    if (!(event.target instanceof Element)) return;
    if (!(event.target.closest('.share-btn') instanceof HTMLElement)) return;
    void shareService();
  });

  if (!id) {
    // Keep the page's h1: the error state must not leave a headingless page.
    els.head.innerHTML = '<h1 class="service-title">Service details</h1>';
    els.body.innerHTML = `<p class="board-msg">${NO_ID}</p>`;
    return;
  }

  els.body.innerHTML = `<p class="board-msg">${LOADING}</p>`;

  // `id` is narrowed to string here; capture it so the hoisted closures below
  // see a definite `string` (TS does not preserve guard narrowing inside
  // hoisted function declarations).
  const serviceId: string = id;

  async function fetchDetail(): Promise<{ resp: ServiceDetailResponse | null; notFound: boolean }> {
    if (state.mock) return { resp: mockDetailResponse(serviceId), notFound: false };
    try {
      const res = await fetch(`${state.apiBase}/service?id=${encodeURIComponent(serviceId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) return { resp: null, notFound: true };
      if (!res.ok) return { resp: null, notFound: false };
      return { resp: (await res.json()) as ServiceDetailResponse, notFound: false };
    } catch {
      return { resp: null, notFound: false };
    }
  }

  // "Show/Hide earlier calling points" disclosure (delegated on the list
  // container; the button itself is re-created on every refresh). APG
  // disclosure: toggling flips aria-expanded and the hidden attribute, and the
  // button's own label updates — screen readers announce the state change and
  // the new name on the focused button.
  els.body.addEventListener('click', (event: Event) => {
    const btn = (event.target as Element | null)?.closest('.earlier-btn') as HTMLButtonElement | null;
    if (!btn) return;
    state.earlierOpen = !state.earlierOpen;
    const list = document.getElementById('earlier-stops');
    if (list) list.hidden = !state.earlierOpen;
    btn.setAttribute('aria-expanded', String(state.earlierOpen));
    btn.textContent = state.earlierOpen ? 'Hide earlier calling points' : 'Show earlier calling points';
  });

  function render(d: ServiceDetail): void {
    const boardIdx = boardPointIndex(d, state.from);
    els.head.innerHTML = headerHtml(d, boardIdx);
    els.body.innerHTML = d.points.length === 0 ? `<p class="board-msg">${EMPTY}</p>` : stopsHtml(d, boardIdx, state.earlierOpen);
    const titleEl = document.getElementById('service-title');
    if (titleEl?.textContent) document.title = `${titleEl.textContent} — VIPTrains.org.uk`;
  }

  function setAsAt(epochMs: number, stale: boolean): void {
    state.asAtMs = epochMs;
    els.asOf.textContent = `As of ${fmtClock(epochMs)}`;
    els.staleNote.textContent = stale
      ? `Couldn\u2019t reach live data — showing details from ${fmtClock(epochMs)}.`
      : '';
  }

  let stopped = false;
  async function refresh(): Promise<void> {
    const { resp, notFound } = await fetchDetail();
    if (notFound) {
      // A 404 is definitive for this id — it won't recover, so stop refreshing.
      stop();
      // Keep the page's h1: the error state must not leave a headingless page.
      els.head.innerHTML = '<h1 class="service-title">Service details</h1>';
      els.body.innerHTML = `<p class="board-msg error">${NOT_FOUND}</p>`;
      els.staleNote.textContent = '';
      return;
    }
    if (resp) {
      render(resp.detail);
      setAsAt(resp.asAt, resp.stale);
      state.prev = resp.detail;
      // Record the visit to History once (the first successful load) — never
      // on the 30s refreshes, so visitedAt reflects when the page was opened.
      // The entry anchors on the searched-from station when there is one, so
      // History shows the same time + station as the page header.
      if (!state.recorded && resp.detail.id && resp.detail.origin) {
        state.recorded = true;
        const boardIdx = boardPointIndex(resp.detail, state.from);
        const boardPoint = boardIdx > 0 ? resp.detail.points[boardIdx] : undefined;
        recordServiceVisit(resp.detail, {
          station: boardPoint?.station,
          time: boardPoint?.scheduledTime,
          crs: state.from,
        });
      }
    } else if (state.prev && state.asAtMs !== null) {
      // Worker unreachable but we have a prior detail — keep it, mark stale.
      setAsAt(state.asAtMs, true);
    } else {
      els.body.innerHTML = `<p class="board-msg error">${ERROR_MSG}</p>`;
      els.staleNote.textContent = '';
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    stop();
    timer = setInterval(() => void refresh(), REFRESH_MS);
  }
  function stop(): void {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.hidden) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    } else {
      void refresh();
      start();
    }
  });

  void refresh();
  start();

  // Resolve station codes for the header and the platform links as soon as the
  // list arrives (the first render happens without them, then updates in place).
  onStationCrsReady(() => {
    if (state.prev) render(state.prev);
  });
}

// ---- Mock detail for offline dev (PUBLIC_MOCK=true) ----

function mockDetailResponse(id: string): ServiceDetailResponse {
  const today = new Date().toISOString().slice(0, 10);
  const t = (h: number, m: number) =>
    `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  return {
    detail: {
      id,
      origin: 'London King\u2019s Cross',
      destination: 'Edinburgh',
      operator: 'LNER',
      coaches: 9,
      cancelled: false,
      points: [
        { station: 'London King\u2019s Cross', scheduledTime: t(10, 0), expectedTime: t(10, 0), platform: { number: '1', state: 'confirmed' }, cancelled: false },
        { station: 'Peterborough', scheduledTime: t(10, 48), expectedTime: t(10, 52), platform: { number: '3', state: 'confirmed' }, cancelled: false },
        { station: 'York', scheduledTime: t(11, 38), expectedTime: t(11, 44), platform: { number: '5', state: 'provisional' }, cancelled: false },
        { station: 'Newcastle', scheduledTime: t(12, 28), expectedTime: t(12, 35), platform: null, cancelled: false },
        { station: 'Edinburgh', scheduledTime: t(13, 30), expectedTime: t(13, 38), platform: { number: '7', state: 'confirmed' }, cancelled: false },
      ],
    },
    asAt: Date.now(),
    stale: false,
  };
}
