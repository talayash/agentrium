/**
 * Atomic increment of one ingest_limits row. Returns false when the row is
 * already at `limit` inside the current window; a stale window resets to 1.
 */
async function bumpCounter(db: D1Database, key: string, window: number, limit: number): Promise<boolean> {
  const row = await db.prepare(`INSERT INTO ingest_limits (key, window, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      window = excluded.window,
      count = CASE WHEN ingest_limits.window != excluded.window THEN 1 ELSE ingest_limits.count + 1 END
    WHERE ingest_limits.window != excluded.window OR ingest_limits.count < ?
    RETURNING count`).bind(key, window, limit).first();
  return row !== null;
}

/** Atomic increment with no cap; returns the count after this request. */
async function countRequest(db: D1Database, key: string, window: number): Promise<number> {
  const row = await db.prepare(`INSERT INTO ingest_limits (key, window, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      window = excluded.window,
      count = CASE WHEN ingest_limits.window != excluded.window THEN 1 ELSE ingest_limits.count + 1 END
    RETURNING count`).bind(key, window).first<{ count: number }>();
  return row?.count ?? Number.MAX_SAFE_INTEGER;
}

export const IP_INGEST_PER_MINUTE = 120;
/** Total ingest per minute above which the Worker counts as overloaded. */
export const GLOBAL_INGEST_SOFT_LIMIT = 10000;
/** Requests per minute an IP may still send while the Worker is overloaded. */
export const LIGHT_IP_PER_MINUTE = 5;

/**
 * Atomic D1 admission counters; installation IDs cannot reset these budgets.
 *
 * Per IP: at most IP_INGEST_PER_MINUTE. Globally: past GLOBAL_INGEST_SOFT_LIMIT
 * only IPs above LIGHT_IP_PER_MINUTE are refused. The global budget used to be
 * a hard cap, so ~84 addresses at the per-IP limit filled it and every real
 * client (a heartbeat every few minutes) got 429 (F10, 2026-11-05 assessment).
 * Now a flood only throttles the heavy senders that cause it. Volumetric
 * floods from very many light IPs belong in a Cloudflare WAF rate-limit rule.
 */
export async function admitIngest(db: D1Database, ip: string, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 60000);
  const ipKey = `ip:${ip}`;
  if (!await bumpCounter(db, ipKey, window, IP_INGEST_PER_MINUTE)) return false;
  const total = await countRequest(db, 'global', window);
  if (total <= GLOBAL_INGEST_SOFT_LIMIT) return true;
  const row = await db.prepare('SELECT count FROM ingest_limits WHERE key = ? AND window = ?')
    .bind(ipKey, window).first<{ count: number }>();
  return (row?.count ?? 0) <= LIGHT_IP_PER_MINUTE;
}

/** Error reports one IP may insert per UTC day, on top of the per-minute caps. */
export const ERROR_REPORT_DAILY_LIMIT = 1000;

/**
 * Window value for a per-day row. Expressed in the same minute count as the
 * per-minute rows but aligned to the UTC day start, so the cron sweep
 * (`window < now_minute - 1440`) only ever removes rows from past days and
 * cannot reset a budget mid-day. No schema change: same key/window/count row.
 */
export function errorDayWindow(now: number): number {
  return Math.floor(now / 86_400_000) * 1440;
}

/** Per-IP daily budget for /error_report; the minute caps still apply first. */
export async function admitErrorReport(db: D1Database, ip: string, now = Date.now()): Promise<boolean> {
  return bumpCounter(db, `err_day:${ip}`, errorDayWindow(now), ERROR_REPORT_DAILY_LIMIT);
}

export async function boundedJson(request: Request, cap = 16 * 1024): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > cap) throw new RangeError('payload_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) { await reader.cancel(); throw new RangeError('payload_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Upper bound on a self-reported app version.
 *
 * Ingest is unauthenticated by necessity - the desktop binary cannot hold a
 * secret - so `app_version` is caller-controlled: any well-formed string
 * becomes a real bucket in `daily_stats`. The format regex alone admits
 * 9999.9999.9999, which is how a fabricated `1.99.0` came to outrank every
 * shipped release in the version chart.
 *
 * The ceiling sits deliberately far above the shipping version instead of
 * equal to it. Pinning it to the current release would reject the first
 * heartbeat of every new release until this Worker is redeployed, silently
 * blackholing telemetry for exactly the build most worth watching. Raise it
 * when the real version comes within a few minors; rejections surface as
 * `version_out_of_range` rather than a generic 400, so the cause is legible
 * from the response alone.
 */
export const MAX_APP_VERSION = '1.60.0';

/** Numeric compare over major.minor.patch. A prerelease suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const [xi, yi] = [x[i] ?? 0, y[i] ?? 0];
    if (xi !== yi) return xi < yi ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a version is at or below MAX_APP_VERSION. Intended to run after
 * validDimensions has already vouched for the format, but safe on any input.
 */
export function versionWithinCeiling(version: unknown): boolean {
  return typeof version === 'string' && compareVersions(version, MAX_APP_VERSION) <= 0;
}

export function validDimensions(id: unknown, version: unknown, os: unknown): boolean {
  return typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    && typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.]{1,16})?$/.test(version)
    && typeof os === 'string' && ['windows', 'macos', 'linux'].includes(os.toLowerCase());
}
