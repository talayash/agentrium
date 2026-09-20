/** Atomic D1 admission counters; installation IDs cannot reset these budgets. */
export async function admitIngest(db: D1Database, ip: string, now = Date.now()): Promise<boolean> {
  const window = Math.floor(now / 60000);
  for (const [key, limit] of [['global', 10000], [`ip:${ip}`, 120]] as const) {
    const row = await db.prepare(`INSERT INTO ingest_limits (key, window, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        window = excluded.window,
        count = CASE WHEN ingest_limits.window != excluded.window THEN 1 ELSE ingest_limits.count + 1 END
      WHERE ingest_limits.window != excluded.window OR ingest_limits.count < ?
      RETURNING count`).bind(key, window, limit).first();
    if (!row) return false;
  }
  return true;
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
