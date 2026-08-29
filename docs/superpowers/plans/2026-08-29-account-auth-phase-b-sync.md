# Account Auth Phase B - Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on cross-device sync. When a user signs in, their profiles, workspaces, snippets, session_history, session_summaries, and sync-safe settings converge across devices via debounced push + cursor pull. Session log bodies upload to R2 via presigned URLs. On first login on a device with local data, a merge modal offers Merge/Replace/Push.

**Architecture:** Every local mutation is wrapped in an enqueue that writes to `sync_queue` in the same SQLite transaction as the mutation. A debounced pusher (in a Tokio background task) drains the queue in batches of up to 500 rows / 512 KB and calls `POST /sync/push`. A full pull runs on startup, on window focus (throttled), and on manual "Sync now" - it uses `user_meta.last_pull_cursor` and applies rows and tombstones. Log upload is triggered by the existing `terminal-finished` event: client gzips the log, requests a presigned R2 PUT URL from the Worker, PUTs directly to R2, then upserts the `log_r2_key` metadata through the normal push path.

**Tech Stack:**
- Existing Phase A stack plus R2 binding on the Worker (`R2_LOGS`), Rust `flate2` for gzip, existing `tokio` for the pusher task.
- Miniflare pool for Worker tests, `#[cfg(test)]` + `tempfile` for Rust tests, Vitest + `@testing-library/react` for React tests.

**Prerequisites (external, do these before Task 1):**

1. In Cloudflare dashboard: create an R2 bucket named `agentrium-logs`. Give it a lifecycle rule to delete objects after 60 days (belt and suspenders alongside our cron).
2. Add R2 binding to `workers/ct-analytics/wrangler.toml`:
   ```toml
   [[r2_buckets]]
   binding = "R2_LOGS"
   bucket_name = "agentrium-logs"
   ```
3. Keep `SYNC_ENABLED = "false"` during Phase B rollout; flip to `"true"` after client v1.34.0 has had 24h to propagate via auto-updater.

**File structure created / modified by this plan:**

*Cloudflare Worker (new):* schema types, per-user rate limiter, `/sync/push`, `/sync/pull`, presigned log URL endpoints, `require_session` helper.

*Cloudflare Worker (modified):* index routes, `handlers.ts` refactored to use `require_session`, `wrangler.toml` gains R2 binding.

*Rust (new):* `sync/mod.rs`, `sync/queue.rs`, `sync/payload.rs`, `sync/pusher.rs`, `sync/puller.rs`, `sync/merge.rs`, `sync/log_upload.rs`, `sync/status.rs`, `sync/commands.rs`.

*Rust (modified):* `database.rs` wraps writes in enqueue and tombstone helpers, `terminal.rs` triggers log upload on session finish, `main.rs` spawns the pusher and registers commands.

*TypeScript / React (new):* `lib/settingsBlob.ts`, `components/auth/MergeModal.tsx`, `components/auth/SyncStatusDot.tsx`.

*TypeScript / React (modified):* `store/appStore.ts` subscribes to sync-safe key changes, `components/auth/UserMenu.tsx` shows status dot and Sync-now button, `App.tsx` mounts merge modal and pulls on focus.

*Release:* Version bump to 1.34.0.

---

## Task 1: D1 sync schema migration

**Files:**
- Create: `workers/ct-analytics/migrations/0002_sync.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0002_sync.sql
-- Per-user sync tables. Shape mirrors local SQLite so payloads can be
-- upserted row-for-row. deleted_at is a tombstone; presence means "row exists
-- for tombstone visibility until GC" and blocks resurrection on stale pushes.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  working_directory TEXT NOT NULL,
  claude_args TEXT NOT NULL,
  env_vars TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  preview_json TEXT,
  agent TEXT NOT NULL,
  agent_args_json TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, profile_id)
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_updated ON user_profiles(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  terminals_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, workspace_name)
);
CREATE INDEX IF NOT EXISTS idx_user_workspaces_updated ON user_workspaces(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_snippets (
  user_id TEXT NOT NULL,
  snippet_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, snippet_id)
);
CREATE INDEX IF NOT EXISTS idx_user_snippets_updated ON user_snippets(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_session_summaries (
  user_id TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, terminal_id)
);
CREATE INDEX IF NOT EXISTS idx_user_session_summaries_updated ON user_session_summaries(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_session_history (
  user_id TEXT NOT NULL,
  history_uuid TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  agent TEXT NOT NULL,
  origin_installation_id TEXT NOT NULL,
  origin_working_directory TEXT,
  claude_session_id TEXT,
  log_r2_key TEXT,
  log_size_bytes INTEGER,
  log_uploaded_at TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, history_uuid)
);
CREATE INDEX IF NOT EXISTS idx_user_session_history_updated ON user_session_history(user_id, updated_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: Apply**

```bash
cd workers/ct-analytics
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote
```

Expected: `Migrations applied: 0002_sync.sql` on both.

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/migrations/0002_sync.sql
git commit -m "feat(worker): D1 sync tables (profiles, workspaces, snippets, history, summaries, settings)"
```

---

## Task 2: Extract `requireSession` helper from `handlers.ts`

**Files:**
- Modify: `workers/ct-analytics/src/auth/handlers.ts`
- Create: `workers/ct-analytics/src/auth/require_session.ts`

- [ ] **Step 1: Extract the helper**

Move the "extract token, look up session, return user_id" pattern into its own module. Content of `require_session.ts`:

```typescript
// workers/ct-analytics/src/auth/require_session.ts
import type { D1Database } from '@cloudflare/workers-types';
import { lookupSession } from './sessions';

interface Env { DB: D1Database; }

export interface RequiredSession {
  user_id: string;
  installation_id: string;
  origin: string;
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get('Authorization');
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7);
}

function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v ?? null;
  }
  return null;
}

export async function requireSession(req: Request, env: Env): Promise<RequiredSession | Response> {
  const token = extractBearer(req) ?? extractCookie(req, 'ct_session');
  if (!token) {
    return new Response(JSON.stringify({ error: 'no_session' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  const session = await lookupSession(env.DB, token);
  if (!session) {
    return new Response(JSON.stringify({ error: 'session_expired' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  return session;
}
```

Replace the inline token-extraction in `handlers.ts` with:

```typescript
import { requireSession } from './require_session';

export async function handleMe(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;
  const session = await requireSession(req, env);
  if (session instanceof Response) return session;
  // ... existing body from session.user_id downward
}
// Same shape for handleLogout, handleAccountDelete, handleAccountRestore.
```

- [ ] **Step 2: Existing tests still pass**

```bash
cd workers/ct-analytics && npx vitest run src/auth/
```

Expected: PASS (existing handler tests still green).

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/src/auth/require_session.ts workers/ct-analytics/src/auth/handlers.ts
git commit -m "refactor(worker): extract requireSession helper for reuse across sync routes"
```

---

## Task 3: Per-user rate limiter (KV)

**Files:**
- Create: `workers/ct-analytics/src/sync/rate_limit.ts`
- Test: `workers/ct-analytics/src/sync/__tests__/rate_limit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/sync/__tests__/rate_limit.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit } from '../rate_limit';

beforeEach(async () => {
  const list = await env.KV_BINDING.list({ prefix: 'rl:' });
  for (const k of list.keys) await env.KV_BINDING.delete(k.name);
});

