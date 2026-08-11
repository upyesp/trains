// Client controller for a station board. Imported by StationBoard.astro.
//
// On load: fetches the live board from the Worker, renders it, and refreshes
// every 30s (paused while the tab is hidden - saves the shared RTT rate budget,
// see docs/research/rtt-api.md sec 6). Between refreshes it diffs previous vs
// current via the PURE diffBoards() (src/lib/diff) and announces ONLY meaningful
// changes to a polite aria-live region (ADR-0002): cancellation, platform change,
// or a >=5min expected-time swing. Routine churn is silent.
//
// The Worker returns stale-while-error itself (stale:true + cached board) on
// upstream failure; we only show our local "couldn't load" path when the Worker
// itself is unreachable.

import { diffBoards } from '../lib/diff';
import { fmtClock, fmtDurationMin, fmtTime } from '../lib/format';
import { esc, platformChip } from '../lib/html';
import type {
  Board,
  BoardKind,
  BoardResponse,
  MeaningfulChange,
  Platform,
  Service,
} from '../lib/types';
import { initCombobox } from './combobox';

const REFRESH_MS = 30_000;
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

interface State {
  crs: string;
  kind: BoardKind;
  callsAt: string | null;
  apiBase: string;
  mock: boolean;
  stationName: string;
  prev: Board | null;
  asAtMs: number | null;
}

interface Elements {
  body: HTMLOListElement;
  asOf: HTMLElement;
  staleNote: HTMLElement;
  announcer: HTMLElement;
  clock: HTMLElement;
  tablist: HTMLElement;
  tabs: HTMLButtonElement[];
  filterInput: HTMLInputElement | null;
}

// ---- Pure HTML builders (escaped; safe against RTT-provided strings) ----

function delayMinutes(s: Service): number {
  // The recorded actual (once the train has passed) beats the forecast.
  const sched = Date.parse(s.scheduledTime);
  const exp = Date.parse(s.actualTime ?? s.expectedTime);
  if (Number.isNaN(sched) || Number.isNaN(exp)) return 0;
  return Math.round((exp - sched) / 60_000);
}

// Each field renders as a labelled <div> inside an <li> (see StationBoard.astro).
// The board is a real <ol> of service cards - not a <table> - so the layout is
// fully responsive (cards on phones) without CSS display:block tricks that can
// drop table semantics in some screen readers (ADR-0002). Field order in the
// DOM is time, destination, platform, status: logical for screen readers, and
// the desktop grid reads them into columns in that same order.

