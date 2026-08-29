# Account Auth Phase C - Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin dashboard for `/stat` so you (Tal) can see who is using the app: total signups, recent signup counts, a searchable user list, per-user detail (installations, sessions, sync footprint, app version), a "revoke sessions" action, and an audit log of every admin action.

**Architecture:** A small Vite + React SPA lives in a new `workers/ct-analytics-dashboard/` directory and deploys to Cloudflare Pages at `stat.agentrium.app`. It authenticates via the same WorkOS AuthKit setup as the desktop app but through the browser-native OAuth flow (WorkOS redirects to `https://stat.agentrium.app/auth/callback`, which is a route on the existing ct-analytics Worker that sets an HttpOnly `ct_session` cookie). The Worker's existing `/stat/*` routes remain accessible via the legacy `STATS_TOKEN` header for CLI use; the new `/admin/*` routes require the cookie plus `users.admin = 1`. Every admin endpoint writes an `admin_audit` row *before* returning.

**Tech Stack:**
- Cloudflare Pages (Vite + React 18 + TypeScript, no server-side rendering)
- Existing Worker with new `admin/` and `stat/` modules
- Tailwind CSS for styling (already in ClaudeTerminal; consistent look)
- Miniflare pool for handler tests, Vitest for TS tests
- No new backend services

**Prerequisites (external, do these before Task 1):**

1. Set up DNS: `stat.agentrium.app` CNAME to Cloudflare Pages once the project exists (created in Task 10). Alternately, use a subroute like `ct-analytics.<domain>/stat/*` if you prefer to avoid a new subdomain. This plan assumes the subdomain path.
2. In WorkOS, add `https://stat.agentrium.app/auth/callback` to the redirect URI allow-list.
3. Set the Worker vars in `wrangler.toml`:
   ```toml
   DASHBOARD_ORIGIN = "https://stat.agentrium.app"
   ```

**File structure created / modified by this plan:**

*Cloudflare Worker (new):*
- `workers/ct-analytics/migrations/0003_admin.sql` - `admin_audit` table
- `workers/ct-analytics/src/admin/audit.ts` - `writeAudit()` helper
- `workers/ct-analytics/src/admin/require_admin.ts` - session + admin flag check
- `workers/ct-analytics/src/admin/users.ts` - list, detail, revoke
- `workers/ct-analytics/src/admin/audit_handler.ts` - `GET /admin/audit`
- `workers/ct-analytics/src/stat/auth.ts` - browser OAuth start + callback

*Cloudflare Worker (modified):*
- `workers/ct-analytics/src/index.ts` - route `/admin/*` and `/stat/auth/*`

*Cloudflare Pages (new project under `workers/ct-analytics-dashboard/`):*
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `index.html`
- `src/main.tsx`, `src/App.tsx`
- `src/components/AppLayout.tsx`, `src/components/LoginPage.tsx`, `src/components/UsersTable.tsx`, `src/components/UserDetailDrawer.tsx`, `src/components/AuditTable.tsx`
- `src/lib/api.ts`, `src/lib/auth.ts`
- `wrangler.toml`, `.gitignore`

*Release:*
- Version bump to 1.35.0 (client no-op; the version reflects that the dashboard shipped)

---

## Task 1: D1 admin_audit migration

**Files:**
- Create: `workers/ct-analytics/migrations/0003_admin.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0003_admin.sql
-- Every admin-initiated read/write records one row here BEFORE the endpoint
-- returns its response. Cheap and it's the ledger you point at when a user
-- asks "who looked at my data?".

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- 'view_users', 'view_user', 'revoke_sessions', 'view_audit'
  target_user_id TEXT,            -- NULL for list views
  details_json TEXT,              -- JSON payload with the request particulars
  at TEXT NOT NULL,
  ip TEXT,
  country TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_user_id);
```

- [ ] **Step 2: Apply**

```bash
cd workers/ct-analytics
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote
```

Expected: `Migrations applied: 0003_admin.sql` on both.

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/migrations/0003_admin.sql
git commit -m "feat(worker): admin_audit table for admin action ledger"
```

---

## Task 2: `writeAudit` helper

**Files:**
- Create: `workers/ct-analytics/src/admin/audit.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/audit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/admin/__tests__/audit.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { writeAudit } from '../audit';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_audit').run();
});

