import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  compareSemverDesc,
  computeActivity,
  computeErrors,
  computeFirstSeenByDate,
  computeReleases,
  computeRetention,
} from './insights';

// Same Miniflare + schema setup as retention.test.ts, minus the tables this
// module never touches.
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: ['DB'],
});
let db: D1Database;

beforeAll(async () => {
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
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
});

async function seedDau(rows: Array<[string, string]>) {
  for (const [d, id] of rows) {
    await db.prepare('INSERT OR IGNORE INTO daily_dau (date, installation_id) VALUES (?, ?)').bind(d, id).run();
  }
}
async function seedStat(date: string, dimension: string, bucket: string, count: number) {
  await db.prepare('INSERT INTO daily_stats (date, dimension, bucket, count) VALUES (?, ?, ?, ?)').bind(date, dimension, bucket, count).run();
}
async function seedError(ts: string, version: string) {
  await db
    .prepare(
      "INSERT INTO errors (ts, installation_id, app_version, os, country, source, kind, message, stack, fingerprint) VALUES (?, 'i', ?, 'windows', 'US', 'rust', null, 'm', null, 'fp')"
    )
    .bind(ts, version)
    .run();
}

const TODAY = '2026-09-28';

// --- computeActivity ---------------------------------------------------

it('computeActivity on empty tables returns an all-zero week with no NaN', async () => {
  const activity = await computeActivity(db, 7, TODAY);
  expect(activity.series).toHaveLength(7);
  for (const p of activity.series) {
    expect(p).toMatchObject({ dau: 0, wau: 0, mau: 0, new: 0, returning: 0 });
  }
  expect(activity.current.stickiness).toBe(0);
  // NaN serializes to `null` in JSON; a bare `null` anywhere here means a
  // division produced NaN instead of going through `ratio`.
  expect(JSON.stringify(activity)).not.toContain('null');
});

it('computeActivity: dau/wau/mau/new/returning for a mixed cohort', async () => {
  const a = 'a';
  const b = 'b';
  const c = 'c';
  await seedDau([
    ['2026-09-22', a],
    ['2026-09-23', a],
    ['2026-09-24', a],
    ['2026-09-25', a],
    ['2026-09-26', a],
    ['2026-09-27', a],
    ['2026-09-28', a],
    ['2026-09-28', b],
    ['2026-09-01', c],
  ]);

  const activity = await computeActivity(db, 7, TODAY);
  const last = activity.series[activity.series.length - 1];
  expect(last).toEqual({ date: '2026-09-28', dau: 2, wau: 2, mau: 3, new: 1, returning: 1 });

  const first = activity.series[0];
  expect(first.date).toBe('2026-09-22');
  expect(first.new).toBe(1);

  expect(activity.current.dau_avg).toBe(1.14);
  expect(activity.current.stickiness).toBe(Math.round((1.14 / 3) * 1000) / 1000);
});

it('computeActivity: previous period isolates installs outside the current window', async () => {
  const p = 'p';
  await seedDau([
    ['2026-09-15', p],
    ['2026-09-16', p],
    ['2026-09-17', p],
    ['2026-09-18', p],
    ['2026-09-19', p],
    ['2026-09-20', p],
    ['2026-09-21', p],
  ]);

  const activity = await computeActivity(db, 7, TODAY);
  expect(activity.previous.wau).toBe(1);
  expect(activity.previous.new_installs).toBe(1);
  expect(activity.current.new_installs).toBe(0);

  // p is active every day of the previous period and nowhere else, so its
  // dau_avg, mau, and stickiness are all exactly 1.
  expect(activity.previous.dau_avg).toBe(1);
  expect(activity.previous.mau).toBe(1);
  expect(activity.previous.stickiness).toBe(1);
});

// --- computeRetention ----------------------------------------------------

it('computeRetention: cohort weeks with correct nulls past today', async () => {
  await seedDau([
    ['2026-08-31', 'x1'],
    ['2026-08-31', 'x2'],
    ['2026-09-08', 'x1'],
    ['2026-09-16', 'x1'],
  ]);

  const retention = await computeRetention(db, TODAY);
  const cohort = retention.cohorts.find((c) => c.week_start === '2026-08-31');
  expect(cohort).toBeDefined();
  expect(cohort!.size).toBe(2);
  expect(cohort!.weeks).toHaveLength(8);
  expect(cohort!.weeks[0]).toBe(0.5);
  expect(cohort!.weeks[1]).toBe(0.5);
  expect(cohort!.weeks[2]).toBe(0);
  // k=4's week_start (2026-09-28) is TODAY's own Monday - the current week,
  // still in progress - so it is `null` like a future week, not a partial 0.
  expect(cohort!.weeks[3]).toBeNull();
  expect(cohort!.weeks[4]).toBeNull();
  expect(cohort!.weeks[5]).toBeNull();
  expect(cohort!.weeks[6]).toBeNull();
  expect(cohort!.weeks[7]).toBeNull();

  expect(retention.cohorts.length).toBeLessThanOrEqual(12);
});

