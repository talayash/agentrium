import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { admitErrorReport, admitIngest, GLOBAL_INGEST_SOFT_LIMIT, LIGHT_IP_PER_MINUTE, boundedJson, compareVersions, ERROR_REPORT_DAILY_LIMIT, errorDayWindow, MAX_APP_VERSION, validDimensions, versionWithinCeiling } from './ingest';
import worker from './index';

const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
let db: D1Database;
beforeAll(async () => {
  db = await mf.getD1Database('DB') as unknown as D1Database;
  await db.exec('CREATE TABLE ingest_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
});
afterAll(async () => { await mf.dispose(); });
// 130 D1 round-trips through miniflare take ~2.5 s locally and over 6 s on a
// slow CI runner, so the 5 s default timeout is too tight for this one test.
it('atomically limits concurrent requests from one IP regardless of installation IDs', async () => {
  const results = await Promise.all(Array.from({ length: 130 }, () => admitIngest(db, 'test-ip', 60000)));
  expect(results.filter(Boolean)).toHaveLength(120);
  expect(await admitIngest(db, 'test-ip', 120000)).toBe(true);
}, 20_000);
// F10 (2026-11-05 assessment): the global budget used to be a hard cap, so
// ~84 IPs at the per-IP limit filled it and every real client got 429. Under
// global overload only heavy IPs are refused now; light ones still get in.
it('under global overload, heavy IPs are refused but a light (real) client still gets in', async () => {
  const w = 3; // minute window 3 -> now = 180000
  await db.prepare("INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES ('global', ?, ?)").bind(w, GLOBAL_INGEST_SOFT_LIMIT).run();
  // An attacker IP already past the light allowance in this window...
  await db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, ?, ?)').bind('ip:flood-ip', w, LIGHT_IP_PER_MINUTE).run();
  expect(await admitIngest(db, 'flood-ip', 180000)).toBe(false);
  // ...while a real client's heartbeat from its own IP is admitted.
  expect(await admitIngest(db, 'real-client-ip', 180000)).toBe(true);
});

it('a flood from many IPs at the per-IP cap cannot lock real clients out', async () => {
  const now = 240000; // window 4
  // 90 attacker IPs at the 120/min per-IP cap: 10,800 requests, past the global budget.
  for (let i = 0; i < 90; i++) {
    await db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, 4, 120)').bind(`ip:bot-${i}`).run();
  }
  await db.prepare("INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES ('global', 4, 10800)").run();
  const real = await Promise.all(Array.from({ length: 20 }, (_, i) => admitIngest(db, `user-${i}`, now)));
  expect(real.every(Boolean)).toBe(true);
  expect(await admitIngest(db, 'bot-0', now)).toBe(false);
});

it('without overload the per-IP limit alone applies, as before', async () => {
  const now = 300000; // window 5, global empty
  const results: boolean[] = [];
  for (let i = 0; i < 121; i++) results.push(await admitIngest(db, 'busy-but-legit-ip', now));
  expect(results.filter(Boolean)).toHaveLength(120);
}, 20_000);
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

it('caps error reports per IP per UTC day and resets at the next day', async () => {
  const day = Date.UTC(2026, 8, 20, 13, 45); // 13:45 UTC, well inside the day
  await db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, ?, ?)')
    .bind('err_day:daily-ip', errorDayWindow(day), ERROR_REPORT_DAILY_LIMIT - 1).run();
  expect(await admitErrorReport(db, 'daily-ip', day)).toBe(true);        // the 1000th report
  expect(await admitErrorReport(db, 'daily-ip', day)).toBe(false);       // the 1001st
  expect(await admitErrorReport(db, 'daily-ip', day + 3_600_000)).toBe(false); // still the same day
  expect(await admitErrorReport(db, 'daily-ip', day + 86_400_000)).toBe(true); // next UTC day
  expect(await admitErrorReport(db, 'other-ip', day)).toBe(true);        // budgets are per IP
});

it('stores the daily window in minute units so the minute-based cron sweep cannot reset it mid-day', () => {
  const day = Date.UTC(2026, 8, 20, 3, 0);
  // Aligned to the UTC day start and expressed in the same minute count as the
  // per-minute rows, so `window < now_minute - 1440` only matches past days.
  expect(errorDayWindow(day)).toBe(Math.floor(day / 86_400_000) * 1440);
  expect(errorDayWindow(day + 20 * 3_600_000)).toBe(errorDayWindow(day));
  expect(errorDayWindow(day + 86_400_000)).toBe(errorDayWindow(day) + 1440);
});

it('Worker refuses /error_report once the daily IP budget is spent but still admits heartbeats', async () => {
  await db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, ?, ?)')
    .bind('err_day:spent-ip', errorDayWindow(Date.now()), ERROR_REPORT_DAILY_LIMIT).run();
  const env = { DB: db, KV_BINDING: { get: async () => null, put: async () => undefined } } as any;
  const send = (path: string) => worker.fetch(new Request(`https://local${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': 'spent-ip' },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), app_version: '1.34.3', os: 'windows', source: 'frontend', message: 'boom', fingerprint: 'abcd' }),
  }), env, { waitUntil() {} } as any);
  const denied = await send('/error_report');
  expect(denied.status).toBe(429);
  expect(await denied.json()).toEqual({ error: 'rate_limited' });
  // The minute cap is untouched: the same IP is still admitted on other routes.
  expect((await send('/heartbeat')).status).not.toBe(429);
});
