// Regression tests for the Calling Points header's "Next stop" line. The rule
// guarded here: the header's next stop MUST agree with the stop list below —
// a stop with no recorded actual is still to come (the card shows its
// "Expected" time), even when its SCHEDULED time has passed, because the
// train may be running late. It used to be judged on the scheduled time
// alone, so a delayed train short of Winchester reported Basingstoke as the
// next stop while the list still showed Winchester un-arrived.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextStop, stopCard } from './service-client';
import type { CallingPoint, ServiceDetail } from '../lib/types';

/** 2026-08-20 HH:MM UTC, sliced verbatim style like the app's naive ISO. */
const ISO = (h: number, m: number) => new Date(Date.UTC(2026, 7, 20, h, m)).toISOString();

function point(station: string, h: number, m: number, extra: Partial<CallingPoint> = {}): CallingPoint {
  return { station, scheduledTime: ISO(h, m), expectedTime: ISO(h, m), platform: null, cancelled: false, ...extra };
}

/** Salisbury 18:47 -> Grateley 18:59 -> Andover 19:06 -> Basingstoke 19:31. */
function service(extra: Partial<ServiceDetail> = {}): ServiceDetail {
  return {
    id: 'gb-nr:T12345:2026-08-20',
    origin: 'Salisbury',
    destination: 'Basingstoke',
    operator: 'South Western Railway',
    coaches: 5,
    cancelled: false,
    points: [
      point('Salisbury', 18, 47, { actualDeparture: ISO(18, 47) }),
      point('Grateley', 18, 59),
      point('Andover', 19, 6),
      point('Basingstoke', 19, 31),
    ],
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

describe('stopCard', () => {
  it('shows "Arrived" for a stop the train has reached but not yet left (arrival actual, no departure yet)', () => {
    const html = stopCard(point('Basingstoke', 13, 50, { expectedTime: ISO(14, 2), actualArrival: ISO(14, 1), platform: { number: '4', state: 'at-platform' } }), false);
    expect(html).toContain('Arrived 14:01');
    expect(html).not.toContain('Expected');
    expect(html).not.toContain('Departed');
  });

  it('shows "Departed" once the train has left, arrival and departure both recorded', () => {
    const html = stopCard(point('Winchester', 13, 32, { actualArrival: ISO(13, 45), actualDeparture: ISO(13, 47) }), false);
    expect(html).toContain('Departed 13:47');
    expect(html).not.toContain('Arrived');
  });

  it('still shows "Completed" at the terminus', () => {
    const html = stopCard(point('Bournemouth', 12, 45, { actualArrival: ISO(12, 45) }), true);
    expect(html).toContain('Completed on time');
    expect(html).not.toContain('Arrived');
  });

  it('shows "Expected" while the train is still en route (no actuals)', () => {
    const html = stopCard(point('Reading', 14, 15, { expectedTime: ISO(14, 26) }), false);
    expect(html).toContain('Expected 14:26');
  });
});

describe('nextStop', () => {
  it('agrees with the stop list: a stop without an actual is the next stop even when its scheduled time has passed (late train)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 15));
    // Grateley scheduled 18:59 is past, but the train hasn't arrived (no
    // actuals) and its expected time is 19:40 — running late. The list shows
    // "Expected 19:40"; the header must say Grateley, not Basingstoke.
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { expectedTime: ISO(19, 40) });
    expect(nextStop(d)?.station).toBe('Grateley');
  });

  it('skips the origin while the train still sits there, showing the stop after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 18, 40));
    const d = service();
    const origin = d.points[0];
    if (origin) delete origin.actualDeparture; // not yet departed
    expect(nextStop(d)?.station).toBe('Grateley');
  });

  it('skips stops with a recorded actual (passed, even if early)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 0));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 57) }); // ran early
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('skips a stop the train is sitting at (arrived, not yet departed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 2));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59) });
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('with no live report, mirrors the stop card: past scheduled = gone, future scheduled = next', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 0));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { noReport: true }); // scheduled past -> "Departed — no live data"
    d.points[2] = point('Andover', 19, 6, { noReport: true }); // scheduled future -> "Expected"
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('returns null once every stop has an actual (journey completed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 40));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59), actualDeparture: ISO(19, 0) });
    d.points[2] = point('Andover', 19, 6, { actualArrival: ISO(19, 6), actualDeparture: ISO(19, 7) });
    d.points[3] = point('Basingstoke', 19, 31, { actualArrival: ISO(19, 31) });
    expect(nextStop(d)).toBeNull();
  });
});
