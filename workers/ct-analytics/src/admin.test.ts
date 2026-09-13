import { describe, it, expect } from 'vitest';
import { checkLoginAttempt, parseMatchBody, matchInstallations, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS } from './admin';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function fakeDb(dauIds: Set<string>) {
  return {
    prepare: (sqlText: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const ids = args.slice(1) as string[]; // args[0] is the date
          const n = ids.filter((id) => dauIds.has(id)).length;
          return { n };
        },
      }),
    }),
    _sql: null as unknown,
  } as unknown as D1Database;
}

describe('checkLoginAttempt', () => {
  it('allows the first ten attempts then denies with a retry hint', async () => {
    const kv = fakeKv();
    const t0 = 1_800_000_000_000;
    for (let i = 1; i <= LOGIN_LIMIT; i++) {
      const r = await checkLoginAttempt(kv, 'h1', t0);
      expect(r.allowed).toBe(true);
      if (r.allowed) expect(r.remaining).toBe(LOGIN_LIMIT - i);
    }
    const denied = await checkLoginAttempt(kv, 'h1', t0 + 60_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retry_after_seconds).toBe(LOGIN_WINDOW_SECONDS - 60);
  });
  it('resets after the window', async () => {
    const kv = fakeKv();
    const t0 = 1_800_000_000_000;
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'h1', t0);
    const later = await checkLoginAttempt(kv, 'h1', t0 + (LOGIN_WINDOW_SECONDS + 1) * 1000);
    expect(later.allowed).toBe(true);
  });
  it('keys per hash', async () => {
    const kv = fakeKv();
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'a');
    expect((await checkLoginAttempt(kv, 'b')).allowed).toBe(true);
  });
});

describe('parseMatchBody', () => {
  it('accepts and dedupes a list of ids', () => {
    expect(parseMatchBody({ installation_ids: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
  });
  it('rejects non-arrays, empty strings, long strings and oversize lists', () => {
    expect(parseMatchBody({})).toBeNull();
    expect(parseMatchBody({ installation_ids: 'a' })).toBeNull();
    expect(parseMatchBody({ installation_ids: [''] })).toBeNull();
    expect(parseMatchBody({ installation_ids: ['x'.repeat(129)] })).toBeNull();
    expect(parseMatchBody({ installation_ids: Array.from({ length: 5001 }, (_, i) => `i${i}`) })).toBeNull();
  });
  it('accepts an empty list', () => {
    expect(parseMatchBody({ installation_ids: [] })).toEqual([]);
  });
});

describe('matchInstallations', () => {
  it('counts ids present in daily_dau and in live: keys', async () => {
    const kv = fakeKv({ 'live:a': '1', 'live:c': '1' });
    const db = fakeDb(new Set(['a', 'b']));
    const r = await matchInstallations(db, kv, ['a', 'b', 'c', 'd'], '2026-09-13');
    expect(r).toEqual({ active_today: 2, active_now: 2 });
  });
  it('handles more than one chunk of 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const db = fakeDb(new Set(ids));
    const r = await matchInstallations(db, fakeKv(), ids, '2026-09-13');
    expect(r.active_today).toBe(250);
    expect(r.active_now).toBe(0);
  });
  it('returns zeros for an empty list without touching storage', async () => {
    const r = await matchInstallations(fakeDb(new Set()), fakeKv(), [], '2026-09-13');
    expect(r).toEqual({ active_today: 0, active_now: 0 });
  });
});