describe('checkRateLimit', () => {
  it('allows the first N requests within the window', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimit(env.KV_BINDING, 'user_01H', 'push', 3, 60);
      expect(r.allowed).toBe(true);
    }
  });

  it('rejects after the cap and returns retry_after_seconds', async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(env.KV_BINDING, 'user_01H', 'push', 3, 60);
    const r = await checkRateLimit(env.KV_BINDING, 'user_01H', 'push', 3, 60);
    expect(r.allowed).toBe(false);
    expect(r.retry_after_seconds).toBeGreaterThan(0);
  });

  it('isolates users', async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(env.KV_BINDING, 'user_A', 'push', 3, 60);
    const r = await checkRateLimit(env.KV_BINDING, 'user_B', 'push', 3, 60);
    expect(r.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/sync/rate_limit.ts
import type { KVNamespace } from '@cloudflare/workers-types';

export interface RateLimitResult {
  allowed: boolean;
  retry_after_seconds: number;
}

// Simple fixed-window counter. Cheap; adequate for per-user API guarding.
// Window granularity is `window_seconds`; cap is `max` requests per window.
export async function checkRateLimit(
  kv: KVNamespace,
  user_id: string,
  route: string,
  max: number,
  window_seconds: number,
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / window_seconds);
  const key = `rl:${user_id}:${route}:${bucket}`;
  const current = await kv.get(key);
  const count = current ? Number.parseInt(current, 10) : 0;
  if (count >= max) {
    const nextBucketAt = (bucket + 1) * window_seconds;
    return { allowed: false, retry_after_seconds: Math.max(1, nextBucketAt - nowSec) };
  }
  await kv.put(key, String(count + 1), { expirationTtl: window_seconds * 2 });
  return { allowed: true, retry_after_seconds: 0 };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/sync/__tests__/rate_limit.test.ts
```

Expected: PASS 3.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/sync/rate_limit.ts workers/ct-analytics/src/sync/__tests__/rate_limit.test.ts
git commit -m "feat(worker): per-user KV rate limiter"
```

---

## Task 4: Shared sync schema types

**Files:**
- Create: `workers/ct-analytics/src/sync/schema.ts`

- [ ] **Step 1: Write the types**

```typescript
// workers/ct-analytics/src/sync/schema.ts
// Wire payload shapes. Client and Worker must agree; kept minimal on purpose.

export interface SyncProfile {
  profile_id: string;
  name: string;
  description: string | null;
  working_directory: string;
  claude_args: string;     // JSON as text
  env_vars: string;        // JSON as text
  is_default: 0 | 1;
  preview_json: string | null;
  agent: string;
  agent_args_json: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncWorkspace {
  workspace_name: string;
  terminals_json: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncSnippet {
  snippet_id: string;
  title: string;
  content: string;
  category: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncSessionSummary {
  terminal_id: string;
  summary: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncSessionHistory {
  history_uuid: string;
  terminal_id: string;
  label: string;
  started_at: string;
  ended_at: string | null;
  agent: string;
  origin_installation_id: string;
  origin_working_directory: string | null;
  claude_session_id: string | null;
  log_r2_key: string | null;
  log_size_bytes: number | null;
  log_uploaded_at: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncSettings {
  settings_json: string;
  updated_at: string;
}

export interface PushRequest {
  profiles?: SyncProfile[];
  workspaces?: SyncWorkspace[];
  snippets?: SyncSnippet[];
  session_summaries?: SyncSessionSummary[];
  session_history?: SyncSessionHistory[];
  settings?: SyncSettings;
}

export interface PushResponse {
  accepted: Record<string, string[]>;      // table_name -> primary keys accepted
  skipped:  Record<string, string[]>;      // table_name -> primary keys with older updated_at
}

export interface PullRequest {
  cursor: string | null;   // ISO8601, null = full sync
}

export interface PullResponse {
  rows: {
    profiles: SyncProfile[];
    workspaces: SyncWorkspace[];
    snippets: SyncSnippet[];
    session_summaries: SyncSessionSummary[];
    session_history: SyncSessionHistory[];
    settings: SyncSettings | null;
  };
  next_cursor: string;    // Server "now" ISO8601; client stores for next call.
}

export const MAX_PUSH_BATCH_ROWS = 500;
export const MAX_PUSH_BATCH_BYTES = 512 * 1024;
export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
```

- [ ] **Step 2: Commit**

```bash
git add workers/ct-analytics/src/sync/schema.ts
git commit -m "feat(worker): sync push/pull payload types"
```

---

## Task 5: `POST /sync/push` handler

**Files:**
- Create: `workers/ct-analytics/src/sync/push.ts`
- Test: `workers/ct-analytics/src/sync/__tests__/push.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/sync/__tests__/push.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleSyncPush } from '../push';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function authedRequest(body: unknown, token: string): Promise<Request> {
  return new Request('https://x/sync/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedUserAndSession(): Promise<{ user_id: string; token: string }> {
  const user_id = 'user_A';
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(user_id, 'a@x.com', 'google', now, now).run();
  const token = generateSessionToken();
  await createSession(env.DB, token, {
    user_id, installation_id: 'install-A', origin: 'desktop',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return { user_id, token };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM user_profiles').run();
  await env.DB.prepare('DELETE FROM user_settings').run();
});

describe('handleSyncPush', () => {
  it('rejects with 503 when SYNC_ENABLED is false', async () => {
    const { token } = await seedUserAndSession();
    const res = await handleSyncPush(
      await authedRequest({}, token),
      { ...env, SYNC_ENABLED: 'false' } as any,
    );
    expect(res.status).toBe(503);
  });

  it('rejects with 401 without a valid token', async () => {
    const req = new Request('https://x/sync/push', { method: 'POST', body: '{}' });
    const res = await handleSyncPush(req, env);
    expect(res.status).toBe(401);
  });

  it('inserts a new profile', async () => {
    const { user_id, token } = await seedUserAndSession();
    const now = new Date().toISOString();
    const res = await handleSyncPush(await authedRequest({
      profiles: [{
        profile_id: 'p1', name: 'default', description: null,
        working_directory: 'C:\\work', claude_args: '[]', env_vars: '{}',
        is_default: 1, preview_json: null, agent: 'claude', agent_args_json: null,
        updated_at: now, deleted_at: null,
      }],
    }, token), env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.accepted.profiles).toEqual(['p1']);

    const row = await env.DB.prepare('SELECT name FROM user_profiles WHERE user_id = ? AND profile_id = ?')
      .bind(user_id, 'p1').first();
    expect((row as any).name).toBe('default');
  });

  it('skips a row with an older updated_at', async () => {
    const { user_id, token } = await seedUserAndSession();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60000).toISOString();
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, working_directory,
         claude_args, env_vars, is_default, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user_id, 'p1', 'newer-name', 'x', '[]', '{}', 0, 'claude', newer).run();

    const res = await handleSyncPush(await authedRequest({
      profiles: [{
        profile_id: 'p1', name: 'older-name', description: null,
        working_directory: 'x', claude_args: '[]', env_vars: '{}',
        is_default: 0, preview_json: null, agent: 'claude', agent_args_json: null,
        updated_at: older, deleted_at: null,
      }],
    }, token), env);

    const json: any = await res.json();
    expect(json.skipped.profiles).toEqual(['p1']);
    const row = await env.DB.prepare('SELECT name FROM user_profiles WHERE profile_id = ?').bind('p1').first();
    expect((row as any).name).toBe('newer-name');
  });

  it('caps settings blob at 64 KB', async () => {
    const { token } = await seedUserAndSession();
    const huge = 'x'.repeat(70000);
    const res = await handleSyncPush(await authedRequest({
      settings: { settings_json: huge, updated_at: new Date().toISOString() },
    }, token), env);
    expect(res.status).toBe(413);
  });

  it('returns 429 when rate limited', async () => {
    const { user_id, token } = await seedUserAndSession();
    const window = Math.floor(Date.now() / 60000);
    await env.KV_BINDING.put(`rl:${user_id}:push:${window}`, '999', { expirationTtl: 120 });
    const res = await handleSyncPush(await authedRequest({}, token), env);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/sync/push.ts
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { requireSyncEnabled } from '../auth/killswitch';
import { requireSession } from '../auth/require_session';
import { checkRateLimit } from './rate_limit';
import {
  type PushRequest, type PushResponse, MAX_SETTINGS_BYTES, MAX_PUSH_BATCH_ROWS, MAX_PUSH_BATCH_BYTES,
} from './schema';

interface Env {
  DB: D1Database;
  KV_BINDING: KVNamespace;
  SYNC_ENABLED?: string;
}

const PUSH_RATE_MAX = 60;
const PUSH_RATE_WINDOW = 60;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export async function handleSyncPush(req: Request, env: Env): Promise<Response> {
  const gate = requireSyncEnabled(env);
  if (gate) return gate;

  const session = await requireSession(req, env);
  if (session instanceof Response) return session;

  const rate = await checkRateLimit(env.KV_BINDING, session.user_id, 'push', PUSH_RATE_MAX, PUSH_RATE_WINDOW);
  if (!rate.allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retry_after_seconds) });

  let body: PushRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }

  // Cheap size guardrails BEFORE hitting D1.
  const totalRows =
    (body.profiles?.length ?? 0) +
    (body.workspaces?.length ?? 0) +
    (body.snippets?.length ?? 0) +
    (body.session_summaries?.length ?? 0) +
    (body.session_history?.length ?? 0);
  if (totalRows > MAX_PUSH_BATCH_ROWS) return json({ error: 'too_many_rows', max: MAX_PUSH_BATCH_ROWS }, 413);
  const approxBytes = JSON.stringify(body).length;
  if (approxBytes > MAX_PUSH_BATCH_BYTES) return json({ error: 'batch_too_large' }, 413);
  if (body.settings && body.settings.settings_json.length > MAX_SETTINGS_BYTES) {
    return json({ error: 'settings_too_large' }, 413);
  }

  const accepted: PushResponse['accepted'] = {};
  const skipped:  PushResponse['skipped']  = {};

  await upsertProfiles(env.DB, session.user_id, body.profiles ?? [], accepted, skipped);
  await upsertWorkspaces(env.DB, session.user_id, body.workspaces ?? [], accepted, skipped);
  await upsertSnippets(env.DB, session.user_id, body.snippets ?? [], accepted, skipped);
  await upsertSessionSummaries(env.DB, session.user_id, body.session_summaries ?? [], accepted, skipped);
  await upsertSessionHistory(env.DB, session.user_id, body.session_history ?? [], accepted, skipped);

  if (body.settings) {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, settings_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE
          SET settings_json = CASE WHEN user_settings.updated_at < excluded.updated_at THEN excluded.settings_json ELSE user_settings.settings_json END,
              updated_at   = CASE WHEN user_settings.updated_at < excluded.updated_at THEN excluded.updated_at   ELSE user_settings.updated_at   END`,
    ).bind(session.user_id, body.settings.settings_json, body.settings.updated_at).run();
  }

  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE user_id = ?')
    .bind(new Date().toISOString(), session.user_id).run();

  return json({ accepted, skipped } as PushResponse);
}

async function upsertProfiles(db: D1Database, user_id: string, rows: any, acc: any, skp: any) {
  acc.profiles ||= []; skp.profiles ||= [];
  for (const r of rows ?? []) {
    const existing = await db
      .prepare('SELECT updated_at FROM user_profiles WHERE user_id = ? AND profile_id = ?')
      .bind(user_id, r.profile_id).first<{ updated_at: string }>();
    if (existing && existing.updated_at >= r.updated_at) { skp.profiles.push(r.profile_id); continue; }
    await db.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, description, working_directory,
         claude_args, env_vars, is_default, preview_json, agent, agent_args_json,
         updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, profile_id) DO UPDATE
          SET name = excluded.name, description = excluded.description,
              working_directory = excluded.working_directory,
              claude_args = excluded.claude_args, env_vars = excluded.env_vars,
              is_default = excluded.is_default, preview_json = excluded.preview_json,
              agent = excluded.agent, agent_args_json = excluded.agent_args_json,
              updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    ).bind(
      user_id, r.profile_id, r.name, r.description, r.working_directory,
      r.claude_args, r.env_vars, r.is_default, r.preview_json, r.agent, r.agent_args_json,
      r.updated_at, r.deleted_at,
    ).run();
    acc.profiles.push(r.profile_id);
  }
}

async function upsertWorkspaces(db: D1Database, user_id: string, rows: any, acc: any, skp: any) {
  acc.workspaces ||= []; skp.workspaces ||= [];
  for (const r of rows ?? []) {
    const existing = await db.prepare('SELECT updated_at FROM user_workspaces WHERE user_id = ? AND workspace_name = ?')
      .bind(user_id, r.workspace_name).first<{ updated_at: string }>();
    if (existing && existing.updated_at >= r.updated_at) { skp.workspaces.push(r.workspace_name); continue; }
    await db.prepare(
      `INSERT INTO user_workspaces (user_id, workspace_name, terminals_json, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workspace_name) DO UPDATE
          SET terminals_json = excluded.terminals_json,
              updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    ).bind(user_id, r.workspace_name, r.terminals_json, r.updated_at, r.deleted_at).run();
    acc.workspaces.push(r.workspace_name);
  }
}

async function upsertSnippets(db: D1Database, user_id: string, rows: any, acc: any, skp: any) {
  acc.snippets ||= []; skp.snippets ||= [];
  for (const r of rows ?? []) {
    const existing = await db.prepare('SELECT updated_at FROM user_snippets WHERE user_id = ? AND snippet_id = ?')
      .bind(user_id, r.snippet_id).first<{ updated_at: string }>();
    if (existing && existing.updated_at >= r.updated_at) { skp.snippets.push(r.snippet_id); continue; }
    await db.prepare(
      `INSERT INTO user_snippets (user_id, snippet_id, title, content, category, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, snippet_id) DO UPDATE
          SET title = excluded.title, content = excluded.content, category = excluded.category,
              updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    ).bind(user_id, r.snippet_id, r.title, r.content, r.category, r.created_at, r.updated_at, r.deleted_at).run();
    acc.snippets.push(r.snippet_id);
  }
}

