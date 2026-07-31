import { describe, expect, it } from 'vitest';
import { parseBoardRequest, parseServiceRequest } from './router';

describe('parseBoardRequest', () => {
  it('parses GET /board/WAT with the default departures kind', () => {
    expect(parseBoardRequest('GET', '/board/WAT', {})).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures', callsAt: null },
    });
  });

  it('uppercases the CRS', () => {
    expect(parseBoardRequest('GET', '/board/wat', {})).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures', callsAt: null },
    });
  });

  it('honours ?kind=arrivals', () => {
    expect(parseBoardRequest('GET', '/board/CLJ', { kind: 'arrivals' })).toEqual({
      ok: true,
      request: { crs: 'CLJ', kind: 'arrivals', callsAt: null },
    });
  });

  it('parses a ?callsAt filter CRS, uppercased', () => {
    expect(parseBoardRequest('GET', '/board/WAT', { callsAt: 'clj' })).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures', callsAt: 'CLJ' },
    });
  });

  it('treats an empty callsAt as no filter', () => {
    expect(parseBoardRequest('GET', '/board/WAT', { callsAt: '' })).toEqual({
      ok: true,
      request: { crs: 'WAT', kind: 'departures', callsAt: null },
    });
  });

  it('rejects a callsAt that is not exactly 3 letters', () => {
    expect(parseBoardRequest('GET', '/board/WAT', { callsAt: 'X' })).toEqual({
      ok: false, reason: 'bad-calls-at' });
    expect(parseBoardRequest('GET', '/board/WAT', { callsAt: 'WATX' })).toEqual({
      ok: false, reason: 'bad-calls-at' });
    expect(parseBoardRequest('GET', '/board/WAT', { callsAt: '123' })).toEqual({
      ok: false, reason: 'bad-calls-at' });
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

describe('parseServiceRequest', () => {
  it('parses GET /service?id=<namespaced uniqueIdentity>', () => {
    expect(parseServiceRequest('GET', '/service', { id: 'gb-nr:L01525:2026-07-27' })).toEqual({
      ok: true,
      request: { id: 'gb-nr:L01525:2026-07-27' },
    });
  });

  it('parses the shorter identity:date form', () => {
    expect(parseServiceRequest('GET', '/service', { id: 'L01525:2026-07-27' })).toEqual({
      ok: true,
      request: { id: 'L01525:2026-07-27' },
    });
  });

  it('returns bad-id when id is absent or empty', () => {
    expect(parseServiceRequest('GET', '/service', {})).toEqual({ ok: false, reason: 'bad-id' });
    expect(parseServiceRequest('GET', '/service', { id: '' })).toEqual({ ok: false, reason: 'bad-id' });
  });

  it('rejects an id with path/query/space metacharacters', () => {
    expect(parseServiceRequest('GET', '/service', { id: 'gb-nr/L1' })).toEqual({ ok: false, reason: 'bad-id' });
    expect(parseServiceRequest('GET', '/service', { id: 'a b' })).toEqual({ ok: false, reason: 'bad-id' });
    expect(parseServiceRequest('GET', '/service', { id: 'a?b' })).toEqual({ ok: false, reason: 'bad-id' });
    expect(parseServiceRequest('GET', '/service', { id: 'a&b' })).toEqual({ ok: false, reason: 'bad-id' });
  });

  it('returns not-found for any path other than exactly /service', () => {
    expect(parseServiceRequest('GET', '/service/x', {})).toEqual({ ok: false, reason: 'not-found' });
    expect(parseServiceRequest('GET', '/board/WAT', {})).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns method-not-allowed for non-GET', () => {
    expect(parseServiceRequest('POST', '/service', { id: 'x' })).toEqual({
      ok: false,
      reason: 'method-not-allowed',
    });
  });
});
