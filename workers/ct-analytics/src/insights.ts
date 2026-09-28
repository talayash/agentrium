/**
 * Pure aggregate computations backing `GET /stats/insights` (route wiring is
 * a separate change). Every function takes `today` (a `YYYY-MM-DD` UTC date)
 * as a parameter instead of reading the clock, so tests are deterministic
 * and the route can pin it once per request.
 *
 * "Period" = the `days` dates ending on `today` inclusive; "previous" = the
 * `days` dates immediately before that (spec [03] 3.1).
 */

export interface ActivityPoint {
  date: string;
  dau: number;
  wau: number;
  mau: number;
  new: number;
  returning: number;
}
export interface ActivitySummary {
  dau_avg: number;
  wau: number;
  mau: number;
  stickiness: number;
  new_installs: number;
}
export interface Cohort {
  week_start: string;
  size: number;
  weeks: Array<number | null>; // length 8
}
export interface VersionRow {
  version: string;
  pings: number;
  share: number;
  errors: number;
  errors_per_1k_pings: number;
  first_seen: string;
}
export interface ErrorDay {
  date: string;
  errors: number;
  heartbeats: number;
  per_1k: number;
}
export interface InsightsPayload {
  days: number;
  generated_at: string;
  activity: { series: ActivityPoint[]; current: ActivitySummary; previous: ActivitySummary };
  retention: { cohorts: Cohort[] };
  releases: {
    latest_version: string | null;
    latest_share_today: number;
    versions: VersionRow[];
    overall_errors_per_1k: number;
    overall_errors_per_1k_pings: number;
  };
  errors: { per_day: ErrorDay[]; current: { errors: number; per_1k: number }; previous: { errors: number; per_1k: number } | null };
}

/** D1 keeps `errors` for this many days; a `previous` window that would read
 * past it is reported as `null` instead of a silently-wrong partial count. */
export const ERROR_RETENTION_DAYS_FOR_INSIGHTS = 90;

/** `den <= 0` returns 0 instead of NaN/Infinity so every downstream field is
 * a plain finite number (NaN serializes to `null` in JSON). */
export function ratio(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
const round2 = (n: number) => round(n, 2);
const round3 = (n: number) => round(n, 3);

/** `1.34.6`, `1.34.6-beta`, but not `unknown`. Not anchored at the end, so a
 * build metadata/prerelease suffix after the first three numeric parts still
 * matches. */
export function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(v);
}

/** Descending version order for the releases table: numerically newest
 * semver first, a prerelease ranks just below its release at the same
 * major.minor.patch, and anything that isn't semver (`unknown`) sorts last. */
export function compareSemverDesc(a: string, b: string): number {
  const aSemver = isSemver(a);
  const bSemver = isSemver(b);
  if (aSemver !== bSemver) return aSemver ? -1 : 1;
  if (!aSemver) return a < b ? -1 : a > b ? 1 : 0;

  const parse = (v: string) => {
    const [core, ...rest] = v.split('-');
    const [maj, min, pat] = core.split('.').map((n) => parseInt(n, 10) || 0);
    return { maj, min, pat, pre: rest.join('-') };
  };
  const x = parse(a);
  const y = parse(b);
  if (x.maj !== y.maj) return y.maj - x.maj;
  if (x.min !== y.min) return y.min - x.min;
  if (x.pat !== y.pat) return y.pat - x.pat;
  if (!x.pre && y.pre) return -1;
  if (x.pre && !y.pre) return 1;
  if (x.pre !== y.pre) return x.pre < y.pre ? -1 : 1;
  return 0;
}

/** `dateStr + delta` days, both UTC, formatted back to `YYYY-MM-DD`. */
function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface CalRow {
  date: string;
  dau: number;
  wau: number;
  mau: number;
}
interface NewRow {
  date: string;
  n: number;
}
interface DauRow {
  date: string;
  installation_id: string;
}

/**
 * Distinct-count per date over a trailing `windowSize`-day window (current
 * date inclusive), for every date in `datesAsc` (ascending, contiguous).
 * Maintains a sliding deque of per-date ID sets plus an occurrence count per
 * ID, so the whole pass is O(rows + dates) instead of rescanning the raw
 * rows once per date (the previous correlated-subquery version read ~870k
 * rows for a 90-day window over 200 seeded installs).
 */