async function upsertSessionSummaries(db: D1Database, user_id: string, rows: any, acc: any, skp: any) {
  acc.session_summaries ||= []; skp.session_summaries ||= [];
  for (const r of rows ?? []) {
    const existing = await db.prepare('SELECT updated_at FROM user_session_summaries WHERE user_id = ? AND terminal_id = ?')
      .bind(user_id, r.terminal_id).first<{ updated_at: string }>();
    if (existing && existing.updated_at >= r.updated_at) { skp.session_summaries.push(r.terminal_id); continue; }
    await db.prepare(
      `INSERT INTO user_session_summaries (user_id, terminal_id, summary, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, terminal_id) DO UPDATE
          SET summary = excluded.summary, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    ).bind(user_id, r.terminal_id, r.summary, r.updated_at, r.deleted_at).run();
    acc.session_summaries.push(r.terminal_id);
  }
}

async function upsertSessionHistory(db: D1Database, user_id: string, rows: any, acc: any, skp: any) {
  acc.session_history ||= []; skp.session_history ||= [];
  for (const r of rows ?? []) {
    const existing = await db.prepare('SELECT updated_at FROM user_session_history WHERE user_id = ? AND history_uuid = ?')
      .bind(user_id, r.history_uuid).first<{ updated_at: string }>();
    if (existing && existing.updated_at >= r.updated_at) { skp.session_history.push(r.history_uuid); continue; }
    await db.prepare(
      `INSERT INTO user_session_history (user_id, history_uuid, terminal_id, label, started_at, ended_at,
         agent, origin_installation_id, origin_working_directory, claude_session_id,
         log_r2_key, log_size_bytes, log_uploaded_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, history_uuid) DO UPDATE
          SET label = excluded.label, ended_at = excluded.ended_at,
              log_r2_key = excluded.log_r2_key, log_size_bytes = excluded.log_size_bytes,
              log_uploaded_at = excluded.log_uploaded_at,
              updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
    ).bind(
      user_id, r.history_uuid, r.terminal_id, r.label, r.started_at, r.ended_at,
      r.agent, r.origin_installation_id, r.origin_working_directory, r.claude_session_id,
      r.log_r2_key, r.log_size_bytes, r.log_uploaded_at, r.updated_at, r.deleted_at,
    ).run();
    acc.session_history.push(r.history_uuid);
  }
}
```

- [ ] **Step 3: Verify tests pass**

```bash
npx vitest run src/sync/__tests__/push.test.ts
```

Expected: PASS all 6.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/sync/push.ts workers/ct-analytics/src/sync/__tests__/push.test.ts
git commit -m "feat(worker): /sync/push with last-write-wins + rate limit + size caps"
```

---

## Task 6: `POST /sync/pull` handler

**Files:**
- Create: `workers/ct-analytics/src/sync/pull.ts`
- Test: `workers/ct-analytics/src/sync/__tests__/pull.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/sync/__tests__/pull.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleSyncPull } from '../pull';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seed() {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user_A', 'a@x.com', 'google', now, now).run();
  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_A', installation_id: 'i', origin: 'desktop',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

async function req(body: unknown, token: string): Promise<Request> {
  return new Request('https://x/sync/pull', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM user_profiles').run();
  await env.DB.prepare('DELETE FROM user_settings').run();
});

describe('handleSyncPull', () => {
  it('returns everything when cursor is null', async () => {
    const t = await seed();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, working_directory,
         claude_args, env_vars, is_default, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('user_A', 'p1', 'default', 'x', '[]', '{}', 0, 'claude', now).run();

    const res = await handleSyncPull(await req({ cursor: null }, t), env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.rows.profiles.length).toBe(1);
    expect(json.rows.settings).toBeNull();
    expect(json.next_cursor).toBeDefined();
  });

  it('returns only rows newer than cursor', async () => {
    const t = await seed();
    const old = new Date(Date.now() - 60000).toISOString();
    const newer = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, working_directory,
         claude_args, env_vars, is_default, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('user_A', 'p_old', 'x', 'x', '[]', '{}', 0, 'claude', old).run();
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, working_directory,
         claude_args, env_vars, is_default, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('user_A', 'p_new', 'y', 'x', '[]', '{}', 0, 'claude', newer).run();

    const cursor = new Date(Date.now() - 30000).toISOString();
    const res = await handleSyncPull(await req({ cursor }, t), env);
    const json: any = await res.json();
    expect(json.rows.profiles.map((r: any) => r.profile_id)).toEqual(['p_new']);
  });

  it('scopes rows to the calling user', async () => {
    const t = await seed();
    await env.DB.prepare('INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .bind('user_B', 'b@x.com', 'google', new Date().toISOString(), new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, profile_id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('user_B', 'p_other', 'x', 'x', '[]', '{}', 0, 'claude', new Date().toISOString()).run();

    const res = await handleSyncPull(await req({ cursor: null }, t), env);
    const json: any = await res.json();
    expect(json.rows.profiles.length).toBe(0);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/sync/pull.ts
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { requireSyncEnabled } from '../auth/killswitch';
import { requireSession } from '../auth/require_session';
import { checkRateLimit } from './rate_limit';
import type { PullRequest, PullResponse } from './schema';

interface Env {
  DB: D1Database;
  KV_BINDING: KVNamespace;
  SYNC_ENABLED?: string;
}

const PULL_RATE_MAX = 60;
const PULL_RATE_WINDOW = 60;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function selectSince<T = any>(db: D1Database, sql: string, user_id: string, cursor: string | null): Promise<T[]> {
  const bindArgs = cursor === null ? [user_id] : [user_id, cursor];
  const res = await db.prepare(sql).bind(...bindArgs).all<T>();
  return res.results ?? [];
}

export async function handleSyncPull(req: Request, env: Env): Promise<Response> {
  const gate = requireSyncEnabled(env);
  if (gate) return gate;

  const session = await requireSession(req, env);
  if (session instanceof Response) return session;

  const rate = await checkRateLimit(env.KV_BINDING, session.user_id, 'pull', PULL_RATE_MAX, PULL_RATE_WINDOW);
  if (!rate.allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retry_after_seconds) });

  let body: PullRequest;
  try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const cursor = typeof body.cursor === 'string' ? body.cursor : null;
  const nextCursor = new Date().toISOString();

  const whereSince = cursor === null ? '' : ' AND updated_at > ?';
  const profiles = await selectSince(
    env.DB,
    `SELECT profile_id, name, description, working_directory, claude_args, env_vars,
            is_default, preview_json, agent, agent_args_json, updated_at, deleted_at
       FROM user_profiles WHERE user_id = ?${whereSince}`,
    session.user_id, cursor,
  );
  const workspaces = await selectSince(
    env.DB,
    `SELECT workspace_name, terminals_json, updated_at, deleted_at
       FROM user_workspaces WHERE user_id = ?${whereSince}`,
    session.user_id, cursor,
  );
  const snippets = await selectSince(
    env.DB,
    `SELECT snippet_id, title, content, category, created_at, updated_at, deleted_at
       FROM user_snippets WHERE user_id = ?${whereSince}`,
    session.user_id, cursor,
  );
  const session_summaries = await selectSince(
    env.DB,
    `SELECT terminal_id, summary, updated_at, deleted_at
       FROM user_session_summaries WHERE user_id = ?${whereSince}`,
    session.user_id, cursor,
  );
  const session_history = await selectSince(
    env.DB,
    `SELECT history_uuid, terminal_id, label, started_at, ended_at, agent,
            origin_installation_id, origin_working_directory, claude_session_id,
            log_r2_key, log_size_bytes, log_uploaded_at, updated_at, deleted_at
       FROM user_session_history WHERE user_id = ?${whereSince}`,
    session.user_id, cursor,
  );

  const settingsRow = await env.DB
    .prepare(
      cursor === null
        ? 'SELECT settings_json, updated_at FROM user_settings WHERE user_id = ?'
        : 'SELECT settings_json, updated_at FROM user_settings WHERE user_id = ? AND updated_at > ?',
    )
    .bind(...(cursor === null ? [session.user_id] : [session.user_id, cursor]))
    .first<{ settings_json: string; updated_at: string }>();

  const response: PullResponse = {
    rows: {
      profiles: profiles as any, workspaces: workspaces as any, snippets: snippets as any,
      session_summaries: session_summaries as any, session_history: session_history as any,
      settings: settingsRow ?? null,
    },
    next_cursor: nextCursor,
  };
  return json(response);
}
```

- [ ] **Step 3: Verify tests pass**

```bash
npx vitest run src/sync/__tests__/pull.test.ts
```

Expected: PASS all 3.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/sync/pull.ts workers/ct-analytics/src/sync/__tests__/pull.test.ts
git commit -m "feat(worker): /sync/pull with cursor + rate limit + user-scoped selects"
```

---

## Task 7: Presigned R2 upload/download URLs

**Files:**
- Create: `workers/ct-analytics/src/sync/log_urls.ts`
- Test: `workers/ct-analytics/src/sync/__tests__/log_urls.test.ts`

- [ ] **Step 1: Write the failing tests**

Include cases for: reject over-cap size, return URL scoped to the user prefix, download 404 when no row, download success when `log_r2_key` is set. Miniflare provides an in-memory R2 for the pool. Test file mirrors the shape of `handlers.callback.test.ts` from Phase A.

Full test file body:

```typescript
// workers/ct-analytics/src/sync/__tests__/log_urls.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleLogUploadUrl, handleLogDownloadUrl } from '../log_urls';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seed(): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind('user_A', 'a@x.com', 'google', now, now).run();
  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_A', installation_id: 'i', origin: 'desktop',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await env.DB.prepare('DELETE FROM user_session_history').run();
});

describe('handleLogUploadUrl', () => {
  it('rejects sizes over 10 MB', async () => {
    const t = await seed();
    const res = await handleLogUploadUrl(new Request('https://x/sync/session-log/upload-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ history_uuid: 'u1', log_size_bytes: 15 * 1024 * 1024 }),
    }), env);
    expect(res.status).toBe(413);
  });

  it('returns a URL scoped to users/<user_id>/logs/', async () => {
    const t = await seed();
    const res = await handleLogUploadUrl(new Request('https://x/sync/session-log/upload-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ history_uuid: 'u1', log_size_bytes: 1000 }),
    }), env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.upload_url).toMatch(/users\/user_A\/logs\/u1\.log\.gz/);
    expect(json.expires_in_seconds).toBeGreaterThan(0);
  });
});

