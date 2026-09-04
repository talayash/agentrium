/**
 * ClaudeTerminal analytics worker.
 *
 * Storage:
 *   - KV (binding: KV_BINDING)
 *       seen:{installation_id}   no TTL,    used to detect first-ever heartbeat
 *       live:{installation_id}   TTL=900s,  metadata = {version, os, country}
 *
 *   - D1 (binding: DB)
 *       counters             - all-time scalars (total_installations)
 *       daily_dau            - one row per (date, installation_id), DAU = COUNT(*)
 *       daily_stats          - counters by (date, dimension, bucket)
 *
 * Routes:
 *   POST /heartbeat              record a heartbeat
 *   POST /update_check           record an update-check event
 *   GET  /stats                  legacy dashboard payload (back-compat)
 *   GET  /stats/live             active in last 15 min, by version/os/country
 *   GET  /stats/history?days=30&metric=dau|heartbeats|update_checks|version|os|country
 *   GET  /errors/summary?days=7&limit=20   top error groups + by source/version/os/day
 */

interface Env {
  KV_BINDING: KVNamespace;
  DB: D1Database;
  STATS_TOKEN: string;
}

interface HeartbeatBody {
  installation_id?: unknown;
  app_version?: unknown;
  os?: unknown;
  os_version?: unknown;
  timestamp?: unknown;
}

interface ErrorReportBody {
  installation_id?: unknown;
  app_version?: unknown;
  os?: unknown;
  source?: unknown;
  kind?: unknown;
  message?: unknown;
  stack?: unknown;
  fingerprint?: unknown;
}

interface NormalizedErrorReport {
  installation_id: string;
  app_version: string;
  os: string;
  country: string;
  source: string;
  kind: string | null;
  message: string;
  stack: string | null;
  fingerprint: string;
}

interface NormalizedPayload {
  installation_id: string;
  version: string;
  os: string;
  country: string;
}

interface LiveMetadata {
  version: string;
  os: string;
  country: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // x-ct-token remains available for the protected administrative stats
  // endpoints. Public ingestion routes deliberately do not authenticate with
  // a secret embedded in the desktop client.
  'Access-Control-Allow-Headers': 'Content-Type, x-ct-token',
  'Access-Control-Max-Age': '86400',
};

const LIVE_TTL_SECONDS = 900;
const MAX_HISTORY_DAYS = 365;
const RATE_LIMIT_TTL_SECONDS = 60;
const ERROR_RETENTION_DAYS = 90;

function requireToken(request: Request, expected: string | undefined): Response | null {
  if (!expected) return json({ error: 'server_misconfigured' }, 500);
  const provided = request.headers.get('x-ct-token');
  if (provided !== expected) return json({ error: 'unauthorized' }, 401);
  return null;
}

// Cloudflare KV requires expirationTtl >= 60; a previous 5s value here failed
// every PUT with 400, which surfaced as 500 on /heartbeat, /update_check, and
// /error_report and caused active_now to drop to 0 (no live: keys written).
const KV_MIN_TTL_SECONDS = 60;

async function rateLimitIngest(request: Request, env: Env, installationId: unknown): Promise<Response | null> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const id = typeof installationId === 'string' ? installationId.slice(0, 64) : 'unknown';
  const key = `rl:ingest:${ip}:${id}`;
  if (await env.KV_BINDING.get(key)) return json({ error: 'rate_limited' }, 429);
  await env.KV_BINDING.put(key, '1', { expirationTtl: KV_MIN_TTL_SECONDS });
  return null;
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function clampString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function normalize(body: HeartbeatBody, request: Request): NormalizedPayload | null {
  const installation_id = clampString(body.installation_id, 128);
  const version = clampString(body.app_version, 32);
  const os = clampString(body.os, 32);
  if (!installation_id || !version || !os) return null;

  const country =
    typeof (request as Request & { cf?: { country?: string } }).cf?.country === 'string'
      ? ((request as Request & { cf?: { country?: string } }).cf!.country as string).toUpperCase().slice(0, 2)
      : 'XX';

  return {
    installation_id,
    version,
    os: os.toLowerCase(),
    country,
  };
}

const ALLOWED_SOURCES = new Set(['rust_panic', 'rust_command', 'frontend']);

function normalizeError(body: ErrorReportBody, request: Request): NormalizedErrorReport | null {
  const installation_id = clampString(body.installation_id, 128);
  const app_version = clampString(body.app_version, 32);
  const os = clampString(body.os, 32);
  const source = clampString(body.source, 16);
  const message = clampString(body.message, 2048);
  if (!installation_id || !app_version || !os || !source || !message) return null;
  if (!ALLOWED_SOURCES.has(source)) return null;

  const country =
    typeof (request as Request & { cf?: { country?: string } }).cf?.country === 'string'
      ? ((request as Request & { cf?: { country?: string } }).cf!.country as string).toUpperCase().slice(0, 2)
      : 'XX';

  return {
    installation_id,
    app_version,
    os: os.toLowerCase(),
    country,
    source,
    kind: clampString(body.kind, 64),
    message,
    stack: clampString(body.stack, 8192),
    fingerprint: clampString(body.fingerprint, 16) ?? 'unknown',
  };
}

