import { describe, expect, it } from 'vitest';
import { parseBoardRequest } from './router';

describe('parseBoardRequest', () => {
  it('parses GET /board/WAT with the default departures kind', () => {
    expect(parseBoardRequest('GET', '/board/WAT', {})).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures' },
    });
  });

  it('uppercases the CRS', () => {
    expect(parseBoardRequest('GET', '/board/wat', {})).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures' },
    });
  });

  it('honours ?kind=arrivals', () => {
    expect(parseBoardRequest('GET', '/board/CLJ', { kind: 'arrivals' })).toEqual({
      ok: true,
      request: { crs: 'CLJ', kind: 'arrivals' },
    });
  });

  it('rejects an unknown kind', () => {
    expect(parseBoardRequest('GET', '/board/WAT', { kind: 'bogus' })).toEqual({
      ok: false,
      reason: 'bad-kind',
    });
  });

  it('rejects a CRS that is not exactly 3 letters', () => {
    expect(parseBoardRequest('GET', '/board/X', {})).toEqual({ ok: false, reason: 'not-found' });
    expect(parseBoardRequest('GET', '/board/WATX', {})).toEqual({ ok: false, reason: 'not-found' });
    expect(parseBoardRequest('GET', '/board/123', {})).toEqual({ ok: false, reason: 'not-found' });
    expect(parseBoardRequest('GET', '/board/', {})).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns not-found for an unknown path', () => {
    expect(parseBoardRequest('GET', '/something-else', {})).toEqual({ ok: false, reason: 'not-found' });
    expect(parseBoardRequest('GET', '/', {})).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns method-not-allowed for non-GET', () => {
    expect(parseBoardRequest('POST', '/board/WAT', {})).toEqual({
      ok: false,
      reason: 'method-not-allowed',
    });
  });
});
