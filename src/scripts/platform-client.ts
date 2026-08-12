// Client controller for a per-platform board (platform/index.astro).
//
// Reads ?station=<CRS>&platform=<number> from the URL, fetches BOTH directions
// of the station's board from the Worker (with a one-hour lookback so recently
// departed/arrived services are included), and lists the services that use
// that platform, refreshed every 30s (paused while the tab is hidden).
// Meaningful changes are announced to a polite live region, mirroring the
// station board.

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

const DEP_EMPTY = '<li class="board-msg">No departures from this platform in the next two hours.</li>';
const ARR_EMPTY = '<li class="board-msg">No arrivals at this platform in the next two hours.</li>';
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
  apiBase: string;
  mock: boolean;
  prevDep: Board | null;
  prevArr: Board | null;
  asAtMs: number | null;
}

interface Elements {
  back: HTMLElement;
  title: HTMLElement;
  lede: HTMLElement;
  dep: HTMLOListElement;
  arr: HTMLOListElement;
  asOf: HTMLElement;
  staleNote: HTMLElement;
  announcer: HTMLElement;
}

function renderList(el: HTMLOListElement, board: Board, emptyMsg: string): void {
  // statusOnly: every service is on this platform, so the redundant platform
  // NUMBER is dropped — only the per-service state flag (at-platform/provisional)
  // is kept. crs is null: this page's chips are plain (they'd only self-link).
  el.innerHTML = board.services.length === 0 ? emptyMsg : boardRowsHtml(board.services, null, true);
}

export function initPlatform(depRoot: HTMLElement): void {
  const apiBase = depRoot.dataset.api ?? DEFAULT_API;
  const mock = depRoot.dataset.mock === 'true';

  const params = new URLSearchParams(window.location.search);
  const crsRaw = params.get('station') ?? '';
  const platformRaw = params.get('platform') ?? '';
  const crs = crsRaw.toUpperCase();
  if (!CRS_RE.test(crsRaw) || !PLATFORM_RE.test(platformRaw)) {
    const body = document.getElementById('plat-dep');
    if (body) {
      body.innerHTML =
        '<li class="board-msg error">This platform link is incomplete. Open it from a station board or calling points list.</li>';
    }
    return;
  }
  const platform = platformRaw.toUpperCase();

  const back = document.getElementById('plat-back');
  const title = document.getElementById('plat-title');
  const lede = document.getElementById('plat-lede');
  const dep = document.querySelector<HTMLOListElement>('#plat-dep');
  const arr = document.querySelector<HTMLOListElement>('#plat-arr');
  const asOf = document.getElementById('as-of');
  const staleNote = document.getElementById('stale-note');
  const announcer = document.getElementById('announcer');
  if (!back || !title || !lede || !dep || !arr || !asOf || !staleNote || !announcer) return;

  const els: Elements = { back, title, lede, dep, arr, asOf, staleNote, announcer };

  const state: State = {
    crs,
    platform,
    apiBase,
    mock,
    prevDep: null,
    prevArr: null,
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
    const [depResp, arrResp] = await Promise.all([fetchBoard('departures'), fetchBoard('arrivals')]);
    let ok = false;

    if (depResp) {
      const filtered = usesPlatform(depResp.board, state.platform);
      const messages =
        state.prevDep && sameKey(state.prevDep, depResp.board)
          ? describeChanges(
              changesForPlatform(diffBoards(state.prevDep, depResp.board), depResp.board, state.platform),
              filtered,
            )
          : [];
      renderList(els.dep, filtered, DEP_EMPTY);
      state.prevDep = depResp.board;
      state.asAtMs = depResp.asAt;
      announce(messages);
      ok = true;
    }

    if (arrResp) {
      const filtered = usesPlatform(arrResp.board, state.platform);
      const messages =
        state.prevArr && sameKey(state.prevArr, arrResp.board)
          ? describeChanges(
              changesForPlatform(diffBoards(state.prevArr, arrResp.board), arrResp.board, state.platform),
              filtered,
            )
          : [];
      renderList(els.arr, filtered, ARR_EMPTY);
      state.prevArr = arrResp.board;
      announce(messages);
      ok = true;
    }

    if (ok) {
      els.asOf.textContent = `As of ${fmtClock(state.asAtMs ?? Date.now())}`;
      els.staleNote.textContent = depResp?.stale === true
        ? `Couldn\u2019t reach live data — showing the board from ${fmtClock(state.asAtMs ?? Date.now())}.`
        : '';
    } else {
      els.dep.innerHTML = ERROR_ROW;
      els.arr.innerHTML = ERROR_ROW;
      els.staleNote.textContent = '';
    }
  }

  // The station name (for the heading, back link, and title) resolves from the
  // bundled stations list; render the chrome once it's known.
  onStationCrsReady(() => {
    const name = stationNameByCrs(state.crs) ?? state.crs;
    const labelled = stationLabel(name);
    els.title.textContent = `Platform ${state.platform}`;
    els.lede.textContent = `All departures and arrivals from platform ${state.platform} at ${labelled}, including the preceding hour where available.`;
    els.back.innerHTML = `<a class="back-link" href="/stations/${state.crs.toLowerCase()}/">← Back to ${labelled} board</a>`;
    document.title = `Platform ${state.platform} — ${labelled} — VIPTrains.org`;
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

  void refresh();
  start();
}
