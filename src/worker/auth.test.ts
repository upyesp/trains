import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOKEN_TTL_MS,
  createMemoryAccessTokenStore,
  getAccessToken,
  parseAccessTokenResult,
} from './auth';
import type { AccessToken, AccessTokenStore } from './auth';

const NOW = Date.parse('2026-07-28T10:00:00Z');
const VALID_UNTIL_ISO = '2026-07-28T10:50:00Z';
const VALID_UNTIL_MS = Date.parse(VALID_UNTIL_ISO);

/** Minimal in-memory store that records call order for assertions. */
function recordingStore(): AccessTokenStore & { calls: string[] } {
  let value: AccessToken | null = null;
  const calls: string[] = [];
  return {
    calls,
    async get() {
      calls.push('get');
      return value;
    },
    async set(entry) {
      calls.push('set');
      value = entry;
    },
    async clear() {
      calls.push('clear');
      value = null;
    },
  };
}

describe('parseAccessTokenResult', () => {
  it('maps 200 with an ISO-datetime validUntil', () => {
    expect(parseAccessTokenResult(200, { token: 'abc', validUntil: VALID_UNTIL_ISO }, NOW)).toEqual({
      ok: true,
      token: 'abc',
      expiresAt: VALID_UNTIL_MS,
    });
  });

  it('treats a small numeric validUntil as epoch seconds', () => {
    const secs = Math.floor(VALID_UNTIL_MS / 1000);
    expect(parseAccessTokenResult(200, { token: 'abc', validUntil: secs }, NOW)).toEqual({
      ok: true,
      token: 'abc',
      expiresAt: secs * 1000,
    });
  });

  it('treats a large numeric validUntil as epoch milliseconds', () => {
    expect(parseAccessTokenResult(200, { token: 'abc', validUntil: VALID_UNTIL_MS }, NOW)).toEqual({
      ok: true,
      token: 'abc',
      expiresAt: VALID_UNTIL_MS,
    });
  });

  it('falls back to the default TTL when validUntil is absent', () => {
    expect(parseAccessTokenResult(200, { token: 'abc' }, NOW)).toEqual({
      ok: true,
      token: 'abc',
      expiresAt: NOW + DEFAULT_TOKEN_TTL_MS,
    });
  });

  it('falls back to the default TTL when validUntil is unparseable', () => {
    expect(parseAccessTokenResult(200, { token: 'abc', validUntil: 'nonsense' }, NOW)).toEqual({
      ok: true,
      token: 'abc',
      expiresAt: NOW + DEFAULT_TOKEN_TTL_MS,
    });
  });

  it('rejects 200 with a missing token', () => {
    expect(parseAccessTokenResult(200, { validUntil: VALID_UNTIL_ISO }, NOW)).toEqual({ ok: false });
  });

  it('rejects 200 with an empty token', () => {
    expect(parseAccessTokenResult(200, { token: '' }, NOW)).toEqual({ ok: false });
  });

  it('rejects non-200 statuses', () => {
    expect(parseAccessTokenResult(401, { token: 'abc' }, NOW)).toEqual({ ok: false });
    expect(parseAccessTokenResult(500, null, NOW)).toEqual({ ok: false });
  });
});

describe('getAccessToken', () => {
  it('returns a cached token without fetching when fresh', async () => {
    const store = recordingStore();
    await store.set({ token: 'cached', expiresAt: NOW + 10 * 60 * 1000 }); // 10 min ahead
    const fetchAuth = vi.fn();
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toEqual({ token: 'cached' });
    expect(fetchAuth).not.toHaveBeenCalled();
  });

  it('exchanges and caches when the store is empty', async () => {
    const store = recordingStore();
    const fetchAuth = vi.fn(async () => ({
      status: 200,
      body: { token: 'fresh', validUntil: VALID_UNTIL_ISO },
    }));
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toEqual({ token: 'fresh' });
    expect(fetchAuth).toHaveBeenCalledTimes(1);
    expect(store.calls).toContain('set');
  });

  it('re-exchanges when the cached token is within the refresh buffer', async () => {
    const store = recordingStore();
    // Expires 10s from now -> inside the 60s buffer -> must refresh.
    await store.set({ token: 'old', expiresAt: NOW + 10 * 1000 });
    const fetchAuth = vi.fn(async () => ({
      status: 200,
      body: { token: 'new', validUntil: VALID_UNTIL_ISO },
    }));
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toEqual({ token: 'new' });
    expect(fetchAuth).toHaveBeenCalledTimes(1);
  });

  it('returns null on a network failure', async () => {
    const store = recordingStore();
    const fetchAuth = vi.fn(async () => null);
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toBeNull();
  });

  it('returns null and does not cache on a non-200 response', async () => {
    const store = recordingStore();
    const fetchAuth = vi.fn(async () => ({ status: 401, body: { error: 'nope' } }));
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toBeNull();
    expect(store.calls).not.toContain('set');
  });

  it('returns null on a malformed 200 body', async () => {
    const store = recordingStore();
    const fetchAuth = vi.fn(async () => ({ status: 200, body: {} }));
    const result = await getAccessToken({ fetchAuth, store, now: NOW });
    expect(result).toBeNull();
  });
});

describe('createMemoryAccessTokenStore', () => {
  it('round-trips set/get/clear', async () => {
    const store = createMemoryAccessTokenStore();
    expect(await store.get()).toBeNull();
    await store.set({ token: 'x', expiresAt: 123 });
    expect(await store.get()).toEqual({ token: 'x', expiresAt: 123 });
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});
