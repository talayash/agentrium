# Admin Dashboard (`/admin`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `https://www.agentrium.app/admin`, a password-gated tabbed dashboard that merges `/stat` and `/inbox` and adds account data from the Neon Postgres behind `agentrium-api`.

**Architecture:** Four repos in deploy order. (A) `agentrium-api` gains read-only `/api/admin/*` routes behind an `x-admin-token` header, a `users.created_at` column, and starts writing `refresh_tokens.client_info`. (B) The `ct-analytics` Worker gains two token-gated routes: a KV-backed login rate limiter and an installation-id matcher. (C) The Astro website gains `src/pages/admin.astro`, a signed-cookie session in `api/_lib/admin-session.js`, and session-gated edge proxies. (D) The desktop app sends an optional `client` object with app version, OS and installation id at sign-in and refresh.

**Tech Stack:** Next.js 15 App Router + Drizzle + zod + vitest (API); Cloudflare Worker + D1 + KV + vitest (Worker); Astro 6 + Tailwind v4 + Vercel edge functions + vitest (site); Rust/Tauri + reqwest + serde_json (desktop).

**Spec:** `docs/superpowers/plans/../specs/2026-09-13-admin-dashboard-design.md` (in the `agentrium` repo). Executors read both.

## Global Constraints

- Repo paths on this machine: API `C:/Users/talay/agentrium-api` (branch `master`, pushing deploys production); Worker `C:/Users/talay/agentrium/workers/ct-analytics`; desktop `C:/Users/talay/agentrium` (branch `feat/m1-auth-signin`); website must be cloned: `git clone https://github.com/talayash/claude-terminal-website.git C:/Users/talay/agentrium-website` (default branch `main`, Vercel deploys on push).
- Never return from any admin route: `password_hash`, `token_hash`, `accounts.access_token/refresh_token/id_token`, `profiles.env_vars`, `profiles.claude_args`, `profiles.working_directory`, `workspaces.terminals` contents, `sessions`.
- Every admin proxy on the site responds `cache-control: no-store`. Every API admin route uses `jsonNoStore`.
- No em-dash characters anywhere in the website `src/**` or `README.md` (content-lint enforces it). Use a plain hyphen.
- Constant-time comparison for every secret check (password, session HMAC, admin token).
- Desktop ↔ broker contract: the `client` object is optional on the wire. Both repos change in this plan; README in the API documents it.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Apply the Neon migration before pushing API code that reads `users.created_at` (API CLAUDE.md rule).

---

# Part A: agentrium-api

Work in `C:/Users/talay/agentrium-api`. Run tests with `npx vitest run`, types with `npx tsc --noEmit -p tsconfig.json`.

### Task A1: `users.created_at` column and migration

**Files:**
- Modify: `db/schema.ts` (users table)
- Create: `db/migrations/0007_users_created_at.sql` (generated, then edited for the backfill)
- Modify: `src/lib/adapter.test.ts`

**Interfaces:**
- Produces: `users.createdAt` Drizzle column (`timestamp with time zone`, not null, default now) used by A3, A4, A5.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/adapter.test.ts`:

```ts
import { users } from '../../db/schema';

