import { describe, expect, it } from 'vitest';
import { parseBoardRequest, parseContactRequest, parseServiceRequest } from './router';

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

describe('parseContactRequest', () => {
  const body = (fields: Record<string, string>): string =>
    new URLSearchParams(fields).toString();

  it('parses a valid submission, trimming whitespace', () => {
    const raw = body({ name: '  Ada Lovelace ', email: 'ada@example.com', message: '  Hi there  ' });
    expect(parseContactRequest('POST', '/contact', raw)).toEqual({
      ok: true,
      request: { name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hi there' },
    });
  });

  it('treats a missing honeypot field as empty (allowed)', () => {
    const raw = body({ name: 'Ada', email: 'ada@example.com', message: 'Hi' });
    expect(parseContactRequest('POST', '/contact', raw).ok).toBe(true);
  });

  it('rejects when the honeypot field is filled (a bot)', () => {
    const raw = body({
      name: 'Ada',
      email: 'ada@example.com',
      message: 'Hi',
      website: 'http://spam.example',
    });
    expect(parseContactRequest('POST', '/contact', raw)).toEqual({
      ok: false,
      reason: 'bad-request',
    });
  });

  it('rejects missing required fields with per-field issues', () => {
    expect(parseContactRequest('POST', '/contact', '')).toEqual({
      ok: false,
      reason: 'bad-request',
      issues: [
        { field: 'name', code: 'required' },
        { field: 'email', code: 'required' },
        { field: 'message', code: 'required' },
      ],
    });
  });

  it('rejects an invalid email', () => {
    const raw = body({ name: 'Ada', email: 'not-an-email', message: 'Hi' });
    expect(parseContactRequest('POST', '/contact', raw)).toEqual({
      ok: false,
      reason: 'bad-request',
      issues: [{ field: 'email', code: 'invalid-email' }],
    });
  });

  it('rejects an over-long message', () => {
    const raw = body({ name: 'Ada', email: 'ada@example.com', message: 'x'.repeat(5001) });
    expect(parseContactRequest('POST', '/contact', raw)).toEqual({
      ok: false,
      reason: 'bad-request',
      issues: [{ field: 'message', code: 'too-long' }],
    });
  });

  it('rejects an over-long name', () => {
    const raw = body({ name: 'x'.repeat(101), email: 'ada@example.com', message: 'Hi' });
    expect(parseContactRequest('POST', '/contact', raw)).toEqual({
      ok: false,
      reason: 'bad-request',
      issues: [{ field: 'name', code: 'too-long' }],
    });
  });

  it('returns not-found for any path other than exactly /contact', () => {
    expect(parseContactRequest('POST', '/contact/x', '')).toEqual({ ok: false, reason: 'not-found' });
    expect(parseContactRequest('POST', '/board/WAT', '')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns method-not-allowed for non-POST', () => {
    expect(parseContactRequest('GET', '/contact', '')).toEqual({
      ok: false,
      reason: 'method-not-allowed',
    });
  });
});