describe('handleLogDownloadUrl', () => {
  it('returns 404 when the row does not exist', async () => {
    const t = await seed();
    const res = await handleLogDownloadUrl(new Request('https://x/sync/session-log/unknown/download-url', {
      method: 'GET', headers: { Authorization: `Bearer ${t}` },
    }), env, 'unknown');
    expect(res.status).toBe(404);
  });

  it('returns a download URL when log_r2_key is set', async () => {
    const t = await seed();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO user_session_history (user_id, history_uuid, terminal_id, label, started_at,
         agent, origin_installation_id, log_r2_key, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('user_A', 'u1', 't1', 'label', now, 'claude', 'i', 'users/user_A/logs/u1.log.gz', now).run();

    const res = await handleLogDownloadUrl(new Request('https://x/sync/session-log/u1/download-url', {
      method: 'GET', headers: { Authorization: `Bearer ${t}` },
    }), env, 'u1');
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.download_url).toContain('users/user_A/logs/u1.log.gz');
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/sync/log_urls.ts
import type { D1Database, R2Bucket, KVNamespace } from '@cloudflare/workers-types';
import { requireSyncEnabled } from '../auth/killswitch';
import { requireSession } from '../auth/require_session';
import { checkRateLimit } from './rate_limit';
import { MAX_LOG_BYTES } from './schema';

interface Env {
  DB: D1Database;
  KV_BINDING: KVNamespace;
  R2_LOGS: R2Bucket;
  SYNC_ENABLED?: string;
}

const URL_TTL_SECONDS = 300;
const UPLOAD_RATE_MAX = 20;
const UPLOAD_RATE_WINDOW = 60;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Cloudflare R2's presign helper: R2Bucket has createPresignedUrl in recent
// runtime types. If your build's types don't expose it yet, install
// @aws-sdk/s3-request-presigner and sign against R2's S3-compatible endpoint.
async function presignPut(bucket: R2Bucket, key: string, ttl: number): Promise<string> {
  // @ts-expect-error - createPresignedUrl available on R2Bucket in workers-types@4+
  return await bucket.createPresignedUrl('PUT', key, { expiresIn: ttl });
}

async function presignGet(bucket: R2Bucket, key: string, ttl: number): Promise<string> {
  // @ts-expect-error - see note above.
  return await bucket.createPresignedUrl('GET', key, { expiresIn: ttl });
}

export async function handleLogUploadUrl(req: Request, env: Env): Promise<Response> {
  const gate = requireSyncEnabled(env);
  if (gate) return gate;
  const session = await requireSession(req, env);
  if (session instanceof Response) return session;

  const rate = await checkRateLimit(env.KV_BINDING, session.user_id, 'log_upload', UPLOAD_RATE_MAX, UPLOAD_RATE_WINDOW);
  if (!rate.allowed) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retry_after_seconds) });

  let body: { history_uuid?: string; log_size_bytes?: number };
  try { body = await req.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!body.history_uuid || typeof body.log_size_bytes !== 'number') {
    return json({ error: 'missing_fields' }, 400);
  }
  if (body.log_size_bytes > MAX_LOG_BYTES) {
    return json({ error: 'log_too_large', max: MAX_LOG_BYTES }, 413);
  }

  const key = `users/${session.user_id}/logs/${body.history_uuid}.log.gz`;
  const url = await presignPut(env.R2_LOGS, key, URL_TTL_SECONDS);
  return json({ upload_url: url, r2_key: key, expires_in_seconds: URL_TTL_SECONDS });
}

export async function handleLogDownloadUrl(req: Request, env: Env, history_uuid: string): Promise<Response> {
  const gate = requireSyncEnabled(env);
  if (gate) return gate;
  const session = await requireSession(req, env);
  if (session instanceof Response) return session;

  const row = await env.DB.prepare(
    'SELECT log_r2_key FROM user_session_history WHERE user_id = ? AND history_uuid = ?',
  ).bind(session.user_id, history_uuid).first<{ log_r2_key: string | null }>();
  if (!row?.log_r2_key) return json({ error: 'not_found' }, 404);

  const url = await presignGet(env.R2_LOGS, row.log_r2_key, URL_TTL_SECONDS);
  return json({ download_url: url, expires_in_seconds: URL_TTL_SECONDS });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/sync/__tests__/log_urls.test.ts
```

Expected: PASS 4.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/sync/log_urls.ts workers/ct-analytics/src/sync/__tests__/log_urls.test.ts
git commit -m "feat(worker): presigned R2 URLs for log upload/download"
```

---

## Task 8: Wire sync routes into Worker `index.ts`

**Files:**
- Modify: `workers/ct-analytics/src/index.ts`

- [ ] **Step 1: Add route handlers**

```typescript
import { handleSyncPush } from './sync/push';
import { handleSyncPull } from './sync/pull';
import { handleLogUploadUrl, handleLogDownloadUrl } from './sync/log_urls';

// Inside the fetch handler, alongside the existing /auth routes:
if (request.method === 'POST' && url.pathname === '/sync/push')                  return handleSyncPush(request, env);
if (request.method === 'POST' && url.pathname === '/sync/pull')                  return handleSyncPull(request, env);
if (request.method === 'POST' && url.pathname === '/sync/session-log/upload-url')return handleLogUploadUrl(request, env);
{
  const m = /^\/sync\/session-log\/([a-f0-9-]{36})\/download-url$/.exec(url.pathname);
  if (m && request.method === 'GET') return handleLogDownloadUrl(request, env, m[1]);
}
```

- [ ] **Step 2: Verify preview deploy**

```bash
cd workers/ct-analytics
npx wrangler deploy --env=preview
curl -X POST "https://<preview>/sync/push"
```

Expected: `{ "error": "no_session" }` with 401.

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/src/index.ts
git commit -m "feat(worker): route /sync/push, /sync/pull, session-log URLs"
```

---

## Task 9: Rust `sync_queue` CRUD helpers

**Files:**
- Create: `src-tauri/src/sync/mod.rs`
- Create: `src-tauri/src/sync/queue.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write the module skeleton and failing tests**

Create `src-tauri/src/sync/mod.rs`:

```rust
pub mod queue;
pub mod payload;
pub mod pusher;
pub mod puller;
pub mod merge;
pub mod log_upload;
pub mod status;
pub mod commands;
```

Create `src-tauri/src/sync/queue.rs` with in-file tests (see Task 9 in the spec discussion for the full body). Key functions: `enqueue`, `drain_batch`, `mark_success`, `mark_failure`, `backoff_ms`.

Wire in `main.rs`:

```rust
mod sync;
```

- [ ] **Step 2: Run tests**

```bash
cd src-tauri && cargo test sync::queue
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sync/mod.rs src-tauri/src/sync/queue.rs src-tauri/src/main.rs
git commit -m "feat(sync): sync_queue CRUD + exponential backoff"
```

Full body of `queue.rs`:

```rust
// src-tauri/src/sync/queue.rs
use crate::database::Database;
use rusqlite::params;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueRow {
    pub table_name: String,
    pub row_key: String,
    pub attempts: i64,
}

pub fn enqueue(db: &Database, table_name: &str, row_key: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    db.conn().execute(
        "INSERT INTO sync_queue (table_name, row_key, enqueued_at, attempts)
         VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(table_name, row_key) DO UPDATE
            SET enqueued_at = excluded.enqueued_at,
                attempts = 0,
                last_error = NULL",
        params![table_name, row_key, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn drain_batch(db: &Database, max_rows: usize) -> Result<Vec<QueueRow>, String> {
    let mut stmt = db.conn()
        .prepare("SELECT table_name, row_key, attempts FROM sync_queue
                  ORDER BY enqueued_at ASC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![max_rows as i64], |r| Ok(QueueRow {
            table_name: r.get(0)?, row_key: r.get(1)?, attempts: r.get(2)?,
        }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn mark_success(db: &Database, rows: &[QueueRow]) -> Result<(), String> {
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;
    for r in rows {
        tx.execute(
            "DELETE FROM sync_queue WHERE table_name = ?1 AND row_key = ?2",
            params![r.table_name, r.row_key],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn mark_failure(db: &Database, rows: &[QueueRow], error: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;
    for r in rows {
        tx.execute(
            "UPDATE sync_queue SET attempts = attempts + 1, last_attempt_at = ?1, last_error = ?2
             WHERE table_name = ?3 AND row_key = ?4",
            params![now, error, r.table_name, r.row_key],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// min(30 * 2^attempts, 3600) seconds with 20% jitter, in ms.
pub fn backoff_ms(attempts: i64) -> u64 {
    use rand::Rng;
    let base_seconds = 30_u64.saturating_mul(1_u64 << attempts.min(10) as u32);
    let capped = base_seconds.min(3600);
    let jitter = rand::thread_rng().gen_range(0.8..1.2);
    ((capped as f64) * jitter * 1000.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> Database { Database::new_in_memory().unwrap() }

    #[test]
    fn enqueue_upserts_and_resets_attempts() {
        let d = db();
        enqueue(&d, "profiles", "p1").unwrap();
        mark_failure(&d, &drain_batch(&d, 10).unwrap(), "boom").unwrap();
        enqueue(&d, "profiles", "p1").unwrap();
        let rows = drain_batch(&d, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].attempts, 0);
    }

    #[test]
    fn drain_returns_up_to_max_rows() {
        let d = db();
        for i in 0..5 { enqueue(&d, "profiles", &format!("p{}", i)).unwrap(); }
        let rows = drain_batch(&d, 3).unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn mark_success_deletes_the_queue_rows() {
        let d = db();
        enqueue(&d, "profiles", "p1").unwrap();
        let rows = drain_batch(&d, 10).unwrap();
        mark_success(&d, &rows).unwrap();
        assert!(drain_batch(&d, 10).unwrap().is_empty());
    }

    #[test]
    fn backoff_ms_grows_with_attempts_and_caps() {
        for a in 0..15 {
            let b = backoff_ms(a);
            assert!(b >= 24_000, "backoff for {} attempts too small: {}", a, b);
            assert!(b <= 3600 * 1200, "backoff for {} attempts exceeds cap: {}", a, b);
        }
    }
}
```

---

## Task 10: Wrap existing DB writes in enqueue

**Files:**
- Modify: `src-tauri/src/database.rs`

Add `updated_at` maintenance and enqueue to write paths, and add tombstone helpers that soft-delete instead of hard `DELETE`.

Key changes:
- Add helper `fn now_rfc3339() -> String` at top of `impl Database`.
- Modify `save_profile`, `save_workspace`, `save_snippet`, `save_session_summary`, `insert_session_history`, `update_session_ended` to write `updated_at` in the INSERT/UPDATE and call `crate::sync::queue::enqueue(...)` after.
- Add `tombstone_profile(id)`, `tombstone_workspace(name)`, `tombstone_snippet(id)`, `tombstone_session_history(history_uuid)`. Each sets `deleted_at = updated_at = now()` and enqueues.
- Rewrite `delete_profile`, `delete_workspace`, `delete_snippet`, `delete_session_history_entry` to call the corresponding tombstone helper.

Add tests:

```rust
#[test]
fn save_profile_enqueues_a_sync_row() {
    let db = Database::new_in_memory().unwrap();
    let p = make_profile("p1", "x");
    db.save_profile(&p).unwrap();
    let rows = crate::sync::queue::drain_batch(&db, 10).unwrap();
    assert!(rows.iter().any(|r| r.table_name == "profiles" && r.row_key == "p1"));
}

#[test]
fn tombstone_profile_sets_deleted_at_and_bumps_updated_at() {
    let db = Database::new_in_memory().unwrap();
    let p = make_profile("p1", "x");
    db.save_profile(&p).unwrap();
    db.tombstone_profile("p1").unwrap();
    let (deleted_at, updated_at): (Option<String>, String) = db.conn().query_row(
        "SELECT deleted_at, updated_at FROM profiles WHERE id = ?1",
        rusqlite::params!["p1"], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert!(deleted_at.is_some());
    assert_eq!(deleted_at.unwrap(), updated_at);
}
```

Verify:

```bash
cd src-tauri && cargo test database
```

Commit:

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): wrap DB writes in updated_at + sync_queue enqueue + tombstones"
```

---

## Task 11: Assemble push payload from local rows

**Files:**
- Create: `src-tauri/src/sync/payload.rs`

Full body:

```rust
// src-tauri/src/sync/payload.rs
use crate::database::Database;
use crate::sync::queue::QueueRow;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Default, Serialize)]
pub struct PushPayload {
    #[serde(skip_serializing_if = "Vec::is_empty")] pub profiles: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")] pub workspaces: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")] pub snippets: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")] pub session_summaries: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")] pub session_history: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")] pub settings: Option<Value>,
}

