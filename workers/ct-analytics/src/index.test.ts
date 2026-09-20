import { describe, expect, it } from 'vitest';
import worker from './index';
import { hashIP } from './feedback';

// Route-level pins for the token-gated admin surface. Fakes stand in for KV
// and D1 so each test can inspect exactly which keys a request touched.

const TOKEN = 'stats-token';

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function post(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`https://local${path}`, {
    method: 'POST',
    headers: { 'x-ct-token': TOKEN, 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('IP hashing salt', () => {
  const attempt = async (env: Record<string, string>) => {
    const kv = fakeKv();
    const res = await worker.fetch(
      post('/admin/login_attempt', JSON.stringify({ ip: '203.0.113.7' })),
      { KV_BINDING: kv, DB: {} as D1Database, STATS_TOKEN: TOKEN, ...env } as any,
      {} as any,
    );
    expect(res.status).toBe(200);
    return [...kv.store.keys()].find((k) => k.startsWith('rl:admin_login:'))!;
  };

  it('keeps the STATS_TOKEN-derived bucket when IP_HASH_SALT is absent', async () => {
    expect(await attempt({})).toBe(`rl:admin_login:${await hashIP('203.0.113.7', TOKEN)}`);
  });

  it('derives a different bucket once IP_HASH_SALT is set', async () => {
    const legacy = await attempt({});
    const salted = await attempt({ IP_HASH_SALT: 'independent-salt' });
    expect(salted).toBe(`rl:admin_login:${await hashIP('203.0.113.7', 'independent-salt')}`);
    expect(salted).not.toBe(legacy);
  });
});
