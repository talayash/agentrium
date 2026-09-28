import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import worker from './index';
import { clampInsightDays } from './insights-route';
import { computeActivity, computeRetention } from './insights';

// Route-level pins for GET /stats/insights: auth parity with /stats/history,
// days clamping, the two-tier KV cache (payload + range-independent
// cohorts), and the D1-failure path. Schema matches insights.test.ts.

const TOKEN = 'tok';
const TODAY = '2026-09-28';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: ['DB'],
  kvNamespaces: ['KV_BINDING'],
});
let db: D1Database;
let kv: KVNamespace;

beforeAll(async () => {
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  kv = (await mf.getKVNamespace('KV_BINDING')) as unknown as KVNamespace;
  await db.exec(
    'CREATE TABLE IF NOT EXISTS daily_dau (date TEXT NOT NULL, installation_id TEXT NOT NULL, PRIMARY KEY (date, installation_id))'
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS daily_stats (date TEXT NOT NULL, dimension TEXT NOT NULL, bucket TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, dimension, bucket))"
  );
  await db.exec(
    'CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, installation_id TEXT NOT NULL, app_version TEXT NOT NULL, os TEXT NOT NULL, country TEXT NOT NULL, source TEXT NOT NULL, kind TEXT, message TEXT NOT NULL, stack TEXT, fingerprint TEXT NOT NULL)'
  );
});
afterAll(async () => {
  await mf.dispose();
});

beforeEach(async () => {
  await db.exec('DELETE FROM daily_dau');
  await db.exec('DELETE FROM daily_stats');
  await db.exec('DELETE FROM errors');
  const listed = await kv.list();
  for (const k of listed.keys) await kv.delete(k.name);
});

// The two cache tests below seed daily_dau rows relative to TODAY and rely
// on handleInsights's real-clock `todayUTC()` landing on that same date, so
// the query window actually includes the seeded rows. Pin the clock (Date
// only - Miniflare's own timers/promises must keep running on the real
// clock) instead of letting this drift out of the query window as real time
// passes TODAY.
afterEach(() => {
  vi.useRealTimers();
});

function baseEnv(overrides: { DB?: D1Database } = {}) {
  return { DB: overrides.DB ?? db, KV_BINDING: kv, STATS_TOKEN: TOKEN } as any;
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://local${path}`, { headers });
}

async function seedDau(date: string, id: string) {
  await db.prepare('INSERT OR IGNORE INTO daily_dau (date, installation_id) VALUES (?, ?)').bind(date, id).run();
}

it('clampInsightDays: clamps 7..90, defaults to 30 for non-integer/invalid/absent', () => {
  expect(clampInsightDays(null)).toBe(30);
  expect(clampInsightDays('abc')).toBe(30);
  expect(clampInsightDays('3')).toBe(7);
  expect(clampInsightDays('1000')).toBe(90);
  expect(clampInsightDays('30.5')).toBe(30);
  expect(clampInsightDays('30')).toBe(30);
  expect(clampInsightDays('7')).toBe(7);
  expect(clampInsightDays('90')).toBe(90);
});

it('requires the token with the same status /stats/history gives without one', async () => {
  const insightsRes = await worker.fetch(get('/stats/insights'), baseEnv(), {} as any);
  const historyRes = await worker.fetch(get('/stats/history'), baseEnv(), {} as any);
  expect(insightsRes.status).toBe(historyRes.status);
  expect(insightsRes.status).toBe(401);
});

it.each([
  ['abc', 30],
  ['3', 7],
  ['1000', 90],
  ['30.5', 30],
])('GET /stats/insights?days=%s clamps body.days to %d', async (raw, expected) => {
  const res = await worker.fetch(get(`/stats/insights?days=${raw}`, { 'x-ct-token': TOKEN }), baseEnv(), {} as any);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { days: number };
  expect(body.days).toBe(expected);
});

it('serves a repeat call within TTL from KV instead of recomputing', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));

  const first = await worker.fetch(get('/stats/insights?days=30', { 'x-ct-token': TOKEN }), baseEnv(), {} as any);
  expect(first.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstBody = (await first.json()) as any;
  expect(firstBody.activity.series.every((p: { dau: number }) => p.dau === 0)).toBe(true);

  await seedDau(TODAY, 'fresh-install');

  // Sanity: an uncached compute over this same seeded data must show the
  // install that was just inserted. Without this, the "still zero" assertion
  // below would pass just as well if the cache were broken and the query
  // simply failed to see the seeded row for an unrelated reason (e.g. a
  // clock/window bug) - this pins that the data really is there and visible.
  const uncached = await computeActivity(db, 30, TODAY);
  expect(uncached.series[uncached.series.length - 1].dau).toBeGreaterThan(0);

  const second = await worker.fetch(get('/stats/insights?days=30', { 'x-ct-token': TOKEN }), baseEnv(), {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secondBody = (await second.json()) as any;
  expect(secondBody.activity.series.every((p: { dau: number }) => p.dau === 0)).toBe(true);

  expect(await kv.get('insights:v1:30')).not.toBeNull();
});

it('caches retention cohorts separately from the days-keyed payload cache', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));

  await seedDau('2026-08-31', 'x1');

  const first = await worker.fetch(get('/stats/insights?days=7', { 'x-ct-token': TOKEN }), baseEnv(), {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstBody = (await first.json()) as any;
  expect(firstBody.retention.cohorts.length).toBeGreaterThan(0);
  expect(await kv.get('insights:v1:cohorts')).not.toBeNull();

  // A days=14 call misses the days-keyed payload cache (different key) and
  // recomputes activity/releases/errors, but must still read the cohorts
  // cache rather than recomputing retention from the newly seeded row.
  await seedDau('2026-09-07', 'x2');

  // Sanity: an uncached compute over this same seeded data must surface the
  // new cohort, so the "identical to first" assertion below is actually
  // discriminating between "cohorts were cached" and "cohorts cache is a
  // no-op that happens to match" (e.g. because the new row was never seen).
  const uncachedRetention = await computeRetention(db, TODAY);
  expect(uncachedRetention.cohorts.some((c) => c.week_start === '2026-09-07')).toBe(true);

  const second = await worker.fetch(get('/stats/insights?days=14', { 'x-ct-token': TOKEN }), baseEnv(), {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secondBody = (await second.json()) as any;
  expect(secondBody.retention).toEqual(firstBody.retention);
});

it('returns 500 insights_failed on a D1 failure and writes no cache key', async () => {
  const brokenDb = {
    prepare: () => {
      throw new Error('boom');
    },
  } as unknown as D1Database;

  const res = await worker.fetch(
    get('/stats/insights?days=45', { 'x-ct-token': TOKEN }),
    baseEnv({ DB: brokenDb }),
    {} as any
  );
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'insights_failed' });
  expect(await kv.get('insights:v1:45')).toBeNull();
});

it('still computes and returns 200 when KV_BINDING.get throws', async () => {
  const throwingKv = {
    get: async () => {
      throw new Error('kv down');
    },
    put: kv.put.bind(kv),
  } as unknown as KVNamespace;

  const res = await worker.fetch(
    get('/stats/insights?days=21', { 'x-ct-token': TOKEN }),
    { DB: db, KV_BINDING: throwingKv, STATS_TOKEN: TOKEN } as any,
    {} as any
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { days: number };
  expect(body.days).toBe(21);
});