function mondayMinusWeeks(base: string, weeksAgo: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
  return d.toISOString().slice(0, 10);
}

it('computeRetention: caps at 12 cohorts, oldest first, when data spans more weeks', async () => {
  // TODAY (2026-09-28) is itself a Monday. Seed 14 weekly cohorts, one
  // install each, so weeks 12 and 13 fall outside the 12-cohort window and
  // must be dropped.
  for (let weeksAgo = 13; weeksAgo >= 0; weeksAgo--) {
    await seedDau([[mondayMinusWeeks(TODAY, weeksAgo), `w${weeksAgo}`]]);
  }

  const retention = await computeRetention(db, TODAY);
  expect(retention.cohorts).toHaveLength(12);
  expect(retention.cohorts[0].week_start).toBe('2026-07-13'); // weeksAgo = 11, the oldest kept cohort
  expect(retention.cohorts[retention.cohorts.length - 1].week_start).toBe(TODAY); // weeksAgo = 0, newest last
  for (let i = 1; i < retention.cohorts.length; i++) {
    expect(retention.cohorts[i].week_start > retention.cohorts[i - 1].week_start).toBe(true);
  }
});

// --- computeReleases -------------------------------------------------------

it('computeReleases: latest version, share, sorting, error rates, first_seen', async () => {
  await seedStat(TODAY, 'version', '1.34.6', 60);
  await seedStat(TODAY, 'version', '1.34.5', 30);
  await seedStat(TODAY, 'version', 'unknown', 10);
  await seedStat('2026-09-20', 'version', '1.34.5', 100);
  // version buckets are pinged by both /heartbeat and /update_check, so the
  // heartbeats-only total (used for overall_errors_per_1k) legitimately
  // differs from the version-bucket ping total (100, used for share and
  // overall_errors_per_1k_pings).
  await seedStat(TODAY, 'heartbeats', '', 500);
  await seedError(`${TODAY}T10:00:00Z`, '1.34.6');
  await seedError(`${TODAY}T11:00:00Z`, '1.34.6');
  await seedError(`${TODAY}T12:00:00Z`, '1.34.6');

  const releases = await computeReleases(db, 7, TODAY);
  expect(releases.latest_version).toBe('1.34.6');
  expect(releases.latest_share_today).toBe(0.6);
  expect(releases.versions.map((v) => v.version)).toEqual(['1.34.6', '1.34.5', 'unknown']);
  const v6 = releases.versions.find((v) => v.version === '1.34.6')!;
  expect(v6.pings).toBe(60);
  expect(v6.share).toBe(0.6); // 60 / 100 total pings in period
  expect(v6.errors_per_1k_pings).toBe(50); // 3 / 60 * 1000
  const v5 = releases.versions.find((v) => v.version === '1.34.5')!;
  expect(v5.first_seen).toBe('2026-09-20');

  expect(releases.overall_errors_per_1k).toBe(6); // 3 errors / 500 heartbeats * 1000
  expect(releases.overall_errors_per_1k_pings).toBe(30); // 3 errors / 100 total pings * 1000
});

it('compareSemverDesc: semver desc, prerelease below release, non-semver last', () => {
  const input = ['1.9.0', '1.10.0', 'unknown', '1.34.6-beta', '1.34.6'];
  expect([...input].sort(compareSemverDesc)).toEqual(['1.34.6', '1.34.6-beta', '1.10.0', '1.9.0', 'unknown']);
});

// --- computeErrors -----------------------------------------------------

it('computeErrors: per_1k per day, zero-heartbeat day is 0 not NaN, and previous cutoff', async () => {
  await seedError('2026-09-27T10:00:00Z', '1.34.6');
  await seedError('2026-09-27T11:00:00Z', '1.34.6');
  await seedStat('2026-09-27', 'heartbeats', '', 1000);
  await seedError('2026-09-26T10:00:00Z', '1.34.6'); // errors with no heartbeats row that day

  const errors = await computeErrors(db, 7, TODAY);
  const day27 = errors.per_day.find((d) => d.date === '2026-09-27')!;
  expect(day27.per_1k).toBe(2);
  const day26 = errors.per_day.find((d) => d.date === '2026-09-26')!;
  expect(day26.errors).toBe(1);
  expect(day26.heartbeats).toBe(0);
  expect(day26.per_1k).toBe(0);

  // Current period (2026-09-22..28) holds all 3 seeded errors and the one
  // heartbeats row (1000 on 09-27); previous (09-15..21) has neither.
  expect(errors.current).toEqual({ errors: 3, per_1k: 3 });
  expect(errors.previous).not.toBeNull();
  expect(errors.previous).toEqual({ errors: 0, per_1k: 0 });

  expect((await computeErrors(db, 60, TODAY)).previous).toBeNull();
  expect((await computeErrors(db, 30, TODAY)).previous).not.toBeNull();
});