impl PushPayload {
    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty() && self.workspaces.is_empty() && self.snippets.is_empty()
            && self.session_summaries.is_empty() && self.session_history.is_empty()
            && self.settings.is_none()
    }
}

pub fn build_payload(db: &Database, queue_rows: &[QueueRow]) -> Result<PushPayload, String> {
    let mut payload = PushPayload::default();
    for r in queue_rows {
        match r.table_name.as_str() {
            "profiles" => if let Some(v) = read_profile(db, &r.row_key)? { payload.profiles.push(v); },
            "workspaces" => if let Some(v) = read_workspace(db, &r.row_key)? { payload.workspaces.push(v); },
            "snippets" => if let Some(v) = read_snippet(db, &r.row_key)? { payload.snippets.push(v); },
            "session_summaries" => if let Some(v) = read_session_summary(db, &r.row_key)? { payload.session_summaries.push(v); },
            "session_history" => if let Some(v) = read_session_history(db, &r.row_key)? { payload.session_history.push(v); },
            "settings" => payload.settings = Some(read_settings(db)?),
            _ => {}
        }
    }
    Ok(payload)
}

fn read_profile(db: &Database, id: &str) -> Result<Option<Value>, String> {
    match db.conn().query_row(
        "SELECT id, name, description, working_directory, claude_args, env_vars,
                is_default, preview_json, agent, agent_args_json, updated_at, deleted_at
           FROM profiles WHERE id = ?1",
        params![id],
        |r| Ok(serde_json::json!({
            "profile_id": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "description": r.get::<_, Option<String>>(2)?,
            "working_directory": r.get::<_, String>(3)?,
            "claude_args": r.get::<_, String>(4)?,
            "env_vars": r.get::<_, String>(5)?,
            "is_default": r.get::<_, i64>(6)?,
            "preview_json": r.get::<_, Option<String>>(7)?,
            "agent": r.get::<_, String>(8)?,
            "agent_args_json": r.get::<_, Option<String>>(9)?,
            "updated_at": r.get::<_, String>(10)?,
            "deleted_at": r.get::<_, Option<String>>(11)?,
        })),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_workspace(db: &Database, name: &str) -> Result<Option<Value>, String> {
    match db.conn().query_row(
        "SELECT name, terminals, updated_at, deleted_at FROM workspaces WHERE name = ?1",
        params![name],
        |r| Ok(serde_json::json!({
            "workspace_name": r.get::<_, String>(0)?,
            "terminals_json": r.get::<_, String>(1)?,
            "updated_at": r.get::<_, String>(2)?,
            "deleted_at": r.get::<_, Option<String>>(3)?,
        })),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_snippet(db: &Database, id: &str) -> Result<Option<Value>, String> {
    match db.conn().query_row(
        "SELECT id, title, content, category, created_at, updated_at, deleted_at
           FROM snippets WHERE id = ?1",
        params![id],
        |r| Ok(serde_json::json!({
            "snippet_id": r.get::<_, String>(0)?,
            "title": r.get::<_, String>(1)?,
            "content": r.get::<_, String>(2)?,
            "category": r.get::<_, String>(3)?,
            "created_at": r.get::<_, String>(4)?,
            "updated_at": r.get::<_, String>(5)?,
            "deleted_at": r.get::<_, Option<String>>(6)?,
        })),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_session_summary(db: &Database, terminal_id: &str) -> Result<Option<Value>, String> {
    match db.conn().query_row(
        "SELECT terminal_id, summary, updated_at, deleted_at FROM session_summaries WHERE terminal_id = ?1",
        params![terminal_id],
        |r| Ok(serde_json::json!({
            "terminal_id": r.get::<_, String>(0)?,
            "summary": r.get::<_, String>(1)?,
            "updated_at": r.get::<_, String>(2)?,
            "deleted_at": r.get::<_, Option<String>>(3)?,
        })),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_session_history(db: &Database, history_uuid: &str) -> Result<Option<Value>, String> {
    let installation_id = db.get_or_create_installation_id()?;
    match db.conn().query_row(
        "SELECT history_uuid, terminal_id, label, started_at, ended_at, log_path,
                working_directory, claude_session_id, updated_at, deleted_at
           FROM session_history WHERE history_uuid = ?1",
        params![history_uuid],
        |r| Ok(serde_json::json!({
            "history_uuid": r.get::<_, String>(0)?,
            "terminal_id": r.get::<_, String>(1)?,
            "label": r.get::<_, String>(2)?,
            "started_at": r.get::<_, String>(3)?,
            "ended_at": r.get::<_, Option<String>>(4)?,
            "agent": "claude",  // placeholder; real agent lives on the terminal row
            "origin_installation_id": installation_id.clone(),
            "origin_working_directory": r.get::<_, Option<String>>(6)?,
            "claude_session_id": r.get::<_, Option<String>>(7)?,
            "log_r2_key": serde_json::Value::Null,
            "log_size_bytes": serde_json::Value::Null,
            "log_uploaded_at": serde_json::Value::Null,
            "updated_at": r.get::<_, String>(8)?,
            "deleted_at": r.get::<_, Option<String>>(9)?,
        })),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn read_settings(db: &Database) -> Result<Value, String> {
    let raw: Option<String> = db.conn().query_row(
        "SELECT value FROM user_meta WHERE key = 'pending_settings_blob'",
        [], |r| r.get(0),
    ).ok();
    let raw = raw.unwrap_or_else(|| "{}".to_string());
    Ok(serde_json::json!({
        "settings_json": raw,
        "updated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use crate::sync::queue::{drain_batch, enqueue};

    #[test]
    fn build_payload_collects_profile_and_workspace_rows() {
        let db = Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at)
             VALUES ('p1','x','wd','[]','{}',0,'claude','2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        enqueue(&db, "profiles", "p1").unwrap();

        db.conn().execute(
            "INSERT INTO workspaces (name, terminals, created_at, updated_at)
             VALUES ('w1','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        enqueue(&db, "workspaces", "w1").unwrap();

        let queue = drain_batch(&db, 10).unwrap();
        let payload = build_payload(&db, &queue).unwrap();
        assert_eq!(payload.profiles.len(), 1);
        assert_eq!(payload.workspaces.len(), 1);
    }
}
```

Run:

```bash
cargo test sync::payload
```

Commit:

```bash
git add src-tauri/src/sync/payload.rs
git commit -m "feat(sync): assemble push payload from local rows"
```

---

## Task 12: Debounced pusher task + SyncStatus events

**Files:**
- Create: `src-tauri/src/sync/status.rs`
- Create: `src-tauri/src/sync/pusher.rs`
- Create: `src-tauri/src/sync/commands.rs`
- Modify: `src-tauri/src/main.rs`

Contents of `status.rs`:

```rust
// src-tauri/src/sync/status.rs
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncStatus {
    Idle { last_synced_at: Option<String> },
    Syncing,
    Failed { message: String, since: String },
    Offline,
}
```

Contents of `pusher.rs`:

```rust
// src-tauri/src/sync/pusher.rs
use crate::auth::keychain;
use crate::database::Database;
use crate::sync::payload::{build_payload, PushPayload};
use crate::sync::queue::{backoff_ms, drain_batch, mark_failure, mark_success};
use crate::sync::status::SyncStatus;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

const DEBOUNCE_MS: u64 = 5_000;
const MAX_BATCH_ROWS: usize = 500;

pub struct Pusher {
    trigger: Arc<Notify>,
}

impl Pusher {
    pub fn new(app: AppHandle, db: Arc<Mutex<Database>>) -> Self {
        let trigger = Arc::new(Notify::new());
        let trig = trigger.clone();
        tokio::spawn(run_loop(app, db, trig));
        Self { trigger }
    }
    pub fn notify(&self) { self.trigger.notify_one(); }
}

async fn run_loop(app: AppHandle, db: Arc<Mutex<Database>>, trig: Arc<Notify>) {
    loop {
        trig.notified().await;
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
        // Coalesce any additional notifies that arrived during the debounce.
        while tokio::time::timeout(Duration::from_millis(0), trig.notified()).await.is_ok() {}

        let token = match keychain::load_session_token(&app).ok().flatten() {
            Some(t) => t,
            None => { emit_status(&app, SyncStatus::Idle { last_synced_at: None }); continue; }
        };

        let queue = { drain_batch(&db.lock().unwrap(), MAX_BATCH_ROWS) };
        let queue = match queue {
            Ok(q) if q.is_empty() => continue,
            Ok(q) => q,
            Err(e) => { emit_status(&app, SyncStatus::Failed { message: e, since: now() }); continue; }
        };

        let payload = build_payload(&db.lock().unwrap(), &queue);
        let payload = match payload {
            Ok(p) if p.is_empty() => { let _ = mark_success(&db.lock().unwrap(), &queue); continue; }
            Ok(p) => p,
            Err(e) => {
                let _ = mark_failure(&db.lock().unwrap(), &queue, &e);
                emit_status(&app, SyncStatus::Failed { message: e, since: now() });
                schedule_retry(&trig, &queue);
                continue;
            }
        };

        emit_status(&app, SyncStatus::Syncing);
        match post_push(&token, &payload).await {
            Ok(()) => {
                let _ = mark_success(&db.lock().unwrap(), &queue);
                emit_status(&app, SyncStatus::Idle { last_synced_at: Some(now()) });
            }
            Err(msg) => {
                let _ = mark_failure(&db.lock().unwrap(), &queue, &msg);
                emit_status(&app, SyncStatus::Failed { message: msg, since: now() });
                schedule_retry(&trig, &queue);
            }
        }
    }
}

fn schedule_retry(trig: &Arc<Notify>, queue: &[crate::sync::queue::QueueRow]) {
    let attempts = queue.iter().map(|r| r.attempts).max().unwrap_or(0);
    let wait = backoff_ms(attempts);
    let t = trig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(wait)).await;
        t.notify_one();
    });
}

async fn post_push(token: &str, payload: &PushPayload) -> Result<(), String> {
    let client = reqwest::Client::new();
    let base = crate::auth::session::worker_base();
    let res = client
        .post(format!("{}/sync/push", base))
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .header(CONTENT_TYPE, "application/json")
        .json(payload).send().await
        .map_err(|e| format!("network: {}", e))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("push failed {}: {}", status, body));
    }
    Ok(())
}

fn emit_status(app: &AppHandle, status: SyncStatus) { let _ = app.emit("sync-status", &status); }
fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
```

Contents of `commands.rs`:

```rust
// src-tauri/src/sync/commands.rs
use tauri::State;

#[tauri::command]
pub async fn sync_now(pusher: State<'_, crate::sync::pusher::Pusher>) -> Result<(), String> {
    pusher.notify();
    Ok(())
}
```

In `main.rs`, inside `.setup(|app| ...)`:

```rust
use std::sync::{Arc, Mutex};
let db_state = app.state::<Arc<Mutex<crate::database::Database>>>().inner().clone();
let pusher = crate::sync::pusher::Pusher::new(app.handle().clone(), db_state);
app.manage(pusher);
```

Register `sync::commands::sync_now` in the `invoke_handler` and (in later tasks) `pull_now`, `merge_get_counts`, `merge_apply_choice`, `enqueue_settings_blob`.

Verify:

```bash
cargo check
```

Commit:

```bash
git add src-tauri/src/sync/pusher.rs src-tauri/src/sync/status.rs src-tauri/src/sync/commands.rs src-tauri/src/main.rs
git commit -m "feat(sync): debounced pusher task + SyncStatus events + sync_now command"
```

---

## Task 13: Puller (cursor pull + apply)

**Files:**
- Create: `src-tauri/src/sync/puller.rs`
- Modify: `src-tauri/src/sync/commands.rs`

Full body of `puller.rs`:

```rust
// src-tauri/src/sync/puller.rs
use crate::auth::keychain;
use crate::database::Database;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use rusqlite::params;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

const CURSOR_KEY: &str = "last_pull_cursor";

pub async fn pull(app: &AppHandle, db: &Arc<Mutex<Database>>) -> Result<(), String> {
    let Some(token) = keychain::load_session_token(app)? else { return Ok(()); };
    let cursor: Option<String> = {
        let db = db.lock().unwrap();
        db.conn().query_row(
            "SELECT value FROM user_meta WHERE key = ?1",
            params![CURSOR_KEY], |r| r.get(0),
        ).ok()
    };

    let client = reqwest::Client::new();
    let base = crate::auth::session::worker_base();
    let res = client.post(format!("{}/sync/pull", base))
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .header(CONTENT_TYPE, "application/json")
        .json(&serde_json::json!({ "cursor": cursor })).send().await
        .map_err(|e| format!("network: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("pull {}: {}", res.status().as_u16(), res.text().await.unwrap_or_default()));
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    let next_cursor = body.get("next_cursor").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let rows = body.get("rows").cloned().unwrap_or(Value::Null);

    apply_rows(db, &rows)?;

    let db = db.lock().unwrap();
    db.conn().execute(
        "INSERT OR REPLACE INTO user_meta (key, value) VALUES (?1, ?2)",
        params![CURSOR_KEY, next_cursor],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_rows(db: &Arc<Mutex<Database>>, rows: &Value) -> Result<(), String> {
    let db = db.lock().unwrap();
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;

    if let Some(arr) = rows.get("profiles").and_then(Value::as_array)          { for r in arr { apply_profile(&tx, r)?; } }
    if let Some(arr) = rows.get("workspaces").and_then(Value::as_array)        { for r in arr { apply_workspace(&tx, r)?; } }
    if let Some(arr) = rows.get("snippets").and_then(Value::as_array)          { for r in arr { apply_snippet(&tx, r)?; } }
    if let Some(arr) = rows.get("session_summaries").and_then(Value::as_array) { for r in arr { apply_session_summary(&tx, r)?; } }
    if let Some(arr) = rows.get("session_history").and_then(Value::as_array)   { for r in arr { apply_session_history(&tx, r)?; } }
    if let Some(s) = rows.get("settings") {
        if !s.is_null() {
            let json = s.get("settings_json").and_then(Value::as_str).unwrap_or("{}");
            tx.execute(
                "INSERT OR REPLACE INTO user_meta (key, value) VALUES ('pulled_settings_blob', ?1)",
                params![json],
            ).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn get_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> { v.get(k).and_then(Value::as_str) }
fn get_i64<'a>(v: &'a Value, k: &str) -> Option<i64> { v.get(k).and_then(Value::as_i64) }

fn apply_profile(tx: &rusqlite::Transaction, r: &Value) -> Result<(), String> {
    let id = get_str(r, "profile_id").ok_or("missing profile_id")?;
    if get_str(r, "deleted_at").is_some() {
        tx.execute("DELETE FROM profiles WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO profiles
           (id, name, description, working_directory, claude_args, env_vars,
            is_default, preview_json, agent, agent_args_json, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        params![
            id, get_str(r, "name").unwrap_or(""), get_str(r, "description"),
            get_str(r, "working_directory").unwrap_or(""),
            get_str(r, "claude_args").unwrap_or("[]"),
            get_str(r, "env_vars").unwrap_or("{}"),
            get_i64(r, "is_default").unwrap_or(0),
            get_str(r, "preview_json"),
            get_str(r, "agent").unwrap_or("claude"),
            get_str(r, "agent_args_json"),
            get_str(r, "updated_at").unwrap_or(""),
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_workspace(tx: &rusqlite::Transaction, r: &Value) -> Result<(), String> {
    let name = get_str(r, "workspace_name").ok_or("missing workspace_name")?;
    if get_str(r, "deleted_at").is_some() {
        tx.execute("DELETE FROM workspaces WHERE name = ?1", params![name]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO workspaces (name, terminals, created_at, updated_at)
         VALUES (?1, ?2, COALESCE((SELECT created_at FROM workspaces WHERE name = ?1), ?3), ?3)",
        params![name, get_str(r, "terminals_json").unwrap_or("[]"), get_str(r, "updated_at").unwrap_or("")],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_snippet(tx: &rusqlite::Transaction, r: &Value) -> Result<(), String> {
    let id = get_str(r, "snippet_id").ok_or("missing snippet_id")?;
    if get_str(r, "deleted_at").is_some() {
        tx.execute("DELETE FROM snippets WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO snippets (id, title, content, category, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            get_str(r, "title").unwrap_or(""),
            get_str(r, "content").unwrap_or(""),
            get_str(r, "category").unwrap_or("General"),
            get_str(r, "created_at").unwrap_or(""),
            get_str(r, "updated_at").unwrap_or(""),
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_session_summary(tx: &rusqlite::Transaction, r: &Value) -> Result<(), String> {
    let terminal_id = get_str(r, "terminal_id").ok_or("missing terminal_id")?;
    if get_str(r, "deleted_at").is_some() {
        tx.execute("DELETE FROM session_summaries WHERE terminal_id = ?1", params![terminal_id])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO session_summaries (terminal_id, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![terminal_id, get_str(r, "summary").unwrap_or(""), get_str(r, "updated_at").unwrap_or("")],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn apply_session_history(tx: &rusqlite::Transaction, r: &Value) -> Result<(), String> {
    let uuid = get_str(r, "history_uuid").ok_or("missing history_uuid")?;
    if get_str(r, "deleted_at").is_some() {
        tx.execute("DELETE FROM session_history WHERE history_uuid = ?1", params![uuid])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    tx.execute(
        "INSERT INTO session_history
            (terminal_id, label, started_at, ended_at, log_path, working_directory,
             claude_session_id, history_uuid, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)
         ON CONFLICT(history_uuid) DO UPDATE
            SET label = excluded.label, ended_at = excluded.ended_at,
                working_directory = excluded.working_directory,
                claude_session_id = excluded.claude_session_id,
                updated_at = excluded.updated_at, deleted_at = NULL",
        params![
            get_str(r, "terminal_id").unwrap_or(""),
            get_str(r, "label").unwrap_or(""),
            get_str(r, "started_at").unwrap_or(""),
            get_str(r, "ended_at"),
            get_str(r, "origin_working_directory"),
            get_str(r, "claude_session_id"),
            uuid,
            get_str(r, "updated_at").unwrap_or(""),
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

Append to `commands.rs`:

```rust
#[tauri::command]
pub async fn pull_now(
    app: tauri::AppHandle,
    db: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
) -> Result<(), String> {
    crate::error_reporter::wrap_cmd("pull_now", async move {
        crate::sync::puller::pull(&app, &db.inner().clone()).await
    }).await
}
```

Register in `invoke_handler`.

Verify:

```bash
cargo check
```

Commit:

```bash
git add src-tauri/src/sync/puller.rs src-tauri/src/sync/commands.rs src-tauri/src/main.rs
git commit -m "feat(sync): cursor pull + row apply with tombstone-aware deletion"
```

---

## Task 14: Log upload

**Files:**
- Create: `src-tauri/src/sync/log_upload.rs`
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src-tauri/src/database.rs`

Add `log_r2_key TEXT` to the `session_history` local schema migrations if not already present.

Full body of `log_upload.rs`:

```rust
// src-tauri/src/sync/log_upload.rs
use crate::auth::keychain;
use flate2::{write::GzEncoder, Compression};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use std::io::Write;
use tauri::AppHandle;

const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

pub async fn upload_log_for_history(
    app: &AppHandle,
    history_uuid: &str,
    log_path: &str,
) -> Result<Option<(String, u64)>, String> {
    let Some(token) = keychain::load_session_token(app)? else { return Ok(None); };

    let raw = tokio::fs::read(log_path).await.map_err(|e| format!("read {}: {}", log_path, e))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|e| e.to_string())?;
    let mut gz = encoder.finish().map_err(|e| e.to_string())?;

    if gz.len() as u64 > MAX_LOG_BYTES {
        // Tail-truncate: keep the last ~8 MB of raw with a truncation marker.
        let keep = 8 * 1024 * 1024;
        let head = format!("[log truncated - {}MB elided]\n", (raw.len() - keep) / 1024 / 1024);
        let mut trimmed = Vec::with_capacity(head.len() + keep);
        trimmed.extend_from_slice(head.as_bytes());
        trimmed.extend_from_slice(&raw[raw.len() - keep..]);
        let mut enc2 = GzEncoder::new(Vec::new(), Compression::default());
        enc2.write_all(&trimmed).map_err(|e| e.to_string())?;
        gz = enc2.finish().map_err(|e| e.to_string())?;
    }

    let size = gz.len() as u64;
    let client = reqwest::Client::new();
    let base = crate::auth::session::worker_base();

    #[derive(serde::Deserialize)]
    struct UploadUrl { upload_url: String, r2_key: String }
    let url_resp: UploadUrl = client
        .post(format!("{}/sync/session-log/upload-url", base))
        .header(AUTHORIZATION, format!("Bearer {}", token))
        .json(&serde_json::json!({ "history_uuid": history_uuid, "log_size_bytes": size }))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let put = client.put(&url_resp.upload_url)
        .header(CONTENT_TYPE, "application/gzip")
        .header(CONTENT_LENGTH, size)
        .body(gz)
        .send().await.map_err(|e| format!("R2 PUT: {}", e))?;
    if !put.status().is_success() {
        return Err(format!("R2 PUT {}: {}", put.status().as_u16(), put.text().await.unwrap_or_default()));
    }
    Ok(Some((url_resp.r2_key, size)))
}
```

Hook into `terminal.rs`: locate the code that emits `terminal-finished`, then after `update_session_ended`, spawn:

```rust
let app_clone = app.clone();
let (history_uuid, log_path_opt) = {
    let db = db.lock().unwrap();
    let uuid: Option<String> = db.conn().query_row(
        "SELECT history_uuid FROM session_history WHERE terminal_id = ?1
         ORDER BY started_at DESC LIMIT 1",
        rusqlite::params![terminal_id], |r| r.get(0),
    ).ok();
    let path = db.get_log_path_for_terminal(&terminal_id).ok().flatten();
    (uuid, path)
};
if let (Some(uuid), Some(log_path)) = (history_uuid, log_path_opt) {
    let db_arc = db.clone();
    tokio::spawn(async move {
        match crate::sync::log_upload::upload_log_for_history(&app_clone, &uuid, &log_path).await {
            Ok(Some((r2_key, size))) => {
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                let db = db_arc.lock().unwrap();
                let _ = db.conn().execute(
                    "UPDATE session_history SET log_r2_key = ?1, log_size_bytes = ?2, log_uploaded_at = ?3, updated_at = ?3
                     WHERE history_uuid = ?4",
                    rusqlite::params![r2_key, size as i64, now, uuid],
                );
                let _ = crate::sync::queue::enqueue(&db, "session_history", &uuid);
            }
            Ok(None) => {}, // Not signed in.
            Err(e) => crate::error_reporter::report_bg("log_upload", &e),
        }
    });
}
```

Verify:

```bash
cargo check
```

Manual: run a Claude Code session while signed in; confirm a `users/<user_id>/logs/<uuid>.log.gz` object appears in R2.

Commit:

```bash
git add src-tauri/src/sync/log_upload.rs src-tauri/src/terminal.rs src-tauri/src/database.rs
git commit -m "feat(sync): gzip + upload session logs to R2 on terminal-finished"
```

---

## Task 15: Guest-to-account merge

**Files:**
- Create: `src-tauri/src/sync/merge.rs`
- Modify: `src-tauri/src/sync/commands.rs`

Full body of `merge.rs`:

```rust
// src-tauri/src/sync/merge.rs
use crate::database::Database;
use rusqlite::params;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeChoice {
    Merge,
    ReplaceLocalWithAccount,
    PushLocalUpToAccount,
}

#[derive(Debug, serde::Serialize)]
pub struct LocalCounts {
    pub profiles: i64,
    pub workspaces: i64,
    pub snippets: i64,
    pub session_history: i64,
    pub session_summaries: i64,
}

pub fn count_local(db: &Database) -> Result<LocalCounts, String> {
    let mut counts = LocalCounts { profiles: 0, workspaces: 0, snippets: 0, session_history: 0, session_summaries: 0 };
    for (name, target) in [
        ("profiles", &mut counts.profiles),
        ("workspaces", &mut counts.workspaces),
        ("snippets", &mut counts.snippets),
        ("session_history", &mut counts.session_history),
        ("session_summaries", &mut counts.session_summaries),
    ] {
        let n: i64 = db.conn().query_row(
            &format!("SELECT COUNT(*) FROM {} WHERE deleted_at IS NULL", name),
            [], |r| r.get(0),
        ).unwrap_or(0);
        *target = n;
    }
    Ok(counts)
}

pub fn apply_choice(db: &Database, choice: MergeChoice) -> Result<(), String> {
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;
    match choice {
        MergeChoice::Merge => enqueue_all_local(&tx)?,
        MergeChoice::ReplaceLocalWithAccount => {
            tx.execute("DELETE FROM profiles", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM workspaces WHERE name NOT LIKE '\\_\\_%' ESCAPE '\\'", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM snippets", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM session_summaries", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM session_history", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM sync_queue", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM user_meta WHERE key = 'last_pull_cursor'", []).map_err(|e| e.to_string())?;
        }
        MergeChoice::PushLocalUpToAccount => {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            for table in ["profiles", "workspaces", "snippets", "session_history", "session_summaries"] {
                let sql = format!("UPDATE {} SET updated_at = ?1", table);
                tx.execute(&sql, params![now]).map_err(|e| e.to_string())?;
            }
            enqueue_all_local(&tx)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn enqueue_all_local(tx: &rusqlite::Transaction) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (table, key_col) in [
        ("profiles", "id"),
        ("workspaces", "name"),
        ("snippets", "id"),
        ("session_history", "history_uuid"),
        ("session_summaries", "terminal_id"),
    ] {
        let sql = format!(
            "INSERT OR IGNORE INTO sync_queue (table_name, row_key, enqueued_at, attempts)
             SELECT '{table}', {key_col}, '{now}', 0 FROM {table} WHERE {key_col} IS NOT NULL",
        );
        tx.execute(&sql, []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    #[test]
    fn count_local_excludes_tombstoned() {
        let db = Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at)
             VALUES ('p1','a','x','[]','{}',0,'claude','2026-01-01')",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at, deleted_at)
             VALUES ('p2','b','x','[]','{}',0,'claude','2026-01-01','2026-01-01')",
            [],
        ).unwrap();
        let c = count_local(&db).unwrap();
        assert_eq!(c.profiles, 1);
    }

    #[test]
    fn replace_local_wipes_sync_tables() {
        let db = Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at)
             VALUES ('p1','a','x','[]','{}',0,'claude','2026-01-01')",
            [],
        ).unwrap();
        apply_choice(&db, MergeChoice::ReplaceLocalWithAccount).unwrap();
        let n: i64 = db.conn().query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn push_local_up_bumps_updated_at_and_enqueues() {
        let db = Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, is_default, agent, updated_at)
             VALUES ('p1','a','x','[]','{}',0,'claude','2020-01-01')",
            [],
        ).unwrap();
        apply_choice(&db, MergeChoice::PushLocalUpToAccount).unwrap();
        let (updated_at, queued): (String, i64) = db.conn().query_row(
            "SELECT (SELECT updated_at FROM profiles WHERE id = 'p1'),
                    (SELECT COUNT(*) FROM sync_queue WHERE table_name = 'profiles')",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_ne!(updated_at, "2020-01-01");
        assert_eq!(queued, 1);
    }
}
```

Append to `sync/commands.rs`:

```rust
#[tauri::command]
pub async fn merge_get_counts(
    db: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
) -> Result<crate::sync::merge::LocalCounts, String> {
    crate::error_reporter::wrap_cmd("merge_get_counts", async move {
        let db = db.lock().map_err(|e| e.to_string())?;
        crate::sync::merge::count_local(&db)
    }).await
}

#[tauri::command]
pub async fn merge_apply_choice(
    db: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
    choice: crate::sync::merge::MergeChoice,
) -> Result<(), String> {
    crate::error_reporter::wrap_cmd("merge_apply_choice", async move {
        let db = db.lock().map_err(|e| e.to_string())?;
        crate::sync::merge::apply_choice(&db, choice)
    }).await
}
```

Register both in `invoke_handler`.

Run:

```bash
cargo test sync::merge
```

Commit:

```bash
git add src-tauri/src/sync/merge.rs src-tauri/src/sync/commands.rs src-tauri/src/main.rs
git commit -m "feat(sync): guest-to-account merge with three strategies + IPC"
```

---

## Task 16: Frontend - MergeModal

**Files:**
- Create: `src/components/auth/MergeModal.tsx`
- Test: `src/components/auth/__tests__/MergeModal.test.tsx`

- [ ] **Step 1: Write the failing test** (Vitest + RTL, patterns identical to Phase A's DeleteAccountModal test). Assert the modal shows both count sides, and clicking "Keep both" calls `invoke('merge_apply_choice', { choice: 'merge' })`.

- [ ] **Step 2: Implement**

```tsx
// src/components/auth/MergeModal.tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Counts {
  profiles: number; workspaces: number; snippets: number;
  session_history: number; session_summaries: number;
}

interface Props {
  open: boolean;
  accountCounts: Counts;
  onClose: () => void;
}

export function MergeModal({ open, accountCounts, onClose }: Props) {
  const [local, setLocal] = useState<Counts | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    invoke<Counts>('merge_get_counts')
      .then(setLocal)
      .catch(() => setLocal({ profiles: 0, workspaces: 0, snippets: 0, session_history: 0, session_summaries: 0 }));
  }, [open]);

  async function apply(choice: 'merge' | 'replace_local_with_account' | 'push_local_up_to_account') {
    setBusy(true);
    try {
      await invoke('merge_apply_choice', { choice });
      if (choice !== 'push_local_up_to_account') await invoke('pull_now');
      onClose();
    } finally { setBusy(false); }
  }

  if (!open || !local) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[520px] rounded-lg bg-[--elevation-3] p-6">
        <h3 className="mb-2 text-lg font-semibold">Combine data</h3>
        <p className="mb-4 text-sm opacity-80">
          You have data on both this PC and your account. Choose how to combine them.
        </p>
        <div className="mb-4 grid grid-cols-2 gap-4 rounded border border-white/10 p-3 text-sm">
          <div>
            <div className="mb-1 font-medium">This PC</div>
            <ul className="opacity-80">
              <li>{local.profiles} profiles</li>
              <li>{local.workspaces} workspaces</li>
              <li>{local.snippets} snippets</li>
              <li>{local.session_history} sessions</li>
            </ul>
          </div>
          <div>
            <div className="mb-1 font-medium">Account</div>
            <ul className="opacity-80">
              <li>{accountCounts.profiles} profiles</li>
              <li>{accountCounts.workspaces} workspaces</li>
              <li>{accountCounts.snippets} snippets</li>
              <li>{accountCounts.session_history} sessions</li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button disabled={busy} onClick={() => apply('merge')}
                  className="rounded bg-[--accent] px-3 py-2 text-sm text-white disabled:opacity-50">
            Keep both (recommended)
          </button>
          <button disabled={busy} onClick={() => apply('replace_local_with_account')}
                  className="rounded border border-white/10 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50">
            Replace this PC's data with the account
          </button>
          <button disabled={busy} onClick={() => apply('push_local_up_to_account')}
                  className="rounded border border-white/10 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50">
            Overwrite the account with this PC's data
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm run test -- src/components/auth/__tests__/MergeModal.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/MergeModal.tsx src/components/auth/__tests__/MergeModal.test.tsx
git commit -m "feat(sync): MergeModal with three strategies"
```

---

## Task 17: Frontend - settings blob + SYNCED_KEYS subscription

**Files:**
- Create: `src/lib/settingsBlob.ts`
- Modify: `src/store/appStore.ts`
- Modify: `src-tauri/src/sync/commands.rs`

- [ ] **Step 1: Add `extractSyncedKeys` and `applySettingsBlob`**

```typescript
// src/lib/settingsBlob.ts
import { SYNCED_KEYS } from './settingsSync';

export function extractSyncedKeys<T extends Record<string, unknown>>(state: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of SYNCED_KEYS) {
    if (k in state) (out as any)[k] = state[k];
  }
  return out;
}

export function applySettingsBlob(
  incoming: Record<string, unknown>,
  setState: (patch: Record<string, unknown>) => void,
): void {
  const patch: Record<string, unknown> = {};
  for (const k of SYNCED_KEYS) {
    if (k in incoming) patch[k] = incoming[k];
  }
  if (Object.keys(patch).length) setState(patch);
}
```

- [ ] **Step 2: Subscribe in `appStore.ts`**

At the bottom of the file, after `create(...)`:

```typescript
import { invoke } from '@tauri-apps/api/core';
import { extractSyncedKeys } from '../lib/settingsBlob';

let settingsPushTimer: ReturnType<typeof setTimeout> | null = null;
useAppStore.subscribe((state, prev) => {
  const before = extractSyncedKeys(prev as any);
  const after = extractSyncedKeys(state as any);
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  if (settingsPushTimer) clearTimeout(settingsPushTimer);
  settingsPushTimer = setTimeout(() => {
    const blob = extractSyncedKeys(useAppStore.getState() as any);
    invoke('enqueue_settings_blob', { blob: JSON.stringify(blob) }).catch(() => {});
  }, 2000);
});
```

- [ ] **Step 3: Add `enqueue_settings_blob` Rust IPC**

Append to `sync/commands.rs`:

```rust
#[tauri::command]
pub async fn enqueue_settings_blob(
    db: tauri::State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
    pusher: tauri::State<'_, crate::sync::pusher::Pusher>,
    blob: String,
) -> Result<(), String> {
    crate::error_reporter::wrap_cmd("enqueue_settings_blob", async move {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.conn().execute(
            "INSERT OR REPLACE INTO user_meta (key, value) VALUES ('pending_settings_blob', ?1)",
            rusqlite::params![blob],
        ).map_err(|e| e.to_string())?;
        crate::sync::queue::enqueue(&db, "settings", "settings")?;
        drop(db);
        pusher.notify();
        Ok::<(), String>(())
    }).await
}
```

Register in `invoke_handler`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settingsBlob.ts src/store/appStore.ts src-tauri/src/sync/commands.rs src-tauri/src/main.rs
git commit -m "feat(sync): settings blob extraction + Zustand subscription + enqueue command"
```

---

## Task 18: Frontend - sync-status dot + Sync now button

**Files:**
- Create: `src/components/auth/SyncStatusDot.tsx`
- Modify: `src/components/auth/UserMenu.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Implement `SyncStatusDot.tsx`**

```tsx
// src/components/auth/SyncStatusDot.tsx
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

type StatusState =
  | { state: 'idle'; last_synced_at?: string }
  | { state: 'syncing' }
  | { state: 'failed'; message: string; since: string }
  | { state: 'offline' };

export function SyncStatusDot() {
  const [status, setStatus] = useState<StatusState>({ state: 'idle' });

  useEffect(() => {
    const p = listen<StatusState>('sync-status', (e) => setStatus(e.payload));
    return () => { p.then(fn => fn()).catch(() => {}); };
  }, []);

  const color =
    status.state === 'syncing' ? 'bg-amber-500' :
    status.state === 'failed'  ? 'bg-red-500' :
    status.state === 'offline' ? 'bg-gray-500' : 'bg-emerald-500';

  const tooltip =
    status.state === 'idle'   ? (status.last_synced_at ? `Synced at ${new Date(status.last_synced_at).toLocaleTimeString()}` : 'Not synced yet') :
    status.state === 'syncing' ? 'Syncing...' :
    status.state === 'failed' ? `Failed: ${status.message}` : 'Offline';

  return <span title={tooltip} className={`ml-1 inline-block h-2 w-2 rounded-full ${color}`} />;
}
```

- [ ] **Step 2: Add to `UserMenu.tsx`**

In the signed-in branch, next to the initials avatar:

```tsx
import { SyncStatusDot } from './SyncStatusDot';
// ...
<span className="grid h-5 w-5 place-items-center rounded-full bg-[--accent] text-[10px] font-medium text-white">
  {initialsOf(user.email)}
</span>
<SyncStatusDot />
```

And add a "Sync now" button inside the dropdown:

```tsx
import { invoke } from '@tauri-apps/api/core';
// ...
<button
  className="block w-full rounded px-2 py-1 text-left hover:bg-white/5"
  onClick={() => {
    setMenuOpen(false);
    invoke('sync_now').catch(() => {});
    invoke('pull_now').catch(() => {});
  }}
>
  Sync now
</button>
```

- [ ] **Step 3: Wire pull-on-focus in `App.tsx`**

```tsx
useEffect(() => {
  const onFocus = () => invoke('pull_now').catch(() => {});
  window.addEventListener('focus', onFocus);
  invoke('pull_now').catch(() => {}); // initial pull
  return () => window.removeEventListener('focus', onFocus);
}, []);
```

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/SyncStatusDot.tsx src/components/auth/UserMenu.tsx src/App.tsx
git commit -m "feat(sync): sync-status dot, Sync-now button, pull-on-focus"
```

---

## Task 19: Fire MergeModal on first-login-on-device

**Files:**
- Modify: `src/App.tsx`

Subscribe to the `auth-first-login-on-device` event that Phase A already emits from Rust. On payload `true`, pull once, read local (post-pull) counts, open MergeModal with them.

```tsx
// Additions to App.tsx
import { MergeModal } from './components/auth/MergeModal';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// State:
const [mergeOpen, setMergeOpen] = useState(false);
const [accountCounts, setAccountCounts] = useState<any>(null);

useEffect(() => {
  const p = listen<boolean>('auth-first-login-on-device', async (e) => {
    if (!e.payload) return;
    await invoke('pull_now').catch(() => {});
    const counts = await invoke<any>('merge_get_counts');
    setAccountCounts(counts);
    setMergeOpen(true);
  });
  return () => { p.then(fn => fn()).catch(() => {}); };
}, []);

// JSX:
{mergeOpen && accountCounts && (
  <MergeModal open={mergeOpen} accountCounts={accountCounts} onClose={() => setMergeOpen(false)} />
)}
```

Manual verify: sign in on a fresh device with existing local data. Confirm the modal appears with plausible counts.

Commit:

```bash
git add src/App.tsx
git commit -m "feat(sync): MergeModal fires on first login with account data"
```

---

## Task 20: Extend heartbeat with user_id

**Files:**
- Modify: `workers/ct-analytics/src/index.ts` (existing heartbeat handler)
- Modify: `src-tauri/src/telemetry.rs` (or wherever heartbeats are constructed)

- [ ] **Step 1: Add `user_id` to the client heartbeat body**

Look up the current session's user via a new small helper:

```rust
// In src-tauri/src/auth/session.rs (add):
pub async fn cached_user_id(app: &tauri::AppHandle) -> Option<String> {
    let token = keychain::load_session_token(app).ok().flatten()?;
    fetch_me(&token).await.ok().map(|u| u.user_id)
}
```

Then include it in the heartbeat:

```rust
let user_id = crate::auth::session::cached_user_id(&app).await;
let body = serde_json::json!({
    "installation_id": installation_id,
    "app_version": app_version,
    "os": os,
    "os_version": os_version,
    "user_id": user_id,
});
```

Also send the Bearer header so the Worker can trust `user_id`:

```rust
let mut req = reqwest::Client::new().post(url).json(&body);
if let Some(tok) = keychain::load_session_token(&app).ok().flatten() {
    req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {}", tok));
}
req.send().await ...
```

- [ ] **Step 2: Update Worker heartbeat handler**

After the existing anonymous-heartbeat writes, add:

```typescript
if (typeof body.user_id === 'string' && body.user_id.length > 0) {
  const token = extractBearer(request) ?? extractCookie(request, 'ct_session');
  if (token) {
    const session = await lookupSession(env.DB, token);
    if (session && session.user_id === body.user_id) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO user_installations (installation_id, user_id, first_linked_at, last_seen_at, os, os_version, app_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, user_id) DO UPDATE
            SET last_seen_at = excluded.last_seen_at,
                os = excluded.os, os_version = excluded.os_version, app_version = excluded.app_version`,
      ).bind(body.installation_id, body.user_id, now, now, body.os, body.os_version, body.app_version).run();
      await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE user_id = ?').bind(now, body.user_id).run();
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/src/index.ts src-tauri/src/telemetry.rs src-tauri/src/auth/session.rs
git commit -m "feat(analytics): heartbeat carries user_id when signed in"
```

---

## Task 21: End-to-end manual verification

- [ ] **Two-PC convergence**: install v1.34.0 on PC A and PC B; sign into the same account on both; create a profile on A; click Sync now on B within 10 seconds; verify the profile appears; edit on B; verify on A after Sync now.
- [ ] **Log upload**: finish a Claude Code session on PC A; wait a few seconds; check the R2 bucket - `users/<user_id>/logs/<uuid>.log.gz` should exist; open the session in PC B's Session History; verify the log body loads via presigned URL.
- [ ] **Guest merge**: sign out on PC A; create profile "guest-only" in guest mode; sign into a *different* account; confirm MergeModal appears with correct counts; pick "Keep both"; verify "guest-only" is on the new account when signing in on PC B.
- [ ] **Killswitch**: set `SYNC_ENABLED=false` on the Worker and deploy; both PCs' next sync attempt should return 503 and the status dot goes red with tooltip. Reset to `true`; dot returns green within 30 seconds.

---

## Task 22: Release v1.34.0

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, `src/changelog.json`

- [ ] **Step 1: Bump versions**

Everywhere: 1.33.0 -> 1.34.0.

- [ ] **Step 2: Changelog entry**

```json
{
  "version": "1.34.0",
  "date": "2026-09-19",
  "title": "Cross-device sync",
  "highlights": [
    "Your profiles, workspaces, snippets, and settings now sync across every PC you sign in to.",
    "Session history (including log bodies) is browsable from any PC.",
    "First-time sign-in on a device with local data offers to merge, replace, or push local up to the account."
  ]
}
```

- [ ] **Step 3: Refresh Cargo.lock and commit**

```bash
cd src-tauri && cargo check && cd ..
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json README.md src/changelog.json
git commit -m "Release v1.34.0"
git tag v1.34.0
git push origin master --tags
```

- [ ] **Step 4: Deploy Worker with `SYNC_ENABLED` still false**

```bash
cd workers/ct-analytics
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

- [ ] **Step 5: Progressive rollout**

Wait ~24h after the client release lands on GitHub so users receive it via auto-updater. Then flip `SYNC_ENABLED=true` in the Worker and redeploy. Watch `/errors/summary` and D1 growth over the next 24h. If push failures spike, flip `SYNC_ENABLED=false`.

---

## Self-Review Notes

Cross-checked against Section 6 (sync engine), Section 7 sync-status dot bullet, Section 9.1 (offline), Section 9.3 (conflict resolution), Section 9.4 (log upload), Section 10.7 (rollback).

Deferred to phase C (out of scope for this plan):
- Admin dashboard's Users tab
- `admin_audit` table and endpoints
- Cookie-based auth on `/stat`
- Cloudflare Pages project

Placeholder scan: none.

Type consistency: `PushRequest`/`PushResponse`/`PullRequest`/`PullResponse` shapes match between `schema.ts`, the Rust `PushPayload`, and both handlers. `MergeChoice` names (`merge` / `replace_local_with_account` / `push_local_up_to_account`) match between Rust `serde` tags and the React invoke calls.
