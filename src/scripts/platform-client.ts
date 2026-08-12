// Client controller for a per-platform board (platform/index.astro).
//
// Reads ?station=<CRS>&platform=<number> from the URL, fetches the station's
// board for the ACTIVE direction (Departures / Arrivals tabs, like the station
// board) with a one-hour lookback so recently departed/arrived services are
// included, filters to this platform, and lists those services — refreshed
// every 30s (paused while the tab is hidden). Switching direction resets the
// diff baseline so changes aren't announced across kinds. Meaningful changes
// (filtered to this platform) go to a polite live region, mirroring the station
// board.
//
// The platform column is dropped entirely here — every service is on this one
// platform (named by the page title/lede), so boardRowsHtml is asked to omit it.

import { boardRowsHtml, describeChanges, sameKey } from '../lib/board-html';
import { diffBoards } from '../lib/diff';
import { fmtClock } from '../lib/format';
import { onStationCrsReady, stationLabel, stationNameByCrs } from '../lib/station-codes';
import type { Board, BoardKind, BoardResponse, MeaningfulChange } from '../lib/types';

const REFRESH_MS = 30_000;
const LOOKBACK_MIN = 60; // include the preceding hour, per RTT timeFrom
const DEFAULT_API = 'https://trains-api.upyesp.workers.dev';

const CRS_RE = /^[A-Za-z]{3}$/;
const PLATFORM_RE = /^[A-Za-z0-9]{1,4}$/;

const EMPTY_ROW = '<li class="board-msg">No services at this platform in the next two hours.</li>';
const ERROR_ROW = '<li class="board-msg error">Couldn\u2019t load the live board. We\u2019ll keep trying.</li>';

/** A service uses this platform when its platform number matches (case-insensitive). */
function usesPlatform(board: Board, platform: string): Board {
  const p = platform.toLowerCase();
  return { ...board, services: board.services.filter((s) => s.platform?.number.toLowerCase() === p) };
}

/** Only changes to services that use this platform are worth announcing. */
function changesForPlatform(changes: MeaningfulChange[], board: Board, platform: string): MeaningfulChange[] {
  const p = platform.toLowerCase();
  const byId = new Map(board.services.map((s) => [s.id, s]));
  return changes.filter((c) => byId.get(c.serviceId)?.platform?.number.toLowerCase() === p);
}

interface State {
  crs: string;
  platform: string;
  kind: BoardKind;
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
  tablist: HTMLElement;
  tabs: HTMLButtonElement[];
}

export function initPlatform(root: HTMLElement): void {
  const apiBase = root.dataset.api ?? DEFAULT_API;
  const mock = root.dataset.mock === 'true';

  const params = new URLSearchParams(window.location.search);
  const crsRaw = params.get('station') ?? '';
  const platformRaw = params.get('platform') ?? '';
  const crs = crsRaw.toUpperCase();
  if (!CRS_RE.test(crsRaw) || !PLATFORM_RE.test(platformRaw)) {
    const body = root.querySelector<HTMLOListElement>('#plat-body');
    if (body) {
      body.innerHTML =
        '<li class="board-msg error">This platform link is incomplete. Open it from a station board or calling points list.</li>';
    }
    return;
  }
  const platform = platformRaw.toUpperCase();

  const body = root.querySelector<HTMLOListElement>('#plat-body');
  const asOf = document.getElementById('as-of');
  const staleNote = document.getElementById('stale-note');
  const announcer = document.getElementById('announcer');
  const tablist = document.getElementById('tablist');
  if (!body || !asOf || !staleNote || !announcer || !tablist) return;
  const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  const els: Elements = { body, asOf, staleNote, announcer, tablist, tabs };

  const state: State = {
    crs,
    platform,
    kind: 'departures',
    apiBase,
    mock,
    stationName: crs,
    prev: null,
    asAtMs: null,
  };

  function announce(messages: string[]): void {
    els.announcer.textContent = '';
    if (messages.length === 0) return;
    // Clear-then-write on next frame so a repeated message re-announces.
    requestAnimationFrame(() => {
      els.announcer.textContent = messages.join(' ');
    });
  }

  async function fetchBoard(kind: BoardKind): Promise<BoardResponse | null> {
    if (state.mock) return null;
    const query = new URLSearchParams({ kind, lookback: String(LOOKBACK_MIN) });
    const url = `${state.apiBase}/board/${encodeURIComponent(state.crs)}?${query}`;
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
      const filtered = usesPlatform(resp.board, state.platform);
      const messages =
        state.prev && sameKey(state.prev, resp.board)
          ? describeChanges(
              changesForPlatform(diffBoards(state.prev, resp.board), resp.board, state.platform),
              filtered,
            )
          : [];
      // Follow the board if it comes back as the other kind mid-flight.
      if (resp.board.kind !== state.kind) {
        state.kind = resp.board.kind;
        syncTabUi();
      }
      els.body.innerHTML =
        filtered.services.length === 0 ? EMPTY_ROW : boardRowsHtml(filtered.services, null, false);
      updateBoardLabel();
      state.prev = resp.board;
      state.asAtMs = resp.asAt;
      els.asOf.textContent = `As of ${fmtClock(resp.asAt)}`;
      els.staleNote.textContent =
        resp.stale === true
          ? `Couldn\u2019t reach live data — showing the board from ${fmtClock(resp.asAt)}.`
          : '';
      announce(messages);
    } else if (state.prev && state.asAtMs !== null) {
      // Worker unreachable but we have a prior board — keep it, mark stale.
      els.asOf.textContent = `As of ${fmtClock(state.asAtMs)}`;
      els.staleNote.textContent = `Couldn\u2019t reach live data — showing the board from ${fmtClock(state.asAtMs)}.`;
    } else {
      els.body.innerHTML = ERROR_ROW;
      els.staleNote.textContent = '';
    }
  }

  function updateBoardLabel(): void {
    // The <ol>'s accessible name frames the board for screen readers, including
    // the active direction and the platform/station it is filtered to.
    const verb = state.kind === 'arrivals' ? 'Arrivals at' : 'Departures from';
    els.body.setAttribute('aria-label', `${verb} platform ${state.platform} at ${state.stationName}`);
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
        els.body.innerHTML = '<li class="board-msg">Loading platform…</li>';
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

  // The station name (for the heading, back link, title, and aria-label)
  // resolves from the bundled stations list; render the chrome once it's known.
  onStationCrsReady(() => {
    const name = stationNameByCrs(state.crs) ?? state.crs;
    state.stationName = name;
    const labelled = stationLabel(name);
    const back = document.getElementById('plat-back');
    const title = document.getElementById('plat-title');
    const lede = document.getElementById('plat-lede');
    if (title) title.textContent = `Platform ${state.platform}`;
    if (lede)
      lede.textContent = `All departures and arrivals from platform ${state.platform} at ${labelled}, including the preceding hour where available.`;
    if (back)
      back.innerHTML = `<a class="back-link" href="/stations/${state.crs.toLowerCase()}/">← Back to ${labelled} board</a>`;
    document.title = `Platform ${state.platform} — ${labelled} — VIPTrains.org`;
    updateBoardLabel();
  });

  let timer: ReturnType<typeof setInterval> | undefined;
  function start(): void {
    stop();
    timer = setInterval(() => void refresh(), REFRESH_MS);
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

  setupTabs();
  syncTabUi();
  void refresh();
  start();
}