function rollingDistinctCounts(datesAsc: string[], setByDate: Map<string, Set<string>>, windowSize: number): Map<string, number> {
  const occurrences = new Map<string, number>(); // installation_id -> days present in the current window
  const windowDates: string[] = [];
  const result = new Map<string, number>();
  for (const d of datesAsc) {
    const set = setByDate.get(d);
    if (set) for (const id of set) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    windowDates.push(d);
    if (windowDates.length > windowSize) {
      const dropped = windowDates.shift()!;
      const droppedSet = setByDate.get(dropped);
      if (droppedSet) {
        for (const id of droppedSet) {
          const next = (occurrences.get(id) ?? 0) - 1;
          if (next <= 0) occurrences.delete(id);
          else occurrences.set(id, next);
        }
      }
    }
    result.set(d, occurrences.size);
  }
  return result;
}

export async function computeActivity(db: D1Database, days: number, today: string): Promise<InsightsPayload['activity']> {
  const span = 2 * days;
  const windowStart = addDays(today, -(span - 1));
  // 29 days of lead-in so the mau window (30 days incl. current) is complete
  // even for windowStart's own point, without re-querying per date.
  const fetchStart = addDays(windowStart, -29);

  // The 400-day daily_dau horizon (see cron in index.ts) matches the
  // `seen:` KV TTL, so "first ever seen" here agrees with the installation
  // counter fed by that same KV key - an install first seen more than 400
  // days ago and seen again would double-count as "new" in both places.
  const newSql = `
    SELECT first AS date, COUNT(*) AS n FROM (
      SELECT MIN(date) AS first FROM daily_dau GROUP BY installation_id
    ) WHERE first >= ?1 GROUP BY first`;

  const [dauRes, newRes] = await db.batch([
    db.prepare('SELECT date, installation_id FROM daily_dau WHERE date BETWEEN ?1 AND ?2').bind(fetchStart, today),
    db.prepare(newSql).bind(windowStart),
  ]);

  const dauRows = (dauRes.results ?? []) as unknown as DauRow[];
  const newRows = (newRes.results ?? []) as unknown as NewRow[];
  const newMap = new Map(newRows.map((r) => [r.date, r.n]));

  const setByDate = new Map<string, Set<string>>();
  for (const r of dauRows) {
    let set = setByDate.get(r.date);
    if (!set) {
      set = new Set();
      setByDate.set(r.date, set);
    }
    set.add(r.installation_id);
  }

  const extendedDates: string[] = [];
  for (let i = 0; i < span + 29; i++) extendedDates.push(addDays(fetchStart, i));
  const wauByDate = rollingDistinctCounts(extendedDates, setByDate, 7);
  const mauByDate = rollingDistinctCounts(extendedDates, setByDate, 30);

  const calRows: CalRow[] = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(windowStart, i);
    calRows.push({ date: d, dau: setByDate.get(d)?.size ?? 0, wau: wauByDate.get(d) ?? 0, mau: mauByDate.get(d) ?? 0 });
  }

  const previousRows = calRows.slice(0, days);
  const currentRows = calRows.slice(days);

  const series: ActivityPoint[] = currentRows.map((r) => {
    const newCount = newMap.get(r.date) ?? 0;
    return { date: r.date, dau: r.dau, wau: r.wau, mau: r.mau, new: newCount, returning: Math.max(0, r.dau - newCount) };
  });

  const summarize = (rows: CalRow[]): ActivitySummary => {
    const sumDau = rows.reduce((s, r) => s + r.dau, 0);
    const dauAvg = round2(rows.length ? sumDau / rows.length : 0);
    const last = rows[rows.length - 1];
    const wau = last ? last.wau : 0;
    const mau = last ? last.mau : 0;
    const newInstalls = rows.reduce((s, r) => s + (newMap.get(r.date) ?? 0), 0);
    return { dau_avg: dauAvg, wau, mau, stickiness: round3(ratio(dauAvg, mau)), new_installs: newInstalls };
  };

  return { series, current: summarize(currentRows), previous: summarize(previousRows) };
}

interface CohortRow {
  cw: string;
  k: number;
  n: number;
}