// --- Step 5: rows_read budget check --------------------------------------

// Wraps `db.batch` in a real Proxy trap (assigning `db.batch` directly does
// not stick, since Miniflare's D1 stub is itself a proxy object) and totals
// `meta.rows_read` across every statement in every batch call made through
// the returned handle.
function trackRowsRead(target: D1Database): { db: D1Database; rowsRead: () => number } {
  let rowsRead = 0;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const results = await t.batch(stmts);
          for (const r of results) rowsRead += r.meta.rows_read ?? 0;
          return results;
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
  return { db: proxy as unknown as D1Database, rowsRead: () => rowsRead };
}

it(
  'rows_read for a 90-day compute: warm (cached first-seen map) stays well under a full 400-day x 60-install table scan',
  async () => {
    const NUM_DAYS = 400;
    // Kept at 60 installs/day (not 200) so this test's 24,000-row seed
    // doesn't overload Miniflare's D1 proxy when all 8 spec files run
    // concurrently under `npm run test:run`; the day count (and thus the
    // ratio this test proves - full-table scan vs. windowed query) is
    // unchanged. See the "warm reads only" comment below.
    const NUM_INSTALLS = 60;
    const rows: Array<[string, string]> = [];
    const dayMs = 86_400_000;
    const start = Date.parse(`${TODAY}T00:00:00Z`) - (NUM_DAYS - 1) * dayMs;
    for (let day = 0; day < NUM_DAYS; day++) {
      const date = new Date(start + day * dayMs).toISOString().slice(0, 10);
      for (let inst = 0; inst < NUM_INSTALLS; inst++) {
        rows.push([date, `inst-${inst}`]);
      }
    }
    // One round trip per test run against Miniflare's D1 proxy is expensive,
    // so pack many rows into each statement instead of one statement per row.
    // D1 caps bound parameters per statement at 100, well under SQLite's own
    // ~999 limit; and batches of statements are chunked (<=500 statements per
    // `db.batch` call, D1's own batch-size ceiling) so a single call doesn't
    // have to hold all 24,000 rows' worth at once.
    const rowsPerStatement = 45;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += rowsPerStatement) {
      const chunk = rows.slice(i, i + rowsPerStatement);
      const sql = `INSERT OR IGNORE INTO daily_dau (date, installation_id) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`;
      statements.push(db.prepare(sql).bind(...chunk.flat()));
    }
    const statementsPerBatch = 500;
    for (let i = 0; i < statements.length; i += statementsPerBatch) {
      await db.batch(statements.slice(i, i + statementsPerBatch));
    }

    // Cold: no precomputed map, so computeActivity falls back to the old
    // inline MIN(date)-per-installation scan of the whole table, same as
    // before this change.
    const cold = trackRowsRead(db);
    await computeActivity(cold.db, 90, TODAY);
    const coldRowsRead = cold.rowsRead();

    // Warm: the first-seen map is precomputed once (as insights-route.ts's
    // hourly-cached `computeCohorts` would do) and handed in, so this
    // measurement only covers computeActivity's own windowed dau query.
    const firstSeenByDate = await computeFirstSeenByDate(db, TODAY);
    const warm = trackRowsRead(db);
    await computeActivity(warm.db, 90, TODAY, firstSeenByDate);
    const warmRowsRead = warm.rowsRead();

    // eslint-disable-next-line no-console
    console.log(`computeActivity(90) rows_read - cold: ${coldRowsRead}, warm (cached first-seen map): ${warmRowsRead}`);

    expect(Number.isFinite(coldRowsRead)).toBe(true);
    expect(Number.isFinite(warmRowsRead)).toBe(true);
    // Warm reads only the ~209-day window (fetchStart..today) at 60
    // installs/day (~12,540 rows) instead of the full 400-day x 60-install
    // table (24,000 rows) the cold path's first-seen scan reads on top of
    // that same window query. Ceiling is scaled down from the original
    // 200-install version's 60,000 by the same 60/200 install ratio.
    expect(warmRowsRead).toBeLessThan(18_000);
    expect(warmRowsRead).toBeLessThan(coldRowsRead);
  },
  45_000,
);
