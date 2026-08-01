// Client controller for a service detail page. Imported by service/index.astro.
//
// The page is shareable: it reads ?id=<uniqueIdentity> from the URL, fetches the
// service's full public calling pattern from the Worker, and renders an
// accessible list of stop cards (mirroring the station board) - each stop's
// timetable time, expected time ("On time" when unchanged, else the expected
// time; "Cancelled" for cancelled stops) and platform. Refreshes every 30s
// (paused while the tab is hidden) to keep expected times live.

import { fmtClock, fmtTime } from '../lib/format';
import { esc, platformChip } from '../lib/html';
import type { CallingPoint, Platform, ServiceDetail, ServiceDetailResponse } from '../lib/types';

const REFRESH_MS = 30_000;
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

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

  // Top-right: the live status for this stop. A visually-hidden "Expected "
  // disambiguates a delayed time from the timetable time for screen readers.
  let expHtml: string;
  if (p.cancelled) {
    expHtml = `<div class="stop-exp cancel"><span class="visually-hidden">Expected </span>Cancelled</div>`;
  } else {
    const exp = fmtTime(p.expectedTime);
    expHtml =
      exp === sched
        ? `<div class="stop-exp on-time"><span class="visually-hidden">Expected </span>On time</div>`
        : `<div class="stop-exp delay"><span class="visually-hidden">Expected </span>${esc(exp)}</div>`;
  }

  return `<li class="stop">${timeHtml}${stationHtml}${expHtml}${stopPlatform(p.platform)}</li>`;
}

function stopsHtml(d: ServiceDetail): string {
  // A real <ol> (the route is an ordered sequence) of stop cards, mirroring the
  // station board's .svc rows so the two lists share a visual language. The
  // aria-label frames the fields for screen readers, which (with no <th> here)
  // hear each value via its visually-hidden cell label.
  return `<ol class="stops" aria-label="Calling points for the ${esc(d.origin)} to ${esc(d.destination)} service: station, timetable time, expected time, and platform.">${d.points.map(stopCard).join('')}</ol>`;
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

function headerHtml(d: ServiceDetail): string {
  const coaches = d.coaches ? `${d.coaches} ${d.coaches === 1 ? 'coach' : 'coaches'}` : '';
  const sub = [d.operator, coaches].filter(Boolean).map(esc).join(' · ');
  const date = d.points[0] ? fmtDate(d.points[0].scheduledTime) : '';
  const chip = statusChip(d);
  return `
    <h1 class="service-title" id="service-title">${esc(d.origin)} to ${esc(d.destination)}</h1>
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