export async function computeRetention(db: D1Database, today: string): Promise<InsightsPayload['retention']> {
  // Weeks start Monday. `date(x, 'weekday 0', '-6 days')` maps any date to
  // the Monday of its week (the 'weekday 0' modifier jumps forward to the
  // next Sunday - today's own Sunday when today already is one - then -6
  // days lands back on that week's Monday).
  const sql = `
    WITH firsts AS (SELECT installation_id, MIN(date) AS first FROM daily_dau GROUP BY installation_id),
    cohort AS (SELECT installation_id, date(first, 'weekday 0', '-6 days') AS cw FROM firsts
               WHERE first >= date(?1, 'weekday 0', '-6 days', '-77 days')),
    act AS (SELECT DISTINCT d.installation_id, date(d.date, 'weekday 0', '-6 days') AS aw
            FROM daily_dau d JOIN cohort c ON c.installation_id = d.installation_id)
    SELECT c.cw AS cw, CAST(ROUND((julianday(a.aw) - julianday(c.cw)) / 7) AS INTEGER) AS k,
           COUNT(DISTINCT c.installation_id) AS n
    FROM cohort c JOIN act a ON a.installation_id = c.installation_id
    GROUP BY 1, 2 ORDER BY 1, 2`;

  const [mondayRes, cohortRes] = await db.batch([
    db.prepare("SELECT date(?1, 'weekday 0', '-6 days') AS m").bind(today),
    db.prepare(sql).bind(today),
  ]);

  const todayMonday = ((mondayRes.results?.[0] as unknown as { m: string } | undefined)?.m) ?? today;
  const rows = (cohortRes.results ?? []) as unknown as CohortRow[];

  const byCw = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (!byCw.has(r.cw)) byCw.set(r.cw, new Map());
    byCw.get(r.cw)!.set(r.k, r.n);
  }

  const cohorts: Cohort[] = [...byCw.keys()]
    .sort()
    .map((cw) => {
      const kMap = byCw.get(cw)!;
      const size = kMap.get(0) ?? 0;
      const weeks: Array<number | null> = [];
      for (let k = 1; k <= 8; k++) {
        const weekStart = addDays(cw, 7 * k);
        if (weekStart > todayMonday) {
          weeks.push(null);
          continue;
        }
        weeks.push(size > 0 ? round3(ratio(kMap.get(k) ?? 0, size)) : 0);
      }
      return { week_start: cw, size, weeks };
    })
    .filter((c) => c.size > 0)
    .slice(-12); // the WHERE clause above already bounds this to ~12 cohorts; belt and suspenders.

  return { cohorts };
}

interface BucketHbRow {
  bucket: string;
  hb: number;
}
interface BucketFirstRow {
  bucket: string;
  first_seen: string;
}
interface BucketCountRow {
  bucket: string;
  count: number;
}
interface AppVersionErrRow {
  app_version: string;
  n: number;
}

