import { describe, it, expect } from 'vitest';
import { selectToServe } from './cache';
import type { Board } from './types';

function board(station = 'KGX'): Board {
  return { station, kind: 'departures', services: [] };
}

describe('selectToServe', () => {
  it('serves a fresh value (not stale) when the upstream fetch succeeds', () => {
    const fresh = board('KGX');

    const decision = selectToServe(null, { ok: true, data: fresh }, 1_000);

    expect(decision).toEqual({ status: 'fresh', data: fresh, asAt: 1_000 });
  });

  it('serves the cached value as stale when the upstream fetch fails', () => {
    const cachedBoard = board('KGX');
    const cache = { data: cachedBoard, asAt: 500 };

    const decision = selectToServe(cache, { ok: false }, 1_000);

    expect(decision).toEqual({ status: 'stale', data: cachedBoard, asAt: 500 });
  });

  it('serves the fresh value, not the cached one, when the fetch succeeds despite a cache existing', () => {
    const cache = { data: board('KGX'), asAt: 500 };
    const fresh = board('EDB');

    const decision = selectToServe(cache, { ok: true, data: fresh }, 1_000);

    expect(decision).toEqual({ status: 'fresh', data: fresh, asAt: 1_000 });
  });

  it('is unavailable when the fetch fails and nothing is cached', () => {
    const decision = selectToServe(null, { ok: false }, 1_000);

    expect(decision).toEqual({ status: 'unavailable' });
  });
});
