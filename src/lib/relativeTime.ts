// Compact relative-age labels for notification banners - the macOS
// Notification Center vocabulary ("now", "2m", "1h", "3d"), not a full
// "2 minutes ago" phrase. Deliberately coarse: a banner's timestamp answers
// "is this still current?", never "exactly when?".

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Format an age in milliseconds. Negative ages (a clock that jumped
 *  backwards, or a toast created a tick into the future) clamp to "now". */
export function formatRelativeTime(ageMs: number): string {
  const age = Math.max(0, ageMs);
  if (age < 45_000) return 'now';

  const minutes = Math.round(age / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(age / HOUR_MS);
  if (hours < 24) return `${hours}h`;

  return `${Math.round(age / DAY_MS)}d`;
}