export async function computeReleases(db: D1Database, days: number, today: string): Promise<InsightsPayload['releases']> {
  const start = addDays(today, -(days - 1));

  const [pingRes, firstRes, todayRes, errRes, hbRes] = await db.batch([
    db.prepare("SELECT bucket, SUM(count) AS hb FROM daily_stats WHERE dimension = 'version' AND date >= ?1 GROUP BY bucket").bind(start),
    db.prepare("SELECT bucket, MIN(date) AS first_seen FROM daily_stats WHERE dimension = 'version' GROUP BY bucket"),
    db.prepare("SELECT bucket, count FROM daily_stats WHERE dimension = 'version' AND date = ?1").bind(today),
    db.prepare('SELECT app_version, COUNT(*) AS n FROM errors WHERE ts >= ?1 GROUP BY app_version').bind(`${start}T00:00:00`),
    // `daily_stats` version buckets are bumped by BOTH /heartbeat and
    // /update_check (see handleHeartbeat in index.ts), so they count
    // "pings", not heartbeats. `overall_errors_per_1k` still needs the true
    // heartbeats-only denominator (same one computeErrors uses) to stay
    // comparable across the dashboard; `overall_errors_per_1k_pings` /
    // `errors_per_1k_pings` use the version-bucket ping total instead.
    db.prepare("SELECT SUM(count) AS hb FROM daily_stats WHERE dimension = 'heartbeats' AND bucket = '' AND date >= ?1").bind(start),
  ]);

  const pingRows = (pingRes.results ?? []) as unknown as BucketHbRow[];
  const firstRows = (firstRes.results ?? []) as unknown as BucketFirstRow[];
  const todayRows = (todayRes.results ?? []) as unknown as BucketCountRow[];
  const errRows = (errRes.results ?? []) as unknown as AppVersionErrRow[];
  const heartbeatTotal = ((hbRes.results?.[0] as unknown as { hb: number | null } | undefined)?.hb) ?? 0;

  const firstSeenMap = new Map(firstRows.map((r) => [r.bucket, r.first_seen]));
  const errMap = new Map(errRows.map((r) => [r.app_version, r.n]));
  const totalPings = pingRows.reduce((s, r) => s + r.hb, 0);
  // Errors count toward both overall rates below even when their
  // app_version has no matching `daily_stats` version bucket in the period
  // (e.g. a version that only ever errored and never pinged) - they just
  // don't get a version row, since there's no bucket to attach one to.
  const totalErrors = errRows.reduce((s, r) => s + r.n, 0);

  const versions: VersionRow[] = pingRows
    .map((r) => {
      const errors = errMap.get(r.bucket) ?? 0;
      return {
        version: r.bucket,
        pings: r.hb,
        share: round3(ratio(r.hb, totalPings)),
        errors,
        errors_per_1k_pings: round2(ratio(errors, r.hb) * 1000),
        first_seen: firstSeenMap.get(r.bucket) ?? '',
      };
    })
    .sort((a, b) => compareSemverDesc(a.version, b.version));

  // Never "unknown": only a real semver bucket can be the latest version.
  const latest_version = versions.map((v) => v.version).filter(isSemver).sort(compareSemverDesc)[0] ?? null;

  const todayTotal = todayRows.reduce((s, r) => s + r.count, 0);
  const latestTodayCount = latest_version ? todayRows.find((r) => r.bucket === latest_version)?.count ?? 0 : 0;

  return {
    latest_version,
    latest_share_today: round3(ratio(latestTodayCount, todayTotal)),
    versions,
    overall_errors_per_1k: round2(ratio(totalErrors, heartbeatTotal) * 1000),
    overall_errors_per_1k_pings: round2(ratio(totalErrors, totalPings) * 1000),
  };
}

interface ErrDateRow {
  date: string;
  n: number;
}
interface HbDateRow {
  date: string;
  count: number;
}

export async function computeErrors(db: D1Database, days: number, today: string): Promise<InsightsPayload['errors']> {
  const needPrevious = 2 * days <= ERROR_RETENTION_DAYS_FOR_INSIGHTS;
  const span = needPrevious ? 2 * days : days;
  const start = addDays(today, -(span - 1));

  const [errRes, hbRes] = await db.batch([
    db.prepare('SELECT substr(ts, 1, 10) AS date, COUNT(*) AS n FROM errors WHERE ts >= ?1 GROUP BY 1').bind(`${start}T00:00:00`),
    db.prepare("SELECT date, count FROM daily_stats WHERE dimension = 'heartbeats' AND bucket = '' AND date >= ?1").bind(start),
  ]);

  const errMap = new Map(((errRes.results ?? []) as unknown as ErrDateRow[]).map((r) => [r.date, r.n]));
  const hbMap = new Map(((hbRes.results ?? []) as unknown as HbDateRow[]).map((r) => [r.date, r.count]));

  const calendar: string[] = [];
  for (let i = 0; i < span; i++) calendar.push(addDays(start, i));
  const previousDates = needPrevious ? calendar.slice(0, days) : [];
  const currentDates = calendar.slice(needPrevious ? days : 0);

  const dayOf = (date: string): ErrorDay => {
    const errors = errMap.get(date) ?? 0;
    const heartbeats = hbMap.get(date) ?? 0;
    return { date, errors, heartbeats, per_1k: round2(ratio(errors, heartbeats) * 1000) };
  };

  const per_day = currentDates.map(dayOf);
  const currentErrors = per_day.reduce((s, d) => s + d.errors, 0);
  const currentHb = per_day.reduce((s, d) => s + d.heartbeats, 0);
  const current = { errors: currentErrors, per_1k: round2(ratio(currentErrors, currentHb) * 1000) };

  let previous: { errors: number; per_1k: number } | null = null;
  if (needPrevious) {
    const prevDays = previousDates.map(dayOf);
    const prevErrors = prevDays.reduce((s, d) => s + d.errors, 0);
    const prevHb = prevDays.reduce((s, d) => s + d.heartbeats, 0);
    previous = { errors: prevErrors, per_1k: round2(ratio(prevErrors, prevHb) * 1000) };
  }

  return { per_day, current, previous };
}
