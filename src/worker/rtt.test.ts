import { describe, expect, it } from 'vitest';
import { parseRetryAfter, parseRttResult, parseServiceResult } from './rtt';
import type { RTTLocationResponse, RTTServiceDetailResponse } from '../lib/rtt';

const ctx = { crs: 'WAT', kind: 'departures' as const };

describe('parseRttResult', () => {
  it('maps a 200 body to a Board via mapLocationLineUp', () => {
    const body: RTTLocationResponse = {
      services: [
        {
          scheduleMetadata: { uniqueIdentity: 'gb-nr:L1:2026-07-27', operator: { name: 'SWR' } },
          temporalData: {
            displayAs: 'CALL',
            departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' },
          },
          origin: [{ location: { description: 'London Waterloo' } }],
          destination: [{ location: { description: 'Weymouth' } }],
        },
      ],
    };

    expect(parseRttResult(200, body, null, ctx)).toEqual({
      ok: true,
      data: {
        station: 'WAT',
        kind: 'departures',
        services: [
          expect.objectContaining({ id: 'gb-nr:L1:2026-07-27', destination: 'Weymouth' }),
        ],
      },
    });
  });

  it('treats 204 as an empty board (not an error)', () => {
    expect(parseRttResult(204, null, null, ctx)).toEqual({
      ok: true,
      data: { station: 'WAT', kind: 'departures', services: [] },
    });
  });

  it('treats 429 as an error and carries retry-after seconds', () => {
    expect(parseRttResult(429, null, 60, ctx)).toEqual({ ok: false, retryAfterSec: 60 });
  });

  it('treats 429 without retry-after as a plain error', () => {
    expect(parseRttResult(429, null, null, ctx)).toEqual({ ok: false });
  });

  it('treats other 4xx/5xx as a plain error', () => {
    expect(parseRttResult(500, null, null, ctx)).toEqual({ ok: false });
    expect(parseRttResult(400, null, null, ctx)).toEqual({ ok: false });
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('returns null when absent or empty', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
  });

  it('parses an HTTP-date relative to now (approximate)', () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).not.toBeNull();
    expect(secs!).toBeGreaterThanOrEqual(80);
    expect(secs!).toBeLessThanOrEqual(100);
  });
});

describe('parseServiceResult', () => {
  it('maps a 200 body to a ServiceDetail via mapServiceDetail, echoing the id', () => {
    const body: RTTServiceDetailResponse = {
      service: {
        scheduleMetadata: { uniqueIdentity: 'gb-nr:L1:2026-07-27', operator: { name: 'SWR' } },
        origin: [{ location: { description: 'London Waterloo' } }],
        destination: [{ location: { description: 'Weymouth' } }],
        locations: [
          { location: { description: 'London Waterloo' }, temporalData: { displayAs: 'STARTS', departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' } } },
          { location: { description: 'Weymouth' }, temporalData: { displayAs: 'TERMINATES', arrival: { scheduleAdvertised: '2026-07-27T10:02:00+01:00' } } },
        ],
      },
    };

    expect(parseServiceResult(200, body, null, 'gb-nr:L1:2026-07-27')).toEqual({
      ok: true,
      data: expect.objectContaining({
        id: 'gb-nr:L1:2026-07-27',
        origin: 'London Waterloo',
        destination: 'Weymouth',
        points: expect.arrayContaining([expect.objectContaining({ station: 'Weymouth' })]),
      }),
    });
  });

  it('treats 404 as a definitive not-found', () => {
    expect(parseServiceResult(404, null, null, 'gb-nr:gone:2026-07-27')).toEqual({
      ok: false,
      notFound: true,
    });
  });

  it('treats 429 as an error and carries retry-after seconds', () => {
    expect(parseServiceResult(429, null, 60, 'gb-nr:L1:2026-07-27')).toEqual({
      ok: false,
      retryAfterSec: 60,
    });
  });

  it('treats other 4xx/5xx as a plain error', () => {
    expect(parseServiceResult(500, null, null, 'gb-nr:L1:2026-07-27')).toEqual({ ok: false });
    expect(parseServiceResult(400, null, null, 'gb-nr:L1:2026-07-27')).toEqual({ ok: false });
  });
});
