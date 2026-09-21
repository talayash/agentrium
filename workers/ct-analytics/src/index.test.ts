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

describe('bounded bodies on token-gated routes', () => {
  // Same shape the ingest routes emit for an oversized body, so the admin
  // proxies see one rejection regardless of which route they hit.
  const oversized = JSON.stringify({ ids: [1], ip: '203.0.113.7', pad: 'x'.repeat(17_000) });
  const env = () => ({ KV_BINDING: fakeKv(), DB: {} as D1Database, STATS_TOKEN: TOKEN }) as any;

  it('rejects an oversized /feedback/mark_read body with 413 payload_too_large', async () => {
    const res = await worker.fetch(post('/feedback/mark_read', oversized), env(), {} as any);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('rejects an oversized /admin/login_attempt body with 413 payload_too_large', async () => {
    const res = await worker.fetch(post('/admin/login_attempt', oversized), env(), {} as any);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('rejects an oversized /feedback/delete body with 413 payload_too_large', async () => {
    const res = await worker.fetch(post('/feedback/delete', oversized), env(), {} as any);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('rejects an oversized /errors/resolve body with 413 payload_too_large', async () => {
    const res = await worker.fetch(post('/errors/resolve', oversized), env(), {} as any);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('rejects an oversized /stats/match body with 413 payload_too_large', async () => {
    const res = await worker.fetch(post('/stats/match', oversized), env(), {} as any);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('still reports malformed JSON as 400 invalid_json on every token-gated route', async () => {
    for (const path of ['/feedback/mark_read', '/admin/login_attempt', '/feedback/delete', '/errors/resolve', '/stats/match']) {
      const res = await worker.fetch(post(path, '{not json'), env(), {} as any);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
    }
  });
});