describe('writeAudit', () => {
  it('inserts a row with all metadata', async () => {
    const fakeReq = new Request('https://x/admin/users?q=foo', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    await writeAudit(env.DB, {
      admin_user_id: 'user_A',
      action: 'view_users',
      target_user_id: null,
      details: { query: 'foo' },
      req: fakeReq,
    });
    const row: any = await env.DB.prepare('SELECT * FROM admin_audit').first();
    expect(row.admin_user_id).toBe('user_A');
    expect(row.action).toBe('view_users');
    expect(row.target_user_id).toBeNull();
    expect(JSON.parse(row.details_json).query).toBe('foo');
    expect(row.ip).toBe('1.2.3.4');
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/admin/audit.ts
import type { D1Database } from '@cloudflare/workers-types';

export interface AuditEntry {
  admin_user_id: string;
  action: 'view_users' | 'view_user' | 'revoke_sessions' | 'view_audit';
  target_user_id: string | null;
  details: Record<string, unknown> | null;
  req: Request;
}

export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  const ip = entry.req.headers.get('CF-Connecting-IP')
    ?? entry.req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    ?? null;
  const country = (entry.req as any).cf?.country ?? null;

  await db.prepare(
    `INSERT INTO admin_audit (admin_user_id, action, target_user_id, details_json, at, ip, country)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    entry.admin_user_id,
    entry.action,
    entry.target_user_id,
    entry.details ? JSON.stringify(entry.details) : null,
    new Date().toISOString(),
    ip,
    country,
  ).run();
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/audit.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/audit.ts workers/ct-analytics/src/admin/__tests__/audit.test.ts
git commit -m "feat(worker): writeAudit helper for admin action ledger"
```

---

## Task 3: `requireAdmin` middleware

**Files:**
- Create: `workers/ct-analytics/src/admin/require_admin.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/require_admin.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/admin/__tests__/require_admin.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { requireAdmin } from '../require_admin';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seedUser(admin: 0 | 1): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind('user_A', 'a@x.com', 'google', now, now, admin).run();
  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_A', installation_id: 'i', origin: 'dashboard',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('requireAdmin', () => {
  it('returns 401 without a session', async () => {
    const req = new Request('https://x/admin/users');
    const res = await requireAdmin(req, env);
    expect(res instanceof Response ? res.status : 0).toBe(401);
  });

  it('returns 403 when the user is not admin', async () => {
    const t = await seedUser(0);
    const req = new Request('https://x/admin/users', {
      headers: { Cookie: `ct_session=${t}` },
    });
    const res = await requireAdmin(req, env);
    expect(res instanceof Response ? res.status : 0).toBe(403);
  });

  it('returns the admin user_id when authorized', async () => {
    const t = await seedUser(1);
    const req = new Request('https://x/admin/users', {
      headers: { Cookie: `ct_session=${t}` },
    });
    const res = await requireAdmin(req, env);
    expect(res).toEqual({ admin_user_id: 'user_A' });
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/admin/require_admin.ts
import type { D1Database } from '@cloudflare/workers-types';
import { lookupSession } from '../auth/sessions';

interface Env { DB: D1Database; }

function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v ?? null;
  }
  return null;
}

export async function requireAdmin(req: Request, env: Env): Promise<{ admin_user_id: string } | Response> {
  const token = extractCookie(req, 'ct_session')
    ?? req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
    ?? null;
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

  const user = await env.DB.prepare('SELECT admin FROM users WHERE user_id = ?')
    .bind(session.user_id).first<{ admin: number }>();
  if (!user || user.admin !== 1) {
    return new Response(JSON.stringify({ error: 'not_admin' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
  return { admin_user_id: session.user_id };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/require_admin.test.ts
```

Expected: PASS 3.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/require_admin.ts workers/ct-analytics/src/admin/__tests__/require_admin.test.ts
git commit -m "feat(worker): requireAdmin middleware (cookie or bearer + admin flag)"
```

---

## Task 4: `GET /admin/users` with search, sort, cursor, totals

**Files:**
- Create: `workers/ct-analytics/src/admin/users.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/users.list.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/admin/__tests__/users.list.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleListUsers } from '../users';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seedAdminAndUsers(): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind('user_admin', 'admin@x.com', 'google', now, now, 1).run();

  for (let i = 0; i < 5; i++) {
    await env.DB.prepare(
      'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(`user_${i}`, `u${i}@example.com`, 'google',
           new Date(Date.now() - i * 86400000).toISOString(),
           new Date(Date.now() - i * 3600000).toISOString(), 0).run();
  }
  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_admin', installation_id: 'i', origin: 'dashboard',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_audit').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM user_installations').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('handleListUsers', () => {
  it('returns all users + totals', async () => {
    const t = await seedAdminAndUsers();
    const req = new Request('https://x/admin/users', { headers: { Cookie: `ct_session=${t}` } });
    const res = await handleListUsers(req, env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.rows.length).toBe(6); // 5 users + admin
    expect(json.totals.total).toBe(6);
    expect(json.totals.signups_24h).toBeGreaterThan(0);
  });

  it('filters by email substring', async () => {
    const t = await seedAdminAndUsers();
    const req = new Request('https://x/admin/users?q=u2', { headers: { Cookie: `ct_session=${t}` } });
    const res = await handleListUsers(req, env);
    const json: any = await res.json();
    expect(json.rows.map((r: any) => r.email)).toEqual(['u2@example.com']);
  });

  it('paginates with cursor', async () => {
    const t = await seedAdminAndUsers();
    const first = await handleListUsers(
      new Request('https://x/admin/users?limit=2', { headers: { Cookie: `ct_session=${t}` } }),
      env,
    );
    const firstJson: any = await first.json();
    expect(firstJson.rows.length).toBe(2);
    expect(firstJson.next_cursor).toBeDefined();

    const second = await handleListUsers(
      new Request(`https://x/admin/users?limit=2&cursor=${encodeURIComponent(firstJson.next_cursor)}`, {
        headers: { Cookie: `ct_session=${t}` },
      }),
      env,
    );
    const secondJson: any = await second.json();
    expect(secondJson.rows.length).toBe(2);
    const firstIds = firstJson.rows.map((r: any) => r.user_id);
    const secondIds = secondJson.rows.map((r: any) => r.user_id);
    expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
  });

  it('writes an audit entry', async () => {
    const t = await seedAdminAndUsers();
    await handleListUsers(
      new Request('https://x/admin/users?q=foo', { headers: { Cookie: `ct_session=${t}` } }),
      env,
    );
    const row: any = await env.DB.prepare('SELECT * FROM admin_audit').first();
    expect(row.action).toBe('view_users');
    expect(JSON.parse(row.details_json).q).toBe('foo');
  });

  it('rejects non-admin with 403', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind('user_normal', 'n@x.com', 'google', now, now, 0).run();
    const t = generateSessionToken();
    await createSession(env.DB, t, {
      user_id: 'user_normal', installation_id: 'i', origin: 'dashboard',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const res = await handleListUsers(
      new Request('https://x/admin/users', { headers: { Cookie: `ct_session=${t}` } }),
      env,
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/admin/users.ts
import type { D1Database } from '@cloudflare/workers-types';
import { requireAdmin } from './require_admin';
import { writeAudit } from './audit';

interface Env { DB: D1Database; }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function decodeCursor(cursor: string | null): { last_seen_at: string; user_id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = atob(cursor);
    const parts = decoded.split(String.fromCharCode(0x1f));
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { last_seen_at: parts[0], user_id: parts[1] };
  } catch {
    return null;
  }
}

function encodeCursor(row: { last_seen_at: string; user_id: string }): string {
  return btoa(`${row.last_seen_at}${String.fromCharCode(0x1f)}${row.user_id}`);
}

export async function handleListUsers(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? null;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursor = decodeCursor(url.searchParams.get('cursor'));

  await writeAudit(env.DB, {
    admin_user_id: admin.admin_user_id,
    action: 'view_users',
    target_user_id: null,
    details: { q, limit },
    req,
  });

  const clauses: string[] = ['deleted_at IS NULL'];
  const args: unknown[] = [];
  if (q) { clauses.push('email LIKE ?'); args.push(`%${q}%`); }
  if (cursor) {
    clauses.push('(last_seen_at, user_id) < (?, ?)');
    args.push(cursor.last_seen_at, cursor.user_id);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sqlList = `
    SELECT u.user_id, u.email, u.provider, u.created_at, u.last_seen_at,
           (SELECT COUNT(*) FROM user_installations i WHERE i.user_id = u.user_id) AS installation_count,
           (SELECT app_version FROM user_installations i WHERE i.user_id = u.user_id ORDER BY last_seen_at DESC LIMIT 1) AS app_version,
           (SELECT COUNT(*) FROM user_session_history h
              WHERE h.user_id = u.user_id
                AND h.deleted_at IS NULL
                AND h.started_at > datetime('now', '-30 days')) AS session_count_30d
      FROM users u
      ${where}
     ORDER BY last_seen_at DESC, user_id DESC
     LIMIT ?
  `;
  const rowsRes = await env.DB.prepare(sqlList).bind(...args, limit).all<any>();
  const rows = rowsRes.results ?? [];

  const totalsRow = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total,
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at > datetime('now', '-1 days')) AS signups_24h,
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at > datetime('now', '-7 days')) AS signups_7d,
      (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND created_at > datetime('now', '-30 days')) AS signups_30d
  `).first<any>();

  const next_cursor = rows.length === limit
    ? encodeCursor({ last_seen_at: rows[rows.length - 1].last_seen_at, user_id: rows[rows.length - 1].user_id })
    : null;

  return json({ rows, next_cursor, totals: totalsRow });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/users.list.test.ts
```

Expected: PASS all 5.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/users.ts workers/ct-analytics/src/admin/__tests__/users.list.test.ts
git commit -m "feat(worker): GET /admin/users with search, pagination, totals, audit"
```

---

## Task 5: `GET /admin/users/:user_id` (detail)

**Files:**
- Modify: `workers/ct-analytics/src/admin/users.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/users.detail.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/admin/__tests__/users.detail.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleUserDetail } from '../users';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seedAdminAndTarget(): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind('user_admin', 'a@x.com', 'google', now, now, 1).run();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).bind('user_target', 'target@x.com', 'github', now, now).run();
  await env.DB.prepare(
    `INSERT INTO user_installations (installation_id, user_id, first_linked_at, last_seen_at, os, os_version, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind('inst-1', 'user_target', now, now, 'windows', '10.0.26200', '1.34.0').run();

  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_admin', installation_id: 'i', origin: 'dashboard',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_audit').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM user_installations').run();
  await env.DB.prepare('DELETE FROM user_session_history').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('handleUserDetail', () => {
  it('returns user + installations + sessions_by_day + log_storage_bytes', async () => {
    const t = await seedAdminAndTarget();
    const req = new Request('https://x/admin/users/user_target', {
      headers: { Cookie: `ct_session=${t}` },
    });
    const res = await handleUserDetail(req, env, 'user_target');
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.user.email).toBe('target@x.com');
    expect(json.installations.length).toBe(1);
    expect(json.installations[0].os).toBe('windows');
    expect(json.sessions_by_day).toBeDefined();
    expect(json.log_storage_bytes).toBe(0);
  });

  it('returns 404 when the user does not exist', async () => {
    const t = await seedAdminAndTarget();
    const req = new Request('https://x/admin/users/does-not-exist', {
      headers: { Cookie: `ct_session=${t}` },
    });
    const res = await handleUserDetail(req, env, 'does-not-exist');
    expect(res.status).toBe(404);
  });

  it('writes an audit entry with target_user_id', async () => {
    const t = await seedAdminAndTarget();
    await handleUserDetail(new Request('https://x/admin/users/user_target', {
      headers: { Cookie: `ct_session=${t}` },
    }), env, 'user_target');
    const row: any = await env.DB.prepare('SELECT * FROM admin_audit').first();
    expect(row.action).toBe('view_user');
    expect(row.target_user_id).toBe('user_target');
  });
});
```

- [ ] **Step 2: Implement in `users.ts`**

Append to `workers/ct-analytics/src/admin/users.ts`:

```typescript
export async function handleUserDetail(req: Request, env: Env, user_id: string): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const user = await env.DB.prepare(
    'SELECT user_id, email, provider, created_at, last_seen_at, admin FROM users WHERE user_id = ?',
  ).bind(user_id).first<any>();
  if (!user) return json({ error: 'not_found' }, 404);

  await writeAudit(env.DB, {
    admin_user_id: admin.admin_user_id,
    action: 'view_user',
    target_user_id: user_id,
    details: null,
    req,
  });

  const installsRes = await env.DB.prepare(
    'SELECT installation_id, os, os_version, app_version, first_linked_at, last_seen_at FROM user_installations WHERE user_id = ? ORDER BY last_seen_at DESC',
  ).bind(user_id).all<any>();

  const activeSessionsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(user_id, new Date().toISOString()).first<{ n: number }>();

  const sessionsByDayRes = await env.DB.prepare(
    `SELECT substr(started_at, 1, 10) AS date, COUNT(*) AS count
       FROM user_session_history
      WHERE user_id = ? AND deleted_at IS NULL
        AND started_at > datetime('now', '-30 days')
      GROUP BY substr(started_at, 1, 10)
      ORDER BY date ASC`,
  ).bind(user_id).all<{ date: string; count: number }>();

  const storageRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(log_size_bytes), 0) AS bytes
       FROM user_session_history
      WHERE user_id = ? AND log_size_bytes IS NOT NULL`,
  ).bind(user_id).first<{ bytes: number }>();

  return json({
    user,
    installations: installsRes.results ?? [],
    active_sessions: activeSessionsRow?.n ?? 0,
    sessions_by_day: sessionsByDayRes.results ?? [],
    log_storage_bytes: storageRow?.bytes ?? 0,
  });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/users.detail.test.ts
```

Expected: PASS 3.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/users.ts workers/ct-analytics/src/admin/__tests__/users.detail.test.ts
git commit -m "feat(worker): GET /admin/users/:user_id with installations, activity, storage"
```

---

## Task 6: `POST /admin/users/:user_id/revoke_sessions`

**Files:**
- Modify: `workers/ct-analytics/src/admin/users.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/users.revoke.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/admin/__tests__/users.revoke.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleRevokeSessions } from '../users';
import { generateSessionToken, createSession } from '../../auth/sessions';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_audit').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('handleRevokeSessions', () => {
  it('sets revoked_at on every live session for the target', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind('user_admin', 'a@x.com', 'google', now, now, 1).run();
    await env.DB.prepare(
      'INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ).bind('user_target', 't@x.com', 'google', now, now).run();

    for (let i = 0; i < 2; i++) {
      const t = generateSessionToken();
      await createSession(env.DB, t, {
        user_id: 'user_target', installation_id: `i${i}`, origin: 'desktop',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    const adminToken = generateSessionToken();
    await createSession(env.DB, adminToken, {
      user_id: 'user_admin', installation_id: 'a', origin: 'dashboard',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });

    const res = await handleRevokeSessions(
      new Request('https://x/admin/users/user_target/revoke_sessions', {
        method: 'POST', headers: { Cookie: `ct_session=${adminToken}` },
      }),
      env, 'user_target',
    );
    expect(res.status).toBe(200);

    const targetLive = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
    ).bind('user_target').first<{ n: number }>();
    expect(targetLive?.n).toBe(0);

    const adminLive = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
    ).bind('user_admin').first<{ n: number }>();
    expect(adminLive?.n).toBe(1);

    const audit: any = await env.DB.prepare('SELECT * FROM admin_audit').first();
    expect(audit.action).toBe('revoke_sessions');
    expect(audit.target_user_id).toBe('user_target');
  });
});
```

- [ ] **Step 2: Implement in `users.ts`**

Append:

```typescript
export async function handleRevokeSessions(req: Request, env: Env, user_id: string): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  await writeAudit(env.DB, {
    admin_user_id: admin.admin_user_id,
    action: 'revoke_sessions',
    target_user_id: user_id,
    details: null,
    req,
  });

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
  ).bind(now, user_id).run();

  return json({ ok: true, revoked: result.meta?.changes ?? 0 });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/users.revoke.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/users.ts workers/ct-analytics/src/admin/__tests__/users.revoke.test.ts
git commit -m "feat(worker): POST /admin/users/:id/revoke_sessions with audit"
```

---

## Task 7: `GET /admin/audit`

**Files:**
- Create: `workers/ct-analytics/src/admin/audit_handler.ts`
- Test: `workers/ct-analytics/src/admin/__tests__/audit_handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/admin/__tests__/audit_handler.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleAuditList } from '../audit_handler';
import { generateSessionToken, createSession } from '../../auth/sessions';

async function seedAdmin(): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind('user_admin', 'a@x.com', 'google', now, now, 1).run();
  const t = generateSessionToken();
  await createSession(env.DB, t, {
    user_id: 'user_admin', installation_id: 'i', origin: 'dashboard',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return t;
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM admin_audit').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('handleAuditList', () => {
  it('returns rows ordered by at DESC', async () => {
    const t = await seedAdmin();
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        'INSERT INTO admin_audit (admin_user_id, action, at) VALUES (?, ?, ?)',
      ).bind('user_admin', 'view_users', new Date(Date.now() - i * 60000).toISOString()).run();
    }
    const res = await handleAuditList(
      new Request('https://x/admin/audit?limit=10', { headers: { Cookie: `ct_session=${t}` } }),
      env,
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.rows.length).toBe(4); // 3 seeded + the view_audit written by this call
    for (let i = 1; i < json.rows.length; i++) {
      expect(json.rows[i - 1].at >= json.rows[i].at).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// workers/ct-analytics/src/admin/audit_handler.ts
import type { D1Database } from '@cloudflare/workers-types';
import { requireAdmin } from './require_admin';
import { writeAudit } from './audit';

interface Env { DB: D1Database; }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function handleAuditList(req: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(req, env);
  if (admin instanceof Response) return admin;

  const url = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const since = url.searchParams.get('since');
  const target = url.searchParams.get('target_user_id');

  await writeAudit(env.DB, {
    admin_user_id: admin.admin_user_id,
    action: 'view_audit',
    target_user_id: target,
    details: { since, limit },
    req,
  });

  const clauses: string[] = [];
  const args: unknown[] = [];
  if (since) { clauses.push('at > ?'); args.push(since); }
  if (target) { clauses.push('target_user_id = ?'); args.push(target); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rowsRes = await env.DB.prepare(
    `SELECT id, admin_user_id, action, target_user_id, details_json, at, ip, country
       FROM admin_audit ${where}
      ORDER BY at DESC
      LIMIT ?`,
  ).bind(...args, limit).all<any>();

  return json({ rows: rowsRes.results ?? [] });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/admin/__tests__/audit_handler.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/admin/audit_handler.ts workers/ct-analytics/src/admin/__tests__/audit_handler.test.ts
git commit -m "feat(worker): GET /admin/audit with since/target filters"
```

---

## Task 8: Browser OAuth (start + callback) for dashboard

**Files:**
- Create: `workers/ct-analytics/src/stat/auth.ts`

- [ ] **Step 1: Implement**

```typescript
// workers/ct-analytics/src/stat/auth.ts
import type { D1Database } from '@cloudflare/workers-types';
import { requireAuthEnabled } from '../auth/killswitch';
import { workosAuthorize, workosAuthenticate, type Provider } from '../auth/workos';
import { generateSessionToken, createSession } from '../auth/sessions';

interface Env {
  DB: D1Database;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  ADMIN_EMAILS?: string;
  DASHBOARD_ORIGIN: string;
  AUTH_ENABLED?: string;
}

const SESSION_TTL_HOURS = 24 * 30;

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function base64UrlSha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleStatAuthStart(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  const url = new URL(req.url);
  const provider = (url.searchParams.get('provider') ?? 'google') as Provider;
  if (provider === 'password') return new Response('Not supported for dashboard', { status: 400 });

  const state = randomHex(32);
  const verifier = randomHex(48);
  const challenge = await base64UrlSha256(verifier);

  const redirect_uri = `${env.DASHBOARD_ORIGIN}/auth/callback`;
  const authUrl = workosAuthorize(env, {
    provider: provider as Exclude<Provider, 'password'>,
    redirect_uri, state, code_challenge: challenge,
  });

  const headers = new Headers({ Location: authUrl });
  headers.append('Set-Cookie', `ct_stat_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
  headers.append('Set-Cookie', `ct_stat_verifier=${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}

function extractCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return v ?? null;
  }
  return null;
}

function isAdminEmail(env: Env, email: string): boolean {
  if (!env.ADMIN_EMAILS) return false;
  return env.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).includes(email.toLowerCase());
}

export async function handleStatAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = extractCookie(req, 'ct_stat_state');
  const verifier = extractCookie(req, 'ct_stat_verifier');

  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    return new Response('Sign-in failed. Try again.', { status: 400 });
  }

  const workos = await workosAuthenticate(env, { code, code_verifier: verifier }).catch(() => null);
  if (!workos) return new Response('Sign-in failed at provider.', { status: 502 });

  const nowIso = new Date().toISOString();
  const email = workos.user.email;
  const user_id = workos.user.id;
  const admin = isAdminEmail(env, email) ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
        SET email = excluded.email,
            last_seen_at = excluded.last_seen_at,
            admin = MAX(users.admin, excluded.admin)`,
  ).bind(user_id, email, 'google', nowIso, nowIso, admin).run();

  const raw = generateSessionToken();
  const expires_at = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await createSession(env.DB, raw, { user_id, installation_id: 'dashboard', origin: 'dashboard', expires_at });

  const headers = new Headers({ Location: '/stat/' });
  headers.append('Set-Cookie', `ct_session=${raw}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}`);
  headers.append('Set-Cookie', 'ct_stat_state=; Path=/auth; Max-Age=0');
  headers.append('Set-Cookie', 'ct_stat_verifier=; Path=/auth; Max-Age=0');
  return new Response(null, { status: 302, headers });
}

export async function handleStatLogout(req: Request, env: Env): Promise<Response> {
  const token = extractCookie(req, 'ct_session');
  if (token) {
    const hash = await sha256Hex(token);
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE session_token_hash = ?')
      .bind(new Date().toISOString(), hash).run();
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/stat/login',
      'Set-Cookie': 'ct_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add workers/ct-analytics/src/stat/auth.ts
git commit -m "feat(worker): browser OAuth flow for /stat dashboard"
```

---

## Task 9: Wire admin and stat routes into `index.ts`

**Files:**
- Modify: `workers/ct-analytics/src/index.ts`

- [ ] **Step 1: Add routes**

Use `String.prototype.match` rather than regex `.exec` to keep the routing style consistent with the rest of the router:

```typescript
import { handleListUsers, handleUserDetail, handleRevokeSessions } from './admin/users';
import { handleAuditList } from './admin/audit_handler';
import { handleStatAuthStart, handleStatAuthCallback, handleStatLogout } from './stat/auth';

// Inside the fetch handler, alongside existing routes:
if (request.method === 'GET' && url.pathname === '/admin/users')  return handleListUsers(request, env);
{
  const m = url.pathname.match(/^\/admin\/users\/([A-Za-z0-9_-]+)$/);
  if (m && request.method === 'GET') return handleUserDetail(request, env, m[1]);
}
{
  const m = url.pathname.match(/^\/admin\/users\/([A-Za-z0-9_-]+)\/revoke_sessions$/);
  if (m && request.method === 'POST') return handleRevokeSessions(request, env, m[1]);
}
if (request.method === 'GET' && url.pathname === '/admin/audit') return handleAuditList(request, env);

if (request.method === 'GET'  && url.pathname === '/auth/start')    return handleStatAuthStart(request, env);
if (request.method === 'GET'  && url.pathname === '/auth/callback') return handleStatAuthCallback(request, env);
if (request.method === 'POST' && url.pathname === '/auth/logout')   return handleStatLogout(request, env);
```

- [ ] **Step 2: Deploy preview and smoke-test**

```bash
cd workers/ct-analytics
npx wrangler deploy --env=preview
curl "https://<preview>/admin/users"
```

Expected: `{ "error": "no_session" }` with 401.

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/src/index.ts
git commit -m "feat(worker): route /admin/* and /auth/start|callback|logout for dashboard"
```

---

## Task 10: Scaffold Cloudflare Pages project

**Files:**
- Create: `workers/ct-analytics-dashboard/package.json`
- Create: `workers/ct-analytics-dashboard/vite.config.ts`
- Create: `workers/ct-analytics-dashboard/tsconfig.json`
- Create: `workers/ct-analytics-dashboard/tailwind.config.js`
- Create: `workers/ct-analytics-dashboard/postcss.config.js`
- Create: `workers/ct-analytics-dashboard/index.html`
- Create: `workers/ct-analytics-dashboard/src/main.tsx`
- Create: `workers/ct-analytics-dashboard/src/index.css`
- Create: `workers/ct-analytics-dashboard/wrangler.toml`
- Create: `workers/ct-analytics-dashboard/.gitignore`

- [ ] **Step 1: package.json**

```json
{
  "name": "ct-analytics-dashboard",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "deploy": "wrangler pages deploy dist --project-name=ct-analytics-dashboard"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.41",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.4",
    "vite": "^5.4.2",
    "wrangler": "^3.72.0"
  }
}
```

- [ ] **Step 2: vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // In dev, proxy the API calls to the Worker's preview URL.
      // Override VITE_API_BASE in .env.local for local hacking.
      '/admin':  { target: process.env.VITE_API_BASE ?? 'http://localhost:8787', changeOrigin: true },
      '/auth':   { target: process.env.VITE_API_BASE ?? 'http://localhost:8787', changeOrigin: true },
      '/stats':  { target: process.env.VITE_API_BASE ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
});
```

- [ ] **Step 3: tsconfig.json, tailwind.config.js, postcss.config.js, index.html**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

```js
// tailwind.config.js
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

```js
// postcss.config.js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```html
<!-- index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentrium /stat</title>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: `src/main.tsx` and `src/index.css`**

```tsx
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

```css
/* src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: `wrangler.toml` and `.gitignore`**

```toml
# wrangler.toml
name = "ct-analytics-dashboard"
compatibility_date = "2026-08-01"
pages_build_output_dir = "dist"
```

```
# .gitignore
node_modules
dist
.wrangler
.env.local
```

- [ ] **Step 6: Install and verify build**

```bash
cd workers/ct-analytics-dashboard
npm install
npm run build
```

Expected: `dist/` is populated with a minimal SPA.

- [ ] **Step 7: Commit**

```bash
git add workers/ct-analytics-dashboard/
git commit -m "chore(dashboard): Vite + React + Tailwind + Pages scaffold"
```

---

## Task 11: `App.tsx` + auth guard + routing

**Files:**
- Create: `workers/ct-analytics-dashboard/src/App.tsx`
- Create: `workers/ct-analytics-dashboard/src/lib/api.ts`
- Create: `workers/ct-analytics-dashboard/src/lib/auth.ts`
- Create: `workers/ct-analytics-dashboard/src/components/LoginPage.tsx`
- Create: `workers/ct-analytics-dashboard/src/components/AppLayout.tsx`

- [ ] **Step 1: `lib/api.ts`**

```typescript
// src/lib/api.ts
async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (res.status === 401) {
    window.location.href = '/stat/login';
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export interface UserRow {
  user_id: string;
  email: string;
  provider: string;
  created_at: string;
  last_seen_at: string;
  app_version: string | null;
  installation_count: number;
  session_count_30d: number;
}

export interface ListUsersResp {
  rows: UserRow[];
  next_cursor: string | null;
  totals: { total: number; signups_24h: number; signups_7d: number; signups_30d: number };
}

export function listUsers(params: { q?: string; cursor?: string | null; limit?: number }): Promise<ListUsersResp> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));
  return jsonFetch(`/admin/users?${qs.toString()}`);
}

export interface UserDetail {
  user: { user_id: string; email: string; provider: string; created_at: string; last_seen_at: string; admin: number };
  installations: Array<{ installation_id: string; os: string | null; os_version: string | null; app_version: string | null; first_linked_at: string; last_seen_at: string }>;
  active_sessions: number;
  sessions_by_day: Array<{ date: string; count: number }>;
  log_storage_bytes: number;
}

export function getUserDetail(user_id: string): Promise<UserDetail> {
  return jsonFetch(`/admin/users/${encodeURIComponent(user_id)}`);
}

export function revokeSessions(user_id: string): Promise<{ ok: boolean; revoked: number }> {
  return jsonFetch(`/admin/users/${encodeURIComponent(user_id)}/revoke_sessions`, { method: 'POST' });
}

export interface AuditRow {
  id: number;
  admin_user_id: string;
  action: string;
  target_user_id: string | null;
  details_json: string | null;
  at: string;
  ip: string | null;
  country: string | null;
}

export function listAudit(params: { target_user_id?: string; since?: string; limit?: number }): Promise<{ rows: AuditRow[] }> {
  const qs = new URLSearchParams();
  if (params.target_user_id) qs.set('target_user_id', params.target_user_id);
  if (params.since) qs.set('since', params.since);
  if (params.limit) qs.set('limit', String(params.limit));
  return jsonFetch(`/admin/audit?${qs.toString()}`);
}
```

- [ ] **Step 2: `lib/auth.ts`**

```typescript
// src/lib/auth.ts
export function startLogin(provider: 'google' | 'github' | 'microsoft'): void {
  window.location.href = `/auth/start?provider=${provider}`;
}

export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/stat/login';
}
```

- [ ] **Step 3: `LoginPage.tsx`**

```tsx
// src/components/LoginPage.tsx
import { startLogin } from '../lib/auth';

export function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-[380px] rounded-lg bg-slate-900 p-8 shadow-xl">
        <h1 className="mb-6 text-center text-xl font-semibold">Agentrium admin</h1>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => startLogin('google')}
            className="rounded-md border border-white/10 bg-slate-800 py-2 text-sm hover:bg-slate-700"
          >
            Continue with Google
          </button>
          <button
            onClick={() => startLogin('github')}
            className="rounded-md border border-white/10 bg-slate-800 py-2 text-sm hover:bg-slate-700"
          >
            Continue with GitHub
          </button>
          <button
            onClick={() => startLogin('microsoft')}
            className="rounded-md border border-white/10 bg-slate-800 py-2 text-sm hover:bg-slate-700"
          >
            Continue with Microsoft
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `AppLayout.tsx`**

```tsx
// src/components/AppLayout.tsx
import { Link, Outlet, useLocation } from 'react-router-dom';
import { logout } from '../lib/auth';

export function AppLayout() {
  const loc = useLocation();
  const tab = (path: string, label: string) => (
    <Link
      to={path}
      className={`px-3 py-2 text-sm ${loc.pathname.startsWith(path) ? 'border-b-2 border-blue-400 text-white' : 'text-slate-400 hover:text-slate-200'}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="font-semibold">Agentrium /stat</span>
          {tab('/stat/users', 'Users')}
          {tab('/stat/audit', 'Audit')}
        </div>
        <button onClick={logout} className="text-xs text-slate-400 hover:text-slate-200">Sign out</button>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 5: `App.tsx`**

```tsx
// src/App.tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { LoginPage } from './components/LoginPage';
import { UsersPage } from './components/UsersTable';
import { AuditPage } from './components/AuditTable';

export function App() {
  return (
    <Routes>
      <Route path="/stat/login" element={<LoginPage />} />
      <Route path="/stat" element={<AppLayout />}>
        <Route index element={<Navigate to="/stat/users" replace />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/stat/users" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add workers/ct-analytics-dashboard/src/
git commit -m "feat(dashboard): App shell, auth pages, layout, API client"
```

---

## Task 12: Users tab with search + pagination + detail drawer

**Files:**
- Create: `workers/ct-analytics-dashboard/src/components/UsersTable.tsx`
- Create: `workers/ct-analytics-dashboard/src/components/UserDetailDrawer.tsx`

- [ ] **Step 1: `UsersTable.tsx`**

```tsx
// src/components/UsersTable.tsx
import { useEffect, useState } from 'react';
import { listUsers, type UserRow, type ListUsersResp } from '../lib/api';
import { UserDetailDrawer } from './UserDetailDrawer';

export function UsersPage() {
  const [data, setData] = useState<ListUsersResp | null>(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<UserRow | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      listUsers({ q, limit: 50 }).then(setData).catch((e) => console.error(e));
    }, q ? 200 : 0);
    return () => clearTimeout(handle);
  }, [q]);

  if (!data) return <div className="text-slate-400">Loading...</div>;

  return (
    <div>
      <div className="mb-4 flex items-baseline gap-6">
        <div>
          <div className="text-3xl font-semibold">{data.totals.total}</div>
          <div className="text-xs text-slate-400">total users</div>
        </div>
        <MetricBlock label="24h" v={data.totals.signups_24h} />
        <MetricBlock label="7d"  v={data.totals.signups_7d} />
        <MetricBlock label="30d" v={data.totals.signups_30d} />
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by email..."
        className="mb-4 w-full max-w-md rounded border border-white/10 bg-slate-900 px-3 py-2 text-sm"
      />

      <div className="overflow-hidden rounded border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Provider</th>
              <th className="px-3 py-2 text-left">Signed up</th>
              <th className="px-3 py-2 text-left">Last seen</th>
              <th className="px-3 py-2 text-left">Version</th>
              <th className="px-3 py-2 text-right">Installs</th>
              <th className="px-3 py-2 text-right">Sessions 30d</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr
                key={r.user_id}
                onClick={() => setSelected(r)}
                className="cursor-pointer border-t border-white/5 hover:bg-slate-900"
              >
                <td className="px-3 py-2">{r.email}</td>
                <td className="px-3 py-2 text-slate-400">{r.provider}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(r.created_at).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(r.last_seen_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-slate-400">{r.app_version ?? '-'}</td>
                <td className="px-3 py-2 text-right">{r.installation_count}</td>
                <td className="px-3 py-2 text-right">{r.session_count_30d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <UserDetailDrawer
          user_id={selected.user_id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function MetricBlock({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="text-lg font-medium">+{v}</div>
      <div className="text-xs text-slate-400">{label}</div>
    </div>
  );
}
```

- [ ] **Step 2: `UserDetailDrawer.tsx`**

```tsx
// src/components/UserDetailDrawer.tsx
import { useEffect, useState } from 'react';
import { getUserDetail, revokeSessions, type UserDetail } from '../lib/api';

export function UserDetailDrawer({ user_id, onClose }: { user_id: string; onClose: () => void }) {
  const [data, setData] = useState<UserDetail | null>(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    getUserDetail(user_id).then(setData).catch((e) => console.error(e));
  }, [user_id]);

  async function doRevoke() {
    if (!confirm('Revoke ALL active sessions for this user? They will be signed out on every device.')) return;
    setRevoking(true);
    try {
      const r = await revokeSessions(user_id);
      alert(`Revoked ${r.revoked} session(s)`);
      const fresh = await getUserDetail(user_id);
      setData(fresh);
    } finally { setRevoking(false); }
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[520px] overflow-y-auto border-l border-white/10 bg-slate-950 p-6 shadow-2xl">
      <button onClick={onClose} className="mb-4 text-xs text-slate-400 hover:text-slate-200">Close</button>
      {!data ? (
        <div className="text-slate-400">Loading...</div>
      ) : (
        <>
          <div className="mb-4">
            <div className="text-lg font-semibold">{data.user.email}</div>
            <div className="text-xs text-slate-400">
              {data.user.provider} - signed up {new Date(data.user.created_at).toLocaleString()}
            </div>
          </div>

          <Section title="Installations">
            <table className="w-full text-xs">
              <tbody>
                {data.installations.map((i) => (
                  <tr key={i.installation_id} className="border-t border-white/5">
                    <td className="py-1 text-slate-400">{i.os ?? '-'} {i.os_version ?? ''}</td>
                    <td className="py-1">{i.app_version ?? '-'}</td>
                    <td className="py-1 text-right text-slate-400">{new Date(i.last_seen_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Activity (last 30 days)">
            <Sparkline points={data.sessions_by_day} />
          </Section>

          <Section title="Sync footprint">
            <div className="text-xs text-slate-400">
              Log storage: {formatBytes(data.log_storage_bytes)}
              <br />
              Active sessions: {data.active_sessions}
            </div>
          </Section>

          <Section title="Admin actions">
            <button
              onClick={doRevoke}
              disabled={revoking}
              className="rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Revoke all sessions
            </button>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  );
}

function Sparkline({ points }: { points: Array<{ date: string; count: number }> }) {
  if (points.length === 0) return <div className="text-xs text-slate-400">No activity.</div>;
  const max = Math.max(...points.map(p => p.count), 1);
  return (
    <div className="flex items-end gap-[2px]">
      {points.map(p => (
        <div key={p.date} title={`${p.date}: ${p.count}`}
             className="w-2 bg-blue-500" style={{ height: `${(p.count / max) * 40}px` }} />
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
```

- [ ] **Step 3: Local dev smoke-test**

```bash
cd workers/ct-analytics-dashboard
VITE_API_BASE=https://<preview-worker-url> npm run dev
```

Open `http://localhost:5173/stat/users`. Expect a redirect to `/stat/login` on the first API 401, sign in via one of the buttons, land back on `/stat/users`.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics-dashboard/src/
git commit -m "feat(dashboard): Users tab with totals, search, detail drawer, revoke action"
```

---

## Task 13: Audit tab

**Files:**
- Create: `workers/ct-analytics-dashboard/src/components/AuditTable.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/AuditTable.tsx
import { useEffect, useState } from 'react';
import { listAudit, type AuditRow } from '../lib/api';

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [targetFilter, setTargetFilter] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => {
      listAudit({ target_user_id: targetFilter || undefined, limit: 200 })
        .then((r) => setRows(r.rows))
        .catch((e) => console.error(e));
    }, targetFilter ? 200 : 0);
    return () => clearTimeout(handle);
  }, [targetFilter]);

  return (
    <div>
      <input
        placeholder="Filter by target user_id..."
        value={targetFilter}
        onChange={(e) => setTargetFilter(e.target.value)}
        className="mb-4 w-full max-w-md rounded border border-white/10 bg-slate-900 px-3 py-2 text-sm"
      />
      <div className="overflow-hidden rounded border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Admin</th>
              <th className="px-3 py-2 text-left">Action</th>
              <th className="px-3 py-2 text-left">Target</th>
              <th className="px-3 py-2 text-left">Details</th>
              <th className="px-3 py-2 text-left">IP / Country</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-3 py-2 text-slate-400">{new Date(r.at).toLocaleString()}</td>
                <td className="px-3 py-2">{r.admin_user_id}</td>
                <td className="px-3 py-2">{r.action}</td>
                <td className="px-3 py-2 text-slate-400">{r.target_user_id ?? '-'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  <code>{r.details_json ?? ''}</code>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.ip ?? '-'} {r.country ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add workers/ct-analytics-dashboard/src/components/AuditTable.tsx
git commit -m "feat(dashboard): Audit tab"
```

---

## Task 14: Deploy Pages and configure DNS

- [ ] **Step 1: Create the Pages project**

```bash
cd workers/ct-analytics-dashboard
npm run build
npx wrangler pages project create ct-analytics-dashboard --production-branch=master
npm run deploy
```

Expected: `Deployed to https://ct-analytics-dashboard.pages.dev` (or similar).

- [ ] **Step 2: Add custom domain**

In the Cloudflare dashboard: Pages > ct-analytics-dashboard > Custom domains > Set up a custom domain > `stat.agentrium.app`.

Cloudflare provisions the TLS cert automatically once DNS resolves. If `agentrium.app` is a Cloudflare zone, adding the domain sets up the CNAME on your behalf.

- [ ] **Step 3: Verify**

```bash
curl -sI https://stat.agentrium.app/ | head -5
```

Expected: `HTTP/2 200`.

- [ ] **Step 4: Point OAuth callback and route API paths through Worker**

Confirm `https://stat.agentrium.app/auth/callback` is in the WorkOS redirect URI list. Then, to route `/auth/*`, `/admin/*`, and `/stats/*` from the Pages domain to the Worker (so cookies are same-origin), add Worker routes in the Worker's `wrangler.toml`:

```toml
routes = [
  { pattern = "stat.agentrium.app/auth/*", zone_name = "agentrium.app" },
  { pattern = "stat.agentrium.app/admin/*", zone_name = "agentrium.app" },
  { pattern = "stat.agentrium.app/stats/*", zone_name = "agentrium.app" },
]
```

Redeploy the Worker:

```bash
cd ../ct-analytics && npx wrangler deploy
```

Now `stat.agentrium.app` is a hybrid: the Pages static bundle serves `/stat/*`; the Worker serves `/auth`, `/admin`, `/stats`. All same-origin so the cookie flows work.

- [ ] **Step 5: Commit any config**

```bash
git add workers/ct-analytics/wrangler.toml
git commit -m "chore(worker): route stat.agentrium.app/{auth,admin,stats}/* to the worker"
```

---

## Task 15: End-to-end manual verification

- [ ] **Login flow**: visit `https://stat.agentrium.app/stat`. Redirect to `/stat/login`. Click Google. Complete OAuth. Land back on `/stat/users`.
- [ ] **Non-admin gate**: sign in with a non-admin account (email not in `ADMIN_EMAILS`). Expect a 403 on the users list, redirect to `/stat/login` per `api.ts` handling.
- [ ] **Users tab**: search "tal" - only your row appears. Total and 24h/7d/30d counts render.
- [ ] **User detail**: click a row. Drawer opens; installations and last-seen render. Sparkline renders (or "No activity"). Log storage bytes render.
- [ ] **Revoke sessions**: click "Revoke all sessions" on your own admin user. Confirm. Observe the desktop app gets force-logged-out within 60 seconds of window focus (its next `/sync/pull` returns 401).
- [ ] **Audit tab**: verify every action above appears as a row with the correct `admin_user_id`, `target_user_id` (or NULL for lists), and `details_json`.

---

## Task 16: Release v1.35.0

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`
- Modify: `src/changelog.json` (internal note only)

- [ ] **Step 1: Bump versions**

Everywhere: 1.34.0 -> 1.35.0.

- [ ] **Step 2: Changelog entry (optional, internal)**

```json
{
  "version": "1.35.0",
  "date": "2026-09-26",
  "title": "Under the hood",
  "highlights": [
    "Improvements to how we understand app usage; no user-visible changes."
  ]
}
```

- [ ] **Step 3: Refresh Cargo.lock, commit, tag**

```bash
cd src-tauri && cargo check && cd ..
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json README.md src/changelog.json
git commit -m "Release v1.35.0"
git tag v1.35.0
git push origin master --tags
```

- [ ] **Step 4: Deploy final Worker + Pages**

```bash
cd workers/ct-analytics && npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
cd ../ct-analytics-dashboard && npm run build && npm run deploy
```

---

## Self-Review Notes

Cross-checked against Section 4 (admin extensions) and Section 8 of the spec.

Deferred (post-v1, not in scope):
- Cohort retention charts
- Geographic map of users
- Per-user "sessions over time" chart on a longer window than 30 days
- In-UI admin promotion (still env-var only)
- Impersonation

Placeholder scan: none.

Type consistency: `UserRow`, `UserDetail`, `AuditRow` shapes in `api.ts` match the Worker response bodies from `users.ts` and `audit_handler.ts`. Cookie name `ct_session` matches Phase A's callback and the dashboard's Worker routes.