// The enclosing cell (platformCell) carries the screen-reader label and
// wraps the shared chip (src/lib/html), which owns the visible caption.
function platformCell(p: Platform | null): string {
  // This visually-hidden label is the one screen readers announce; the visible
  // "Platform" caption now lives inside the chip (platformChip).
  const srLabel = p
    ? '<span class="visually-hidden">Platform: </span>'
    : '<span class="visually-hidden">Platform not allocated</span>';
  return `<div class="svc-plat">${srLabel}${platformChip(p)}</div>`;
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

function destCell(s: Service): string {
  const journey = s.journeyMins != null ? fmtDurationMin(s.journeyMins) : '';
  const coaches = s.coaches != null ? `${s.coaches} ${s.coaches === 1 ? 'coach' : 'coaches'}` : '';
  const meta = [journey, coaches].filter(Boolean).map(esc).join(' · ');
  const metaHtml = meta ? `<span class="coaches">${meta}</span>` : '';
  const href = `/service/?${new URLSearchParams({ id: s.id }).toString()}`;
  return `<div class="svc-dest"><span class="dest"><a class="svc-link" href="${href}"><span class="dest-name">${esc(s.destination)}</span> <span class="visually-hidden">view calling points for this service</span></a><span class="toc">${esc(s.operator)}</span>${metaHtml}</span></div>`;
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

function rowHtml(s: Service, _crs: string): string {
  const cls = s.cancelled ? 'svc is-cancelled' : 'svc';
  // Only the station name is a link — not the whole row — so it's obvious
  // and hard to trigger accidentally (same pattern as calling-point stops).
  return `<li class="svc-item"><div class="${cls}">${timeCell(s)}${destCell(s)}${statusCell(s)}${platformCell(s.platform)}</div></li>`;
}

const LOADING_ROW = '<li class="board-msg">Loading live board…</li>';
const EMPTY_ROW = '<li class="board-msg">No services in the next two hours.</li>';
const FILTERED_EMPTY_ROW =
  '<li class="board-msg">No services calling at the selected station in the next two hours.</li>';
const ERROR_ROW = '<li class="board-msg error">Couldn\u2019t load the live board. We\u2019ll keep trying.</li>';

// ---- Announcement phrasing (mirrors diffBoards output) ----

function describePlatform(p: Platform | null): string {
  if (!p) return 'no platform is allocated';
  if (p.state === 'at-platform') return `at platform ${p.number}`;
  if (p.state === 'confirmed') return `platform confirmed — platform ${p.number}`;
  return `provisional platform ${p.number}`;
}

function describeChanges(changes: MeaningfulChange[], board: Board): string[] {
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

function sameKey(a: Board, b: Board): boolean {
  return a.station === b.station && a.kind === b.kind;
}

// ---- Mock board for offline dev (PUBLIC_MOCK=true) ----

function mockBoardResponse(crs: string, kind: BoardKind): BoardResponse {
  const today = new Date().toISOString().slice(0, 10);
  const t = (h: number, m: number) =>
    `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const services: Service[] = [
    { id: 'M1', scheduledTime: t(10, 38), expectedTime: t(10, 38), platform: { number: '3', state: 'confirmed' }, destination: 'Leeds', operator: 'LNER', coaches: 9, journeyMins: 45, cancelled: false },
    { id: 'M2', scheduledTime: t(10, 42), expectedTime: t(10, 48), platform: { number: '9', state: 'confirmed' }, destination: 'Newcastle', operator: 'LNER', coaches: 9, journeyMins: 90, cancelled: false },
    { id: 'M3', scheduledTime: t(10, 45), expectedTime: t(10, 45), platform: { number: '1', state: 'provisional' }, destination: 'Edinburgh', operator: 'LNER', coaches: 10, journeyMins: 230, cancelled: false },
    { id: 'M4', scheduledTime: t(10, 50), expectedTime: t(10, 50), platform: null, destination: 'York', operator: 'LNER', coaches: null, journeyMins: null, cancelled: true },
  ];
  return { board: { station: crs, kind, services }, asAt: Date.now(), stale: false };
}

// ---- Controller ----

export function initBoard(root: HTMLElement): void {
  const crs = root.dataset.crs;
  if (!crs) return;
  const initialKind: BoardKind = root.dataset.kind === 'arrivals' ? 'arrivals' : 'departures';
  const apiBase = root.dataset.api ?? DEFAULT_API;
  const mock = root.dataset.mock === 'true';

  // "calling at" filter restored from the URL (?callsAt=CLJ) so a saved
  // favourite re-opens already filtered. The URL is written by a REAL
  // navigation (updateUrl), never replaceState, so the page is always loaded
  // with the filter already in place.
  const callsParam = new URLSearchParams(window.location.search).get('callsAt');
  const initialCallsAt =
    callsParam && /^[A-Za-z]{3}$/.test(callsParam) ? callsParam.toUpperCase() : null;

  const body = root.querySelector<HTMLOListElement>('#board-body');
  const asOf = document.getElementById('as-of');
  const staleNote = document.getElementById('stale-note');
  const announcer = document.getElementById('announcer');
  const clock = document.getElementById('clock');
  const tablist = document.getElementById('tablist');
  const stationNameEl = document.getElementById('station-name');
  if (!body || !asOf || !staleNote || !announcer || !clock || !tablist) return;

  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const filterInput = document.getElementById('calls-input') as HTMLInputElement | null;
  const els: Elements = { body, asOf, staleNote, announcer, clock, tablist, tabs, filterInput };
  const stationName = stationNameEl?.textContent ?? crs;

  const state: State = {
    crs,
    kind: initialKind,
    callsAt: initialCallsAt,
    apiBase,
    mock,
    stationName,
    prev: null,
    asAtMs: null,
  };

  // When a filter was restored from the URL (a reload after updateUrl's real
  // navigation), announce it once the combobox has resolved the station name
  // into the input — the reload replaced the old in-page announcement.
  let filterRestorePending = initialCallsAt !== null;

  function render(board: Board): void {
    els.body.innerHTML =
      board.services.length === 0
        ? state.callsAt
          ? FILTERED_EMPTY_ROW
          : EMPTY_ROW
        : board.services.map((s) => rowHtml(s, state.crs)).join('');
  }

  function setAsAt(epochMs: number, stale: boolean): void {
    state.asAtMs = epochMs;
    els.asOf.textContent = `As of ${fmtClock(epochMs)}`;
    els.staleNote.textContent = stale
      ? `Couldn\u2019t reach live data — showing the board from ${fmtClock(epochMs)}.`
      : '';
  }

  function announce(messages: string[]): void {
    els.announcer.textContent = '';
    if (messages.length === 0) return;
    // Clear-then-write on next frame so a repeated message re-announces.
    requestAnimationFrame(() => {
      els.announcer.textContent = messages.join(' ');
    });
  }

  async function fetchBoard(kind: BoardKind): Promise<BoardResponse | null> {
    if (state.mock) return mockBoardResponse(state.crs, kind);
    const params = new URLSearchParams({ kind });
    if (state.callsAt) params.set('callsAt', state.callsAt);
    const url = `${state.apiBase}/board/${encodeURIComponent(state.crs)}?${params}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return (await res.json()) as BoardResponse;
    } catch {
      return null;
    }
  }

  async function refresh(): Promise<void> {
    const resp = await fetchBoard(state.kind);
    if (resp) {
      const messages =
        state.prev && sameKey(state.prev, resp.board)
          ? describeChanges(diffBoards(state.prev, resp.board), resp.board)
          : [];
      if (resp.board.kind !== state.kind) {
        state.kind = resp.board.kind;
        syncTabUi();
      }
      render(resp.board);
      updateBoardLabel();
      setAsAt(resp.asAt, resp.stale);
      state.prev = resp.board;
      announce(messages);
      if (filterRestorePending && state.callsAt) {
        const fname = els.filterInput?.value.trim();
        if (fname) {
          filterRestorePending = false;
          const noun = state.kind === 'arrivals' ? 'Arrivals' : 'Departures';
          announce([`${noun} filtered to services calling at ${fname}.`]);
        }
      }
    } else if (state.prev && state.asAtMs !== null) {
      // Worker unreachable but we have a prior board - keep it, mark stale.
      setAsAt(state.asAtMs, true);
    } else {
      els.body.innerHTML = ERROR_ROW;
      els.staleNote.textContent = '';
    }
  }

  function updateBoardLabel(): void {
    // The <ol>'s accessible name frames the whole board for screen readers,
    // including the active "calling at" filter so AT users know it is applied.
    const verb = state.kind === 'arrivals' ? 'arrivals at' : 'departures from';
    let label = `Live ${verb} ${state.stationName}`;
    const fname = els.filterInput?.value.trim();
    if (state.callsAt && fname) label += ` calling at ${fname}`;
    els.body.setAttribute('aria-label', label);
  }

  function syncTabUi(): void {
    for (const t of els.tabs) {
      const on = (t.dataset.kind ?? 'departures') === state.kind;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    }
    updateBoardLabel();
  }

  function setupTabs(): void {
    for (const t of els.tabs) {
      t.addEventListener('click', () => {
        const k = t.dataset.kind;
        if (k !== 'departures' && k !== 'arrivals') return;
        if (k === state.kind) return;
        state.kind = k;
        state.prev = null; // don't diff across kinds
        syncTabUi();
        void refresh();
      });
    }
    els.tablist.addEventListener('keydown', (e) => {
      const current = els.tabs.indexOf(document.activeElement as HTMLButtonElement);
      const focusAt = (i: number) => {
        const el = els.tabs[i];
        if (el) el.focus();
      };
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (current >= 0 && current < els.tabs.length - 1) focusAt(current + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (current > 0) focusAt(current - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        els.tabs[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        els.tabs[els.tabs.length - 1]?.focus();
      }
    });
  }

  function setupFilter(): void {
    const filterCombo = document.getElementById('combo-filter');
    if (!(filterCombo instanceof HTMLElement)) return;
    initCombobox(filterCombo, {
      selectable: true,
      initialCrs: state.callsAt,
      onChoose: (station) => {
        state.callsAt = station.crs;
        // updateUrl() navigates; the reloaded page restores the filter from
        // the URL and announces it (filterRestorePending).
        updateUrl();
      },
      onClear: () => {
        state.callsAt = null;
        updateUrl();
      },
    });
  }

  function updateUrl(): void {
    const url = new URL(window.location.href);
    if (state.callsAt) url.searchParams.set('callsAt', state.callsAt);
    else url.searchParams.delete('callsAt');
    // A REAL navigation, not replaceState: Android Chrome's "Add to home
    // screen" saves the URL the page was LOADED with, so a same-document
    // replaceState change would be lost on the saved icon (the browser's
    // share option, which reads the live address bar, would keep it — the
    // exact mismatch reported). The page restores the filter from ?callsAt=
    // on load, so a reload is cheap and the filter survives everywhere.
    window.location.assign(url.toString());
  }

  function setupClock(): void {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      els.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    tick();
    window.setInterval(tick, 1000);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    stop();
    timer = window.setInterval(() => void refresh(), REFRESH_MS);
  }
  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else {
      void refresh();
      start();
    }
  });

  // boot
  setupTabs();
  setupFilter();
  syncTabUi();
  setupClock();
  els.body.innerHTML = LOADING_ROW;
  void refresh();
  start();
}