async function handleHeartbeat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  dimension: 'heartbeats' | 'update_checks',
): Promise<Response> {
  let body: HeartbeatBody;
  try {
    body = (await request.json()) as HeartbeatBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const payload = normalize(body, request);
  if (!payload) return json({ error: 'invalid_payload' }, 400);

  // Per-installation rate limit. Drops repeat posts within the window so a
  // single client can't pump up counters; legit heartbeats fire far less often.
  const rateKey = `rl:${dimension}:${payload.installation_id}`;
  if (await env.KV_BINDING.get(rateKey)) {
    return json({ ok: true, throttled: true });
  }
  ctx.waitUntil(env.KV_BINDING.put(rateKey, '1', { expirationTtl: RATE_LIMIT_TTL_SECONDS }));

  const date = todayUTC();

  // Live presence: TTL key with metadata for /stats/live aggregation.
  const liveMetadata: LiveMetadata = {
    version: payload.version,
    os: payload.os,
    country: payload.country,
  };
  ctx.waitUntil(
    env.KV_BINDING.put(`live:${payload.installation_id}`, '1', {
      expirationTtl: LIVE_TTL_SECONDS,
      metadata: liveMetadata,
    }),
  );

  // First-ever sighting? Record in KV and bump all-time installations counter.
  const seenKey = `seen:${payload.installation_id}`;
  const seen = await env.KV_BINDING.get(seenKey);
  const isFirstSighting = seen === null;
  if (isFirstSighting) {
    ctx.waitUntil(
      env.KV_BINDING.put(
        seenKey,
        JSON.stringify({
          first_seen: new Date().toISOString(),
          version: payload.version,
          os: payload.os,
          country: payload.country,
        }),
      ),
    );
  }

  // Aggregate writes - one batch, partial atomicity.
  const stmts = [
    env.DB.prepare('INSERT OR IGNORE INTO daily_dau (date, installation_id) VALUES (?, ?)').bind(
      date,
      payload.installation_id,
    ),
    env.DB.prepare(
      "INSERT INTO daily_stats (date, dimension, bucket, count) VALUES (?, ?, '', 1) " +
        'ON CONFLICT(date, dimension, bucket) DO UPDATE SET count = count + 1',
    ).bind(date, dimension),
    env.DB.prepare(
      "INSERT INTO daily_stats (date, dimension, bucket, count) VALUES (?, 'version', ?, 1) " +
        'ON CONFLICT(date, dimension, bucket) DO UPDATE SET count = count + 1',
    ).bind(date, payload.version),
    env.DB.prepare(
      "INSERT INTO daily_stats (date, dimension, bucket, count) VALUES (?, 'os', ?, 1) " +
        'ON CONFLICT(date, dimension, bucket) DO UPDATE SET count = count + 1',
    ).bind(date, payload.os),
    env.DB.prepare(
      "INSERT INTO daily_stats (date, dimension, bucket, count) VALUES (?, 'country', ?, 1) " +
        'ON CONFLICT(date, dimension, bucket) DO UPDATE SET count = count + 1',
    ).bind(date, payload.country),
  ];

  if (isFirstSighting) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO counters (key, value) VALUES ('total_installations', 1) " +
          'ON CONFLICT(key) DO UPDATE SET value = value + 1',
      ),
    );
  }

  try {
    await env.DB.batch(stmts);
  } catch (err) {
    console.error('[heartbeat] D1 batch failed:', err);
    return json({ error: 'db_error' }, 500);
  }

  return json({ ok: true });
}

async function handleErrorReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ErrorReportBody;
  try {
    body = (await request.json()) as ErrorReportBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const payload = normalizeError(body, request);
  if (!payload) return json({ error: 'invalid_payload' }, 400);

  // Known-benign noise still emitted by clients older than 1.28.1: monaco's
  // WebKit clipboard workaround rejects a pending write with CancellationError
  // (name === message === "Canceled") on every editor click/keydown in
  // WKWebView. Filtered client-side since 1.28.1; drop it here too so old
  // versions can't refill the table.
  if (payload.source === 'frontend' && payload.kind === 'Canceled' && payload.message === 'Canceled') {
    return json({ ok: true, dropped: true });
  }

  const rateKey = `rl:errors:${payload.installation_id}:${payload.fingerprint}`;
  if (await env.KV_BINDING.get(rateKey)) {
    return json({ ok: true, throttled: true });
  }
  ctx.waitUntil(env.KV_BINDING.put(rateKey, '1', { expirationTtl: RATE_LIMIT_TTL_SECONDS }));

  try {
    await env.DB.prepare(
      'INSERT INTO errors (ts, installation_id, app_version, os, country, source, kind, message, stack, fingerprint) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        new Date().toISOString(),
        payload.installation_id,
        payload.app_version,
        payload.os,
        payload.country,
        payload.source,
        payload.kind,
        payload.message,
        payload.stack,
        payload.fingerprint,
      )
      .run();
  } catch (err) {
    console.error('[error_report] D1 insert failed:', err);
    return json({ error: 'db_error' }, 500);
  }

  return json({ ok: true });
}

