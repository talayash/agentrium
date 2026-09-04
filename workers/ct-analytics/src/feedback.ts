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
