/**
 * Pure functions for the /feedback ingest route. Kept out of index.ts so the
 * validation rules can be tested without a Worker environment.
 *
 * Rules mirror src/lib/feedbackForm.ts and src-tauri/src/feedback.rs in the
 * agentrium repo, so the client, the Rust command, and the Worker all agree
 * on what a valid submission looks like.
 */

export const NAME_MAX = 60;
export const MESSAGE_MAX = 2000;
const META_MAX = 32; // matches heartbeat/error_report caps for version + os

export interface RawFeedback {
  name?: unknown;
  message?: unknown;
  honeypot?: unknown;
  app_version?: unknown;
  os?: unknown;
}

export interface NormalizedFeedback {
  name: string;
  message: string;
  app_version: string;
  os: string;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedFeedback }
  | { ok: false; reason: 'spam' | 'invalid' };

function trimmedStringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function metaField(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return 'unknown';
  return s.slice(0, META_MAX);
}

export function normalizeFeedback(raw: RawFeedback): NormalizeResult {
  // Honeypot runs first so a bot filling every field still gets 'spam' rather
  // than a hint about which field to fix. Any non-empty string counts.
  if (typeof raw.honeypot === 'string' && raw.honeypot.length > 0) {
    return { ok: false, reason: 'spam' };
  }
  const name = trimmedStringOrEmpty(raw.name);
  if (!name || [...name].length > NAME_MAX) {
    return { ok: false, reason: 'invalid' };
  }
  const message = trimmedStringOrEmpty(raw.message);
  if (!message || [...message].length > MESSAGE_MAX) {
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    value: {
      name,
      message,
      app_version: metaField(raw.app_version),
      os: metaField(raw.os),
    },
  };
}

/**
 * Hash an IP address with a salt using SHA-256. Used as a stable, non-reversible
 * rate-limit key so we get consistent per-IP throttling without persisting
 * plaintext IPs in KV. First 16 hex chars are enough entropy for a rate-limit
 * bucket while keeping keys short.
 */
/**
 * Salt for IP hashing. Prefer the dedicated IP_HASH_SALT secret so the stats
 * bearer token never doubles as hashing key material; fall back to STATS_TOKEN
 * so rate-limit and feedback buckets stay stable until the secret is set.
 */
export function ipHashSalt(env: { IP_HASH_SALT?: string; STATS_TOKEN?: string }): string {
  return env.IP_HASH_SALT || env.STATS_TOKEN || 'unsalted';
}

export async function hashIP(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * D1 caps bound parameters at 100 per statement. The delete statement binds
 * one timestamp plus one placeholder per id, so 99 ids is the ceiling.
 */
export const DELETE_MAX_IDS = 99;

export interface DeleteRequest {
  ids: number[];
  deleted: boolean;
}

/**
 * Parser for /feedback/delete. Strict about every id, unlike /feedback/mark_read
 * which skips malformed entries: silently dropping one id from a destructive
 * call would act on a different set than the caller asked for. `deleted: false`
 * is the undo path, which is why it is a flag and not a separate route.
 */
export function parseDeleteBody(body: unknown): DeleteRequest | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { ids?: unknown; deleted?: unknown };

  let deleted = true;
  if (raw.deleted !== undefined) {
    if (typeof raw.deleted !== 'boolean') return null;
    deleted = raw.deleted;
  }

  if (!Array.isArray(raw.ids)) return null;
  if (raw.ids.length === 0) return null;
  if (raw.ids.length > DELETE_MAX_IDS) return null;

  const out = new Set<number>();
  for (const v of raw.ids) {
    // Numeric strings are accepted because the list payload carries ids as
    // JSON numbers but the panel round-trips them through dataset attributes.
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    const n = typeof v === 'number' ? v : Number(v.trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    out.add(n);
  }
  return { ids: [...out], deleted };
}
