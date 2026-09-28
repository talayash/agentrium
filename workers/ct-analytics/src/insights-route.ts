/**
 * Route wiring for `GET /stats/insights` (spec [03] 3.1). Kept out of
 * index.ts so the growing insights surface doesn't bloat the main dispatch
 * file; the pure aggregate math itself lives in insights.ts. `json` /
 * `todayUTC` come from the shared, one-way `./http` module rather than from
 * index.ts, so this file never imports back into the file that imports it.
 *
 * Cache: the full payload is cached under `insights:v1:<days>` for 15
 * minutes (900s) - it's cheap to recompute but not free, and the dashboard
 * polls it. Retention cohorts are range-independent (same 12 cohorts
 * regardless of `days`) and the most expensive query, so they get their own
 * `insights:v1:cohorts` key with a longer, 1-hour TTL, shared across every
 * `days` value instead of being recomputed - and re-cached - on every miss.
 */

import { json, todayUTC } from './http';
import { computeActivity, computeErrors, computeReleases, computeRetention, type InsightsPayload } from './insights';

const PAYLOAD_CACHE_TTL_SECONDS = 900;
const COHORTS_CACHE_TTL_SECONDS = 3600;
const COHORTS_CACHE_KEY = 'insights:v1:cohorts';

const MIN_INSIGHT_DAYS = 7;
const MAX_INSIGHT_DAYS = 90;
const DEFAULT_INSIGHT_DAYS = 30;

interface InsightsEnv {
  DB: D1Database;
  KV_BINDING: KVNamespace;
}

/**
 * Clamps the `days` query param to 7..90, defaulting to 30 for anything
 * absent, non-numeric, or non-integer (so `days=30.5` never silently floors
 * to a slightly-off window - it falls back to the documented default).
 */
export function clampInsightDays(raw: string | null): number {
  if (raw === null) return DEFAULT_INSIGHT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_INSIGHT_DAYS;
  return Math.min(Math.max(n, MIN_INSIGHT_DAYS), MAX_INSIGHT_DAYS);
}

/** `Date#toISOString` truncated to whole seconds, matching spec [03] 3.1's example. */
function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function getCached<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return (await kv.get(key, 'json')) as T | null;
  } catch (err) {
    console.error('[insights] KV read failed:', err);
    return null;
  }
}

async function putCached(kv: KVNamespace, key: string, value: unknown, expirationTtl: number): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl });
  } catch (err) {
    console.error('[insights] KV write failed:', err);
  }
}

export async function handleInsights(url: URL, env: InsightsEnv): Promise<Response> {
  const days = clampInsightDays(url.searchParams.get('days'));
  const payloadKey = `insights:v1:${days}`;

  const cachedPayload = await getCached<InsightsPayload>(env.KV_BINDING, payloadKey);
  if (cachedPayload) return json(cachedPayload);

  try {
    const today = todayUTC();
    const cachedRetention = await getCached<InsightsPayload['retention']>(env.KV_BINDING, COHORTS_CACHE_KEY);

    const [activity, releases, errors, retention] = await Promise.all([
      computeActivity(env.DB, days, today),
      computeReleases(env.DB, days, today),
      computeErrors(env.DB, days, today),
      cachedRetention ?? computeRetention(env.DB, today),
    ]);

    if (!cachedRetention) {
      await putCached(env.KV_BINDING, COHORTS_CACHE_KEY, retention, COHORTS_CACHE_TTL_SECONDS);
    }

    const payload: InsightsPayload = {
      days,
      generated_at: nowISO(),
      activity,
      retention,
      releases,
      errors,
    };

    await putCached(env.KV_BINDING, payloadKey, payload, PAYLOAD_CACHE_TTL_SECONDS);

    return json(payload);
  } catch (err) {
    console.error('[insights] failed:', err);
    return json({ error: 'insights_failed' }, 500);
  }
}