async function handleStats(env: Env): Promise<Response> {
  const date = todayUTC();

  const [dauRow, scalarRows, dimRows, totalRow] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM daily_dau WHERE date = ?').bind(date).first<{ n: number }>(),
    env.DB.prepare(
      "SELECT dimension, count FROM daily_stats WHERE date = ? AND bucket = '' AND dimension IN ('heartbeats','update_checks')",
    )
      .bind(date)
      .all<{ dimension: string; count: number }>(),
    env.DB.prepare(
      "SELECT dimension, bucket, count FROM daily_stats WHERE date = ? AND dimension IN ('version','os','country')",
    )
      .bind(date)
      .all<{ dimension: string; bucket: string; count: number }>(),
    env.DB.prepare("SELECT value FROM counters WHERE key = 'total_installations'").first<{ value: number }>(),
  ]);

  const scalars: Record<string, number> = {};
  for (const r of scalarRows.results ?? []) scalars[r.dimension] = r.count;

  const versionDist: Record<string, number> = {};
  const osDist: Record<string, number> = {};
  const countryDist: Record<string, number> = {};
  for (const r of dimRows.results ?? []) {
    if (r.dimension === 'version') versionDist[r.bucket] = r.count;
    else if (r.dimension === 'os') osDist[r.bucket] = r.count;
    else if (r.dimension === 'country') countryDist[r.bucket] = r.count;
  }

  return json({
    date,
    daily_active_users: dauRow?.n ?? 0,
    total_heartbeats_today: scalars.heartbeats ?? 0,
    total_update_checks_today: scalars.update_checks ?? 0,
    total_installations: totalRow?.value ?? 0,
    version_distribution: versionDist,
    os_distribution: osDist,
    country_distribution: countryDist,
  });
}

async function handleStatsLive(env: Env): Promise<Response> {
  const byVersion: Record<string, number> = {};
  const byOs: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  let activeNow = 0;
  let cursor: string | undefined;

  do {
    const page: KVNamespaceListResult<LiveMetadata> = await env.KV_BINDING.list<LiveMetadata>({
      prefix: 'live:',
      cursor,
    });
    for (const entry of page.keys) {
      activeNow += 1;
      const meta = entry.metadata;
      if (!meta) continue;
      byVersion[meta.version] = (byVersion[meta.version] ?? 0) + 1;
      byOs[meta.os] = (byOs[meta.os] ?? 0) + 1;
      byCountry[meta.country] = (byCountry[meta.country] ?? 0) + 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json(
    {
      ts: new Date().toISOString(),
      window_seconds: LIVE_TTL_SECONDS,
      active_now: activeNow,
      by_version: byVersion,
      by_os: byOs,
      by_country: byCountry,
    },
    200,
    { 'cache-control': 'public, max-age=5' },
  );
}

async function handleErrorsSummary(url: URL, env: Env): Promise<Response> {
  const days = Math.min(
    Math.max(parseInt(url.searchParams.get('days') ?? '7', 10) || 7, 1),
    ERROR_RETENTION_DAYS,
  );
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 100);
  const since = `-${days} days`;

  const [totals, groupsRes, bySourceRes, byVersionRes, byOsRes, byDayRes] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT installation_id) AS affected_installations, COUNT(DISTINCT fingerprint) AS unique_fingerprints FROM errors WHERE ts >= datetime('now', ?)",
    )
      .bind(since)
      .first<{ total: number; affected_installations: number; unique_fingerprints: number }>(),
    env.DB.prepare(
      "SELECT fingerprint, COUNT(*) AS occurrences, COUNT(DISTINCT installation_id) AS users, " +
        'MAX(ts) AS last_seen, MIN(ts) AS first_seen, ' +
        'MAX(source) AS source, MAX(kind) AS kind, MAX(message) AS message, MAX(stack) AS stack, ' +
        'GROUP_CONCAT(DISTINCT app_version) AS versions ' +
        "FROM errors WHERE ts >= datetime('now', ?) " +
        'GROUP BY fingerprint ORDER BY occurrences DESC LIMIT ?',
    )
      .bind(since, limit)
      .all<{
        fingerprint: string;
        occurrences: number;
        users: number;
        last_seen: string;
        first_seen: string;
        source: string;
        kind: string | null;
        message: string;
        stack: string | null;
        versions: string;
      }>(),
    env.DB.prepare(
      "SELECT source, COUNT(*) AS count FROM errors WHERE ts >= datetime('now', ?) GROUP BY source ORDER BY count DESC",
    )
      .bind(since)
      .all<{ source: string; count: number }>(),
    env.DB.prepare(
      "SELECT app_version AS version, COUNT(*) AS count FROM errors WHERE ts >= datetime('now', ?) GROUP BY app_version ORDER BY count DESC",
    )
      .bind(since)
      .all<{ version: string; count: number }>(),
    env.DB.prepare(
      "SELECT os, COUNT(*) AS count FROM errors WHERE ts >= datetime('now', ?) GROUP BY os ORDER BY count DESC",
    )
      .bind(since)
      .all<{ os: string; count: number }>(),
    env.DB.prepare(
      "SELECT substr(ts, 1, 10) AS date, COUNT(*) AS count FROM errors WHERE ts >= datetime('now', ?) GROUP BY substr(ts, 1, 10) ORDER BY date",
    )
      .bind(since)
      .all<{ date: string; count: number }>(),
  ]);

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    total_errors: totals?.total ?? 0,
    affected_installations: totals?.affected_installations ?? 0,
    unique_fingerprints: totals?.unique_fingerprints ?? 0,
    top_groups: groupsRes.results ?? [],
    by_source: bySourceRes.results ?? [],
    by_version: byVersionRes.results ?? [],
    by_os: byOsRes.results ?? [],
    by_day: byDayRes.results ?? [],
  });
}

