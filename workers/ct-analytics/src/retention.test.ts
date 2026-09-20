import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import worker from './index';
import { errorDayWindow } from './ingest';

// Exercises the two unbounded-growth fixes against real SQLite and real KV:
// the `seen:` TTL and the daily_dau prune in the cron. Both fail silently in
// production if wrong - the cron swallows errors, and a missing TTL is
// invisible until KV has grown for a year - so they are pinned here.
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: ['DB'],
  kvNamespaces: ['KV_BINDING'],
});
let db: D1Database;
let kv: KVNamespace;

beforeAll(async () => {
  db = await mf.getD1Database('DB') as unknown as D1Database;
  kv = await mf.getKVNamespace('KV_BINDING') as unknown as KVNamespace;
  await db.exec('CREATE TABLE IF NOT EXISTS ingest_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
  await db.exec('CREATE TABLE IF NOT EXISTS daily_dau (date TEXT NOT NULL, installation_id TEXT NOT NULL, PRIMARY KEY (date, installation_id))');
  await db.exec('CREATE TABLE IF NOT EXISTS daily_stats (date TEXT NOT NULL, dimension TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT \'\', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, dimension, bucket))');
  await db.exec('CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)');
  await db.exec('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, installation_id TEXT NOT NULL, app_version TEXT NOT NULL, os TEXT NOT NULL, country TEXT NOT NULL, source TEXT NOT NULL, kind TEXT, message TEXT NOT NULL, stack TEXT, fingerprint TEXT NOT NULL)');
  await db.exec('CREATE TABLE IF NOT EXISTS error_state (fingerprint TEXT PRIMARY KEY, resolved_at TEXT NOT NULL, resolved_version TEXT)');
});
afterAll(async () => { await mf.dispose(); });

beforeEach(async () => {
  await db.exec('DELETE FROM daily_dau');
  await db.exec('DELETE FROM ingest_limits');
});

/** Runs the handler with a ctx that actually settles its waitUntil work. */
async function fetchSettled(request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} };
  const res = await worker.fetch(request, { DB: db, KV_BINDING: kv } as any, ctx as any);
  await Promise.all(pending);
  return res;
}

it('writes the first-sighting seen: key with a bounded TTL', async () => {
  const id = crypto.randomUUID();
  const res = await fetchSettled(new Request('https://local/heartbeat', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `ttl-${id}` },
    body: JSON.stringify({ installation_id: id, app_version: '1.34.3', os: 'windows' }),
  }));
  expect(res.status).toBe(200);

  const listed = await kv.list({ prefix: `seen:${id}` });
  expect(listed.keys).toHaveLength(1);
  // An absent `expiration` is exactly the bug being fixed: the key would live forever.
  const expiration = listed.keys[0].expiration;
  expect(expiration).toBeTypeOf('number');
  const daysOut = (expiration! - Date.now() / 1000) / 86400;
  expect(daysOut).toBeGreaterThan(365); // outlives MAX_HISTORY_DAYS
  expect(daysOut).toBeLessThanOrEqual(400);
});

it('prunes daily_dau past the retention horizon and keeps everything inside it', async () => {
  const insert = (date: string, id: string) =>
    db.prepare('INSERT OR IGNORE INTO daily_dau (date, installation_id) VALUES (?, ?)').bind(date, id).run();
  const dayOffset = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

  await insert(dayOffset(-500), 'ancient');
  await insert(dayOffset(-401), 'just-past-horizon');
  await insert(dayOffset(-399), 'just-inside-horizon');
  await insert(dayOffset(-30), 'recent');
  await insert(dayOffset(0), 'today');

  await worker.scheduled({} as any, { DB: db, KV_BINDING: kv } as any, {} as any);

  const rows = await db.prepare('SELECT installation_id FROM daily_dau ORDER BY installation_id').all<{ installation_id: string }>();
  expect((rows.results ?? []).map((r) => r.installation_id)).toEqual(['just-inside-horizon', 'recent', 'today']);
});

it('cron sweep keeps the current UTC day error-report budget row and drops past days', async () => {
  const today = errorDayWindow(Date.now());
  const seed = (key: string, window: number) =>
    db.prepare('INSERT OR REPLACE INTO ingest_limits (key, window, count) VALUES (?, ?, 5)').bind(key, window).run();
  await seed('err_day:today', today);
  await seed('err_day:two-days-ago', today - 2 * 1440);
  await seed('ip:stale-minute', Math.floor(Date.now() / 60000) - 2000);

  await worker.scheduled({} as any, { DB: db, KV_BINDING: kv } as any, {} as any);

  const rows = await db.prepare('SELECT key FROM ingest_limits ORDER BY key').all<{ key: string }>();
  expect((rows.results ?? []).map((r) => r.key)).toEqual(['err_day:today']);
});
