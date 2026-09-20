import { admitIngest, boundedJson, validDimensions, versionWithinCeiling } from './ingest';
/**
 * Agentrium analytics worker.
 *
 * Storage:
 *   - KV (binding: KV_BINDING)
 *       seen:{installation_id}   TTL=400d,  used to detect first-ever heartbeat
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
 *   POST /errors/resolve         mark fingerprints resolved / un-resolved (token)
 *   POST /feedback/delete        soft-delete / restore inbox messages (token)
 *   POST /admin/login_attempt    admin-dashboard login rate limit (token)
 *   POST /stats/match            count given installation ids active today / now (token)
 */

import { constantTimeEqual, checkLoginAttempt, parseMatchBody, matchInstallations } from './admin';
import { parseResolveBody, isGroupResolved } from './errors';

interface Env {
  KV_BINDING: KVNamespace;
  DB: D1Database;
  /** Bearer token for the admin/stats routes (`wrangler secret put STATS_TOKEN`). */
  STATS_TOKEN: string;
  /**
   * Salt for hashing client IPs in feedback rows and rate-limit keys
   * (`wrangler secret put IP_HASH_SALT`). Optional: when unset the worker
   * falls back to STATS_TOKEN, so setting it rotates every IP-keyed bucket
   * once and thereafter keeps the bearer token out of hashing altogether.
   */
  IP_HASH_SALT?: string;
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
// A `seen:` key is the sole record that an installation was ever observed, so
// it cannot expire while the install is plausibly alive - but without any TTL
// every novel UUID leaves a permanent key, and ingest accepts unauthenticated
// UUIDs at 120/min/IP. 400 days outlives the 365-day history window, so a key
// only lapses well after its install has stopped reporting. The trade is that
// an install running continuously past 400 days is recounted once as new.
const SEEN_TTL_SECONDS = 400 * 24 * 60 * 60;
// daily_dau holds one row per (date, installation_id) and so grows with every
// fabricated UUID. Pruned on the same 400-day horizon as `seen:`, which stays
// clear of MAX_HISTORY_DAYS - no servable chart loses data.
const DAU_RETENTION_DAYS = 400;
// /feedback rate limit: 5 submissions per IP per hour is more than any real user
// will send. Bots that survive the honeypot get squelched here.
const FEEDBACK_RATE_LIMIT_TTL_SECONDS = 60 * 60;
const FEEDBACK_RATE_LIMIT_MAX = 5;

function requireToken(request: Request, expected: string | undefined): Response | null {
  if (!expected) return json({ error: 'server_misconfigured' }, 500);
  const provided = request.headers.get('x-ct-token');
  if (provided === null || !constantTimeEqual(provided, expected)) return json({ error: 'unauthorized' }, 401);
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

/**
 * Reads a JSON body through the same 16 KB bounded reader the ingest routes
 * use, mapping an oversized body to 413 and malformed JSON to 400 so every
 * route reports the two failures identically.
 */
async function readBoundedBody(request: Request): Promise<{ body: unknown } | { response: Response }> {
  try {
    return { body: await boundedJson(request) };
  } catch (err) {
    return {
      response: err instanceof RangeError
        ? json({ error: 'payload_too_large' }, 413)
        : json({ error: 'invalid_json' }, 400),
    };
  }
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
  if (!installation_id || !version || !os || !validDimensions(body.installation_id, body.app_version, body.os)) return null;

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
  if (!ALLOWED_SOURCES.has(source) || !validDimensions(body.installation_id, body.app_version, body.os)) return null;

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
  body: HeartbeatBody,
): Promise<Response> {

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
        { expirationTtl: SEEN_TTL_SECONDS },
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

async function handleErrorReport(request: Request, env: Env, ctx: ExecutionContext, body: ErrorReportBody): Promise<Response> {

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

async function handleFeedbackIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { normalizeFeedback, hashIP, ipHashSalt } = await import('./feedback');

  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const result = normalizeFeedback(body as Parameters<typeof normalizeFeedback>[0]);
  if (!result.ok) {
    // Both 'spam' and 'invalid' return the same generic 400 so a bot can't
    // distinguish "you tripped the honeypot" from "you sent bad data".
    return json({ error: 'rejected' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await hashIP(ip, ipHashSalt(env));

  // Sliding counter: increment, reject when over the cap. Using put with TTL
  // and get gives us a rough hour-window bucket without a heavy counter
  // implementation. Race conditions can let one extra through, which is fine.
  const rateKey = `rl:feedback:${ipHash}`;
  const existing = await env.KV_BINDING.get(rateKey);
  const count = existing ? parseInt(existing, 10) || 0 : 0;
  if (count >= FEEDBACK_RATE_LIMIT_MAX) {
    return json({ error: 'rate_limited' }, 429);
  }
  ctx.waitUntil(
    env.KV_BINDING.put(rateKey, String(count + 1), {
      expirationTtl: FEEDBACK_RATE_LIMIT_TTL_SECONDS,
    }),
  );

  const country =
    typeof (request as Request & { cf?: { country?: string } }).cf?.country === 'string'
      ? ((request as Request & { cf?: { country?: string } }).cf!.country as string).toUpperCase().slice(0, 2)
      : 'XX';

  try {
    await env.DB.prepare(
      'INSERT INTO feedback (ts, name, message, app_version, os, country, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        new Date().toISOString(),
        result.value.name,
        result.value.message,
        result.value.app_version,
        result.value.os,
        country,
        ipHash,
      )
      .run();
  } catch (err) {
    console.error('[feedback] D1 insert failed:', err);
    return json({ error: 'db_error' }, 500);
  }

  return json({ ok: true });
}

async function handleFeedbackList(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const unreadOnly = url.searchParams.get('unread_only') === '1';

  // Soft-deleted rows leave the list and the counters; the text stays in D1
  // so the dashboard's Undo can restore it.
  const whereClause = unreadOnly
    ? 'WHERE deleted_at IS NULL AND read_at IS NULL'
    : 'WHERE deleted_at IS NULL';
  const rows = await env.DB.prepare(
    `SELECT id, ts, name, message, app_version, os, country, read_at FROM feedback ${whereClause} ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: number;
      ts: string;
      name: string;
      message: string;
      app_version: string;
      os: string;
      country: string;
      read_at: string | null;
    }>();

  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM feedback WHERE deleted_at IS NULL',
  ).first<{ total: number; unread: number }>();

  return json({
    total: totals?.total ?? 0,
    unread: totals?.unread ?? 0,
    items: rows.results ?? [],
  });
}

async function handleFeedbackMarkRead(request: Request, env: Env): Promise<Response> {
  const read = await readBoundedBody(request);
  if ('response' in read) return read.response;
  const body = (read.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(body.ids)) return json({ error: 'invalid_payload' }, 400);
  const ids: number[] = [];
  for (const raw of body.ids) {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) ids.push(Math.floor(n));
  }
  if (ids.length === 0) return json({ ok: true, updated: 0 });
  const placeholders = ids.map(() => '?').join(',');
  try {
    const res = await env.DB.prepare(
      `UPDATE feedback SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL AND deleted_at IS NULL`,
    )
      .bind(new Date().toISOString(), ...ids)
      .run();
    return json({ ok: true, updated: res.meta.changes ?? 0 });
  } catch (err) {
    console.error('[feedback] mark_read failed:', err);
    return json({ error: 'db_error' }, 500);
  }
}

async function handleFeedbackDelete(request: Request, env: Env): Promise<Response> {
  const { parseDeleteBody } = await import('./feedback');

  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const parsed = parseDeleteBody(body);
  if (!parsed) return json({ error: 'invalid_payload' }, 400);

  const placeholders = parsed.ids.map(() => '?').join(',');
  try {
    // Soft delete both ways: `deleted: false` clears the stamp, which is what
    // the dashboard's Undo sends. The message text is never removed here.
    const res = await env.DB.prepare(
      `UPDATE feedback SET deleted_at = ? WHERE id IN (${placeholders})`,
    )
      .bind(parsed.deleted ? new Date().toISOString() : null, ...parsed.ids)
      .run();
    return json({ ok: true, deleted: parsed.deleted, updated: res.meta.changes ?? 0 });
  } catch (err) {
    console.error('[feedback] delete failed:', err);
    return json({ error: 'db_error' }, 500);
  }
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

  const [totals, groupsRes, bySourceRes, byVersionRes, byOsRes, byDayRes, unresolvedRow] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT installation_id) AS affected_installations, COUNT(DISTINCT fingerprint) AS unique_fingerprints FROM errors WHERE ts >= datetime('now', ?)",
    )
      .bind(since)
      .first<{ total: number; affected_installations: number; unique_fingerprints: number }>(),
    env.DB.prepare(
      "SELECT e.fingerprint AS fingerprint, COUNT(*) AS occurrences, COUNT(DISTINCT e.installation_id) AS users, " +
        'MAX(e.ts) AS last_seen, MIN(e.ts) AS first_seen, ' +
        'MAX(e.source) AS source, MAX(e.kind) AS kind, MAX(e.message) AS message, MAX(e.stack) AS stack, ' +
        'GROUP_CONCAT(DISTINCT e.app_version) AS versions, ' +
        // Functionally dependent on the GROUP BY key (error_state is keyed by
        // fingerprint), so MAX just satisfies the aggregate rule.
        'MAX(es.resolved_at) AS resolved_at, MAX(es.resolved_version) AS resolved_version ' +
        'FROM errors e LEFT JOIN error_state es ON es.fingerprint = e.fingerprint ' +
        "WHERE e.ts >= datetime('now', ?) " +
        'GROUP BY e.fingerprint ORDER BY occurrences DESC LIMIT ?',
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
        resolved_at: string | null;
        resolved_version: string | null;
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
    // Counted over every group in the window, not just the `limit` returned
    // above, so the tab badge stays right when the top list is truncated.
    // Both timestamps are toISOString() text, so the string compare is exact.
    env.DB.prepare(
      'SELECT COUNT(*) AS n FROM (' +
        'SELECT e.fingerprint, MAX(e.ts) AS last_seen, MAX(es.resolved_at) AS resolved_at ' +
        'FROM errors e LEFT JOIN error_state es ON es.fingerprint = e.fingerprint ' +
        "WHERE e.ts >= datetime('now', ?) GROUP BY e.fingerprint) g " +
        'WHERE g.resolved_at IS NULL OR g.last_seen > g.resolved_at',
    )
      .bind(since)
      .first<{ n: number }>(),
  ]);

  // `resolved` is derived here rather than stored so a recurrence reopens the
  // group on the next read, with no background job to keep in sync.
  const groups = (groupsRes.results ?? []).map((g) => ({
    ...g,
    resolved: isGroupResolved(g.last_seen, g.resolved_at),
  }));

  return json({
    window_days: days,
    generated_at: new Date().toISOString(),
    total_errors: totals?.total ?? 0,
    affected_installations: totals?.affected_installations ?? 0,
    unique_fingerprints: totals?.unique_fingerprints ?? 0,
    unresolved_groups: unresolvedRow?.n ?? 0,
    top_groups: groups,
    by_source: bySourceRes.results ?? [],
    by_version: byVersionRes.results ?? [],
    by_os: byOsRes.results ?? [],
    by_day: byDayRes.results ?? [],
  });
}

async function handleErrorsResolve(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const parsed = parseResolveBody(body);
  if (!parsed) return json({ error: 'invalid_payload' }, 400);

  const now = new Date().toISOString();
  try {
    if (parsed.resolved) {
      // resolved_version is read from the data rather than the request so a
      // client cannot label a group with a version it never occurred on.
      await env.DB.batch(
        parsed.fingerprints.map((fp) =>
          env.DB.prepare(
            'INSERT INTO error_state (fingerprint, resolved_at, resolved_version) ' +
              'VALUES (?, ?, (SELECT app_version FROM errors WHERE fingerprint = ? ORDER BY ts DESC LIMIT 1)) ' +
              'ON CONFLICT(fingerprint) DO UPDATE SET resolved_at = excluded.resolved_at, ' +
              'resolved_version = excluded.resolved_version',
          ).bind(fp, now, fp),
        ),
      );
    } else {
      // Un-resolving removes the row entirely: absence is the unresolved state.
      const placeholders = parsed.fingerprints.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM error_state WHERE fingerprint IN (${placeholders})`)
        .bind(...parsed.fingerprints)
        .run();
    }
  } catch (err) {
    console.error('[errors] resolve failed:', err);
    return json({ error: 'db_error' }, 500);
  }

  return json({ ok: true, resolved: parsed.resolved, count: parsed.fingerprints.length, resolved_at: parsed.resolved ? now : null });
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

async function handleAdminLoginAttempt(request: Request, env: Env): Promise<Response> {
  const { hashIP, ipHashSalt } = await import('./feedback');
  const read = await readBoundedBody(request);
  if ('response' in read) return read.response;
  const body = (read.body ?? {}) as { ip?: unknown };
  const ip = clampString(body.ip, 64);
  if (!ip) return json({ error: 'invalid_payload' }, 400);
  // Same salted hash the feedback route uses; the raw address is never stored.
  const ipHash = await hashIP(ip, ipHashSalt(env));
  return json(await checkLoginAttempt(env.KV_BINDING, ipHash));
}

async function handleStatsMatch(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const ids = parseMatchBody(body);
  if (!ids) return json({ error: 'invalid_payload' }, 400);
  return json(await matchInstallations(env.DB, env.KV_BINDING, ids, todayUTC()));
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await env.DB.prepare('DELETE FROM ingest_limits WHERE window < ?').bind(Math.floor(Date.now() / 60000) - 1440).run();
      await env.DB.prepare("DELETE FROM errors WHERE ts < datetime('now', ?)").bind(`-${ERROR_RETENTION_DAYS} days`).run();
      await env.DB.prepare("DELETE FROM daily_dau WHERE date < date('now', ?)").bind(`-${DAU_RETENTION_DAYS} days`).run();
      // Retention drops the errors themselves, so resolution rows whose
      // fingerprint no longer occurs anywhere would linger forever.
      await env.DB.prepare(
        'DELETE FROM error_state WHERE fingerprint NOT IN (SELECT DISTINCT fingerprint FROM errors)',
      ).run();
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
      if (request.method === 'POST' && ['/heartbeat', '/update_check', '/error_report', '/feedback'].includes(url.pathname)) {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        // Admission precedes parsing and all attacker-controlled persistent keys.
        if (!await admitIngest(env.DB, ip)) return json({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
        if (url.pathname === '/feedback') return await handleFeedbackIngest(request, env, ctx);
        let body: HeartbeatBody & ErrorReportBody;
        try {
          body = await boundedJson(request) as HeartbeatBody & ErrorReportBody;
          if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_payload' }, 400);
        } catch (err) {
          return json({ error: err instanceof RangeError ? 'payload_too_large' : 'invalid_json' }, err instanceof RangeError ? 413 : 400);
        }
        if (!validDimensions(body.installation_id, body.app_version, body.os)) return json({ error: 'invalid_payload' }, 400);
        // Format-valid but implausible versions are refused before they can
        // become a daily_stats bucket. Distinct code: a real release tripping
        // this means MAX_APP_VERSION needs raising, not that the client is bad.
        if (!versionWithinCeiling(body.app_version)) return json({ error: 'version_out_of_range' }, 400);
        const denied = await rateLimitIngest(request, env, body.installation_id);
        if (denied) return denied;
        if (url.pathname === '/error_report') return await handleErrorReport(request, env, ctx, body);
        return await handleHeartbeat(request, env, ctx, url.pathname === '/heartbeat' ? 'heartbeats' : 'update_checks', body);
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
      if (request.method === 'GET' && url.pathname === '/feedback/list') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleFeedbackList(url, env);
      }
      if (request.method === 'POST' && url.pathname === '/feedback/mark_read') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleFeedbackMarkRead(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/feedback/delete') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleFeedbackDelete(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/errors/resolve') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleErrorsResolve(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/admin/login_attempt') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleAdminLoginAttempt(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/stats/match') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleStatsMatch(request, env);
      }
    } catch (err) {
      console.error('[fetch] unhandled error:', err);
      return json({ error: 'internal_error' }, 500);
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
