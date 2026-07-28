import { describe, it, expect } from 'vitest';
import { diffBoards } from './diff';
import type { Board, Service } from './types';

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 'S1',
    scheduledTime: '2025-01-01T10:00:00Z',
    expectedTime: '2025-01-01T10:00:00Z',
    platform: { number: '3', state: 'provisional' },
    destination: 'Leeds',
    operator: 'LNER',
    coaches: null,
    cancelled: false,
    ...overrides,
  };
}

function board(services: Service[], station = 'KGX'): Board {
  return { station, kind: 'departures', services };
}

describe('diffBoards', () => {
  it('returns no changes when the boards are identical', () => {
    const b = board([service()]);
    expect(diffBoards(b, b)).toEqual([]);
  });

  it('reports a cancellation when a service becomes cancelled', () => {
    const previous = board([service({ id: 'S1', cancelled: false })]);
    const current = board([service({ id: 'S1', cancelled: true })]);

    expect(diffBoards(previous, current)).toEqual([
      { type: 'cancellation', serviceId: 'S1' },
    ]);
  });

  it('reports a platform change when the platform number changes', () => {
    const previous = board([
      service({ id: 'S1', platform: { number: '3', state: 'confirmed' } }),
    ]);
    const current = board([
      service({ id: 'S1', platform: { number: '5', state: 'confirmed' } }),
    ]);

    expect(diffBoards(previous, current)).toEqual([
      {
        type: 'platform-change',
        serviceId: 'S1',
        from: { number: '3', state: 'confirmed' },
        to: { number: '5', state: 'confirmed' },
      },
    ]);
  });

  it('reports a platform change when a provisional platform is confirmed (same number)', () => {
    const previous = board([
      service({ id: 'S1', platform: { number: '3', state: 'provisional' } }),
    ]);
    const current = board([
      service({ id: 'S1', platform: { number: '3', state: 'confirmed' } }),
    ]);

    expect(diffBoards(previous, current)).toEqual([
      {
        type: 'platform-change',
        serviceId: 'S1',
        from: { number: '3', state: 'provisional' },
        to: { number: '3', state: 'confirmed' },
      },
    ]);
  });

  it('reports a delay when the expected time swings by 6 minutes', () => {
    const previous = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:00:00Z' }),
    ]);
    const current = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:06:00Z' }),
    ]);

    expect(diffBoards(previous, current)).toEqual([
      { type: 'delay', serviceId: 'S1', minutesSwing: 6 },
    ]);
  });

  it('does not report a delay for an expected-time swing under 5 minutes', () => {
    const previous = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:00:00Z' }),
    ]);
    const current = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:02:00Z' }),
    ]);

    expect(diffBoards(previous, current)).toEqual([]);
  });

  it('reports a delay at exactly the 5-minute threshold (boundary)', () => {
    const previous = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:00:00Z' }),
    ]);
    const current = board([
      service({ id: 'S1', expectedTime: '2025-01-01T10:05:00Z' }),
    ]);

    expect(diffBoards(previous, current)).toEqual([
      { type: 'delay', serviceId: 'S1', minutesSwing: 5 },
    ]);
  });

  it('does not report a change when a service departs and leaves the board', () => {
    const previous = board([service({ id: 'S1' })]);
    const current = board([]);

    expect(diffBoards(previous, current)).toEqual([]);
  });

  it('does not report a change when a new service scrolls into the board window', () => {
    const previous = board([]);
    const current = board([service({ id: 'S2' })]);

    expect(diffBoards(previous, current)).toEqual([]);
  });

  it('does not report platform or delay changes for a service cancelled in both boards', () => {
    const previous = board([
      service({
        id: 'S1',
        cancelled: true,
        platform: { number: '3', state: 'confirmed' },
        expectedTime: '2025-01-01T10:00:00Z',
      }),
    ]);
    const current = board([
      service({
        id: 'S1',
        cancelled: true,
        platform: { number: '9', state: 'confirmed' },
        expectedTime: '2025-01-01T10:42:00Z',
      }),
    ]);

    expect(diffBoards(previous, current)).toEqual([]);
  });

  it('does not report a change when a cancelled service is reinstated', () => {
    const previous = board([
      service({
        id: 'S1',
        cancelled: true,
        platform: { number: '3', state: 'provisional' },
      }),
    ]);
    const current = board([
      service({
        id: 'S1',
        cancelled: false,
        platform: { number: '5', state: 'confirmed' },
      }),
    ]);

    expect(diffBoards(previous, current)).toEqual([]);
  });
});
