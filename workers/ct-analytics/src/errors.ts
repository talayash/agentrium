/**
 * Pure helpers for the error-resolution routes. Kept out of index.ts so the
 * request parsing and the reopen rule can be tested without a Worker
 * environment, matching how admin.ts and feedback.ts are split.
 *
 * Resolution model: resolving a fingerprint stamps error_state.resolved_at.
 * A group counts as resolved only while no occurrence is newer than that
 * stamp, so an error that keeps happening reopens itself with no cron job
 * and no state to reconcile - the join re-decides it on every read.
 */

// /error_report clamps fingerprint to 16 chars before insert, so a longer
// value can never match a stored row.
export const FINGERPRINT_MAX = 16;
// One D1 statement per fingerprint, batched. The cap keeps a single request
// from turning into an unbounded batch.
export const RESOLVE_MAX_FINGERPRINTS = 50;

export interface ResolveRequest {
  fingerprints: string[];
  resolved: boolean;
}

export function parseResolveBody(body: unknown): ResolveRequest | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as { fingerprints?: unknown; resolved?: unknown };

  // Absent means resolve: that is the dashboard's common action, and a typo in
  // the flag name must not silently un-resolve a group.
  let resolved = true;
  if (raw.resolved !== undefined) {
    if (typeof raw.resolved !== 'boolean') return null;
    resolved = raw.resolved;
  }

  if (!Array.isArray(raw.fingerprints)) return null;
  if (raw.fingerprints.length === 0) return null;
  if (raw.fingerprints.length > RESOLVE_MAX_FINGERPRINTS) return null;

  const out = new Set<string>();
  for (const v of raw.fingerprints) {
    if (typeof v !== 'string' || v.length === 0 || v.length > FINGERPRINT_MAX) return null;
    out.add(v);
  }
  return { fingerprints: [...out], resolved };
}

/**
 * SQLite `datetime()` text ("YYYY-MM-DD HH:MM:SS", UTC, no zone) is read by
 * Date.parse as local time. Normalise to an explicit UTC instant first, the
 * same way the dashboard's errors panel does.
 */
function parseUtc(ts: string | null | undefined): number {
  const s = String(ts ?? '').trim();
  if (!s) return NaN;
  const explicit = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(explicit);
}

/**
 * True while the group should stay quiet. Anything unparsable or missing
 * falls to false so a bad timestamp surfaces the group rather than hiding it.
 */
export function isGroupResolved(lastSeen: string | null, resolvedAt: string | null): boolean {
  if (!resolvedAt) return false;
  const seen = parseUtc(lastSeen);
  const resolved = parseUtc(resolvedAt);
  if (Number.isNaN(seen) || Number.isNaN(resolved)) return false;
  return seen <= resolved;
}
