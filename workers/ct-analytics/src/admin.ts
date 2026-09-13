/**
 * Helpers for the two admin-dashboard routes the website's edge proxies call:
 *   POST /admin/login_attempt  - shared login rate limit (Vercel edge has no shared memory)
 *   POST /stats/match          - how many of these installation ids were active today / now
 * Pure over (kv, db) so they are testable with fakes.
 */

export const LOGIN_LIMIT = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
const MATCH_MAX_IDS = 5000;
const MATCH_ID_MAX_LEN = 128;
const D1_CHUNK = 100;
const KV_PARALLEL = 50;

interface LoginWindow { count: number; reset: number } // reset = epoch ms

export type LoginAttemptResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retry_after_seconds: number };

export async function checkLoginAttempt(kv: KVNamespace, ipHash: string, now = Date.now()): Promise<LoginAttemptResult> {
  const key = `rl:admin_login:${ipHash}`;
  const raw = await kv.get(key);
  let win: LoginWindow | null = null;
  if (raw) {
    try { win = JSON.parse(raw) as LoginWindow; } catch { win = null; }
  }
  if (!win || win.reset <= now) {
    win = { count: 0, reset: now + LOGIN_WINDOW_SECONDS * 1000 };
  }
  if (win.count >= LOGIN_LIMIT) {
    return { allowed: false, retry_after_seconds: Math.max(1, Math.ceil((win.reset - now) / 1000)) };
  }
  win.count += 1;
  // TTL to the window end (KV minimum is 60 s).
  const ttl = Math.max(60, Math.ceil((win.reset - now) / 1000));
  await kv.put(key, JSON.stringify(win), { expirationTtl: ttl });
  return { allowed: true, remaining: LOGIN_LIMIT - win.count };
}

export function parseMatchBody(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { installation_ids?: unknown }).installation_ids;
  if (!Array.isArray(raw) || raw.length > MATCH_MAX_IDS) return null;
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' || v.length === 0 || v.length > MATCH_ID_MAX_LEN) return null;
    out.add(v);
  }
  return [...out];
}

export async function matchInstallations(
  db: D1Database,
  kv: KVNamespace,
  ids: string[],
  date: string,
): Promise<{ active_today: number; active_now: number }> {
  if (ids.length === 0) return { active_today: 0, active_now: 0 };

  let activeToday = 0;
  for (let i = 0; i < ids.length; i += D1_CHUNK) {
    const chunk = ids.slice(i, i + D1_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM daily_dau WHERE date = ? AND installation_id IN (${placeholders})`)
      .bind(date, ...chunk)
      .first<{ n: number }>();
    activeToday += row?.n ?? 0;
  }

  let activeNow = 0;
  for (let i = 0; i < ids.length; i += KV_PARALLEL) {
    const chunk = ids.slice(i, i + KV_PARALLEL);
    const hits = await Promise.all(chunk.map((id) => kv.get(`live:${id}`)));
    activeNow += hits.filter((h) => h !== null).length;
  }

  return { active_today: activeToday, active_now: activeNow };
}
