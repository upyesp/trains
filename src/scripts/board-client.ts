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
import { fmtClock, fmtTime } from '../lib/format';
import type {
  Board,
  BoardKind,
  BoardResponse,
  MeaningfulChange,
  Platform,
  Service,
} from '../lib/types';

const REFRESH_MS = 30_000;
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

interface State {
  crs: string;
  kind: BoardKind;
  apiBase: string;
  mock: boolean;
  stationName: string;
  prev: Board | null;
  asAtMs: number | null;
}

interface Elements {
  body: HTMLTableSectionElement;
  asOf: HTMLElement;
  staleNote: HTMLElement;
  caption: HTMLElement;
  announcer: HTMLElement;
  clock: HTMLElement;
  tablist: HTMLElement;
  tabs: HTMLButtonElement[];
}

// ---- Pure HTML builders (escaped; safe against RTT-provided strings) ----

function delayMinutes(s: Service): number {
  const sched = Date.parse(s.scheduledTime);
  const exp = Date.parse(s.expectedTime);
  if (Number.isNaN(sched) || Number.isNaN(exp)) return 0;
  return Math.round((exp - sched) / 60_000);
}

function platformCell(p: Platform | null): string {
  if (!p) return '<td><span class="plat none">—<span class="state">none</span></span></td>';
  const n = esc(p.number);
  if (p.state === 'provisional') {
    return `<td><span class="plat provisional">${n}<span class="state">provisional</span></span></td>`;
  }
  // Confirmed platforms carry a visually-hidden label so the state is in text
  // for screen readers without adding visual noise (ADR-0002).
  return `<td><span class="plat">${n}<span class="visually-hidden">, confirmed</span></span></td>`;
}

function timeCell(s: Service): string {
  const sched = fmtTime(s.scheduledTime);
  if (s.cancelled) return `<td><span class="time">${esc(sched)}</span></td>`;
  const exp = fmtTime(s.expectedTime);
  if (sched !== exp) {
    return `<td><span class="time"><span class="sched">${esc(sched)}</span><span class="arrow" aria-hidden="true">↘</span><span class="exp">${esc(exp)}</span></span></td>`;
  }
  return `<td><span class="time">${esc(exp)}</span></td>`;
}

function statusCell(s: Service): string {
  if (s.cancelled) return '<td class="status"><span class="chip cancel">Cancelled</span></td>';
  const mins = delayMinutes(s);
  if (mins > 0) return `<td class="status"><span class="chip delay">+${mins} min</span></td>`;
  return '<td class="status"></td>';
}

function rowHtml(s: Service): string {
  const cls = s.cancelled ? ' class="is-cancelled"' : '';
  return `<tr${cls}>${timeCell(s)}<td><span class="dest">${esc(s.destination)}<span class="toc">${esc(s.operator)}</span></span></td>${platformCell(s.platform)}${statusCell(s)}</tr>`;
}

const LOADING_ROW = '<tr><td colspan="4" class="board-msg">Loading live board…</td></tr>';
const EMPTY_ROW = '<tr class="empty-row"><td colspan="4">No services in the next two hours.</td></tr>';
const ERROR_ROW = '<tr><td colspan="4" class="board-msg error">Couldn\u2019t load the live board. We\u2019ll keep trying.</td></tr>';

// ---- Announcement phrasing (mirrors diffBoards output) ----

function describePlatform(p: Platform | null): string {
  if (!p) return 'no platform is allocated';
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
    { id: 'M1', scheduledTime: t(10, 38), expectedTime: t(10, 38), platform: { number: '3', state: 'confirmed' }, destination: 'Leeds', operator: 'LNER', cancelled: false },
    { id: 'M2', scheduledTime: t(10, 42), expectedTime: t(10, 48), platform: { number: '9', state: 'confirmed' }, destination: 'Newcastle', operator: 'LNER', cancelled: false },
    { id: 'M3', scheduledTime: t(10, 45), expectedTime: t(10, 45), platform: { number: '1', state: 'provisional' }, destination: 'Edinburgh', operator: 'LNER', cancelled: false },
    { id: 'M4', scheduledTime: t(10, 50), expectedTime: t(10, 50), platform: null, destination: 'York', operator: 'LNER', cancelled: true },
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

  const body = root.querySelector<HTMLTableSectionElement>('#board-body');
  const asOf = document.getElementById('as-of');
  const staleNote = document.getElementById('stale-note');
  const caption = document.getElementById('caption-station');
  const announcer = document.getElementById('announcer');
  const clock = document.getElementById('clock');
  const tablist = document.getElementById('tablist');
  const stationNameEl = document.getElementById('station-name');
  if (!body || !asOf || !staleNote || !caption || !announcer || !clock || !tablist) return;

  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const els: Elements = { body, asOf, staleNote, caption, announcer, clock, tablist, tabs };
  const stationName = stationNameEl?.textContent ?? crs;

  const state: State = { crs, kind: initialKind, apiBase, mock, stationName, prev: null, asAtMs: null };

  function render(board: Board): void {
    els.body.innerHTML =
      board.services.length === 0 ? EMPTY_ROW : board.services.map(rowHtml).join('');
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
    const url = `${state.apiBase}/board/${encodeURIComponent(state.crs)}?kind=${kind}`;
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
      setAsAt(resp.asAt, resp.stale);
      state.prev = resp.board;
      announce(messages);
    } else if (state.prev && state.asAtMs !== null) {
      // Worker unreachable but we have a prior board - keep it, mark stale.
      setAsAt(state.asAtMs, true);
    } else {
      els.body.innerHTML = ERROR_ROW;
      els.staleNote.textContent = '';
    }
  }

  function syncTabUi(): void {
    for (const t of els.tabs) {
      const on = (t.dataset.kind ?? 'departures') === state.kind;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    }
    els.caption.textContent = `${state.stationName} ${state.kind}`;
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
  syncTabUi();
  setupClock();
  els.body.innerHTML = LOADING_ROW;
  void refresh();
  start();
}
