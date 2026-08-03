// Client controller for a service detail page. Imported by service/index.astro.
//
// The page is shareable: it reads ?id=<uniqueIdentity> from the URL, fetches the
// service's full public calling pattern from the Worker, and renders an
// accessible list of stop cards (mirroring the station board) - each stop's
// timetable time, expected time ("On time" when unchanged, else the expected
// time; "Cancelled" for cancelled stops) and platform. Refreshes every 30s
// (paused while the tab is hidden) to keep expected times live.

import { fmtClock, fmtDurationMin, fmtTime } from '../lib/format';
import { esc, platformChip } from '../lib/html';
import type { CallingPoint, Platform, ServiceDetail, ServiceDetailResponse } from '../lib/types';

const REFRESH_MS = 30_000;
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

/** Share glyph (Lucide "share-2": three linked nodes) for the header button.
 *  aria-hidden - the button's aria-label is the accessible name. */
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.42" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

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
  const sched = Date.parse(p.scheduledTime);
  const exp = Date.parse(p.expectedTime);
  if (Number.isNaN(sched) || Number.isNaN(exp)) return 0;
  return Math.round((exp - sched) / 60_000);
}

// ---- Pure HTML builders (escaped; safe against RTT-provided strings) ----

function backLinkHtml(from: string | null): string {
  if (!from) return `<a class="back-link" href="/">← All stations</a>`;
  return `<a class="back-link" href="/stations/${from.toLowerCase()}/">← Back to ${esc(from)} board</a>`;
}

/** Platform rendered with the shared .plat chip, wrapped for the stop card. */
function stopPlatform(p: Platform | null): string {
  // The visually-hidden label is what AT announces; the chip's own inline
  // "Platform" caption (aria-hidden) is the visible one.
  const srLabel = p
    ? '<span class="visually-hidden">Platform: </span>'
    : '<span class="visually-hidden">Platform not allocated</span>';
  return `<div class="stop-plat">${srLabel}${platformChip(p)}</div>`;
}

function stopCard(p: CallingPoint): string {
  const sched = fmtTime(p.scheduledTime);

  // Top-left: timetable time (struck when this stop is cancelled).
  const timeInner = p.cancelled ? `<s>${esc(sched)}</s>` : esc(sched);
  const timeHtml =
    `<div class="stop-time"><span class="visually-hidden">Timetable </span><span class="time">${timeInner}</span></div>`;

  // Bottom-left: station name, the card's primary text.
  const stationHtml = `<div class="stop-station"><span class="dest">${esc(p.station)}</span></div>`;

  // Top-right: the live status for this stop. A "Departed"/"Expected" prefix
  // tells whether the train has already left this calling point (past) or has
  // not arrived yet (future), based on a comparison with the current clock.
  let expHtml: string;
  if (p.cancelled) {
    expHtml = `<div class="stop-exp cancel">Cancelled</div>`;
  } else {
    const exp = fmtTime(p.expectedTime);
    const pointMs = Date.parse(p.scheduledTime);
    const isPast = Number.isFinite(pointMs) && pointMs < Date.now();
    const prefix = isPast ? 'Departed' : 'Expected';
    const cls = exp === sched ? 'on-time' : 'delay';
    expHtml = `<div class="stop-exp ${cls}">${prefix} ${exp === sched ? 'On time' : exp}</div>`;
  }

  // The whole card links to the home search primed with this station, which
  // then lists that station's departures (a bare /stations/<crs> URL = no
  // "calling at" filter, even if one was set on a previous board).
  const href = `/?${new URLSearchParams({ station: p.station }).toString()}`;
  return `<li class="stop-item"><a class="stop" href="${href}">${timeHtml}${stationHtml}${expHtml}${stopPlatform(p.platform)}<span class="visually-hidden">View live departures from this station.</span></a></li>`;
}

