import { describe, it, expect } from 'vitest';
import { selectBoardToServe } from './cache';
import type { Board } from './types';

function board(station = 'KGX'): Board {
  return { station, kind: 'departures', services: [] };
}

describe('selectBoardToServe', () => {
  it('serves a fresh board (not stale) when the upstream fetch succeeds', () => {
    const fresh = board('KGX');

    const decision = selectBoardToServe(null, { ok: true, board: fresh }, 1_000);

    expect(decision).toEqual({ status: 'fresh', board: fresh, asAt: 1_000 });
  });

  it('serves the cached board as stale when the upstream fetch fails', () => {
    const cachedBoard = board('KGX');
    const cache = { board: cachedBoard, asAt: 500 };

    const decision = selectBoardToServe(cache, { ok: false }, 1_000);

    expect(decision).toEqual({ status: 'stale', board: cachedBoard, asAt: 500 });
  });

  it('serves the fresh board, not the cached one, when the fetch succeeds despite a cache existing', () => {
    const cache = { board: board('KGX'), asAt: 500 };
    const fresh = board('EDB');

    const decision = selectBoardToServe(cache, { ok: true, board: fresh }, 1_000);

    expect(decision).toEqual({ status: 'fresh', board: fresh, asAt: 1_000 });
  });

  it('is unavailable when the fetch fails and nothing is cached', () => {
    const decision = selectBoardToServe(null, { ok: false }, 1_000);

    expect(decision).toEqual({ status: 'unavailable' });
  });
});