describe('users schema', () => {
  it('declares created_at so signups can be charted', () => {
    expect(users.createdAt).toBeDefined();
    expect(users.createdAt.notNull).toBe(true);
    expect(users.createdAt.hasDefault).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/adapter.test.ts`
Expected: FAIL, `users.createdAt` is undefined.

- [ ] **Step 3: Add the column to the schema**

In `db/schema.ts`, inside the `users` table object after `passwordHash`:

```ts
    // Signup time. Backfilled in migration 0007 from each user's earliest
    // refresh token so pre-existing accounts get a sensible date.
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
```

and extend the index callback:

```ts
  (t) => ({
    emailLower: uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
    createdAt: index('users_created_at_idx').on(t.createdAt, t.id),
  }),
```

- [ ] **Step 4: Generate the migration**

Run: `npx dotenv -e .env.local -- npx drizzle-kit generate --name users_created_at`
Expected: creates `db/migrations/0007_users_created_at.sql` with an `ALTER TABLE "users" ADD COLUMN "created_at" ...` and a `CREATE INDEX "users_created_at_idx" ...`, and updates `meta/_journal.json` + `meta/0007_snapshot.json`.

- [ ] **Step 5: Add the backfill to the generated SQL**

Insert between the `ALTER TABLE` and `CREATE INDEX` statements in `0007_users_created_at.sql`:

```sql
--> statement-breakpoint
UPDATE "users" u SET "created_at" = COALESCE(
  (SELECT MIN(r."created_at") FROM "refresh_tokens" r WHERE r."user_id" = u."id"),
  now()
);--> statement-breakpoint
```

The final file must be: ALTER TABLE, breakpoint, UPDATE, breakpoint, CREATE INDEX.

- [ ] **Step 6: Run tests and types**

Run: `npx vitest run src/lib/adapter.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors.

- [ ] **Step 7: Apply the migration to Neon**

Run: `npx dotenv -e .env.local -- npx drizzle-kit migrate`
Then verify:
```bash
npx dotenv -e .env.local -- node -e "const p=require('postgres')(process.env.DATABASE_URL,{prepare:false});p\`select count(*)::int as n, min(created_at) from users\`.then(r=>{console.log(r);return p.end()})"
```
Expected: a row with `n` equal to the user count and a non-null `min`.

- [ ] **Step 8: Commit**

```bash
git add db/schema.ts db/migrations src/lib/adapter.test.ts
git commit -m "feat(db): users.created_at with backfill from earliest refresh token

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A2: Accept and store `client` device info on sign-in and refresh

**Files:**
- Create: `src/lib/client-info.ts`, `src/lib/client-info.test.ts`
- Modify: `src/app/api/auth/desktop/token/route.ts`, `src/app/api/auth/desktop/signin-credentials/route.ts`, `src/app/api/auth/desktop/signup/route.ts`, `src/app/api/auth/refresh/route.ts`
- Modify: `src/app/api/auth/desktop/token/route.test.ts`, `src/app/api/auth/refresh/route.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: `clientInfoSchema` (zod, optional object) and type `ClientInfo = { app_version?: string; os?: string; installation_id?: string }`. Stored verbatim in `refresh_tokens.client_info`. Read by A3, A4, A5.

- [ ] **Step 1: Write the failing schema test**

`src/lib/client-info.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clientInfoSchema } from './client-info';

describe('clientInfoSchema', () => {
  it('accepts the three documented fields and trims them', () => {
    const r = clientInfoSchema.safeParse({ app_version: ' 1.33.7 ', os: 'windows', installation_id: 'abc' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ app_version: '1.33.7', os: 'windows', installation_id: 'abc' });
  });
  it('strips unknown keys and allows every field to be missing', () => {
    const r = clientInfoSchema.safeParse({ extra: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({});
  });
  it('rejects fields longer than 64 chars', () => {
    expect(clientInfoSchema.safeParse({ os: 'x'.repeat(65) }).success).toBe(false);
  });
  it('is optional as a whole', () => {
    expect(clientInfoSchema.optional().safeParse(undefined).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/client-info.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the schema**

`src/lib/client-info.ts`:

```ts
import { z } from 'zod';

/**
 * Optional device descriptor the desktop app sends with sign-in and refresh.
 * Stored as-is in refresh_tokens.client_info so the admin dashboard can show
 * app version / OS per account and match installations to accounts.
 */
const field = z.string().trim().min(1).max(64);

export const clientInfoSchema = z
  .object({
    app_version: field.optional(),
    os: field.optional(),
    installation_id: field.optional(),
  })
  .strip();

export type ClientInfo = z.infer<typeof clientInfoSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/client-info.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing token route test**

In `src/app/api/auth/desktop/token/route.test.ts`, add inside the `describe`:

```ts
  it('stores client info on the refresh token when provided', async () => {
    const r = await POST(req({
      code: 'good-code', code_verifier: verifier, state: 'st',
      client: { app_version: '1.33.7', os: 'windows', installation_id: 'inst-1', junk: true },
    }));
    expect(r.status).toBe(200);
    expect(shared.inserted[0]).toMatchObject({
      userId: 'u1',
      clientInfo: { app_version: '1.33.7', os: 'windows', installation_id: 'inst-1' },
    });
  });

  it('inserts a null client_info when the body has no client object', async () => {
    await POST(req({ code: 'good-code', code_verifier: verifier, state: 'st' }));
    expect(shared.inserted[0].clientInfo ?? null).toBeNull();
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/app/api/auth/desktop/token`
Expected: FAIL on the first new test (`clientInfo` missing).

- [ ] **Step 7: Wire `client` into the three sign-in routes**

In `token/route.ts`:

```ts
import { clientInfoSchema } from '../../../../../lib/client-info';

const bodySchema = z.object({
  code: z.string().min(1).max(128),
  code_verifier: z.string().min(43).max(128),
  state: z.string().min(1).max(256),
  client: clientInfoSchema.optional(),
});
```

and the insert:

```ts
  await db.insert(refreshTokens).values({
    userId: grant.userId,
    tokenHash: refreshHash,
    expiresAt: refreshTokenExpiryDate(),
    clientInfo: parsed.data.client ?? null,
  });
```

In `signin-credentials/route.ts` add `client: clientInfoSchema.optional(),` to `bodySchema` (import path `'../../../../../lib/client-info'`) and `clientInfo: parsed.data.client ?? null,` to the insert. Same two edits in `signup/route.ts`.

- [ ] **Step 8: Write the failing refresh test**

In `src/app/api/auth/refresh/route.test.ts`, find how the test doubles `db` (it mocks `update(...).set(...).where(...).returning()` and `insert(...).values(...)`). Add a test that (a) sends `client` and expects the inserted row to carry it, and (b) sends no `client` and expects the inserted row to carry the previous token's `client_info`. To make (b) possible, the mocked `returning()` for the claim must return `{ id, userId, clientInfo: { app_version: '1.33.6', os: 'macos', installation_id: 'inst-9' } }`.

```ts
  it('stores the supplied client info on the rotated token', async () => {
    const r = await POST(req({ refresh_token: GOOD, client: { app_version: '1.33.7', os: 'windows', installation_id: 'inst-1' } }));
    expect(r.status).toBe(200);
    expect(shared.inserted[0]).toMatchObject({ clientInfo: { app_version: '1.33.7', os: 'windows', installation_id: 'inst-1' } });
  });

  it('inherits the previous token client info when the body has none', async () => {
    const r = await POST(req({ refresh_token: GOOD }));
    expect(r.status).toBe(200);
    expect(shared.inserted[0]).toMatchObject({ clientInfo: { app_version: '1.33.6', os: 'macos', installation_id: 'inst-9' } });
  });
```

Adapt `GOOD`, `req`, and `shared.inserted` to the names already used in that test file.

- [ ] **Step 9: Run to verify it fails**

Run: `npx vitest run src/app/api/auth/refresh`
Expected: FAIL on both new tests.

- [ ] **Step 10: Implement inheritance in the refresh route**

In `refresh/route.ts`:

```ts
import { clientInfoSchema } from '../../../../lib/client-info';

const bodySchema = z.object({
  refresh_token: z.string().length(64).regex(/^[0-9a-f]+$/),
  client: clientInfoSchema.optional(),
});
```

Extend the claim's `.returning(...)`:

```ts
    .returning({ id: refreshTokens.id, userId: refreshTokens.userId, clientInfo: refreshTokens.clientInfo });
```

and the insert of the rotated token:

```ts
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: newHash,
    expiresAt: refreshTokenExpiryDate(),
    // A refresh from an older client carries no `client`; keep what the
    // previous token knew so one old-style refresh never erases device info.
    clientInfo: parsed.data.client ?? current.clientInfo ?? null,
  });
```

- [ ] **Step 11: Run the whole suite and types**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS.

- [ ] **Step 12: Document the contract**

In `README.md`, under "Desktop sign-in flow" after step 4, add:

```markdown
All four token-issuing requests (`/desktop/token`, `/desktop/signup`, `/desktop/signin-credentials`, `/auth/refresh`) accept an optional
`"client": { "app_version": "1.33.7", "os": "windows", "installation_id": "<uuid>" }` (each field optional, 1 to 64 chars, unknown keys dropped).
It is stored on the issued refresh token as `client_info`; a refresh without `client` inherits the previous token's value. Old clients that omit it keep working.
```

- [ ] **Step 13: Commit**

```bash
git add src/lib/client-info.ts src/lib/client-info.test.ts src/app/api/auth README.md
git commit -m "feat(auth): store optional client device info on refresh tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A3: Admin token guard

**Files:**
- Create: `src/lib/admin-auth.ts`, `src/lib/admin-auth.test.ts`
- Modify: `.env.local.example`, `README.md`

**Interfaces:**
- Produces: `requireAdminToken(req: Pick<NextRequest,'headers'>): { ok: true } | { ok: false; response: NextResponse }`. Used by A4, A5, A6.

- [ ] **Step 1: Write the failing test**

`src/lib/admin-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireAdminToken } from './admin-auth';

function req(token?: string) {
  return { headers: { get: (k: string) => (k.toLowerCase() === 'x-admin-token' ? token ?? null : null) } } as any;
}

describe('requireAdminToken', () => {
  const prev = process.env.ADMIN_API_TOKEN;
  beforeEach(() => { process.env.ADMIN_API_TOKEN = 'secret-token-value'; });
  afterEach(() => { process.env.ADMIN_API_TOKEN = prev; });

  it('accepts the matching token', () => {
    expect(requireAdminToken(req('secret-token-value')).ok).toBe(true);
  });
  it('rejects a missing or wrong token with 401', async () => {
    for (const t of [undefined, '', 'nope', 'secret-token-valu']) {
      const r = requireAdminToken(req(t));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(401);
        expect((await r.response.json()).error).toBe('unauthorized');
      }
    }
  });
  it('returns 500 server_misconfigured when the env var is unset', async () => {
    delete process.env.ADMIN_API_TOKEN;
    const r = requireAdminToken(req('anything'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin-auth.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/lib/admin-auth.ts`:

```ts
import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { jsonNoStore } from './http';

export type AdminAuth = { ok: true } | { ok: false; response: ReturnType<typeof jsonNoStore> };

/**
 * Shared-secret guard for the read-only /api/admin/* routes. The website's
 * edge proxies hold the same token server-side; it never reaches a browser.
 */
export function requireAdminToken(req: Pick<NextRequest, 'headers'>): AdminAuth {
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    return { ok: false, response: jsonNoStore({ error: 'server_misconfigured' }, { status: 500 }) };
  }
  const provided = req.headers.get('x-admin-token') ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match) {
    return { ok: false, response: jsonNoStore({ error: 'unauthorized' }, { status: 401 }) };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/admin-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the env var**

Append to `.env.local.example`:

```
# Shared secret for the read-only /api/admin/* routes used by the website's /admin page.
# Generate with: openssl rand -hex 32   (set the same value on the website's Vercel project)
ADMIN_API_TOKEN=paste-64-hex-chars
```

Add a row to the README environment table: `| \`ADMIN_API_TOKEN\` | Shared secret for \`/api/admin/*\` (read-only account data for the website's \`/admin\` dashboard). |`

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin-auth.ts src/lib/admin-auth.test.ts .env.local.example README.md
git commit -m "feat(admin): x-admin-token guard for read-only admin routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A4: `GET /api/admin/summary`

**Files:**
- Create: `src/lib/admin-queries.ts`, `src/app/api/admin/summary/route.ts`, `src/app/api/admin/summary/route.test.ts`

**Interfaces:**
- Produces: `getAdminSummary(): Promise<AdminSummary>` in `admin-queries.ts` and the route. Response shape is spec Section 6.3 (`users`, `signups_by_day`, `devices`, `sync`, `active_installation_ids`, `generated_at`).
- Consumes: `requireAdminToken` (A3), `users.createdAt` (A1), `refreshTokens.clientInfo` (A2).

- [ ] **Step 1: Write the failing route test**

`src/app/api/admin/summary/route.test.ts` (mock the query module, test the route contract):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/admin-queries', () => ({
  getAdminSummary: vi.fn().mockResolvedValue({
    users: { total: 3, last_7d: 1, last_30d: 2, by_provider: { google: 2, github: 0, email: 1 } },
    signups_by_day: [{ date: '2026-09-13', count: 1 }],
    devices: { active: 2, by_app_version: { '1.33.7': 2 }, by_os: { windows: 2 } },
    sync: { profiles: 5, custom_agents: 0, workspaces: 1, users_with_sync: 2 },
    active_installation_ids: ['inst-1', 'inst-2'],
  }),
}));
vi.mock('../../../../lib/ratelimit', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/ratelimit')>()),
  rateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

import { GET } from './route';

function req(token?: string) {
  return { headers: { get: (k: string) => (k.toLowerCase() === 'x-admin-token' ? token ?? null : null) } } as any;
}

beforeEach(() => { process.env.ADMIN_API_TOKEN = 't0k'; });

describe('GET /api/admin/summary', () => {
  it('401 without the token', async () => {
    expect((await GET(req())).status).toBe(401);
  });
  it('returns the summary with no-store and a generated_at', async () => {
    const r = await GET(req('t0k'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body.users.total).toBe(3);
    expect(body.active_installation_ids).toEqual(['inst-1', 'inst-2']);
    expect(typeof body.generated_at).toBe('string');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/admin/summary`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the queries**

`src/lib/admin-queries.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db } from './db';

export interface AdminSummary {
  users: { total: number; last_7d: number; last_30d: number; by_provider: Record<string, number> };
  signups_by_day: Array<{ date: string; count: number }>;
  devices: { active: number; by_app_version: Record<string, number>; by_os: Record<string, number> };
  sync: { profiles: number; custom_agents: number; workspaces: number; users_with_sync: number };
  active_installation_ids: string[];
}

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

async function rows(q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(q)) as unknown as Row[];
}

function toCounts(rs: Row[], key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rs) out[String(r[key] ?? 'unknown')] = n(r.count);
  return out;
}

export async function getAdminSummary(): Promise<AdminSummary> {
  const [totals, providers, signups, devices, byVersion, byOs, syncCounts, installIds] = await Promise.all([
    rows(sql`SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS last_7d,
                    count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS last_30d
             FROM users`),
    // A user is 'email' when they have a password and no OAuth account row;
    // otherwise the provider of their earliest linked account.
    rows(sql`SELECT COALESCE(a.provider, CASE WHEN u.password_hash IS NOT NULL THEN 'email' ELSE 'unknown' END) AS provider,
                    count(*)::int AS count
             FROM users u
             LEFT JOIN LATERAL (SELECT provider FROM accounts WHERE "userId" = u.id ORDER BY provider LIMIT 1) a ON true
             GROUP BY 1`),
    rows(sql`SELECT d::date::text AS date, COALESCE(c.count, 0)::int AS count
             FROM generate_series((now() - interval '89 days')::date, now()::date, interval '1 day') d
             LEFT JOIN (SELECT created_at::date AS day, count(*) AS count FROM users
                        WHERE created_at >= (now() - interval '89 days')::date GROUP BY 1) c ON c.day = d::date
             ORDER BY 1`),
    rows(sql`SELECT count(*)::int AS active FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()`),
    rows(sql`SELECT COALESCE(client_info->>'app_version','unknown') AS key, count(*)::int AS count
             FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now() GROUP BY 1`),
    rows(sql`SELECT COALESCE(client_info->>'os','unknown') AS key, count(*)::int AS count
             FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now() GROUP BY 1`),
    rows(sql`SELECT
               (SELECT count(*) FROM profiles WHERE deleted_at IS NULL)::int AS profiles,
               (SELECT count(*) FROM custom_agents WHERE deleted_at IS NULL)::int AS custom_agents,
               (SELECT count(*) FROM workspaces WHERE deleted_at IS NULL)::int AS workspaces,
               (SELECT count(DISTINCT user_id) FROM (
                   SELECT user_id FROM profiles WHERE deleted_at IS NULL
                   UNION SELECT user_id FROM custom_agents WHERE deleted_at IS NULL
                   UNION SELECT user_id FROM workspaces WHERE deleted_at IS NULL) s)::int AS users_with_sync`),
    rows(sql`SELECT DISTINCT client_info->>'installation_id' AS id FROM refresh_tokens
             WHERE revoked_at IS NULL AND expires_at > now() AND client_info->>'installation_id' IS NOT NULL
             LIMIT 5000`),
  ]);

  const t = totals[0] ?? {};
  const providerCounts = toCounts(providers, 'provider');
  return {
    users: {
      total: n(t.total), last_7d: n(t.last_7d), last_30d: n(t.last_30d),
      by_provider: { google: providerCounts.google ?? 0, github: providerCounts.github ?? 0, email: providerCounts.email ?? 0 },
    },
    signups_by_day: signups.map((r) => ({ date: String(r.date), count: n(r.count) })),
    devices: { active: n(devices[0]?.active), by_app_version: toCounts(byVersion, 'key'), by_os: toCounts(byOs, 'key') },
    sync: {
      profiles: n(syncCounts[0]?.profiles), custom_agents: n(syncCounts[0]?.custom_agents),
      workspaces: n(syncCounts[0]?.workspaces), users_with_sync: n(syncCounts[0]?.users_with_sync),
    },
    active_installation_ids: installIds.map((r) => String(r.id)),
  };
}
```

- [ ] **Step 4: Implement the route**

`src/app/api/admin/summary/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { requireAdminToken } from '../../../../lib/admin-auth';
import { getAdminSummary } from '../../../../lib/admin-queries';
import { jsonNoStore, clientIp } from '../../../../lib/http';
import { rateLimit, rateLimitedResponse } from '../../../../lib/ratelimit';

const IP_LIMIT = { limit: 120, windowSec: 60 };

export async function GET(req: NextRequest) {
  const auth = requireAdminToken(req);
  if (!auth.ok) return auth.response;
  const ipCheck = await rateLimit(`rl:admin:ip:${clientIp(req)}`, IP_LIMIT);
  if (!ipCheck.ok) return rateLimitedResponse(ipCheck.retryAfterSec);
  try {
    const summary = await getAdminSummary();
    return jsonNoStore({ generated_at: new Date().toISOString(), ...summary });
  } catch (err) {
    console.error('admin_summary_failed', err);
    return jsonNoStore({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run tests and types**

Run: `npx vitest run src/app/api/admin/summary && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Smoke the SQL against Neon**

Run: `npx dotenv -e .env.local -- npx tsx -e "import('./src/lib/admin-queries').then(async m=>{console.log(JSON.stringify(await m.getAdminSummary(),null,1).slice(0,800));process.exit(0)})"`
(if `tsx` is missing: `npm i -D tsx`). Expected: JSON with non-negative counts and 90 `signups_by_day` entries. Fix any SQL error before committing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-queries.ts src/app/api/admin/summary
git commit -m "feat(admin): GET /api/admin/summary (accounts, signups, devices, sync)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A5: `GET /api/admin/users` (search, keyset paging)

**Files:**
- Modify: `src/lib/admin-queries.ts`
- Create: `src/lib/admin-cursor.ts`, `src/lib/admin-cursor.test.ts`, `src/app/api/admin/users/route.ts`, `src/app/api/admin/users/route.test.ts`

**Interfaces:**
- Produces: `encodeCursor({createdAt: string, id: string}): string`, `decodeCursor(s: string): {createdAt: string; id: string} | null`; `listAdminUsers(opts: {q: string; limit: number; cursor: {createdAt: string; id: string} | null}): Promise<{ total: number; items: AdminUserRow[]; next_cursor: string | null }>`; `AdminUserRow` fields per spec 6.3.

- [ ] **Step 1: Write the failing cursor test**

`src/lib/admin-cursor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from './admin-cursor';

describe('admin cursor', () => {
  it('round-trips', () => {
    const c = { createdAt: '2026-09-13T10:00:00.000Z', id: '6f1c2a3e-1111-4222-8333-444455556666' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it('rejects garbage', () => {
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor(Buffer.from('x|y').toString('base64url'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin-cursor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the cursor**

`src/lib/admin-cursor.ts`:

```ts
export interface UserCursor { createdAt: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: UserCursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(s: string): UserCursor | null {
  let text: string;
  try { text = Buffer.from(s, 'base64url').toString('utf8'); } catch { return null; }
  const sep = text.indexOf('|');
  if (sep < 0) return null;
  const createdAt = text.slice(0, sep);
  const id = text.slice(sep + 1);
  if (Number.isNaN(Date.parse(createdAt)) || !UUID.test(id)) return null;
  return { createdAt, id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/admin-cursor.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

`src/app/api/admin/users/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock('../../../../lib/admin-queries', () => ({
  listAdminUsers: vi.fn(async (opts: Record<string, unknown>) => {
    calls.last = opts;
    return { total: 1, items: [{ id: 'u1', email: 'a@b.co' }], next_cursor: null };
  }),
}));
vi.mock('../../../../lib/ratelimit', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/ratelimit')>()),
  rateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

import { GET } from './route';
import { encodeCursor } from '../../../../lib/admin-cursor';

function req(url: string, token?: string) {
  return { url: `https://x${url}`, headers: { get: (k: string) => (k.toLowerCase() === 'x-admin-token' ? token ?? null : null) } } as any;
}
beforeEach(() => { process.env.ADMIN_API_TOKEN = 't0k'; calls.last = null; });

describe('GET /api/admin/users', () => {
  it('401 without token', async () => { expect((await GET(req('/api/admin/users'))).status).toBe(401); });
  it('defaults: empty q, limit 50, no cursor', async () => {
    const r = await GET(req('/api/admin/users', 't0k'));
    expect(r.status).toBe(200);
    expect(calls.last).toEqual({ q: '', limit: 50, cursor: null });
  });
  it('clamps limit and passes a decoded cursor', async () => {
    const c = { createdAt: '2026-09-13T10:00:00.000Z', id: '6f1c2a3e-1111-4222-8333-444455556666' };
    await GET(req(`/api/admin/users?q=dan&limit=999&cursor=${encodeCursor(c)}`, 't0k'));
    expect(calls.last).toEqual({ q: 'dan', limit: 100, cursor: c });
  });
  it('400 on a malformed cursor', async () => {
    const r = await GET(req('/api/admin/users?cursor=zzz', 't0k'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_cursor');
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/app/api/admin/users`
Expected: FAIL.

- [ ] **Step 7: Add `listAdminUsers` to `admin-queries.ts`**

Append:

```ts
import { encodeCursor, type UserCursor } from './admin-cursor';

export interface AdminUserRow {
  id: string; email: string; name: string | null; image: string | null;
  provider: string; created_at: string; last_seen_at: string | null;
  devices: number; app_version: string | null; os: string | null;
  profiles: number; custom_agents: number; workspaces: number;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function mapUserRow(r: Row): AdminUserRow {
  return {
    id: String(r.id), email: String(r.email), name: (r.name as string | null) ?? null, image: (r.image as string | null) ?? null,
    provider: String(r.provider ?? 'unknown'), created_at: iso(r.created_at)!, last_seen_at: iso(r.last_seen_at),
    devices: n(r.devices), app_version: (r.app_version as string | null) ?? null, os: (r.os as string | null) ?? null,
    profiles: n(r.profiles), custom_agents: n(r.custom_agents), workspaces: n(r.workspaces),
  };
}

// One row per user with the derived columns the dashboard shows. Kept as a
// fragment so the list and the detail route stay identical.
const USER_ROW_SELECT = sql`
  SELECT u.id, u.email, u.name, u.image, u.created_at,
         COALESCE(a.provider, CASE WHEN u.password_hash IS NOT NULL THEN 'email' ELSE 'unknown' END) AS provider,
         rt.last_seen_at, COALESCE(rt.devices, 0) AS devices, rt.app_version, rt.os,
         (SELECT count(*) FROM profiles p WHERE p.user_id = u.id AND p.deleted_at IS NULL)::int AS profiles,
         (SELECT count(*) FROM custom_agents c WHERE c.user_id = u.id AND c.deleted_at IS NULL)::int AS custom_agents,
         (SELECT count(*) FROM workspaces w WHERE w.user_id = u.id AND w.deleted_at IS NULL)::int AS workspaces
  FROM users u
  LEFT JOIN LATERAL (SELECT provider FROM accounts WHERE "userId" = u.id ORDER BY provider LIMIT 1) a ON true
  LEFT JOIN LATERAL (
    SELECT max(created_at) AS last_seen_at,
           count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS devices,
           (array_agg(client_info->>'app_version' ORDER BY created_at DESC) FILTER (WHERE client_info IS NOT NULL))[1] AS app_version,
           (array_agg(client_info->>'os' ORDER BY created_at DESC) FILTER (WHERE client_info IS NOT NULL))[1] AS os
    FROM refresh_tokens WHERE user_id = u.id) rt ON true`;

export async function listAdminUsers(opts: { q: string; limit: number; cursor: UserCursor | null }) {
  const like = `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const search = opts.q ? sql`(u.email ILIKE ${like} OR u.name ILIKE ${like})` : sql`true`;
  const after = opts.cursor
    ? sql`(u.created_at, u.id) < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`
    : sql`true`;
  const [totalRows, items] = await Promise.all([
    rows(sql`SELECT count(*)::int AS total FROM users u WHERE ${search}`),
    rows(sql`${USER_ROW_SELECT} WHERE ${search} AND ${after} ORDER BY u.created_at DESC, u.id DESC LIMIT ${opts.limit + 1}`),
  ]);
  const hasMore = items.length > opts.limit;
  const page = items.slice(0, opts.limit).map(mapUserRow);
  const last = page[page.length - 1];
  return {
    total: n(totalRows[0]?.total),
    items: page,
    next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
```

- [ ] **Step 8: Implement the route**

`src/app/api/admin/users/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { requireAdminToken } from '../../../../lib/admin-auth';
import { listAdminUsers } from '../../../../lib/admin-queries';
import { decodeCursor } from '../../../../lib/admin-cursor';
import { jsonNoStore, clientIp } from '../../../../lib/http';
import { rateLimit, rateLimitedResponse } from '../../../../lib/ratelimit';

const IP_LIMIT = { limit: 120, windowSec: 60 };

export async function GET(req: NextRequest) {
  const auth = requireAdminToken(req);
  if (!auth.ok) return auth.response;
  const ipCheck = await rateLimit(`rl:admin:ip:${clientIp(req)}`, IP_LIMIT);
  if (!ipCheck.ok) return rateLimitedResponse(ipCheck.retryAfterSec);

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return jsonNoStore({ error: 'invalid_cursor' }, { status: 400 });

  try {
    return jsonNoStore(await listAdminUsers({ q, limit, cursor }));
  } catch (err) {
    console.error('admin_users_failed', err);
    return jsonNoStore({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] **Step 9: Run tests, types, and a live smoke**

Run: `npx vitest run src/app/api/admin src/lib && npx tsc --noEmit -p tsconfig.json`
Then: `npx dotenv -e .env.local -- npx tsx -e "import('./src/lib/admin-queries').then(async m=>{const r=await m.listAdminUsers({q:'',limit:2,cursor:null});console.log(JSON.stringify(r,null,1));process.exit(0)})"`
Expected: PASS; two items with every field present, `next_cursor` a string if more than two users exist.

- [ ] **Step 10: Commit**

```bash
git add src/lib/admin-queries.ts src/lib/admin-cursor.ts src/lib/admin-cursor.test.ts src/app/api/admin/users
git commit -m "feat(admin): GET /api/admin/users with search and keyset paging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A6: `GET /api/admin/users/[id]`

**Files:**
- Modify: `src/lib/admin-queries.ts`
- Create: `src/app/api/admin/users/[id]/route.ts`, `src/app/api/admin/users/[id]/route.test.ts`

**Interfaces:**
- Produces: `getAdminUserDetail(id: string): Promise<AdminUserDetail | null>` with shape per spec 6.3 (`user`, `accounts`, `devices`, `sync`).

- [ ] **Step 1: Write the failing route test**

`src/app/api/admin/users/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../lib/admin-queries', () => ({
  getAdminUserDetail: vi.fn(async (id: string) => id === '6f1c2a3e-1111-4222-8333-444455556666'
    ? { user: { id, email: 'a@b.co' }, accounts: [], devices: [], sync: { profiles: [], custom_agents: [], workspaces: [] } }
    : null),
}));
vi.mock('../../../../../lib/ratelimit', async (orig) => ({
  ...(await orig<typeof import('../../../../../lib/ratelimit')>()),
  rateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

import { GET } from './route';

function req(token?: string) {
  return { url: 'https://x/api/admin/users/whatever', headers: { get: (k: string) => (k.toLowerCase() === 'x-admin-token' ? token ?? null : null) } } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => { process.env.ADMIN_API_TOKEN = 't0k'; });

describe('GET /api/admin/users/[id]', () => {
  it('401 without token', async () => {
    expect((await GET(req(), ctx('6f1c2a3e-1111-4222-8333-444455556666'))).status).toBe(401);
  });
  it('400 on a non-uuid id', async () => {
    const r = await GET(req('t0k'), ctx('abc'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_id');
  });
  it('404 when unknown', async () => {
    expect((await GET(req('t0k'), ctx('00000000-0000-4000-8000-000000000000'))).status).toBe(404);
  });
  it('200 with the detail', async () => {
    const r = await GET(req('t0k'), ctx('6f1c2a3e-1111-4222-8333-444455556666'));
    expect(r.status).toBe(200);
    expect((await r.json()).user.email).toBe('a@b.co');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "src/app/api/admin/users/\[id\]"`
Expected: FAIL.

- [ ] **Step 3: Add `getAdminUserDetail` to `admin-queries.ts`**

Append:

```ts
export interface AdminUserDetail {
  user: AdminUserRow;
  accounts: Array<{ provider: string; provider_account_id_tail: string }>;
  devices: Array<{ id: string; created_at: string; expires_at: string; revoked_at: string | null;
                   revoked_reason: string | null; client_info: Record<string, string> | null }>;
  sync: {
    profiles: Array<{ id: string; name: string; agent: string; updated_at: string; deleted_at: string | null }>;
    custom_agents: Array<{ id: string; name: string; binary: string; updated_at: string; deleted_at: string | null }>;
    workspaces: Array<{ id: string; name: string; terminals: number; updated_at: string; deleted_at: string | null }>;
  };
}

export async function getAdminUserDetail(id: string): Promise<AdminUserDetail | null> {
  const userRows = await rows(sql`${USER_ROW_SELECT} WHERE u.id = ${id}::uuid LIMIT 1`);
  if (!userRows[0]) return null;
  const [accounts, devices, profiles, customAgents, workspaces] = await Promise.all([
    rows(sql`SELECT provider, right("providerAccountId", 4) AS tail FROM accounts WHERE "userId" = ${id}::uuid ORDER BY provider`),
    rows(sql`SELECT id, created_at, expires_at, revoked_at, revoked_reason, client_info
             FROM refresh_tokens WHERE user_id = ${id}::uuid ORDER BY created_at DESC LIMIT 20`),
    rows(sql`SELECT id, name, agent, updated_at, deleted_at FROM profiles WHERE user_id = ${id}::uuid ORDER BY updated_at DESC LIMIT 200`),
    rows(sql`SELECT id, name, binary, updated_at, deleted_at FROM custom_agents WHERE user_id = ${id}::uuid ORDER BY updated_at DESC LIMIT 200`),
    rows(sql`SELECT id, name, jsonb_array_length(CASE WHEN jsonb_typeof(terminals) = 'array' THEN terminals ELSE '[]'::jsonb END) AS terminals,
                    updated_at, deleted_at FROM workspaces WHERE user_id = ${id}::uuid ORDER BY updated_at DESC LIMIT 200`),
  ]);
  return {
    user: mapUserRow(userRows[0]),
    accounts: accounts.map((r) => ({ provider: String(r.provider), provider_account_id_tail: `…${String(r.tail ?? '')}` })),
    devices: devices.map((r) => ({
      id: String(r.id), created_at: iso(r.created_at)!, expires_at: iso(r.expires_at)!, revoked_at: iso(r.revoked_at),
      revoked_reason: (r.revoked_reason as string | null) ?? null,
      client_info: (r.client_info as Record<string, string> | null) ?? null,
    })),
    sync: {
      profiles: profiles.map((r) => ({ id: String(r.id), name: String(r.name), agent: String(r.agent), updated_at: iso(r.updated_at)!, deleted_at: iso(r.deleted_at) })),
      custom_agents: customAgents.map((r) => ({ id: String(r.id), name: String(r.name), binary: String(r.binary), updated_at: iso(r.updated_at)!, deleted_at: iso(r.deleted_at) })),
      workspaces: workspaces.map((r) => ({ id: String(r.id), name: String(r.name), terminals: n(r.terminals), updated_at: iso(r.updated_at)!, deleted_at: iso(r.deleted_at) })),
    },
  };
}
```

- [ ] **Step 4: Implement the route**

`src/app/api/admin/users/[id]/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { requireAdminToken } from '../../../../../lib/admin-auth';
import { getAdminUserDetail } from '../../../../../lib/admin-queries';
import { jsonNoStore, clientIp } from '../../../../../lib/http';
import { rateLimit, rateLimitedResponse } from '../../../../../lib/ratelimit';

const IP_LIMIT = { limit: 120, windowSec: 60 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireAdminToken(req);
  if (!auth.ok) return auth.response;
  const ipCheck = await rateLimit(`rl:admin:ip:${clientIp(req)}`, IP_LIMIT);
  if (!ipCheck.ok) return rateLimitedResponse(ipCheck.retryAfterSec);

  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonNoStore({ error: 'invalid_id' }, { status: 400 });
  try {
    const detail = await getAdminUserDetail(id);
    if (!detail) return jsonNoStore({ error: 'not_found' }, { status: 404 });
    return jsonNoStore(detail);
  } catch (err) {
    console.error('admin_user_detail_failed', err);
    return jsonNoStore({ error: 'internal_error' }, { status: 500 });
  }
}
```

- [ ] **Step 5: Add a field-exclusion test on the live query**

Append to `src/lib/admin-auth.test.ts`? No: create `src/integration/admin.test.ts` guarded like `smoke.test.ts` (`RUN_INTEGRATION=1`):

```ts
import { describe, it, expect } from 'vitest';

const run = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!run)('admin queries (live Neon)', () => {
  it('never serialize secret columns', async () => {
    const m = await import('../lib/admin-queries');
    const list = await m.listAdminUsers({ q: '', limit: 5, cursor: null });
    const first = list.items[0];
    if (!first) return;
    const detail = await m.getAdminUserDetail(first.id);
    const text = JSON.stringify({ list, detail });
    for (const banned of ['password_hash', 'passwordHash', 'token_hash', 'tokenHash', 'env_vars', 'envVars', 'claude_args', 'working_directory', 'access_token', 'id_token']) {
      expect(text).not.toContain(banned);
    }
  });
});
```

- [ ] **Step 6: Run everything**

Run: `npx vitest run && RUN_INTEGRATION=1 npx dotenv -e .env.local -- npx vitest run src/integration/admin.test.ts && npx tsc --noEmit -p tsconfig.json`
(on PowerShell: `$env:RUN_INTEGRATION='1'; npx dotenv -e .env.local -- npx vitest run src/integration/admin.test.ts`)
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-queries.ts "src/app/api/admin/users/[id]" src/integration/admin.test.ts
git commit -m "feat(admin): GET /api/admin/users/[id] detail with secret-field exclusion test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task A7: Set `ADMIN_API_TOKEN` and deploy the API

**Files:** none (operations).

- [ ] **Step 1: Generate the token and set it on both Vercel projects**

Run: `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep the value for Part C.
Run in `C:/Users/talay/agentrium-api`: `npx vercel env add ADMIN_API_TOKEN production` and paste the value. Also add to `.env.local` as `ADMIN_API_TOKEN=<value>`.

- [ ] **Step 2: Push to deploy**

Run: `git push origin master`. Wait for the Vercel deployment (`npx vercel ls agentrium-api | head -3`).

- [ ] **Step 3: Verify live**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://agentrium-api.vercel.app/api/admin/summary            # expect 401
curl -s -H "x-admin-token: $ADMIN_API_TOKEN" https://agentrium-api.vercel.app/api/admin/summary | head -c 400   # expect JSON
```

---

# Part B: ct-analytics Worker

Work in `C:/Users/talay/agentrium/workers/ct-analytics`. Tests: `npx vitest run`. Types: `npx tsc --noEmit`. The existing tests are pure-function tests; the new handlers take `env` so tests pass hand-rolled KV and D1 fakes.

### Task B1: Admin helpers module with fakes-driven tests

**Files:**
- Create: `src/admin.ts`, `src/admin.test.ts`

**Interfaces:**
- Produces:
  - `checkLoginAttempt(kv: KVNamespace, ipHash: string, now?: number): Promise<{ allowed: true; remaining: number } | { allowed: false; retry_after_seconds: number }>` - 10 per 15 min, key `rl:admin_login:<hash>`, value `JSON {count, reset}`.
  - `parseMatchBody(body: unknown): string[] | null` - up to 5000 strings, each 1..128 chars, deduped; null when invalid.
  - `matchInstallations(db: D1Database, kv: KVNamespace, ids: string[], date: string): Promise<{ active_today: number; active_now: number }>`.
- Consumed by B2 (route wiring) and Part C proxies.

- [ ] **Step 1: Write the failing tests**

`src/admin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkLoginAttempt, parseMatchBody, matchInstallations, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS } from './admin';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function fakeDb(dauIds: Set<string>) {
  return {
    prepare: (sqlText: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const ids = args.slice(1) as string[]; // args[0] is the date
          const n = ids.filter((id) => dauIds.has(id)).length;
          return { n };
        },
      }),
    }),
    _sql: null as unknown,
  } as unknown as D1Database;
}

describe('checkLoginAttempt', () => {
  it('allows the first ten attempts then denies with a retry hint', async () => {
    const kv = fakeKv();
    const t0 = 1_800_000_000_000;
    for (let i = 1; i <= LOGIN_LIMIT; i++) {
      const r = await checkLoginAttempt(kv, 'h1', t0);
      expect(r.allowed).toBe(true);
      if (r.allowed) expect(r.remaining).toBe(LOGIN_LIMIT - i);
    }
    const denied = await checkLoginAttempt(kv, 'h1', t0 + 60_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retry_after_seconds).toBe(LOGIN_WINDOW_SECONDS - 60);
  });
  it('resets after the window', async () => {
    const kv = fakeKv();
    const t0 = 1_800_000_000_000;
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'h1', t0);
    const later = await checkLoginAttempt(kv, 'h1', t0 + (LOGIN_WINDOW_SECONDS + 1) * 1000);
    expect(later.allowed).toBe(true);
  });
  it('keys per hash', async () => {
    const kv = fakeKv();
    for (let i = 0; i <= LOGIN_LIMIT; i++) await checkLoginAttempt(kv, 'a');
    expect((await checkLoginAttempt(kv, 'b')).allowed).toBe(true);
  });
});

describe('parseMatchBody', () => {
  it('accepts and dedupes a list of ids', () => {
    expect(parseMatchBody({ installation_ids: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
  });
  it('rejects non-arrays, empty strings, long strings and oversize lists', () => {
    expect(parseMatchBody({})).toBeNull();
    expect(parseMatchBody({ installation_ids: 'a' })).toBeNull();
    expect(parseMatchBody({ installation_ids: [''] })).toBeNull();
    expect(parseMatchBody({ installation_ids: ['x'.repeat(129)] })).toBeNull();
    expect(parseMatchBody({ installation_ids: Array.from({ length: 5001 }, (_, i) => `i${i}`) })).toBeNull();
  });
  it('accepts an empty list', () => {
    expect(parseMatchBody({ installation_ids: [] })).toEqual([]);
  });
});

describe('matchInstallations', () => {
  it('counts ids present in daily_dau and in live: keys', async () => {
    const kv = fakeKv({ 'live:a': '1', 'live:c': '1' });
    const db = fakeDb(new Set(['a', 'b']));
    const r = await matchInstallations(db, kv, ['a', 'b', 'c', 'd'], '2026-09-13');
    expect(r).toEqual({ active_today: 2, active_now: 2 });
  });
  it('handles more than one chunk of 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const db = fakeDb(new Set(ids));
    const r = await matchInstallations(db, fakeKv(), ids, '2026-09-13');
    expect(r.active_today).toBe(250);
    expect(r.active_now).toBe(0);
  });
  it('returns zeros for an empty list without touching storage', async () => {
    const r = await matchInstallations(fakeDb(new Set()), fakeKv(), [], '2026-09-13');
    expect(r).toEqual({ active_today: 0, active_now: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/admin.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/admin.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/admin.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/admin.ts workers/ct-analytics/src/admin.test.ts
git commit -m "feat(worker): admin login rate-limit and installation match helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(run `git` from `C:/Users/talay/agentrium`.)

### Task B2: Wire the two routes and deploy

**Files:**
- Modify: `workers/ct-analytics/src/index.ts` (route table in `fetch`, header comment)

**Interfaces:**
- Produces: `POST /admin/login_attempt` `{ ip }` → `{ allowed, remaining }` | `{ allowed:false, retry_after_seconds }`; `POST /stats/match` `{ installation_ids }` → `{ active_today, active_now }`. Both require `x-ct-token`.

- [ ] **Step 1: Add the handlers**

In `src/index.ts` add near the other handlers:

```ts
async function handleAdminLoginAttempt(request: Request, env: Env): Promise<Response> {
  const { checkLoginAttempt } = await import('./admin');
  const { hashIP } = await import('./feedback');
  let body: { ip?: unknown };
  try {
    body = (await request.json()) as { ip?: unknown };
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const ip = clampString(body.ip, 64);
  if (!ip) return json({ error: 'invalid_payload' }, 400);
  // Same salted hash the feedback route uses; the raw address is never stored.
  const ipHash = await hashIP(ip, env.STATS_TOKEN ?? 'unsalted');
  return json(await checkLoginAttempt(env.KV_BINDING, ipHash));
}

async function handleStatsMatch(request: Request, env: Env): Promise<Response> {
  const { parseMatchBody, matchInstallations } = await import('./admin');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const ids = parseMatchBody(body);
  if (!ids) return json({ error: 'invalid_payload' }, 400);
  return json(await matchInstallations(env.DB, env.KV_BINDING, ids, todayUTC()));
}
```

- [ ] **Step 2: Register the routes**

Inside `fetch`, before the final `return json({ error: 'not_found' }, 404);`:

```ts
      if (request.method === 'POST' && url.pathname === '/admin/login_attempt') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleAdminLoginAttempt(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/stats/match') {
        const denied = requireToken(request, env.STATS_TOKEN);
        if (denied) return denied;
        return await handleStatsMatch(request, env);
      }
```

Add two lines to the header comment's route list:

```
 *   POST /admin/login_attempt    admin-dashboard login rate limit (token)
 *   POST /stats/match            count given installation ids active today / now (token)
```

- [ ] **Step 3: Type-check and test**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 4: Deploy and verify**

Run: `npx wrangler deploy`
Then (PowerShell, with the stats token in `$t`):
```powershell
Invoke-RestMethod -Method Post -Uri https://ct-analytics.claude-terminal.workers.dev/stats/match -Headers @{'x-ct-token'=$t} -ContentType 'application/json' -Body '{"installation_ids":["nope"]}'
```
Expected: `active_today 0 active_now 0`. Without the header: 401.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/index.ts
git commit -m "feat(worker): POST /admin/login_attempt and POST /stats/match routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Part C: Website (`claude-terminal-website`)

Clone first: `git clone https://github.com/talayash/claude-terminal-website.git C:/Users/talay/agentrium-website && cd C:/Users/talay/agentrium-website && npm ci`. Work on a branch `feat/admin-dashboard`, open a PR to `main` at the end (C9). Tests: `npx vitest run tests/content-lint.test.js` (fast) and `npm run test:run` (includes the Astro build). Edge functions run on the Edge runtime: use Web Crypto and `Request`/`Response` only, no Node built-ins.

`vitest.config.js` currently includes only `tests/**/*.test.js`; Task C1 widens it to `['tests/**/*.test.js', 'src/**/*.test.ts']`.

### Task C1: Signed session cookie library

**Files:**
- Create: `api/_lib/admin-session.js`, `tests/admin-session.test.js`
- Modify: `vitest.config.js`

**Interfaces:**
- Produces (all exported from `api/_lib/admin-session.js`):
  - `COOKIE_NAME = 'agentrium_admin'`
  - `issueSessionCookie(secret, nowMs = Date.now()) → Promise<string>` (a full `Set-Cookie` header value)
  - `clearSessionCookie() → string`
  - `verifySessionCookie(cookieHeader, secret, nowMs = Date.now()) → Promise<boolean>`
  - `requireAdminSession(request) → Promise<Response|null>` (null when valid; 401 JSON otherwise; 500 when `ADMIN_SESSION_SECRET` is unset)
  - `constantTimeEqual(a, b) → boolean` (strings)
  - `jsonResponse(body, status, extraHeaders = {})`

- [ ] **Step 1: Write the failing tests**

`tests/admin-session.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  COOKIE_NAME, issueSessionCookie, clearSessionCookie, verifySessionCookie,
  requireAdminSession, constantTimeEqual,
} from '../api/_lib/admin-session.js';

const SECRET = 'unit-test-secret-please-ignore';
const cookieValue = (setCookie) => setCookie.split(';')[0].split('=')[1];

describe('admin session cookie', () => {
  it('issues an HttpOnly, Secure, SameSite=Strict cookie with a 30 day max-age', async () => {
    const sc = await issueSessionCookie(SECRET);
    expect(sc.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) expect(sc).toContain(attr);
  });
  it('verifies its own cookie', async () => {
    const sc = await issueSessionCookie(SECRET);
    expect(await verifySessionCookie(`foo=bar; ${COOKIE_NAME}=${cookieValue(sc)}`, SECRET)).toBe(true);
  });
  it('rejects a tampered signature, a wrong secret, and an expired cookie', async () => {
    const sc = await issueSessionCookie(SECRET, 1_000_000_000_000);
    const v = cookieValue(sc);
    expect(await verifySessionCookie(`${COOKIE_NAME}=${v}`, 'other-secret')).toBe(false);
    const [exp, sig] = v.split('.');
    expect(await verifySessionCookie(`${COOKIE_NAME}=${exp}.${sig.slice(0, -1)}0`, SECRET)).toBe(false);
    expect(await verifySessionCookie(`${COOKIE_NAME}=${Number(exp) + 999}.${sig}`, SECRET)).toBe(false);
    expect(await verifySessionCookie(`${COOKIE_NAME}=${v}`, SECRET, 1_000_000_000_000 + 31 * 86400 * 1000)).toBe(false);
  });
  it('rejects a missing or malformed cookie', async () => {
    expect(await verifySessionCookie('', SECRET)).toBe(false);
    expect(await verifySessionCookie(null, SECRET)).toBe(false);
    expect(await verifySessionCookie(`${COOKIE_NAME}=garbage`, SECRET)).toBe(false);
  });
  it('clearSessionCookie expires the cookie', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
  it('constantTimeEqual compares strings of unequal length as false', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('requireAdminSession', () => {
  it('returns 500 when the secret is missing', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const r = await requireAdminSession(new Request('https://x/api/x'));
    expect(r.status).toBe(500);
  });
  it('returns 401 without a valid cookie and null with one', async () => {
    process.env.ADMIN_SESSION_SECRET = SECRET;
    expect((await requireAdminSession(new Request('https://x/api/x'))).status).toBe(401);
    const sc = await issueSessionCookie(SECRET);
    const ok = await requireAdminSession(new Request('https://x/api/x', { headers: { cookie: `${COOKIE_NAME}=${cookieValue(sc)}` } }));
    expect(ok).toBeNull();
  });
});
```

- [ ] **Step 2: Widen the vitest include and run to verify failure**

`vitest.config.js`: change `include` to `['tests/**/*.test.js', 'src/**/*.test.ts']`.
Run: `npx vitest run tests/admin-session.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/_lib/admin-session.js`:

```js
// Signed session cookie for /admin. Edge runtime: Web Crypto only.
// Cookie value = "<expiresUnixMs>.<hmacSha256Hex(expires, secret)>".

export const COOKIE_NAME = 'agentrium_admin';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const enc = new TextEncoder();

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare against self when lengths differ so timing stays flat; result is false either way.
  const other = ab.length === bb.length ? bb : ab;
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ other[i];
  return diff === 0;
}

export async function issueSessionCookie(secret, nowMs = Date.now()) {
  const expires = String(nowMs + MAX_AGE_SECONDS * 1000);
  const sig = await hmacHex(expires, secret);
  return `${COOKIE_NAME}=${expires}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function readCookie(header, name) {
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function verifySessionCookie(cookieHeader, secret, nowMs = Date.now()) {
  const value = readCookie(cookieHeader, COOKIE_NAME);
  if (!value || !secret) return false;
  const dot = value.indexOf('.');
  if (dot < 0) return false;
  const expires = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d{1,16}$/.test(expires) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = await hmacHex(expires, secret);
  if (!constantTimeEqual(sig, expected)) return false;
  return Number(expires) > nowMs;
}

export function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/** null when the request carries a valid session; otherwise a ready-to-return Response. */
export async function requireAdminSession(request) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return jsonResponse({ error: 'server_misconfigured', detail: 'ADMIN_SESSION_SECRET not set' }, 500);
  const ok = await verifySessionCookie(request.headers.get('cookie'), secret);
  return ok ? null : jsonResponse({ error: 'unauthorized' }, 401);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/admin-session.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/admin-session.js tests/admin-session.test.js vitest.config.js
git commit -m "feat(admin): HMAC-signed HttpOnly session cookie helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C2: Login, session check, and logout endpoints

**Files:**
- Create: `api/admin-login.js`, `api/admin-session.js`, `api/admin-logout.js`, `tests/admin-login.test.js`

**Interfaces:**
- Consumes: C1 helpers; Worker `POST /admin/login_attempt` (B2).
- Produces: `POST /api/admin-login {password}` → 204 + Set-Cookie | 401 | 429 (+`Retry-After`) | 503 `rate_limiter_unavailable` | 500; `GET /api/admin-session` → 204 | 401; `POST /api/admin-logout` → 204 + clearing Set-Cookie.

- [ ] **Step 1: Write the failing tests**

`tests/admin-login.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import login from '../api/admin-login.js';
import session from '../api/admin-session.js';
import logout from '../api/admin-logout.js';
import { COOKIE_NAME } from '../api/_lib/admin-session.js';

const SECRET = 'unit-test-secret';
const post = (body, headers = {}) => new Request('https://x/api/admin-login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers }, body: JSON.stringify(body),
});

let limiter;
beforeEach(() => {
  process.env.ADMIN_PASSWORD = 'correct horse';
  process.env.ADMIN_SESSION_SECRET = SECRET;
  process.env.CT_STATS_TOKEN = 'ct-token';
  limiter = vi.fn(async () => new Response(JSON.stringify({ allowed: true, remaining: 9 }), { status: 200 }));
  vi.stubGlobal('fetch', limiter);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/admin-login', () => {
  it('sets the session cookie on the right password', async () => {
    const r = await login(post({ password: 'correct horse' }));
    expect(r.status).toBe(204);
    expect(r.headers.get('set-cookie')).toContain(`${COOKIE_NAME}=`);
    const [url, init] = limiter.mock.calls[0];
    expect(String(url)).toBe('https://ct-analytics.claude-terminal.workers.dev/admin/login_attempt');
    expect(init.headers['x-ct-token']).toBe('ct-token');
    expect(JSON.parse(init.body)).toEqual({ ip: '203.0.113.9' });
  });
  it('401 on a wrong password and never sets a cookie', async () => {
    const r = await login(post({ password: 'wrong' }));
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });
  it('400 on a body without a string password', async () => {
    expect((await login(post({}))).status).toBe(400);
  });
  it('429 with Retry-After when the limiter denies, before checking the password', async () => {
    limiter.mockResolvedValue(new Response(JSON.stringify({ allowed: false, retry_after_seconds: 612 }), { status: 200 }));
    const r = await login(post({ password: 'correct horse' }));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('612');
  });
  it('503 when the limiter is unreachable (fail closed)', async () => {
    limiter.mockRejectedValue(new Error('boom'));
    expect((await login(post({ password: 'correct horse' }))).status).toBe(503);
  });
  it('500 when ADMIN_PASSWORD is unset', async () => {
    delete process.env.ADMIN_PASSWORD;
    expect((await login(post({ password: 'x' }))).status).toBe(500);
  });
});

describe('GET /api/admin-session and POST /api/admin-logout', () => {
  it('session is 401 without a cookie and 204 with the one login issued', async () => {
    expect((await session(new Request('https://x/api/admin-session'))).status).toBe(401);
    const sc = (await login(post({ password: 'correct horse' }))).headers.get('set-cookie');
    const cookie = sc.split(';')[0];
    expect((await session(new Request('https://x/api/admin-session', { headers: { cookie } }))).status).toBe(204);
  });
  it('logout clears the cookie', async () => {
    const r = await logout(new Request('https://x/api/admin-logout', { method: 'POST' }));
    expect(r.status).toBe(204);
    expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admin-login.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three endpoints**

`api/admin-login.js`:

```js
// Password gate for /admin. Rate-limited through the ct-analytics Worker's KV
// (edge functions share no memory), then a constant-time password compare,
// then a signed HttpOnly cookie. Fails closed if the limiter is unreachable.

export const config = { runtime: 'edge' };

import { issueSessionCookie, constantTimeEqual, jsonResponse } from './_lib/admin-session.js';

const LIMITER_URL = 'https://ct-analytics.claude-terminal.workers.dev/admin/login_attempt';

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}

export default async function handler(request) {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  const ctToken = process.env.CT_STATS_TOKEN;
  if (!password || !secret || !ctToken) return jsonResponse({ error: 'server_misconfigured' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid_json' }, 400); }
  const provided = body && typeof body.password === 'string' ? body.password : null;
  if (provided === null || provided.length > 512) return jsonResponse({ error: 'invalid_payload' }, 400);

  let verdict;
  try {
    const res = await fetch(LIMITER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ct-token': ctToken },
      body: JSON.stringify({ ip: clientIp(request) }),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`limiter ${res.status}`);
    verdict = await res.json();
  } catch {
    return jsonResponse({ error: 'rate_limiter_unavailable' }, 503);
  }
  if (!verdict.allowed) {
    const retry = Math.max(1, Number(verdict.retry_after_seconds) || 60);
    return jsonResponse({ error: 'rate_limited', retry_after: retry }, 429, { 'retry-after': String(retry) });
  }

  if (!constantTimeEqual(provided, password)) return jsonResponse({ error: 'unauthorized' }, 401);

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': await issueSessionCookie(secret), 'cache-control': 'no-store' },
  });
}
```

`api/admin-session.js`:

```js
export const config = { runtime: 'edge' };

import { requireAdminSession } from './_lib/admin-session.js';

export default async function handler(request) {
  const denied = await requireAdminSession(request);
  if (denied) return denied;
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
```

`api/admin-logout.js`:

```js
export const config = { runtime: 'edge' };

import { clearSessionCookie } from './_lib/admin-session.js';

export default async function handler() {
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearSessionCookie(), 'cache-control': 'no-store' },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/admin-login.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/admin-login.js api/admin-session.js api/admin-logout.js tests/admin-login.test.js
git commit -m "feat(admin): login, session check and logout edge endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C3: Session-gate the existing proxies and add the Worker proxies

**Files:**
- Modify: `api/stats.js`, `api/stats-live.js`, `api/stats-history.js`, `api/feedback-list.js`, `api/feedback-mark-read.js`
- Create: `api/errors-summary.js`, `api/_lib/worker-proxy.js`, `tests/admin-proxies.test.js`

**Interfaces:**
- Produces: `proxyWorker(request, { path, allowParams, method })` in `api/_lib/worker-proxy.js`: runs `requireAdminSession`, forwards to `https://ct-analytics.claude-terminal.workers.dev<path>` with `x-ct-token`, whitelisting query params and passing a POST body through. Every proxy file becomes a thin call.

- [ ] **Step 1: Write the failing tests**

`tests/admin-proxies.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { issueSessionCookie } from '../api/_lib/admin-session.js';
import stats from '../api/stats.js';
import live from '../api/stats-live.js';
import history from '../api/stats-history.js';
import feedbackList from '../api/feedback-list.js';
import feedbackMark from '../api/feedback-mark-read.js';
import errorsSummary from '../api/errors-summary.js';

const SECRET = 's3';
let upstream;
let cookie;

beforeEach(async () => {
  process.env.ADMIN_SESSION_SECRET = SECRET;
  process.env.CT_STATS_TOKEN = 'ct';
  upstream = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', upstream);
  cookie = (await issueSessionCookie(SECRET)).split(';')[0];
});
afterEach(() => vi.unstubAllGlobals());

const cases = [
  ['stats', stats, 'GET', '/api/stats', 'https://ct-analytics.claude-terminal.workers.dev/stats'],
  ['stats-live', live, 'GET', '/api/stats-live', 'https://ct-analytics.claude-terminal.workers.dev/stats/live'],
  ['stats-history', history, 'GET', '/api/stats-history?metric=dau&days=7', 'https://ct-analytics.claude-terminal.workers.dev/stats/history?metric=dau&days=7'],
  ['feedback-list', feedbackList, 'GET', '/api/feedback-list?limit=5&unread_only=1', 'https://ct-analytics.claude-terminal.workers.dev/feedback/list?limit=5&unread_only=1'],
  ['feedback-mark-read', feedbackMark, 'POST', '/api/feedback-mark-read', 'https://ct-analytics.claude-terminal.workers.dev/feedback/mark_read'],
  ['errors-summary', errorsSummary, 'GET', '/api/errors-summary?days=30&limit=10', 'https://ct-analytics.claude-terminal.workers.dev/errors/summary?days=30&limit=10'],
];

describe.each(cases)('%s proxy', (_name, handler, method, path, expectedUpstream) => {
  const init = method === 'POST' ? { method, body: '{"ids":[1]}', headers: { 'content-type': 'application/json' } } : {};
  it('401 without a session and never calls upstream', async () => {
    const r = await handler(new Request(`https://x${path}`, init));
    expect(r.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('forwards with the worker token when the session is valid', async () => {
    const r = await handler(new Request(`https://x${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const [url, opts] = upstream.mock.calls[0];
    expect(String(url)).toBe(expectedUpstream);
    expect(opts.headers['x-ct-token']).toBe('ct');
    if (method === 'POST') expect(opts.body).toBe('{"ids":[1]}');
  });
});

describe('stats-history validation', () => {
  it('rejects an unknown metric with 400', async () => {
    const r = await history(new Request('https://x/api/stats-history?metric=evil', { headers: { cookie } }));
    expect(r.status).toBe(400);
  });
});

describe('upstream failure', () => {
  it('502 when the worker is unreachable', async () => {
    upstream.mockRejectedValue(new Error('down'));
    const r = await stats(new Request('https://x/api/stats', { headers: { cookie } }));
    expect(r.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admin-proxies.test.js`
Expected: FAIL (401 tests fail for the ungated proxies; errors-summary module missing).

- [ ] **Step 3: Implement the shared proxy helper**

`api/_lib/worker-proxy.js`:

```js
// Shared same-origin proxy to the ct-analytics Worker. Every caller is gated by
// the /admin session cookie; the Worker token stays server-side.

import { requireAdminSession, jsonResponse } from './admin-session.js';

export const WORKER_ORIGIN = 'https://ct-analytics.claude-terminal.workers.dev';

/**
 * @param {Request} request
 * @param {{ path: string, allowParams?: Record<string, (v: string) => string | null>, method?: 'GET'|'POST' }} opts
 *   allowParams maps a query param name to a sanitizer returning the value to forward, or null to drop it.
 */
export async function proxyWorker(request, opts) {
  const denied = await requireAdminSession(request);
  if (denied) return denied;

  const token = process.env.CT_STATS_TOKEN;
  if (!token) return jsonResponse({ error: 'server_misconfigured', detail: 'CT_STATS_TOKEN not set' }, 500);

  const method = opts.method ?? 'GET';
  if (request.method !== method) return jsonResponse({ error: 'method_not_allowed' }, 405);

  const incoming = new URL(request.url);
  const target = new URL(opts.path, WORKER_ORIGIN);
  for (const [name, sanitize] of Object.entries(opts.allowParams ?? {})) {
    const raw = incoming.searchParams.get(name);
    if (raw === null) continue;
    const clean = sanitize(raw);
    if (clean === null) return jsonResponse({ error: `invalid_${name}` }, 400);
    target.searchParams.set(name, clean);
  }

  const init = { method, headers: { 'x-ct-token': token }, cache: 'no-store' };
  if (method === 'POST') {
    init.headers['content-type'] = request.headers.get('content-type') ?? 'application/json';
    init.body = await request.text();
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), init);
  } catch (err) {
    return jsonResponse({ error: 'upstream_unreachable', detail: String(err) }, 502);
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export const intParam = (min, max, fallback) => (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return String(fallback);
  return String(Math.min(Math.max(n, min), max));
};
export const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : null);
```

- [ ] **Step 4: Rewrite the six proxy files**

`api/stats.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker } from './_lib/worker-proxy.js';
export default (request) => proxyWorker(request, { path: '/stats' });
```

`api/stats-live.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker } from './_lib/worker-proxy.js';
export default (request) => proxyWorker(request, { path: '/stats/live' });
```

`api/stats-history.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker, intParam, oneOf } from './_lib/worker-proxy.js';
const METRICS = ['dau', 'heartbeats', 'update_checks', 'version', 'os', 'country'];
export default (request) => proxyWorker(request, {
  path: '/stats/history',
  allowParams: { metric: oneOf(METRICS), days: intParam(1, 365, 30) },
});
```

`api/feedback-list.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker, intParam, oneOf } from './_lib/worker-proxy.js';
export default (request) => proxyWorker(request, {
  path: '/feedback/list',
  allowParams: { limit: intParam(1, 500, 100), unread_only: oneOf(['0', '1']) },
});
```

`api/feedback-mark-read.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker } from './_lib/worker-proxy.js';
export default (request) => proxyWorker(request, { path: '/feedback/mark_read', method: 'POST' });
```

`api/errors-summary.js`:
```js
export const config = { runtime: 'edge' };
import { proxyWorker, intParam } from './_lib/worker-proxy.js';
export default (request) => proxyWorker(request, {
  path: '/errors/summary',
  allowParams: { days: intParam(1, 90, 7), limit: intParam(1, 100, 20) },
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/admin-proxies.test.js tests/admin-login.test.js tests/admin-session.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api tests/admin-proxies.test.js
git commit -m "feat(admin): session-gate every worker proxy, add errors-summary proxy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C4: Account-data proxies to agentrium-api

**Files:**
- Create: `api/_lib/api-proxy.js`, `api/admin-summary.js`, `api/admin-users.js`, `api/admin-user.js`, `tests/admin-api-proxies.test.js`

**Interfaces:**
- Consumes: API routes from A4 to A6; Worker `POST /stats/match` (B2).
- Produces: `GET /api/admin-summary` (merged body per spec 6.4, with `signed_in: {active_today, active_now} | null`, without `active_installation_ids`), `GET /api/admin-users?q&cursor&limit`, `GET /api/admin-user?id=<uuid>`.

- [ ] **Step 1: Write the failing tests**

`tests/admin-api-proxies.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { issueSessionCookie } from '../api/_lib/admin-session.js';
import summary from '../api/admin-summary.js';
import users from '../api/admin-users.js';
import user from '../api/admin-user.js';

const API = 'https://agentrium-api.vercel.app';
const WORKER = 'https://ct-analytics.claude-terminal.workers.dev';
let calls; let cookie;

beforeEach(async () => {
  process.env.ADMIN_SESSION_SECRET = 's3';
  process.env.ADMIN_API_TOKEN = 'api-tok';
  process.env.CT_STATS_TOKEN = 'ct';
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).startsWith(`${API}/api/admin/summary`)) {
      return Response.json({ generated_at: 'now', users: { total: 2 }, active_installation_ids: ['a', 'b'] });
    }
    if (String(url) === `${WORKER}/stats/match`) return Response.json({ active_today: 1, active_now: 0 });
    return Response.json({ ok: true });
  }));
  cookie = (await issueSessionCookie('s3')).split(';')[0];
});
afterEach(() => vi.unstubAllGlobals());

describe('admin-summary', () => {
  it('401 without a session', async () => {
    expect((await summary(new Request('https://x/api/admin-summary'))).status).toBe(401);
  });
  it('merges the match result and strips installation ids', async () => {
    const r = await summary(new Request('https://x/api/admin-summary', { headers: { cookie } }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.signed_in).toEqual({ active_today: 1, active_now: 0 });
    expect(body.active_installation_ids).toBeUndefined();
    expect(body.users.total).toBe(2);
    expect(calls[0][1].headers['x-admin-token']).toBe('api-tok');
    expect(JSON.parse(calls[1][1].body)).toEqual({ installation_ids: ['a', 'b'] });
  });
  it('signed_in is null when the match call fails', async () => {
    fetch.mockImplementation(async (url) => String(url).includes('/stats/match')
      ? new Response('x', { status: 500 })
      : Response.json({ generated_at: 'now', users: {}, active_installation_ids: [] }));
    const body = await (await summary(new Request('https://x/api/admin-summary', { headers: { cookie } }))).json();
    expect(body.signed_in).toBeNull();
  });
});

describe('admin-users and admin-user', () => {
  it('forwards whitelisted params', async () => {
    await users(new Request('https://x/api/admin-users?q=dan&limit=20&cursor=abc&evil=1', { headers: { cookie } }));
    expect(calls[0][0]).toBe(`${API}/api/admin/users?q=dan&limit=20&cursor=abc`);
  });
  it('validates the user id', async () => {
    expect((await user(new Request('https://x/api/admin-user?id=nope', { headers: { cookie } }))).status).toBe(400);
    await user(new Request('https://x/api/admin-user?id=6f1c2a3e-1111-4222-8333-444455556666', { headers: { cookie } }));
    expect(calls[0][0]).toBe(`${API}/api/admin/users/6f1c2a3e-1111-4222-8333-444455556666`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admin-api-proxies.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/_lib/api-proxy.js`:

```js
import { requireAdminSession, jsonResponse } from './admin-session.js';

export const API_ORIGIN = 'https://agentrium-api.vercel.app';

/** Session-gated GET to agentrium-api with the shared admin token. Returns the upstream Response or an error Response. */
export async function fetchApi(request, pathWithQuery) {
  const denied = await requireAdminSession(request);
  if (denied) return { denied };
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return { denied: jsonResponse({ error: 'server_misconfigured', detail: 'ADMIN_API_TOKEN not set' }, 500) };
  try {
    const upstream = await fetch(`${API_ORIGIN}${pathWithQuery}`, { headers: { 'x-admin-token': token }, cache: 'no-store' });
    return { upstream };
  } catch (err) {
    return { denied: jsonResponse({ error: 'upstream_unreachable', detail: String(err) }, 502) };
  }
}

export async function passThrough(upstream) {
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}
```

`api/admin-summary.js`:

```js
export const config = { runtime: 'edge' };
import { fetchApi, passThrough } from './_lib/api-proxy.js';
import { jsonResponse } from './_lib/admin-session.js';
import { WORKER_ORIGIN } from './_lib/worker-proxy.js';

export default async function handler(request) {
  const { denied, upstream } = await fetchApi(request, '/api/admin/summary');
  if (denied) return denied;
  if (!upstream.ok) return passThrough(upstream);

  const summary = await upstream.json();
  const ids = Array.isArray(summary.active_installation_ids) ? summary.active_installation_ids : [];
  delete summary.active_installation_ids;

  let signed_in = null;
  const token = process.env.CT_STATS_TOKEN;
  if (token) {
    try {
      const m = await fetch(`${WORKER_ORIGIN}/stats/match`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ct-token': token },
        body: JSON.stringify({ installation_ids: ids }),
        cache: 'no-store',
      });
      if (m.ok) {
        const j = await m.json();
        signed_in = { active_today: Number(j.active_today) || 0, active_now: Number(j.active_now) || 0 };
      }
    } catch {
      // Leave signed_in null; the tile shows "n/a" rather than failing the page.
    }
  }
  return jsonResponse({ ...summary, signed_in }, 200);
}
```

`api/admin-users.js`:

```js
export const config = { runtime: 'edge' };
import { fetchApi, passThrough } from './_lib/api-proxy.js';

export default async function handler(request) {
  const incoming = new URL(request.url);
  const qs = new URLSearchParams();
  const q = incoming.searchParams.get('q');
  if (q) qs.set('q', q.slice(0, 100));
  const limit = parseInt(incoming.searchParams.get('limit') ?? '', 10);
  if (Number.isFinite(limit)) qs.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  const cursor = incoming.searchParams.get('cursor');
  if (cursor && /^[A-Za-z0-9_-]{1,200}$/.test(cursor)) qs.set('cursor', cursor);
  const suffix = qs.toString() ? `?${qs}` : '';
  const { denied, upstream } = await fetchApi(request, `/api/admin/users${suffix}`);
  return denied ?? passThrough(upstream);
}
```

`api/admin-user.js`:

```js
export const config = { runtime: 'edge' };
import { fetchApi, passThrough } from './_lib/api-proxy.js';
import { jsonResponse } from './_lib/admin-session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return jsonResponse({ error: 'invalid_id' }, 400);
  const { denied, upstream } = await fetchApi(request, `/api/admin/users/${id}`);
  return denied ?? passThrough(upstream);
}
```

Note: `admin-user.js` validates the id before the session check, which is fine because a 400 leaks nothing; but to keep "401 first" behaviour uniform, swap the order if the reviewer prefers. The test does not depend on the order.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/admin-api-proxies.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/api-proxy.js api/admin-summary.js api/admin-users.js api/admin-user.js tests/admin-api-proxies.test.js
git commit -m "feat(admin): account-data proxies to agentrium-api with signed-in merge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C5: Pure front-end modules: tabs and formatting

**Files:**
- Create: `src/lib/admin/tabs.ts`, `src/lib/admin/tabs.test.ts`, `src/lib/admin/format.ts`, `src/lib/admin/format.test.ts`

**Interfaces:**
- Produces:
  - `TABS = ['overview','users','telemetry','errors','inbox'] as const`, `type Tab`, `parseTab(hash: string): Tab`, `tabHash(tab: Tab): string`.
  - `formatNumber(n: unknown): string`, `timeAgo(iso: string, now?: number): string`, `countryFlag(code: string): string`, `countryName(code: string): string`, `osIcon(os: string): string`, `osLabel(os: string): string`, `compareVersionDesc(a: string, b: string): number`, `escapeHtml(s: unknown): string`, `distinctCount(obj: unknown): number`, `initials(nameOrEmail: string): string`.
- The bodies of `countryFlag`, `osIcon`, `osLabel`, `formatNumber`, `escapeHtml`, `distinctCount`, `compareVersionDesc` and the `COUNTRY_NAMES` table are moved out of `src/pages/stat.astro` unchanged; `timeAgo` is moved from `src/pages/inbox.astro` with a `now` parameter added for testability.

- [ ] **Step 1: Write the failing tests**

`src/lib/admin/tabs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTab, tabHash, TABS } from './tabs';

describe('tabs', () => {
  it('parses known hashes and falls back to overview', () => {
    for (const t of TABS) expect(parseTab(`#${t}`)).toBe(t);
    expect(parseTab('')).toBe('overview');
    expect(parseTab('#')).toBe('overview');
    expect(parseTab('#nope')).toBe('overview');
    expect(parseTab('#INBOX')).toBe('inbox');
  });
  it('round-trips', () => {
    for (const t of TABS) expect(parseTab(tabHash(t))).toBe(t);
  });
});
```

`src/lib/admin/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatNumber, timeAgo, countryFlag, countryName, osLabel, compareVersionDesc, escapeHtml, initials, distinctCount } from './format';

describe('format', () => {
  it('formatNumber', () => {
    expect(formatNumber(1204)).toBe('1,204');
    expect(formatNumber('x')).toBe('-');
    expect(formatNumber(NaN)).toBe('-');
  });
  it('timeAgo buckets', () => {
    const now = Date.parse('2026-09-13T12:00:00Z');
    expect(timeAgo('2026-09-13T11:59:30Z', now)).toBe('30s ago');
    expect(timeAgo('2026-09-13T11:15:00Z', now)).toBe('45m ago');
    expect(timeAgo('2026-09-13T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-09-10T12:00:00Z', now)).toBe('3d ago');
    expect(timeAgo('garbage', now)).toBe('-');
  });
  it('country helpers', () => {
    expect(countryFlag('IL')).toBe('🇮🇱');
    expect(countryFlag('??')).toBe('🏳️');
    expect(countryName('IL')).toBe('Israel');
    expect(countryName('ZZ')).toBe('ZZ');
  });
  it('osLabel', () => {
    expect(osLabel('windows')).toBe('Windows');
    expect(osLabel('darwin')).toBe('macOS');
    expect(osLabel('macos')).toBe('macOS');
    expect(osLabel('linux')).toBe('Linux');
  });
  it('compareVersionDesc sorts newest first', () => {
    expect(['1.33.6', '1.33.10', '1.32.9'].sort(compareVersionDesc)).toEqual(['1.33.10', '1.33.6', '1.32.9']);
  });
  it('escapeHtml', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('initials', () => {
    expect(initials('Dana Levi')).toBe('DL');
    expect(initials('dana@example.com')).toBe('D');
    expect(initials('')).toBe('?');
  });
  it('distinctCount ignores zeros', () => {
    expect(distinctCount({ a: 1, b: 0, c: 3 })).toBe(2);
    expect(distinctCount(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `tabs.ts`**

```ts
export const TABS = ['overview', 'users', 'telemetry', 'errors', 'inbox'] as const;
export type Tab = (typeof TABS)[number];

export function parseTab(hash: string): Tab {
  const key = (hash ?? '').replace(/^#/, '').toLowerCase();
  return (TABS as readonly string[]).includes(key) ? (key as Tab) : 'overview';
}

export function tabHash(tab: Tab): string {
  return `#${tab}`;
}
```

- [ ] **Step 4: Implement `format.ts`**

Move the following from `src/pages/stat.astro` into `src/lib/admin/format.ts`, each with `export` added and TypeScript parameter types (`unknown`/`string`): `COUNTRY_NAMES`, `countryFlag`, `osIcon`, `osLabel`, `formatNumber`, `escapeHtml`, `distinctCount`, `compareVersionDesc`. Add:

```ts
export function countryName(code: string): string {
  return COUNTRY_NAMES[String(code).toUpperCase()] ?? code;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function initials(nameOrEmail: string): string {
  const s = String(nameOrEmail ?? '').trim();
  if (!s) return '?';
  if (s.includes('@')) return s[0].toUpperCase();
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}
```

`osLabel` must also map `macos` to `macOS` (the API stores Rust's `std::env::consts::OS`, which is `macos`): add `|| key.includes('macos')` to the darwin branch. `escapeHtml` must escape `&`, `<`, `>`, `"`, `'` exactly as the test expects.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/admin`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin
git commit -m "feat(admin): tab hash routing and formatting helpers with tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C6: Chart renderers and session client

**Files:**
- Create: `src/lib/admin/charts.ts`, `src/lib/admin/session.ts`, `src/lib/admin/dom.ts`

**Interfaces:**
- Produces:
  - `charts.ts`: `renderLineArea(svg: SVGElement, series: {date:string;value:number}[], color: string): {max:number; from:string; to:string}`, `renderStackedArea(svg: SVGElement, legend: HTMLElement|null, series: {date:string;bucket:string;value:number}[]): {buckets:string[]; from:string; to:string}`, `renderBars(svg: SVGElement, series: {date:string;value:number}[], color: string): {max:number}`, `renderDistribution(container: HTMLElement, dist: Record<string,number>|undefined, formatter: (key:string)=>{label:string; sub:string}): number` (returns entry count), `SERIES_COLORS`.
  - `session.ts`: `checkSession(): Promise<boolean>`, `login(password: string): Promise<{ok:true}|{ok:false; status:number; retryAfter:number|null}>`, `logout(): Promise<void>`.
  - `dom.ts`: `$(id: string): HTMLElement`, `el(tag: string, className?: string): HTMLElement`, `text(tag: string, className: string, str: string): HTMLElement`, `clear(node: Element): void` (moved from `inbox.astro`).

- [ ] **Step 1: Create `charts.ts` by moving the renderers**

Move `SERIES_COLORS`, `renderLineArea`, `renderStackedArea`, `renderBar`, `renderDistribution`, `emptyState`, `errorState` from `src/pages/stat.astro` into `src/lib/admin/charts.ts`. Change every `$(svgId)` / `$(peakElId)` style lookup into a passed-in element and return the numbers the caller used to set labels (the `{max, from, to}` objects above). Replace `SERIES_COLORS` with the Midnight palette:

```ts
export const SERIES_COLORS = ['#0A84FF', '#7A5BFF', '#38B6FF', '#AEAEB2', '#5E5CE6', '#64D2FF'];
```

and the area fill `rgba(200,106,74,0.12)` with `rgba(10,132,255,0.14)`; the bar track background likewise. Import `formatNumber`, `escapeHtml`, `compareVersionDesc` from `./format`.

Add the new renderer:

```ts
export function renderBars(svg: SVGElement, series: Array<{ date: string; value: number }>, color: string): { max: number } {
  if (!series.length) {
    svg.innerHTML = '<text x="500" y="100" text-anchor="middle" fill="#8A8A92" font-size="14">No data yet</text>';
    return { max: 0 };
  }
  const W = 1000, H = 200, gap = 2;
  const max = Math.max(...series.map((p) => p.value || 0), 1);
  const bw = Math.max(1, W / series.length - gap);
  svg.innerHTML = series
    .map((p, i) => {
      const h = ((p.value || 0) / max) * (H - 8);
      const x = (i * W) / series.length;
      const y = H - h - 2;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${Math.max(h, p.value ? 2 : 0).toFixed(2)}" fill="${color}" opacity="0.9"><title>${escapeHtml(p.date)}: ${formatNumber(p.value)}</title></rect>`;
    })
    .join('');
  return { max };
}
```

- [ ] **Step 2: Create `session.ts`**

```ts
export async function checkSession(): Promise<boolean> {
  try {
    const r = await fetch('/api/admin-session', { cache: 'no-store', credentials: 'include' });
    return r.status === 204;
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<{ ok: true } | { ok: false; status: number; retryAfter: number | null }> {
  const r = await fetch('/api/admin-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'include',
    cache: 'no-store',
  });
  if (r.status === 204) return { ok: true };
  const retry = r.headers.get('retry-after');
  return { ok: false, status: r.status, retryAfter: retry ? parseInt(retry, 10) : null };
}

export async function logout(): Promise<void> {
  await fetch('/api/admin-logout', { method: 'POST', credentials: 'include', cache: 'no-store' });
}
```

- [ ] **Step 3: Create `dom.ts`**

```ts
export const $ = (id: string): HTMLElement => {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
};
export const el = (tag: string, className = ''): HTMLElement => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
};
export const text = (tag: string, className: string, str: string): HTMLElement => {
  const n = el(tag, className);
  n.textContent = str;
  return n;
};
export const clear = (node: Element): void => {
  while (node.firstChild) node.removeChild(node.firstChild);
};
```

- [ ] **Step 4: Type-check**

Run: `npx astro check` (installs `@astrojs/check` on first run if prompted; accept) or `npx tsc --noEmit -p tsconfig.json`.
Expected: no errors in `src/lib/admin/*`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin
git commit -m "feat(admin): chart renderers, session client and DOM helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C7: The `/admin` page

**Files:**
- Create: `src/pages/admin.astro`, `src/lib/admin/panels/overview.ts`, `src/lib/admin/panels/users.ts`, `src/lib/admin/panels/telemetry.ts`, `src/lib/admin/panels/errors.ts`, `src/lib/admin/panels/inbox.ts`, `src/lib/admin/poll.ts`
- Modify: `src/styles/global.css` (append admin styles)

**Interfaces:**
- Each panel module exports `{ mount(root: HTMLElement): void; activate(): void; deactivate(): void }` and, for badges, `onBadge?: (n: number) => void` set by the page.
- `poll.ts`: `createPoller(fn: () => Promise<void>, intervalMs: number): { start(): void; stop(): void; now(): void }` that runs `fn` immediately on `start`, every `intervalMs` while `document.visibilityState === 'visible'`, skips overlapping runs, and re-runs on `visibilitychange` to visible.

- [ ] **Step 1: Implement `poll.ts`**

```ts
export function createPoller(fn: () => Promise<void>, intervalMs: number) {
  let timer: number | null = null;
  let inFlight = false;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await fn(); } finally { inFlight = false; }
  };
  const onVis = () => { if (document.visibilityState === 'visible') void run(); };
  return {
    start() {
      if (timer !== null) return;
      void run();
      timer = window.setInterval(() => { if (document.visibilityState === 'visible') void run(); }, intervalMs);
      document.addEventListener('visibilitychange', onVis);
    },
    stop() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVis);
    },
    now() { void run(); },
  };
}
```

- [ ] **Step 2: Write `admin.astro`**

```astro
---
import Layout from '../layouts/Layout.astro';
---

<Layout title="Admin - Agentrium" description="Internal admin dashboard - private.">
  <Fragment slot="head">
    <meta name="robots" content="noindex, nofollow, noarchive" />
  </Fragment>

  <!-- Login card: the only thing rendered until /api/admin-session says 204 -->
  <main id="login" class="admin-canvas min-h-screen flex items-center justify-center px-4">
    <form id="login-form" class="admin-card w-full max-w-sm p-8 space-y-5">
      <div class="flex items-center gap-3">
        <img src="/icons/icon.png" alt="" class="w-9 h-9 rounded-xl" />
        <div>
          <div class="text-lg font-semibold text-[var(--night-text)]">Agentrium Admin</div>
          <div class="text-xs text-[var(--night-text-3)]">/admin</div>
        </div>
      </div>
      <label class="block">
        <span class="text-xs uppercase tracking-wider text-[var(--night-text-3)]">Password</span>
        <input id="login-password" type="password" autocomplete="current-password" required
               class="admin-input mt-1.5 w-full" />
      </label>
      <button type="submit" class="admin-btn-primary w-full">Sign in</button>
      <p id="login-error" class="text-sm text-[#FF453A] min-h-5" role="alert"></p>
    </form>
  </main>

  <!-- Dashboard shell -->
  <main id="app" class="admin-canvas min-h-screen pb-16" hidden>
    <header class="admin-topbar">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-3">
        <img src="/icons/icon.png" alt="" class="w-6 h-6 rounded-lg" />
        <span class="font-semibold text-[var(--night-text)]">Admin</span>
        <span class="text-xs text-[var(--night-text-3)]">/admin</span>
        <span class="flex-1"></span>
        <span id="live-pill" class="admin-pill admin-pill-live"><span id="live-count">-</span> active now</span>
        <span id="refreshed-pill" class="admin-pill hidden sm:inline-flex">-</span>
        <button id="refresh-btn" type="button" class="admin-btn">Refresh</button>
        <button id="logout-btn" type="button" class="admin-btn">Log out</button>
      </div>
      <nav class="admin-tabs" aria-label="Sections">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex gap-1 overflow-x-auto">
          <a href="#overview" data-tab="overview" class="admin-tab">Overview</a>
          <a href="#users" data-tab="users" class="admin-tab">Users</a>
          <a href="#telemetry" data-tab="telemetry" class="admin-tab">Telemetry</a>
          <a href="#errors" data-tab="errors" class="admin-tab">Errors <span data-badge="errors" class="admin-badge admin-badge-err" hidden>0</span></a>
          <a href="#inbox" data-tab="inbox" class="admin-tab">Inbox <span data-badge="inbox" class="admin-badge" hidden>0</span></a>
        </div>
      </nav>
    </header>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
      <section id="panel-overview" data-panel="overview" hidden></section>
      <section id="panel-users" data-panel="users" hidden></section>
      <section id="panel-telemetry" data-panel="telemetry" hidden></section>
      <section id="panel-errors" data-panel="errors" hidden></section>
      <section id="panel-inbox" data-panel="inbox" hidden></section>
    </div>
    <p class="mt-10 text-center text-xs text-[var(--night-text-3)]">live 15s · history 5 min · inbox 60s</p>
  </main>

  <script>
    import { parseTab, tabHash, TABS, type Tab } from '../lib/admin/tabs';
    import { checkSession, login, logout } from '../lib/admin/session';
    import { $ } from '../lib/admin/dom';
    import * as overview from '../lib/admin/panels/overview';
    import * as users from '../lib/admin/panels/users';
    import * as telemetry from '../lib/admin/panels/telemetry';
    import * as errors from '../lib/admin/panels/errors';
    import * as inbox from '../lib/admin/panels/inbox';

    const panels: Record<Tab, typeof overview> = { overview, users, telemetry, errors, inbox };
    let active: Tab | null = null;

    function setBadge(name: 'errors' | 'inbox', n: number) {
      const b = document.querySelector<HTMLElement>(`[data-badge="${name}"]`);
      if (!b) return;
      b.textContent = String(n);
      b.hidden = n <= 0;
    }

    function showTab(tab: Tab) {
      if (active === tab) return;
      if (active) panels[active].deactivate();
      for (const t of TABS) {
        $(`panel-${t}`).hidden = t !== tab;
        document.querySelector(`[data-tab="${t}"]`)?.classList.toggle('is-active', t === tab);
      }
      active = tab;
      panels[tab].activate();
    }

    function onUnauthorized() {
      $('app').hidden = true;
      $('login').hidden = false;
      $('login-error').textContent = 'Session expired, sign in again.';
    }

    async function boot() {
      if (!(await checkSession())) return;
      $('login').hidden = true;
      $('app').hidden = false;
      const ctx = {
        onUnauthorized,
        setLive: (n: string) => { $('live-count').textContent = n; },
        setRefreshed: (s: string) => { $('refreshed-pill').textContent = s; },
        setBadge,
      };
      for (const t of TABS) panels[t].mount($(`panel-${t}`), ctx);
      showTab(parseTab(location.hash));
      window.addEventListener('hashchange', () => showTab(parseTab(location.hash)));
      $('refresh-btn').addEventListener('click', () => { if (active) panels[active].refresh(); });
      $('logout-btn').addEventListener('click', async () => { await logout(); location.reload(); });
      // Badges come from the two cheapest endpoints, independent of the active tab.
      errors.pollBadge(ctx);
      inbox.pollBadge(ctx);
    }

    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('login-error');
      err.textContent = '';
      const pw = ($('login-password') as HTMLInputElement).value;
      const r = await login(pw);
      if (r.ok) { location.hash = location.hash || tabHash('overview'); location.reload(); return; }
      err.textContent =
        r.status === 401 ? 'Wrong password.'
        : r.status === 429 ? `Too many attempts. Try again in ${Math.ceil((r.retryAfter ?? 900) / 60)} minutes.`
        : r.status === 503 ? 'Rate limiter unavailable, try again shortly.'
        : 'Server misconfigured.';
    });

    boot();
  </script>
</Layout>
```

The panel module contract used above is therefore:

```ts
export interface PanelCtx {
  onUnauthorized(): void;
  setLive(n: string): void;
  setRefreshed(s: string): void;
  setBadge(name: 'errors' | 'inbox', n: number): void;
}
export function mount(root: HTMLElement, ctx: PanelCtx): void;
export function activate(): void;
export function deactivate(): void;
export function refresh(): void;
```

Put `PanelCtx` in `src/lib/admin/panels/types.ts` and import it from every panel. `errors.ts` and `inbox.ts` additionally export `pollBadge(ctx: PanelCtx): void`.

- [ ] **Step 3: Shared fetch helper for panels**

Add to `src/lib/admin/session.ts`:

```ts
/** GET JSON from a same-origin admin proxy. Throws on non-2xx; calls onUnauthorized on 401. */
export async function getJson<T>(url: string, onUnauthorized: () => void): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', credentials: 'include' });
  if (r.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
```

- [ ] **Step 4: Telemetry panel (moved from `/stat`)**

`src/lib/admin/panels/telemetry.ts`: `mount` sets `root.innerHTML` to the inner markup of today's `stat.astro` `<main>` from the "Live now banner" comment down to and including the "Raw payload" `<details>` (drop the page header and the footer line). Keep every `id` as is. Then port the script logic from `stat.astro` (`fetchLiveAndToday`, `renderToday`, `renderLive`, `fetchHistory`, `setStatus`) into the module, replacing `$('chart-dau')`-style renderer calls with the C6 signatures, for example:

```ts
const dauMeta = renderLineArea($('chart-dau') as unknown as SVGElement, dau.series ?? [], '#0A84FF');
$('chart-dau-peak').textContent = `peak ${formatNumber(dauMeta.max)}`;
$('chart-dau-from').textContent = dauMeta.from;
$('chart-dau-to').textContent = dauMeta.to;
```

Wire two pollers: live+today at 15 000 ms, history at 300 000 ms. `activate()` starts both, `deactivate()` stops both, `refresh()` calls `now()` on both. `renderLive` also calls `ctx.setLive(formatNumber(data.active_now ?? 0))` and every successful fetch calls `ctx.setRefreshed(new Date().toLocaleTimeString())`. The status pill in the moved markup keeps working via `setStatus`.

- [ ] **Step 5: Inbox panel (moved from `/inbox`)**

`src/lib/admin/panels/inbox.ts`: `mount` sets `root.innerHTML` to the inner markup of today's `inbox.astro` `<main>` minus the page header block (keep the controls row, KPI grid, status pill, `#messages`, `#empty`). Port `buildCard`, `render`, `load`, `markRead` verbatim, importing `el`, `text`, `clear` from `../dom` and `timeAgo` from `../format`. After `load()` succeeds call `ctx.setBadge('inbox', data.unread ?? 0)`. Poller at 60 000 ms. Add:

```ts
export function pollBadge(ctx: PanelCtx) {
  const tick = async () => {
    try {
      const d = await getJson<{ unread: number }>('/api/feedback-list?limit=1&unread_only=1', ctx.onUnauthorized);
      ctx.setBadge('inbox', d.unread ?? 0);
    } catch { /* badge is best-effort; the tab itself reports errors */ }
  };
  createPoller(tick, 60_000).start();
}
```

- [ ] **Step 6: Errors panel**

`src/lib/admin/panels/errors.ts` renders the `/api/errors-summary` payload. Markup set in `mount`:

```html
<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
  <h2 class="admin-h2">Errors</h2>
  <div class="flex items-center gap-2">
    <select id="err-days" class="admin-input text-xs">
      <option value="1">Last 24 hours</option><option value="7" selected>Last 7 days</option>
      <option value="30">Last 30 days</option><option value="90">Last 90 days</option>
    </select>
    <span id="err-status" class="admin-pill">loading…</span>
  </div>
</div>
<div class="grid grid-cols-3 gap-4 mb-6">
  <div class="admin-card p-5"><div class="admin-label">Total errors</div><div id="err-total" class="admin-big text-[#FF453A]">-</div></div>
  <div class="admin-card p-5"><div class="admin-label">Installations affected</div><div id="err-installs" class="admin-big">-</div></div>
  <div class="admin-card p-5"><div class="admin-label">Unique groups</div><div id="err-groups" class="admin-big">-</div></div>
</div>
<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
  <section class="admin-card p-5"><h3 class="admin-h3">By source</h3><div id="err-by-source" class="space-y-2.5"></div></section>
  <section class="admin-card p-5"><h3 class="admin-h3">By version</h3><div id="err-by-version" class="space-y-2.5"></div></section>
  <section class="admin-card p-5"><h3 class="admin-h3">By OS</h3><div id="err-by-os" class="space-y-2.5"></div></section>
</div>
<section class="admin-card p-5 mb-6">
  <h3 class="admin-h3">Per day</h3>
  <svg id="err-by-day" viewBox="0 0 1000 200" preserveAspectRatio="none" class="w-full h-28 block"></svg>
</section>
<section class="admin-card p-5">
  <h3 class="admin-h3">Top groups</h3>
  <div id="err-top" class="divide-y divide-[var(--night-seam)]"></div>
</section>
```

Rendering rules: `by_source`, `by_version`, `by_os` arrays are converted to `Record<string, number>` and passed to `renderDistribution`; `by_day` maps `{date, count}` to `{date, value}` for `renderLineArea` with `#FF453A`; each `top_groups` entry becomes a `<details>` built with `el`/`text` (never `innerHTML` for message or stack): summary line = occurrences (bold red), `users` count, `source` pill, `kind`, `message` (truncated to 160 chars in the summary, full in the body), `versions`, `first_seen` and `last_seen` via `timeAgo`; body = `<pre class="admin-pre">` with the stack or "no stack". Fetch `/api/errors-summary?days=${days}&limit=50`; poller 300 000 ms; the `<select>` change calls `refresh()`. Add:

```ts
export function pollBadge(ctx: PanelCtx) {
  const tick = async () => {
    try {
      const d = await getJson<{ unique_fingerprints: number }>('/api/errors-summary?days=1&limit=1', ctx.onUnauthorized);
      ctx.setBadge('errors', d.unique_fingerprints ?? 0);
    } catch { /* best-effort badge */ }
  };
  createPoller(tick, 300_000).start();
}
```

- [ ] **Step 7: Users panel**

`src/lib/admin/panels/users.ts`. Markup in `mount`:

```html
<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
  <h2 class="admin-h2">Users <span id="users-total" class="text-sm font-normal text-[var(--night-text-3)]"></span></h2>
  <div class="flex items-center gap-2">
    <input id="users-q" type="search" placeholder="Search email or name" class="admin-input w-64" />
    <span id="users-status" class="admin-pill">loading…</span>
  </div>
</div>
<div class="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-4">
  <div class="admin-card overflow-x-auto">
    <table class="admin-table">
      <thead><tr>
        <th>User</th><th>Provider</th><th>Signed up</th><th>Last seen</th><th class="num">Devices</th>
        <th>App</th><th>OS</th><th class="num">Profiles</th><th class="num">Workspaces</th>
      </tr></thead>
      <tbody id="users-rows"></tbody>
    </table>
    <div class="p-3 text-center"><button id="users-more" type="button" class="admin-btn" hidden>Load more</button></div>
    <div id="users-empty" class="p-8 text-center text-[var(--night-text-2)]" hidden>No users match.</div>
  </div>
  <aside id="user-detail" class="admin-card p-5 self-start" hidden></aside>
</div>
```

Behaviour: `activate()` loads page 1 if never loaded. Search input debounced 300 ms resets the list (`cursor = null`) and reloads. Rows are built with `el`/`text`: avatar circle with `initials(name || email)`, email (title = id), name muted; provider pill (`Google`, `GitHub`, `Email`, else raw); `timeAgo(created_at)` with `title` = absolute; `timeAgo(last_seen_at)` or `never`; numbers via `formatNumber`; `app_version ?? '-'`; `osLabel(os) ?? '-'`. Clicking a row fetches `/api/admin-user?id=${id}`, marks the row `is-selected`, and renders the detail aside: header (initials, name, email, provider pills from `accounts` with `provider_account_id_tail`), "Devices" list (created via `timeAgo`, `revoked_reason` or `active`, `client_info.app_version`, `osLabel(client_info.os)`, `installation_id.slice(0, 8)`), "Profiles", "Custom agents", "Workspaces" lists, with rows whose `deleted_at` is set given class `line-through opacity-60`. "Load more" appends the next page using `next_cursor`; hidden when null. No poller; `refresh()` reloads page 1 with the current query.

- [ ] **Step 8: Overview panel**

`src/lib/admin/panels/overview.ts`. Markup in `mount`:

```html
<div class="admin-card p-5 mb-6 admin-hero">
  <div class="flex flex-wrap items-end justify-between gap-6">
    <div>
      <div class="admin-label">Active now</div>
      <div class="flex items-baseline gap-2">
        <span id="ov-active" class="admin-big text-4xl text-[var(--accent)]">-</span>
        <span class="text-xs text-[var(--night-text-3)]">in last 15 min · <span id="ov-active-signed">-</span> signed in</span>
      </div>
      <div id="ov-active-dims" class="text-xs text-[var(--night-text-2)] mt-1">-</div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-6 text-right">
      <div><div class="admin-label">Active today</div><div id="ov-dau" class="admin-big">-</div><div id="ov-dau-signed" class="text-xs text-[var(--night-text-3)]">-</div></div>
      <div><div class="admin-label">Installations</div><div id="ov-installs" class="admin-big">-</div></div>
      <div><div class="admin-label">Accounts</div><div id="ov-accounts" class="admin-big">-</div><div id="ov-accounts-7d" class="text-xs text-[var(--night-text-3)]">-</div></div>
      <div><div class="admin-label">Errors · 7d</div><div id="ov-errors" class="admin-big text-[#FF453A]">-</div><div id="ov-errors-sub" class="text-xs text-[var(--night-text-3)]">-</div></div>
    </div>
  </div>
</div>
<div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
  <section class="admin-card p-5">
    <div class="flex items-center justify-between mb-1"><h3 class="admin-h3">DAU · last 30 days</h3><span id="ov-dau-peak" class="text-xs text-[var(--night-text-3)]">peak -</span></div>
    <svg id="ov-chart-dau" viewBox="0 0 1000 200" preserveAspectRatio="none" class="w-full h-32 block"></svg>
    <div class="flex justify-between text-[10px] text-[var(--night-text-3)] mt-2"><span id="ov-dau-from">-</span><span id="ov-dau-to">-</span></div>
  </section>
  <section class="admin-card p-5">
    <div class="flex items-center justify-between mb-1"><h3 class="admin-h3">Signups · last 90 days</h3><span id="ov-signups-providers" class="text-xs text-[var(--night-text-3)]">-</span></div>
    <svg id="ov-chart-signups" viewBox="0 0 1000 200" preserveAspectRatio="none" class="w-full h-32 block"></svg>
    <div class="flex justify-between text-[10px] text-[var(--night-text-3)] mt-2"><span id="ov-signups-from">-</span><span id="ov-signups-to">-</span></div>
  </section>
</div>
<section class="admin-card">
  <div class="flex items-center justify-between p-5 pb-3"><h3 class="admin-h3 mb-0">Recent accounts</h3><a href="#users" class="text-xs text-[var(--accent)]">See all</a></div>
  <div class="overflow-x-auto"><table class="admin-table"><thead><tr><th>User</th><th>Provider</th><th>Signed up</th><th>Last seen</th><th class="num">Devices</th><th>App</th><th class="num">Profiles</th><th class="num">Workspaces</th></tr></thead><tbody id="ov-recent"></tbody></table></div>
</section>
<span id="ov-status" class="admin-pill mt-4 inline-block">loading…</span>
```

Data: live poller (15 s) fetches `/api/stats` and `/api/stats-live`; summary poller (5 min) fetches `/api/admin-summary`, `/api/stats-history?metric=dau&days=30`, `/api/errors-summary?days=7&limit=1`, and `/api/admin-users?limit=10`. Fill: `ov-active` = `active_now`; `ov-active-dims` = `${distinctCount(by_version)} versions · ${distinctCount(by_os)} OS · ${distinctCount(by_country)} countries`; `ov-dau` = `daily_active_users`; `ov-installs` = `total_installations`; `ov-accounts` = `users.total`, `ov-accounts-7d` = `+${users.last_7d} in 7 days`; `ov-errors` = `total_errors`, `ov-errors-sub` = `${affected_installations} installations`; `ov-active-signed` = `signed_in?.active_now ?? 'n/a'`, `ov-dau-signed` = `signed_in ? `${signed_in.active_today} signed in` : 'signed in: n/a'`; `renderLineArea` for DAU (`#0A84FF`), `renderBars` for `signups_by_day` (`#7A5BFF`) with `ov-signups-providers` = `Google ${g} · GitHub ${gh} · Email ${e}`; recent rows reuse the row builder from `users.ts` (export `buildUserRow(item, onSelect?)` from `users.ts` and import it). Clicking a recent row sets `location.hash = '#users'`. `ctx.setLive` and `ctx.setRefreshed` are called like in telemetry.

- [ ] **Step 9: Admin styles**

Append to `src/styles/global.css`:

```css
/* ---------------------------------------------------------------- */
/* /admin dashboard (Midnight canvas)                                */
/* ---------------------------------------------------------------- */
.admin-canvas { background: var(--night-canvas); color: var(--night-text); }
.admin-card { background: var(--night-1); border: 1px solid var(--night-seam); border-radius: 14px; }
.admin-hero { background: linear-gradient(135deg, rgba(10,132,255,.16), rgba(122,91,255,.08)), var(--night-1); }
.admin-topbar { position: sticky; top: 0; z-index: 20; background: rgba(15,19,32,.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--night-seam); }
.admin-tabs { border-top: 1px solid var(--night-seam); }
.admin-tab { display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; font-size: 13px; color: var(--night-text-2); border-bottom: 2px solid transparent; white-space: nowrap; text-decoration: none; }
.admin-tab:hover { color: var(--night-text); }
.admin-tab.is-active { color: var(--night-text); border-bottom-color: var(--accent); font-weight: 600; }
.admin-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: #fff; }
.admin-badge-err { background: #FF453A; }
.admin-pill { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--night-seam); background: var(--night-1); color: var(--night-text-2); }
.admin-pill-live { color: #30D158; border-color: rgba(48,209,88,.35); }
.admin-btn { font-size: 12px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--night-seam-strong); background: var(--night-2); color: var(--night-text); }
.admin-btn:hover { background: var(--night-3); }
.admin-btn-primary { font-size: 14px; font-weight: 600; padding: 10px 14px; border-radius: 10px; background: var(--accent); color: #fff; border: 0; }
.admin-input { background: var(--night-0); border: 1px solid var(--night-seam-strong); color: var(--night-text); border-radius: 10px; padding: 8px 10px; font-size: 14px; }
.admin-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--night-text-3); margin-bottom: 4px; }
.admin-big { font-size: 28px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.admin-h2 { font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
.admin-h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--night-text-2); margin-bottom: 12px; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.admin-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--night-text-3); padding: 10px 14px; border-bottom: 1px solid var(--night-seam); }
.admin-table td { padding: 10px 14px; border-bottom: 1px solid var(--night-seam); color: var(--night-text-2); white-space: nowrap; }
.admin-table tr.is-clickable { cursor: pointer; }
.admin-table tr.is-clickable:hover, .admin-table tr.is-selected { background: rgba(10,132,255,.08); }
.admin-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.admin-pre { font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; background: var(--night-0); border-radius: 8px; padding: 10px; }
/* The moved /stat and /inbox markup reads these; on the Midnight canvas they must resolve to light-on-dark. */
.admin-canvas .surface { background: var(--night-1); border: 1px solid var(--night-seam); }
.admin-canvas { --ink: var(--night-text); --muted-body: var(--night-text-2); --muted-label: var(--night-text-3); --coral: var(--accent); }
```

- [ ] **Step 10: Build and eyeball locally**

Run: `npm run build` then `npx vercel dev` (or `npm run dev` for markup-only; the `/api/*` functions need `vercel dev`). Create `.env` locally with `ADMIN_PASSWORD=test`, `ADMIN_SESSION_SECRET=<any 32+ chars>`, `CT_STATS_TOKEN=<real>`, `ADMIN_API_TOKEN=<from A7>`. Open `http://localhost:3000/admin`: wrong password shows "Wrong password."; correct password shows Overview with live numbers; each tab renders; Inbox "mark read" works; Log out returns to the card.

- [ ] **Step 11: Commit**

```bash
git add src/pages/admin.astro src/lib/admin src/styles/global.css
git commit -m "feat(admin): /admin tabbed dashboard page with overview, users, telemetry, errors, inbox

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C8: Content-lint coverage, README, env

**Files:**
- Modify: `tests/content-lint.test.js`, `README.md`

- [ ] **Step 1: Add lint tests**

Append to `tests/content-lint.test.js`:

```js
describe('Admin dashboard', () => {
  it('admin.astro composes the five tabs and is noindex', async () => {
    const src = await readFile(join(ROOT, 'src/pages/admin.astro'), 'utf8');
    for (const tab of ['overview', 'users', 'telemetry', 'errors', 'inbox']) {
      expect(src).toContain(`data-tab="${tab}"`);
      expect(src).toContain(`data-panel="${tab}"`);
    }
    expect(src).toMatch(/name="robots" content="noindex/);
  });

  it('only admin.astro and its panels call the admin proxies', async () => {
    const files = (await walk(join(ROOT, 'src'), ['.astro', '.ts', '.js']))
      .filter((f) => !f.includes(`${join('src', 'lib', 'admin')}`) && !f.endsWith('admin.astro'));
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      expect(src, `${f} must not call /api/admin-*`).not.toMatch(/\/api\/admin-/);
    }
  });

  it('every api/*.js data proxy is session-gated', async () => {
    const dir = join(ROOT, 'api');
    const entries = (await readdir(dir)).filter((n) => n.endsWith('.js'));
    const exempt = new Set(['admin-login.js', 'admin-logout.js', 'admin-session.js']);
    for (const name of entries) {
      if (exempt.has(name)) continue;
      const src = await readFile(join(dir, name), 'utf8');
      expect(src, `${name} must go through proxyWorker/fetchApi (session gate)`).toMatch(/proxyWorker|fetchApi/);
    }
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/content-lint.test.js tests/admin-*.test.js src`
Expected: PASS.

- [ ] **Step 3: README**

Add a section to `README.md`:

```markdown
## Admin dashboard (`/admin`)

Private, password-gated page that merges the telemetry dashboard, the error summary, the feedback inbox and account data. Served by `src/pages/admin.astro`; data comes only through same-origin edge functions in `api/`, which hold every secret.

Vercel environment variables:

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | The one password for `/admin`. |
| `ADMIN_SESSION_SECRET` | 32+ random bytes (base64), signs the HttpOnly session cookie. |
| `ADMIN_API_TOKEN` | Shared with the `agentrium-api` project; sent as `x-admin-token` to its read-only `/api/admin/*` routes. |
| `CT_STATS_TOKEN` | Existing token for the ct-analytics Worker. |

Login is rate limited to 10 attempts per IP per 15 minutes through the Worker's KV and fails closed if the Worker is unreachable. `/stat` and `/inbox` are kept for a transition period and then redirect to `/admin#telemetry` and `/admin#inbox`.
```

Update the "Project Structure" block: add `admin.astro               # Password-gated admin dashboard (tabs: overview, users, telemetry, errors, inbox)` and `lib/admin/                # Dashboard modules (tabs, charts, panels)` and `api/                      # Vercel edge proxies (session-gated)`.

- [ ] **Step 4: Full suite**

Run: `npm run test:run`
Expected: PASS including the Astro build smoke.

- [ ] **Step 5: Commit**

```bash
git add tests/content-lint.test.js README.md
git commit -m "test(admin): lint coverage for tabs, proxy gating; document /admin env

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C9: Env vars, PR, deploy, verify

- [ ] **Step 1: Set the website's Vercel env vars**

In the website project (link with `npx vercel link` if needed): `npx vercel env add ADMIN_PASSWORD production`, `npx vercel env add ADMIN_SESSION_SECRET production` (value: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), `npx vercel env add ADMIN_API_TOKEN production` (the A7 value). `CT_STATS_TOKEN` already exists.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/admin-dashboard
gh pr create --title "feat: /admin dashboard (merges /stat + /inbox, adds account data)" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-09-13-admin-dashboard-design.md (agentrium repo).

- New password-gated /admin page with five tabs (overview, users, telemetry, errors, inbox)
- HMAC-signed HttpOnly session cookie; login rate-limited via the ct-analytics Worker
- Every worker proxy is now session-gated (stats proxies were public, inbox used Basic Auth)
- New proxies: errors-summary, admin-summary, admin-users, admin-user (agentrium-api)
- /stat and /inbox unchanged for now; redirects follow in two weeks

Requires Vercel env: ADMIN_PASSWORD, ADMIN_SESSION_SECRET, ADMIN_API_TOKEN.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Verify the preview deployment, then merge**

On the PR's Vercel preview URL: `/admin` shows the login card; wrong password 401 message; right password shows data on all five tabs; `/api/stats` without a cookie returns 401. Merge the PR (`gh pr merge --squash`), wait for production, repeat the checks on `https://www.agentrium.app/admin`.

- [ ] **Step 4: Manual end-to-end (spec Section 10)**

Sign in wrong once (message), eleven wrong attempts from one browser (429 message with minutes), correct password, all tabs load, mark one inbox message read (badge decrements), open a user detail, log out, reload shows the login card.

---

# Part D: Desktop app (`agentrium`)

Work in `C:/Users/talay/agentrium` on the current branch. Tests: `cargo test -p claude-terminal --manifest-path src-tauri/Cargo.toml auth` (run from repo root; the crate name is in `src-tauri/Cargo.toml` `[package] name`, adjust `-p` if it differs). Do not launch or kill a running Agentrium.

### Task D1: Send `client` device info at sign-in and refresh

**Files:**
- Modify: `src-tauri/src/error_reporter.rs` (add `installation_id()` getter)
- Modify: `src-tauri/src/auth.rs` (`ClientInfo` struct, four request bodies, tests)

**Interfaces:**
- Consumes: broker contract from A2 (`client` optional object).
- Produces: `error_reporter::installation_id() -> Option<String>`; `auth::ClientInfo { app_version: &'static str, os: &'static str, installation_id: Option<String> }` with `ClientInfo::current()`; `exchange_code(base_url, code, code_verifier, state, client: &ClientInfo)`.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/auth.rs` `mod tests`, replace the assertion `assert_eq!(body.as_object().unwrap().len(), 3, "exactly the three documented fields");` in `exchange_code_posts_the_documented_body_and_reads_tokens` with:

```rust
        assert_eq!(body["client"]["app_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["client"]["os"], std::env::consts::OS);
        assert_eq!(body["client"]["installation_id"], "inst-test");
        assert_eq!(body.as_object().unwrap().len(), 4, "code, code_verifier, state, client");
```

and change the call to pass a client:

```rust
        let client = ClientInfo { app_version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS, installation_id: Some("inst-test".into()) };
        let tokens = rt
            .block_on(exchange_code(&base, "the-code", "the-verifier-43chars-xxxxxxxxxxxxxxxxxxxxxxxxx", "the-state", &client))
            .unwrap();
```

Update `exchange_code_surfaces_the_broker_error_code` to pass `&ClientInfo::current()`.

Add a unit test for the serializer:

```rust
    #[test]
    fn client_info_omits_a_missing_installation_id() {
        let c = ClientInfo { app_version: "1.0.0", os: "windows", installation_id: None };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v, serde_json::json!({ "app_version": "1.0.0", "os": "windows" }));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test auth::tests 2>&1 | tail -20`
Expected: compile error, `ClientInfo` not found.

- [ ] **Step 3: Add the getter in `error_reporter.rs`**

Below `set_installation_id`:

```rust
/// The installation id attached at boot, if the database has been opened.
/// Used by the auth requests so the broker can match accounts to installs.
pub fn installation_id() -> Option<String> {
    let state = REPORTER.get()?;
    let guard = state.installation_id.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_empty() { None } else { Some(guard.clone()) }
}
```

- [ ] **Step 4: Add `ClientInfo` and thread it through in `auth.rs`**

Near the request structs:

```rust
/// Optional device descriptor sent with every token-issuing request
/// (broker README, "Desktop sign-in flow"). Additive on the wire: an older
/// broker ignores it. Stored server-side on the refresh token so the admin
/// dashboard can show app version / OS per account.
#[derive(Serialize, Debug, Clone)]
pub struct ClientInfo {
    pub app_version: &'static str,
    pub os: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
}

impl ClientInfo {
    pub fn current() -> Self {
        Self {
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            installation_id: error_reporter::installation_id(),
        }
    }
}
```

`exchange_code` gains a parameter and field:

```rust
pub async fn exchange_code(
    base_url: &str,
    code: &str,
    code_verifier: &str,
    state: &str,
    client: &ClientInfo,
) -> Result<TokenExchangeResponse, String> {
    let resp = reqwest::Client::new()
        .post(format!("{base_url}/api/auth/desktop/token"))
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": code_verifier,
            "state": state,
            "client": client,
        }))
```

The call in `handle_deep_link` becomes `exchange_code(API_BASE, &ret.code, &flow.code_verifier, &ret.state, &ClientInfo::current()).await?`.

`SignupRequest` and `SigninCredentialsRequest` gain `client: ClientInfo,` and both call sites add `client: ClientInfo::current(),`.

`refresh_access_token` body becomes:

```rust
        .json(&serde_json::json!({ "refresh_token": refresh, "client": ClientInfo::current() }))
```

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test auth::tests 2>&1 | tail -20`
Expected: all auth tests PASS.

- [ ] **Step 6: Type-check the whole crate and the frontend**

Run: `cd src-tauri && cargo check 2>&1 | tail -5` and from the repo root `npx tsc --noEmit`.
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/error_reporter.rs
git commit -m "feat(auth): send client device info (version, os, installation id) with sign-in and refresh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task D2: CLAUDE.md contract note and plan bookkeeping

**Files:**
- Modify: `CLAUDE.md` (agentrium) "Desktop ↔ auth broker contract" bullet
- Modify: `docs/superpowers/plans/2026-09-13-admin-dashboard.md` (tick boxes as tasks land)

- [ ] **Step 1: Extend the contract bullet**

Append to the "Desktop ↔ auth broker contract" bullet in `CLAUDE.md`: `Token-issuing requests carry an optional \`client\` object (\`auth::ClientInfo\`: app_version, os, installation_id); the broker stores it as \`refresh_tokens.client_info\` for the /admin dashboard. Keep it optional on both sides.`

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-09-13-admin-dashboard.md
git commit -m "docs: record the optional client object in the desktop/broker contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

The desktop change ships with the next regular release (`/publish`); it is not blocking for `/admin`.

---

# Part E: Two weeks after launch (scheduled follow-up, not part of the initial execution)

### Task E1: Redirect `/stat` and `/inbox` into `/admin`

**Files (website repo):**
- Modify: `astro.config.mjs`
- Delete: `src/pages/stat.astro`, `src/pages/inbox.astro`
- Modify: `tests/content-lint.test.js` (retarget the "legacy aliases /stat depends on" and ".surface utility used by /stat" tests to `src/lib/admin/panels/telemetry.ts`, keeping the same assertions), `README.md` (remove the transition sentence)
- Vercel: remove `INBOX_PASSWORD`

- [ ] **Step 1: Add redirects**

```js
export default defineConfig({
  redirects: {
    '/stat': '/admin#telemetry',
    '/inbox': '/admin#inbox',
  },
  vite: { plugins: [tailwindcss()] },
});
```

- [ ] **Step 2: Delete the two pages, fix the lint tests, run `npm run test:run`, commit, PR, merge.**

```bash
git commit -am "chore(admin): retire /stat and /inbox in favour of /admin redirects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan self-review (done while writing)

- **Spec coverage:** 4.1 to 4.8 → C5 to C7; 5.1 to 5.4 → C1 to C3; 6.1 → C3, C4; 6.2 → B1, B2; 6.3 → A3 to A6; 6.4 → C4; 7.1 → A1; 7.2 → A2; 7.3 → D1; 8 → A3, A7, C8, C9; 9 → C1 to C4, C7 (`onUnauthorized`); 10 → tests in every task, C9 step 4; 11 → A7, B2 step 4, C9, E1.
- **Type consistency:** `PanelCtx` (C7) is the single contract used by every panel; `getJson` lives in `session.ts` (C6 + C7 step 3); `requireAdminSession` name is used identically in C1 to C4; `ClientInfo` field names match the zod schema in A2.
- **Known judgement calls:** the Worker login limiter counts attempts even on success (spec 5.3 says so); `admin-user.js` validates the id before the session check (documented in C4).