function stopsHtml(d: ServiceDetail): string {
  // A real <ol> (the route is an ordered sequence) of stop cards, mirroring the
  // station board's .svc rows so the two lists share a visual language. The
  // visible "Calling Points" heading (in the header) is the list's accessible
  // name (aria-labelledby); each value also carries a visually-hidden field
  // label for screen readers.
  return `<ol class="stops" aria-labelledby="stops-title">${d.points.map(stopCard).join('')}</ol>`;
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
 *  or future (Scheduled HH:MM). Uses the client clock for now. */
function serviceStatus(d: ServiceDetail): string {
  const origin = d.points[0];
  if (!origin || !origin.scheduledTime) return '';
  const sched = origin.scheduledTime;
  const exp = origin.expectedTime;
  const schedMs = Date.parse(sched);
  if (schedMs <= Date.now()) {
    return exp === sched ? 'Departed on time' : `Departed at ${fmtTime(exp)}`;
  }
  return `Scheduled ${fmtTime(sched)}`;
}

/** The first calling point whose scheduled time is still in the future,
 *  excluding the origin (which would just repeat the departure). Empty when the
 *  service has passed every stop. */
function nextStopName(d: ServiceDetail): string {
  const now = Date.now();
  for (let i = 0; i < d.points.length; i++) {
    const p = d.points[i];
    if (!p) continue;
    if (Date.parse(p.scheduledTime) > now) return i === 0 ? '' : p.station;
  }
  return '';
}

function headerHtml(d: ServiceDetail): string {
  const originTime = fmtTime(d.points[0]?.scheduledTime ?? '');
  // Journey summary after the operator: scheduled duration · number of stops
  // · coach count. "Stops" excludes the origin (you board there - it's not a
  // stop you travel to); each part drops out when its data is absent.
  const journey = fmtDuration(d.points[0]?.scheduledTime ?? '', d.points[d.points.length - 1]?.scheduledTime ?? '');
  const stopCount = Math.max(0, d.points.length - 1);
  const stops = stopCount > 0 ? `${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}` : '';
  const coaches = d.coaches ? `${d.coaches} ${d.coaches === 1 ? 'coach' : 'coaches'}` : '';
  const sub = [d.operator, journey, stops, coaches].filter(Boolean).map(esc).join(' · ');
  const date = d.points[0] ? fmtDate(d.points[0].scheduledTime) : '';
  const chip = statusChip(d);
  const status = serviceStatus(d);
  const next = nextStopName(d);
  return `
    <h1 class="service-title" id="service-title">${originTime ? `${originTime} — ` : ''}${esc(d.origin)} to ${esc(d.destination)}</h1>
    <div class="stops-heading">
      <h2 class="stops-title" id="stops-title">Calling Points</h2>
      <button type="button" class="share-btn" aria-label="Share this service">${SHARE_ICON}</button>
      <span class="share-status" role="status" aria-live="polite"></span>
    </div>
    ${status ? `<p class="service-sub">Status: ${status}</p>` : ''}
    ${next ? `<p class="service-sub">Next stop: ${esc(next)}</p>` : ''}
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

  const state: State = { id, from, apiBase, mock, prev: null, asAtMs: null };

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
    els.head.innerHTML = '';
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

  function render(d: ServiceDetail): void {
    els.head.innerHTML = headerHtml(d);
    els.body.innerHTML = d.points.length === 0 ? `<p class="board-msg">${EMPTY}</p>` : stopsHtml(d);
    const titleEl = document.getElementById('service-title');
    if (titleEl?.textContent) document.title = `${titleEl.textContent} — VIP Trains`;
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
      els.head.innerHTML = '';
      els.body.innerHTML = `<p class="board-msg error">${NOT_FOUND}</p>`;
      els.staleNote.textContent = '';
      return;
    }
    if (resp) {
      render(resp.detail);
      setAsAt(resp.asAt, resp.stale);
      state.prev = resp.detail;
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