async function handleStatsHistory(url: URL, env: Env): Promise<Response> {
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), MAX_HISTORY_DAYS);
  const metric = url.searchParams.get('metric') ?? 'dau';

  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  if (metric === 'dau') {
    const rows = await env.DB.prepare(
      'SELECT date, COUNT(*) AS value FROM daily_dau WHERE date >= ? GROUP BY date ORDER BY date',
    )
      .bind(sinceDate)
      .all<{ date: string; value: number }>();
    return json({ metric: 'dau', days, series: rows.results ?? [] });
  }

  if (metric === 'heartbeats' || metric === 'update_checks') {
    const rows = await env.DB.prepare(
      "SELECT date, count AS value FROM daily_stats WHERE date >= ? AND dimension = ? AND bucket = '' ORDER BY date",
    )
      .bind(sinceDate, metric)
      .all<{ date: string; value: number }>();
    return json({ metric, days, series: rows.results ?? [] });
  }

  if (metric === 'version' || metric === 'os' || metric === 'country') {
    const rows = await env.DB.prepare(
      'SELECT date, bucket, count AS value FROM daily_stats WHERE date >= ? AND dimension = ? ORDER BY date, bucket',
    )
      .bind(sinceDate, metric)
      .all<{ date: string; bucket: string; value: number }>();
    return json({ metric, days, series: rows.results ?? [] });
  }

  return json({ error: 'unknown_metric' }, 400);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await env.DB.prepare("DELETE FROM errors WHERE ts < datetime('now', ?)").bind(`-${ERROR_RETENTION_DAYS} days`).run();
    } catch (err) {
      console.error('[scheduled] error cleanup failed:', err);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/heartbeat') {
        const cloned = request.clone();
        const body = await cloned.json().catch(() => ({})) as HeartbeatBody;
        const denied = await rateLimitIngest(request, env, body.installation_id);
        if (denied) return denied;
        return await handleHeartbeat(request, env, ctx, 'heartbeats');
      }
      if (request.method === 'POST' && url.pathname === '/update_check') {
        const cloned = request.clone();
        const body = await cloned.json().catch(() => ({})) as HeartbeatBody;
        const denied = await rateLimitIngest(request, env, body.installation_id);
        if (denied) return denied;
        return await handleHeartbeat(request, env, ctx, 'update_checks');
      }
      if (request.method === 'POST' && url.pathname === '/error_report') {
        const cloned = request.clone();
        const body = await cloned.json().catch(() => ({})) as ErrorReportBody;
        const denied = await rateLimitIngest(request, env, body.installation_id);
        if (denied) return denied;
        return await handleErrorReport(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/stats') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleStats(env);
      }
      if (request.method === 'GET' && url.pathname === '/stats/live') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleStatsLive(env);
      }
      if (request.method === 'GET' && url.pathname === '/stats/history') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleStatsHistory(url, env);
      }
      if (request.method === 'GET' && url.pathname === '/errors/summary') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleErrorsSummary(url, env);
      }
    } catch (err) {
      console.error('[fetch] unhandled error:', err);
      return json({ error: 'internal_error' }, 500);
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
