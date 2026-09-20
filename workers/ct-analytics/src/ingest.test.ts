import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { admitIngest, boundedJson, compareVersions, MAX_APP_VERSION, validDimensions, versionWithinCeiling } from './ingest';
import worker from './index';

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
let db: D1Database;
beforeAll(async () => {
  db = await mf.getD1Database('DB') as unknown as D1Database;
  await db.exec('CREATE TABLE ingest_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
});
afterAll(async () => { await mf.dispose(); });
it('atomically limits concurrent requests from one IP regardless of installation IDs', async () => {
  const results = await Promise.all(Array.from({ length: 130 }, () => admitIngest(db, 'test-ip', 60000)));
  expect(results.filter(Boolean)).toHaveLength(120);
  expect(await admitIngest(db, 'test-ip', 120000)).toBe(true);
});
it('global budget prevents rotating IPs from admitting more ingestion', async () => {
  await db.prepare("UPDATE ingest_limits SET count = 10000, window = 3 WHERE key = 'global'").run();
  expect(await admitIngest(db, 'fresh-ip', 180000)).toBe(false);
});
it('actual Worker denies a fresh installation ID once its IP budget is exhausted', async () => {
  const window = Math.floor(Date.now() / 60000);
  await db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, ?, ?)').bind('ip:shared-ip', window, 120).run();
  const response = await worker.fetch(new Request('https://local/heartbeat', { method: 'POST', headers: { 'cf-connecting-ip': 'shared-ip' }, body: JSON.stringify({ installation_id: crypto.randomUUID(), app_version: '1.34.3', os: 'windows' }) }), { DB: db, KV_BINDING: { get: async () => null, put: async () => undefined } } as any, {} as any);
  expect(response.status).toBe(429);
});
it('bounds chunked bodies even without Content-Length', async () => {
  const request = new Request('https://local', { method: 'POST', body: 'x'.repeat(17000) });
  await expect(boundedJson(request)).rejects.toBeInstanceOf(RangeError);
  await expect(boundedJson(new Request('https://local', { method: 'POST', body: '{"ok":true}' }))).resolves.toEqual({ ok: true });
});
it('bounds caller-controlled dimensions', () => {
  expect(validDimensions(crypto.randomUUID(), '1.34.3', 'windows')).toBe(true);
  expect(validDimensions('anything', 'arbitrary-version', 'arbitrary-os')).toBe(false);
});

it('orders versions numerically, not lexically, and ignores any prerelease suffix', () => {
  // '9' > '34' as strings; the fabricated 1.99.0 is only caught by numeric compare.
  expect(compareVersions('1.9.0', '1.34.3')).toBe(-1);
  expect(compareVersions('1.34.3', '1.34.3')).toBe(0);
  expect(compareVersions('1.34.10', '1.34.9')).toBe(1);
  expect(compareVersions('2.0.0', '1.99.0')).toBe(1);
  expect(compareVersions('1.34.3-beta.1', '1.34.3')).toBe(0);
});

it('refuses versions above the ceiling while admitting every plausible release', () => {
  expect(versionWithinCeiling('1.99.0')).toBe(false);   // the observed spoof
  expect(versionWithinCeiling('2.0.0')).toBe(false);
  expect(versionWithinCeiling('1.34.3')).toBe(true);    // shipping today
  expect(versionWithinCeiling(MAX_APP_VERSION)).toBe(true); // inclusive bound
  expect(versionWithinCeiling('1.60.1')).toBe(false);   // one patch past it
  expect(versionWithinCeiling(undefined)).toBe(false);
});

it('leaves unreleased-but-near versions ingestible so a new release is never blackholed', () => {
  // Pinning the ceiling to the current release would drop the first heartbeat
  // of every new build until the Worker was redeployed. Headroom prevents that.
  for (const v of ['1.34.4', '1.35.0', '1.40.12', '1.59.99']) {
    expect(validDimensions(crypto.randomUUID(), v, 'windows')).toBe(true);
    expect(versionWithinCeiling(v)).toBe(true);
  }
});

it('Worker rejects an out-of-range version with a distinct code, before it becomes a bucket', async () => {
  const post = (app_version: string) => worker.fetch(
    new Request('https://local/heartbeat', {
      method: 'POST',
      headers: { 'cf-connecting-ip': `ceiling-${app_version}` },
      body: JSON.stringify({ installation_id: crypto.randomUUID(), app_version, os: 'windows' }),
    }),
    { DB: db, KV_BINDING: { get: async () => null, put: async () => undefined } } as any, {} as any,
  );
  const spoof = await post('1.99.0');
  expect(spoof.status).toBe(400);
  expect(await spoof.json()).toEqual({ error: 'version_out_of_range' });
  // Format-invalid input still reports the generic code, so the two are distinguishable.
  const malformed = await post('not-a-version');
  expect(await malformed.json()).toEqual({ error: 'invalid_payload' });
});
