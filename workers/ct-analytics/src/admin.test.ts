import { describe, it, expect } from 'vitest';
import {
  checkLoginAttempt,
  parseMatchBody,
  matchInstallations,
  constantTimeEqual,
  LOGIN_LIMIT,
  LOGIN_WINDOW_SECONDS,
  MATCH_MAX_IDS,
  MATCH_ID_MAX_LEN,
} from './admin';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const ttls: number[] = [];
  return {
    store,
    ttls,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v);
      if (opts?.expirationTtl !== undefined) ttls.push(opts.expirationTtl);
    },
  } as unknown as KVNamespace & { store: Map<string, string>; ttls: number[] };
}

function fakeDb(dauIds: Set<string>) {
  let prepareCalls = 0;
  const bindArgCounts: number[] = [];
  const db = {
    prepare: (sqlText: string) => {
      prepareCalls += 1;
      return {
        bind: (...args: unknown[]) => {
          bindArgCounts.push(args.length);
          return {
            first: async () => {
              const ids = args.slice(1) as string[]; // args[0] is the date
              const n = ids.filter((id) => dauIds.has(id)).length;
              return { n };
            },
          };
        },
      };
    },
    _sql: null as unknown,
  } as unknown as D1Database;
  return {
    db,
    get prepareCalls() { return prepareCalls; },
    get maxBindArgs() { return Math.max(0, ...bindArgCounts); },
  };
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
    // Every write must clamp to the KV minimum TTL (a sub-60s TTL 400s every PUT).
    for (const ttl of kv.ttls) expect(ttl).toBeGreaterThanOrEqual(60);
  });
  it('resets after the window', async () => {
    const kv = fakeKv();
    const t0 = 1_800_000_000_000;
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'h1', t0);
    const later = await checkLoginAttempt(kv, 'h1', t0 + (LOGIN_WINDOW_SECONDS + 1) * 1000);
    expect(later.allowed).toBe(true);
    for (const ttl of kv.ttls) expect(ttl).toBeGreaterThanOrEqual(60);
  });
  it('keys per hash', async () => {
    const kv = fakeKv();
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'a');
    expect((await checkLoginAttempt(kv, 'b')).allowed).toBe(true);
    for (const ttl of kv.ttls) expect(ttl).toBeGreaterThanOrEqual(60);
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
    expect(parseMatchBody({ installation_ids: ['x'.repeat(MATCH_ID_MAX_LEN + 1)] })).toBeNull();
    expect(
      parseMatchBody({ installation_ids: Array.from({ length: MATCH_MAX_IDS + 1 }, (_, i) => `i${i}`) }),
    ).toBeNull();
  });
  it('accepts an empty list', () => {
    expect(parseMatchBody({ installation_ids: [] })).toEqual([]);
  });
});

describe('matchInstallations', () => {
  it('counts ids present in daily_dau and in live: keys', async () => {
    const kv = fakeKv({ 'live:a': '1', 'live:c': '1' });
    const { db } = fakeDb(new Set(['a', 'b']));
    const r = await matchInstallations(db, kv, ['a', 'b', 'c', 'd'], '2026-09-13');
    expect(r).toEqual({ active_today: 2, active_now: 2 });
  });
  it('chunks D1 queries to stay within the 100 bound-parameter limit (99 ids + date)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const fake = fakeDb(new Set(ids));
    const r = await matchInstallations(fake.db, fakeKv(), ids, '2026-09-13');
    expect(r.active_today).toBe(250);
    expect(r.active_now).toBe(0);
    expect(fake.prepareCalls).toBe(Math.ceil(250 / 99));
    // The regression this guards against: D1_CHUNK=100 also yields 3 prepare
    // calls for 250 ids (ceil(250/99) === ceil(250/100)), so the prepare-call
    // count alone can't catch a chunk size that's too large. What actually
    // breaks at D1_CHUNK=100 is the bind width: date + 100 ids = 101 bound
    // parameters, over D1's 100-parameter-per-statement limit.
    expect(fake.maxBindArgs).toBeLessThanOrEqual(100);
  });
  it('returns zeros for an empty list without touching storage', async () => {
    const { db } = fakeDb(new Set());
    const r = await matchInstallations(db, fakeKv(), [], '2026-09-13');
    expect(r).toEqual({ active_today: 0, active_now: 0 });
  });
});

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('secret-token', 'secret-token')).toBe(true);
  });
  it('returns false for different strings of the same length', () => {
    expect(constantTimeEqual('secret-token', 'secret-tokeN')).toBe(false);
  });
  it('returns false for different lengths', () => {
    expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false);
  });
  it('returns false comparing empty vs non-empty', () => {
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});
