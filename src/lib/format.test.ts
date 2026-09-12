// fmtClock / fmtClockSeconds render instants on the UK wall clock, not the
// viewer's device zone — an overseas traveller's board header must tick in
// step with the UK timetable rows below it. Expected strings are literal, so
// these tests pass in any runner timezone.
import { describe, expect, it } from 'vitest';
import { fmtClock, fmtClockSeconds } from './format';

describe('fmtClock / fmtClockSeconds (UK wall clock)', () => {
  it('renders a UTC instant as UK time in summer (BST = UTC+1)', () => {
    expect(fmtClock(Date.parse('2026-09-12T09:05:00Z'))).toBe('10:05');
    expect(fmtClockSeconds(Date.parse('2026-09-12T09:05:23Z'))).toBe('10:05:23');
  });

  it('renders UK time in winter (GMT = UTC+0)', () => {
    expect(fmtClock(Date.parse('2026-01-15T09:05:00Z'))).toBe('09:05');
    expect(fmtClockSeconds(Date.parse('2026-01-15T09:05:23Z'))).toBe('09:05:23');
  });

  it('rolls midnight with h23, never "24"', () => {
    // 23:00:05 UTC on a September day is 00:00:05 BST the next morning.
    expect(fmtClockSeconds(Date.parse('2026-09-12T23:00:05Z'))).toBe('00:00:05');
  });
});
