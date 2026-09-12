// parseUKTime anchors RTT's naive UK wall-clock timestamps to Europe/London.
// Regression guard for the timezone bug: a traveller outside the UK used to
// see future trains reported as "Departed on time", because Date.parse read
// the offset-less strings in the device's own timezone. The expected values
// below are written as explicit-offset UTC strings, so these tests pass in
// any runner timezone.
import { describe, expect, it } from 'vitest';
import { parseUKTime } from './uk-time';

describe('parseUKTime', () => {
  it('anchors naive summer strings to BST (UTC+1)', () => {
    expect(parseUKTime('2026-09-12T10:17:00')).toBe(Date.parse('2026-09-12T09:17:00Z'));
  });

  it('anchors naive winter strings to GMT (UTC+0)', () => {
    expect(parseUKTime('2026-01-15T10:17:00')).toBe(Date.parse('2026-01-15T10:17:00Z'));
  });

  it('accepts seconds-less and space-separated stamps', () => {
    expect(parseUKTime('2026-09-12T10:17')).toBe(Date.parse('2026-09-12T09:17:00Z'));
    expect(parseUKTime('2026-09-12 10:17:05')).toBe(Date.parse('2026-09-12T09:17:05Z'));
  });

  it('resolves the offset at the stamp itself across a DST day', () => {
    // 26 Oct 2025: BST ends at 02:00 BST. A 09:00 stamp that morning is GMT.
    expect(parseUKTime('2025-10-26T09:00:00')).toBe(Date.parse('2025-10-26T09:00:00Z'));
    // 29 Mar 2026: BST starts (01:00 GMT → 02:00 BST). A 09:00 stamp that
    // morning is BST.
    expect(parseUKTime('2026-03-29T09:00:00')).toBe(Date.parse('2026-03-29T08:00:00Z'));
  });

  it('passes absolute stamps (Z or explicit offset) straight through', () => {
    expect(parseUKTime('2026-09-12T10:17:00Z')).toBe(Date.parse('2026-09-12T10:17:00Z'));
    expect(parseUKTime('2026-09-12T10:17:00+02:00')).toBe(Date.parse('2026-09-12T10:17:00+02:00'));
    expect(parseUKTime('2026-09-12T10:17:00.000Z')).toBe(Date.parse('2026-09-12T10:17:00.000Z'));
  });

  it('yields NaN for junk so callers fall back to their unknown-time path', () => {
    expect(parseUKTime('')).toBeNaN();
    expect(parseUKTime('not-a-time')).toBeNaN();
    expect(parseUKTime('2026-13-45T99:99:00')).toBeNaN();
  });
});
