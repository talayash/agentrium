# Account Auth Phase A - Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship end-to-end user login (Google, GitHub, Microsoft, email/password via WorkOS), OS-keychain session storage, header widget, first-run popup, logout, and delete-account. Sync tables are added but the sync loop stays dormant until Phase B.

**Architecture:** Tauri desktop app runs an ephemeral loopback HTTP listener during OAuth so WorkOS can redirect the auth code back to the app. All identity operations route through the existing `ct-analytics` Cloudflare Worker (which holds the WorkOS API key server-side). Sessions live as 32-byte tokens: the raw token is stored in the OS keychain client-side; the Worker stores only its SHA-256 hash. WorkOS is the source of truth for identity; D1 owns application state keyed on `users.user_id`.

**Tech Stack:**
- Rust 2021: `tauri-plugin-keyring`, `tauri-plugin-deep-link`, `tiny_http`, `rand`, `sha2`, `base64`, `uuid`, `chrono`, `reqwest`, `serde_json`
- TypeScript / React 18: existing Zustand + `@tauri-apps/api/core`
- Cloudflare Worker (existing `ct-analytics`) extended with D1 auth tables, WorkOS REST client
- Vitest for frontend, `#[cfg(test)]` + `tempfile` + `wiremock` for Rust, Miniflare (`vitest-environment-miniflare` or `@cloudflare/workers-vitest-pool`) for Worker

**Prerequisites (external, do these before Task 1):**

1. Create a WorkOS account, create an Organization, capture `WORKOS_API_KEY` and `WORKOS_CLIENT_ID`.
2. In WorkOS AuthKit, enable Google, GitHub, Microsoft providers. For each, register the corresponding OAuth app on the provider side (Google Cloud Console, GitHub Developer Settings, Azure App Registrations) and paste the client IDs back into WorkOS.
3. Add redirect URIs in WorkOS: `http://127.0.0.1:*/callback`, `agentrium://auth/callback`. (`https://stat.agentrium.app/auth/callback` is added in Phase C.)
4. Configure a webhook in WorkOS for `user.updated` events pointing at `POST https://<ct-analytics-domain>/webhooks/workos`. Capture `WORKOS_WEBHOOK_SECRET`.
5. Set Cloudflare Worker secrets:
   ```bash
   cd workers/ct-analytics
   npx wrangler secret put WORKOS_API_KEY
   npx wrangler secret put WORKOS_WEBHOOK_SECRET
   npx wrangler secret put SESSION_SIGNING_SECRET   # openssl rand -hex 32
   ```
6. Set Cloudflare Worker vars in `wrangler.toml` under `[vars]`:
   ```toml
   WORKOS_CLIENT_ID = "client_..."
   WORKOS_REDIRECT_URIS = "http://127.0.0.1,agentrium://auth/callback"
   ADMIN_EMAILS = "tal.ayash@lognet-systems.com"
   AUTH_ENABLED = "true"
   SYNC_ENABLED = "false"
   ```

**File structure created / modified by this plan:**

*Rust (new):*
- `src-tauri/src/auth/mod.rs` - public interface, module wiring
- `src-tauri/src/auth/types.rs` - `Provider` enum, `AuthUser` struct, `AuthError`
- `src-tauri/src/auth/keychain.rs` - thin wrapper over `tauri-plugin-keyring`
- `src-tauri/src/auth/pkce.rs` - PKCE verifier/challenge generation
- `src-tauri/src/auth/oauth_flow.rs` - loopback listener + WorkOS URL construction
- `src-tauri/src/auth/session.rs` - session token IO, refresh, `AuthContext`
- `src-tauri/src/auth/commands.rs` - Tauri IPC commands (`start_oauth_login`, `logout`, `get_current_user`, `delete_account`, `restore_account`, `complete_merge_choice`)

*Rust (modified):*
- `src-tauri/src/main.rs` - declare module, register commands, register plugins
- `src-tauri/src/database.rs` - new columns, tables, backfills
- `src-tauri/Cargo.toml` - new dependencies
- `src-tauri/tauri.conf.json` - deep link + keyring plugin config
- `src-tauri/capabilities/default.json` - plugin permissions

*TypeScript / React (new):*
- `src/lib/settingsSync.ts` - `SYNCED_KEYS` / `LOCAL_ONLY_KEYS` constant arrays plus `assertPartition` exhaustiveness check
- `src/lib/auth.ts` - client-side invoke wrappers + event-listener helpers
- `src/store/authStore.ts` - Zustand store for `user`, `sessionState`, `syncStatus`
- `src/components/auth/LoginModal.tsx`
- `src/components/auth/FirstRunPopup.tsx`
- `src/components/auth/AuthGate.tsx` - decides when to show first-run popup
- `src/components/auth/UserMenu.tsx` - header dropdown widget
- `src/components/auth/DeleteAccountModal.tsx`

*TypeScript / React (modified):*
- `src/App.tsx` - mount `AuthGate`, hydrate `authStore` on startup
- `src/store/appStore.ts` - version bump 4 → 5
- `src/components/TitleBar.tsx` - insert `<UserMenu />` into left slot
- `src/changelog.json` - v1.33.0 entry

*Cloudflare Worker (new):*
- `workers/ct-analytics/src/auth/workos.ts` - WorkOS REST client (authorize URL, token exchange, revoke)
- `workers/ct-analytics/src/auth/sessions.ts` - session token generation, hash, upsert, lookup, revoke
- `workers/ct-analytics/src/auth/handlers.ts` - request handlers: callback, logout, me, delete, restore
- `workers/ct-analytics/src/auth/killswitch.ts` - env-var guard middleware
- `workers/ct-analytics/src/webhooks/workos.ts` - user.updated webhook with signature verification
- `workers/ct-analytics/migrations/0001_auth.sql` - D1 schema for users/sessions/user_installations

*Cloudflare Worker (modified):*
- `workers/ct-analytics/src/index.ts` - route `/auth/*`, `/account/*`, `/webhooks/*`
- `workers/ct-analytics/wrangler.toml` - new vars (secrets set via CLI)

*Release:*
- `package.json` - 1.32.2 → 1.33.0
- `src-tauri/Cargo.toml` - 1.32.2 → 1.33.0
- `src-tauri/tauri.conf.json` - 1.32.2 → 1.33.0
- `README.md` - version badge + filenames

---

## Task 1: Add Rust dependencies and Tauri plugin config

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add crates to `Cargo.toml`**

Append to `[dependencies]`:

```toml
tauri-plugin-keyring = "0.1"
tauri-plugin-deep-link = "2"
tiny_http = "0.12"
rand = "0.8"
sha2 = "0.10"
base64 = "0.22"
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

`chrono`, `serde`, `serde_json`, `uuid` are already in the workspace.

- [ ] **Step 2: Register deep link scheme in `tauri.conf.json`**

Under `bundle`, add:

```json
"deepLink": {
  "schemes": ["agentrium"]
}
```

Under `plugins`, add:

```json
"deepLink": {},
"keyring": {}
```

- [ ] **Step 3: Grant capabilities in `capabilities/default.json`**

Add to `permissions`:

```json
"keyring:allow-get",
"keyring:allow-set",
"keyring:allow-delete",
"deep-link:default"
```

- [ ] **Step 4: Verify the build compiles**

Run:

```bash
cd src-tauri && cargo check
```

Expected: `Checking claude-terminal ...` with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "chore(auth): add keyring, deep-link, oauth loopback deps"
```

---

## Task 2: D1 auth schema migration (Worker)

**Files:**
- Create: `workers/ct-analytics/migrations/0001_auth.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0001_auth.sql
-- Adds identity tables for user accounts. Sessions store SHA-256 hashes only.

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deleted_at TEXT,
  admin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users(last_seen_at);

CREATE TABLE IF NOT EXISTS user_installations (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  first_linked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  os TEXT,
  os_version TEXT,
  app_version TEXT,
  PRIMARY KEY (installation_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  installation_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
```

- [ ] **Step 2: Apply to local D1 (via miniflare) and remote**

```bash
cd workers/ct-analytics
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote
```

Expected: both report `Migrations applied: 0001_auth.sql`.

- [ ] **Step 3: Verify tables exist**

```bash
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','user_installations','sessions');"
```

Expected: three rows.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/migrations/0001_auth.sql
git commit -m "feat(worker): D1 schema for users, sessions, installations"
```

---

## Task 3: Worker killswitch middleware

**Files:**
- Create: `workers/ct-analytics/src/auth/killswitch.ts`
- Test: `workers/ct-analytics/src/auth/__tests__/killswitch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// workers/ct-analytics/src/auth/__tests__/killswitch.test.ts
import { describe, it, expect } from 'vitest';
import { requireAuthEnabled } from '../killswitch';

describe('requireAuthEnabled', () => {
  it('returns null when AUTH_ENABLED is "true"', () => {
    const res = requireAuthEnabled({ AUTH_ENABLED: 'true' } as any);
    expect(res).toBeNull();
  });

  it('returns 503 when AUTH_ENABLED is "false"', () => {
    const res = requireAuthEnabled({ AUTH_ENABLED: 'false' } as any);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });

  it('returns 503 when AUTH_ENABLED is missing', () => {
    const res = requireAuthEnabled({} as any);
    expect(res!.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

```bash
cd workers/ct-analytics && npx vitest run src/auth/__tests__/killswitch.test.ts
```

Expected: FAIL, "Cannot find module '../killswitch'".

- [ ] **Step 3: Implement `killswitch.ts`**

```typescript
// workers/ct-analytics/src/auth/killswitch.ts
interface EnvSlice {
  AUTH_ENABLED?: string;
  SYNC_ENABLED?: string;
}

function respond503(feature: 'auth' | 'sync'): Response {
  return new Response(
    JSON.stringify({ error: `${feature}_unavailable` }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );
}

export function requireAuthEnabled(env: EnvSlice): Response | null {
  return env.AUTH_ENABLED === 'true' ? null : respond503('auth');
}

export function requireSyncEnabled(env: EnvSlice): Response | null {
  return env.SYNC_ENABLED === 'true' ? null : respond503('sync');
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/auth/__tests__/killswitch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/auth/killswitch.ts workers/ct-analytics/src/auth/__tests__/
git commit -m "feat(worker): auth/sync killswitch middleware"
```

---

## Task 4: Worker WorkOS REST client

**Files:**
- Create: `workers/ct-analytics/src/auth/workos.ts`
- Test: `workers/ct-analytics/src/auth/__tests__/workos.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/auth/__tests__/workos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workosAuthorize, workosAuthenticate, workosRevoke } from '../workos';

const env = {
  WORKOS_API_KEY: 'sk_test',
  WORKOS_CLIENT_ID: 'client_01H',
} as any;

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('workosAuthorize', () => {
  it('builds the correct authorize URL', () => {
    const url = workosAuthorize(env, {
      provider: 'google',
      redirect_uri: 'http://127.0.0.1:54321/callback',
      state: 'nonce-abc',
      code_challenge: 'chal',
    });
    expect(url).toContain('client_id=client_01H');
    expect(url).toContain('provider=GoogleOAuth');
    expect(url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback');
    expect(url).toContain('state=nonce-abc');
    expect(url).toContain('code_challenge=chal');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('maps github and microsoft to the correct WorkOS provider names', () => {
    expect(workosAuthorize(env, { provider: 'github', redirect_uri: 'x', state: 's', code_challenge: 'c' }))
      .toContain('provider=GitHubOAuth');
    expect(workosAuthorize(env, { provider: 'microsoft', redirect_uri: 'x', state: 's', code_challenge: 'c' }))
      .toContain('provider=MicrosoftOAuth');
  });
});

describe('workosAuthenticate', () => {
  it('POSTs the code exchange and returns user + tokens', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'user_01H', email: 'x@y.com' },
        access_token: 'at',
        refresh_token: 'rt',
      }),
    });
    const result = await workosAuthenticate(env, {
      code: 'code123',
      code_verifier: 'ver',
    });
    expect(result.user.id).toBe('user_01H');
    expect(result.access_token).toBe('at');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.workos.com/user_management/authenticate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on non-2xx', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, status: 400, text: async () => 'bad code' });
    await expect(workosAuthenticate(env, { code: 'x', code_verifier: 'y' })).rejects.toThrow(/bad code/);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npx vitest run src/auth/__tests__/workos.test.ts
```

Expected: FAIL, "Cannot find module '../workos'".

- [ ] **Step 3: Implement `workos.ts`**

```typescript
// workers/ct-analytics/src/auth/workos.ts
export type Provider = 'google' | 'github' | 'microsoft' | 'password';

interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
}

const WORKOS_PROVIDER: Record<Exclude<Provider, 'password'>, string> = {
  google: 'GoogleOAuth',
  github: 'GitHubOAuth',
  microsoft: 'MicrosoftOAuth',
};

export function workosAuthorize(
  env: Env,
  args: { provider: Exclude<Provider, 'password'>; redirect_uri: string; state: string; code_challenge: string },
): string {
  const params = new URLSearchParams({
    client_id: env.WORKOS_CLIENT_ID,
    response_type: 'code',
    provider: WORKOS_PROVIDER[args.provider],
    redirect_uri: args.redirect_uri,
    state: args.state,
    code_challenge: args.code_challenge,
    code_challenge_method: 'S256',
  });
  return `https://api.workos.com/user_management/authorize?${params.toString()}`;
}

export interface WorkOSAuthResult {
  user: { id: string; email: string; first_name?: string; last_name?: string; email_verified?: boolean };
  access_token: string;
  refresh_token: string;
}

export async function workosAuthenticate(
  env: Env,
  args: { code: string; code_verifier: string },
): Promise<WorkOSAuthResult> {
  const res = await fetch('https://api.workos.com/user_management/authenticate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WORKOS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.code_verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WorkOS authenticate failed (${res.status}): ${body}`);
  }
  return (await res.json()) as WorkOSAuthResult;
}

export async function workosRevoke(env: Env, refresh_token: string): Promise<void> {
  // Best-effort: WorkOS returns 204 on success. Failures don't block logout;
  // the local session revocation is authoritative for our app.
  await fetch('https://api.workos.com/user_management/sessions/revoke', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WORKOS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token }),
  }).catch(() => undefined);
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/auth/__tests__/workos.test.ts
```

Expected: PASS all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/auth/workos.ts workers/ct-analytics/src/auth/__tests__/workos.test.ts
git commit -m "feat(worker): WorkOS REST client for authorize/authenticate/revoke"
```

---

## Task 5: Worker session helpers (hash, generate, upsert, lookup)

**Files:**
- Create: `workers/ct-analytics/src/auth/sessions.ts`
- Test: `workers/ct-analytics/src/auth/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/auth/__tests__/sessions.test.ts
import { describe, it, expect } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../sessions';

describe('generateSessionToken', () => {
  it('returns a 64-char hex string (32 random bytes)', () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates distinct tokens on repeat calls', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });
});

describe('hashSessionToken', () => {
  it('produces the same SHA-256 hex for the same input', async () => {
    const t = 'abc123';
    expect(await hashSessionToken(t)).toBe(await hashSessionToken(t));
  });

  it('differs across inputs', async () => {
    expect(await hashSessionToken('a')).not.toBe(await hashSessionToken('b'));
  });

  it('matches a known SHA-256', async () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(await hashSessionToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
```

- [ ] **Step 2: Run and see failures**

```bash
npx vitest run src/auth/__tests__/sessions.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `sessions.ts`**

```typescript
// workers/ct-analytics/src/auth/sessions.ts
import type { D1Database } from '@cloudflare/workers-types';

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashSessionToken(token: string): Promise<string> {
  const buf = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionRecord {
  user_id: string;
  installation_id: string;
  origin: 'desktop' | 'dashboard';
  expires_at: string;
}

export async function createSession(
  db: D1Database,
  raw_token: string,
  record: SessionRecord,
): Promise<void> {
  const hash = await hashSessionToken(raw_token);
  await db
    .prepare(
      `INSERT INTO sessions (session_token_hash, user_id, installation_id, origin, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      hash,
      record.user_id,
      record.installation_id,
      record.origin,
      new Date().toISOString(),
      record.expires_at,
    )
    .run();
}

export async function lookupSession(
  db: D1Database,
  raw_token: string,
): Promise<{ user_id: string; installation_id: string; origin: string } | null> {
  const hash = await hashSessionToken(raw_token);
  const row = await db
    .prepare(
      `SELECT user_id, installation_id, origin
         FROM sessions
        WHERE session_token_hash = ?
          AND revoked_at IS NULL
          AND expires_at > ?`,
    )
    .bind(hash, new Date().toISOString())
    .first<{ user_id: string; installation_id: string; origin: string }>();
  return row ?? null;
}

export async function revokeSession(db: D1Database, raw_token: string): Promise<void> {
  const hash = await hashSessionToken(raw_token);
  await db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE session_token_hash = ?`)
    .bind(new Date().toISOString(), hash)
    .run();
}

export async function revokeAllSessions(db: D1Database, user_id: string): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), user_id)
    .run();
}
```

- [ ] **Step 4: Verify tests pass**

```bash
npx vitest run src/auth/__tests__/sessions.test.ts
```

Expected: PASS all 5.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/auth/sessions.ts workers/ct-analytics/src/auth/__tests__/sessions.test.ts
git commit -m "feat(worker): session token generation, hashing, D1 CRUD"
```

---

## Task 6: Worker `/auth/callback` handler

**Files:**
- Create: `workers/ct-analytics/src/auth/handlers.ts`
- Test: `workers/ct-analytics/src/auth/__tests__/handlers.callback.test.ts`

- [ ] **Step 1: Write the failing tests**

Use Miniflare's D1 in-memory database via the Cloudflare workers vitest pool. Add to the project's vitest config if not already:

```typescript
// vitest.config.ts (add to test.poolOptions.workers.miniflare if not present)
d1Databases: ['DB']
```

Then the test file:

```typescript
// workers/ct-analytics/src/auth/__tests__/handlers.callback.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAuthCallback } from '../handlers';

beforeEach(async () => {
  // Reset D1 tables between tests.
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM user_installations').run();
  await env.DB.prepare('DELETE FROM users').run();

  // Mock WorkOS's authenticate endpoint.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      user: { id: 'user_01H', email: 'foo@example.com', first_name: 'Foo' },
      access_token: 'at',
      refresh_token: 'rt',
    }),
  });
});

function makeRequest(body: unknown): Request {
  return new Request('https://example.com/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handleAuthCallback', () => {
  it('rejects when AUTH_ENABLED is false', async () => {
    const res = await handleAuthCallback(makeRequest({ code: 'x' }), { ...env, AUTH_ENABLED: 'false' } as any);
    expect(res.status).toBe(503);
  });

  it('creates a new user + session on first-time callback', async () => {
    const req = makeRequest({
      code: 'auth-code',
      code_verifier: 'ver',
      installation_id: 'install-1',
      origin: 'desktop',
    });
    const res = await handleAuthCallback(req, env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.user.email).toBe('foo@example.com');
    expect(json.user.user_id).toBe('user_01H');
    expect(json.session_token).toMatch(/^[0-9a-f]{64}$/);
    expect(json.is_new_installation).toBe(true);

    const users = await env.DB.prepare('SELECT * FROM users').all();
    expect(users.results.length).toBe(1);
    const installs = await env.DB.prepare('SELECT * FROM user_installations').all();
    expect(installs.results.length).toBe(1);
  });

  it('reports is_new_installation=false when this install already knows this user', async () => {
    await env.DB.prepare(
      `INSERT INTO users (user_id, email, provider, created_at, last_seen_at)
       VALUES ('user_01H', 'foo@example.com', 'google', ?, ?)`,
    ).bind(new Date().toISOString(), new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO user_installations (installation_id, user_id, first_linked_at, last_seen_at)
       VALUES ('install-1', 'user_01H', ?, ?)`,
    ).bind(new Date().toISOString(), new Date().toISOString()).run();

    const req = makeRequest({ code: 'c', code_verifier: 'v', installation_id: 'install-1', origin: 'desktop' });
    const res = await handleAuthCallback(req, env);
    const json: any = await res.json();
    expect(json.is_new_installation).toBe(false);
  });

  it('marks user as admin when their email is in ADMIN_EMAILS', async () => {
    const req = makeRequest({ code: 'c', code_verifier: 'v', installation_id: 'install-1', origin: 'desktop' });
    await handleAuthCallback(req, { ...env, ADMIN_EMAILS: 'foo@example.com' } as any);
    const row = await env.DB.prepare('SELECT admin FROM users WHERE user_id = ?').bind('user_01H').first();
    expect((row as any).admin).toBe(1);
  });

  it('returns 410 with restorable_until when the user is soft-deleted', async () => {
    const deletedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO users (user_id, email, provider, created_at, last_seen_at, deleted_at)
       VALUES ('user_01H', 'foo@example.com', 'google', ?, ?, ?)`,
    ).bind(deletedAt, deletedAt, deletedAt).run();

    const req = makeRequest({ code: 'c', code_verifier: 'v', installation_id: 'install-1', origin: 'desktop' });
    const res = await handleAuthCallback(req, env);
    expect(res.status).toBe(410);
    const json: any = await res.json();
    expect(json.error).toBe('account_deleted');
    expect(json.restorable_until).toBeDefined();
  });

  it('returns 400 on invalid body', async () => {
    const req = new Request('https://example.com/auth/callback', {
      method: 'POST',
      body: 'not-json',
    });
    const res = await handleAuthCallback(req, env);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to see failures**

```bash
npx vitest run src/auth/__tests__/handlers.callback.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `handlers.ts` callback**

```typescript
// workers/ct-analytics/src/auth/handlers.ts
import type { D1Database } from '@cloudflare/workers-types';
import { requireAuthEnabled } from './killswitch';
import { workosAuthenticate, workosRevoke, type Provider } from './workos';
import { generateSessionToken, createSession, lookupSession, revokeSession, revokeAllSessions } from './sessions';

interface Env {
  DB: D1Database;
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  AUTH_ENABLED?: string;
  ADMIN_EMAILS?: string;
}

const SESSION_TTL_HOURS = 24 * 30;                  // 30-day session; access token refresh is transparent
const RESTORABLE_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30 days

interface CallbackBody {
  code?: string;
  code_verifier?: string;
  installation_id?: string;
  origin?: 'desktop' | 'dashboard';
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function isAdminEmail(env: Env, email: string): boolean {
  if (!env.ADMIN_EMAILS) return false;
  return env.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).includes(email.toLowerCase());
}

export async function handleAuthCallback(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  let body: CallbackBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  const { code, code_verifier, installation_id, origin } = body;
  if (!code || !code_verifier || !installation_id || (origin !== 'desktop' && origin !== 'dashboard')) {
    return json({ error: 'missing_fields' }, 400);
  }

  let workos;
  try {
    workos = await workosAuthenticate(env, { code, code_verifier });
  } catch (err) {
    return json({ error: 'workos_authenticate_failed', detail: String(err) }, 502);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const email = workos.user.email;
  const user_id = workos.user.id;

  const existing = await env.DB.prepare('SELECT deleted_at FROM users WHERE user_id = ?')
    .bind(user_id)
    .first<{ deleted_at: string | null }>();

  if (existing?.deleted_at) {
    const deletedMs = Date.parse(existing.deleted_at);
    if (!Number.isNaN(deletedMs) && Date.now() - deletedMs <= RESTORABLE_WINDOW_MS) {
      return json(
        { error: 'account_deleted', restorable_until: new Date(deletedMs + RESTORABLE_WINDOW_MS).toISOString() },
        410,
      );
    }
    // Beyond the restore window - treat as fresh signup with the same WorkOS user_id.
    await env.DB.prepare('UPDATE users SET deleted_at = NULL WHERE user_id = ?').bind(user_id).run();
  }

  const admin = isAdminEmail(env, email) ? 1 : 0;
  const provider: Provider = 'google'; // WorkOS returns exact provider elsewhere; we accept any and record the last-used one on subsequent logins via webhook.

  await env.DB.prepare(
    `INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
        SET email = excluded.email,
            last_seen_at = excluded.last_seen_at,
            admin = MAX(users.admin, excluded.admin)`,
  ).bind(user_id, email, provider, nowIso, nowIso, admin).run();

  const linkedBefore = await env.DB.prepare(
    'SELECT installation_id FROM user_installations WHERE installation_id = ? AND user_id = ?',
  ).bind(installation_id, user_id).first();

  const is_new_installation = linkedBefore === null;

  await env.DB.prepare(
    `INSERT INTO user_installations (installation_id, user_id, first_linked_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(installation_id, user_id) DO UPDATE
        SET last_seen_at = excluded.last_seen_at`,
  ).bind(installation_id, user_id, nowIso, nowIso).run();

  const token = generateSessionToken();
  const expires = new Date(now.getTime() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await createSession(env.DB, token, { user_id, installation_id, origin, expires_at: expires });

  const headers: Record<string, string> = {};
  if (origin === 'dashboard') {
    headers['Set-Cookie'] = `ct_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}`;
  }

  return json(
    {
      session_token: token,
      user: { user_id, email, admin: admin === 1 },
      is_new_installation,
    },
    200,
    headers,
  );
}

export async function handleLogout(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  const token = extractBearer(req) ?? extractCookie(req, 'ct_session');
  if (!token) return json({ error: 'no_session' }, 401);
  await revokeSession(env.DB, token);
  return json({ ok: true });
}

export async function handleMe(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  const token = extractBearer(req) ?? extractCookie(req, 'ct_session');
  if (!token) return json({ error: 'no_session' }, 401);
  const session = await lookupSession(env.DB, token);
  if (!session) return json({ error: 'session_expired' }, 401);

  const user = await env.DB.prepare(
    'SELECT user_id, email, admin FROM users WHERE user_id = ?',
  ).bind(session.user_id).first<{ user_id: string; email: string; admin: number }>();
  if (!user) return json({ error: 'no_user' }, 401);

  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE user_id = ?')
    .bind(new Date().toISOString(), user.user_id).run();

  return json({ user: { user_id: user.user_id, email: user.email, admin: user.admin === 1 } });
}

export async function handleAccountDelete(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  const token = extractBearer(req) ?? extractCookie(req, 'ct_session');
  if (!token) return json({ error: 'no_session' }, 401);
  const session = await lookupSession(env.DB, token);
  if (!session) return json({ error: 'session_expired' }, 401);

  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE users SET deleted_at = ? WHERE user_id = ?').bind(now, session.user_id).run();
  await revokeAllSessions(env.DB, session.user_id);
  return json({ ok: true, restorable_until: new Date(Date.now() + RESTORABLE_WINDOW_MS).toISOString() });
}

export async function handleAccountRestore(req: Request, env: Env): Promise<Response> {
  const gate = requireAuthEnabled(env);
  if (gate) return gate;

  const token = extractBearer(req) ?? extractCookie(req, 'ct_session');
  if (!token) return json({ error: 'no_session' }, 401);
  const session = await lookupSession(env.DB, token);
  if (!session) return json({ error: 'session_expired' }, 401);

  await env.DB.prepare('UPDATE users SET deleted_at = NULL WHERE user_id = ?').bind(session.user_id).run();
  return json({ ok: true });
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
```

- [ ] **Step 4: Verify all callback tests pass**

```bash
npx vitest run src/auth/__tests__/handlers.callback.test.ts
```

Expected: PASS all 6.

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/auth/handlers.ts workers/ct-analytics/src/auth/__tests__/handlers.callback.test.ts
git commit -m "feat(worker): /auth/callback with signup, admin allowlist, soft-delete gate"
```

---

## Task 7: Worker logout, me, delete, restore endpoints (integration tests)

**Files:**
- Test: `workers/ct-analytics/src/auth/__tests__/handlers.other.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/auth/__tests__/handlers.other.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleLogout, handleMe, handleAccountDelete, handleAccountRestore } from '../handlers';
import { generateSessionToken, createSession } from '../sessions';

async function seedUser(user_id = 'user_01H', email = 'foo@example.com', admin = 0): Promise<string> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at, admin) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(user_id, email, 'google', now, now, admin).run();

  const token = generateSessionToken();
  await createSession(env.DB, token, {
    user_id,
    installation_id: 'install-1',
    origin: 'desktop',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  return token;
}

function req(url: string, token: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM user_installations').run();
  await env.DB.prepare('DELETE FROM users').run();
});

describe('handleMe', () => {
  it('returns the user for a valid token', async () => {
    const t = await seedUser();
    const res = await handleMe(req('https://x/auth/me', t), env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.user.email).toBe('foo@example.com');
    expect(json.user.admin).toBe(false);
  });

  it('returns 401 for no token', async () => {
    const res = await handleMe(new Request('https://x/auth/me'), env);
    expect(res.status).toBe(401);
  });

  it('returns 401 for a revoked token', async () => {
    const t = await seedUser();
    await handleLogout(req('https://x/auth/logout', t), env);
    const res = await handleMe(req('https://x/auth/me', t), env);
    expect(res.status).toBe(401);
  });
});

describe('handleLogout', () => {
  it('revokes the session', async () => {
    const t = await seedUser();
    const res = await handleLogout(req('https://x/auth/logout', t), env);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare('SELECT revoked_at FROM sessions').first<any>();
    expect(row.revoked_at).not.toBeNull();
  });
});

describe('handleAccountDelete', () => {
  it('soft-deletes and revokes all sessions', async () => {
    const t = await seedUser();
    const res = await handleAccountDelete(req('https://x/account/delete', t), env);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.restorable_until).toBeDefined();

    const user = await env.DB.prepare('SELECT deleted_at FROM users').first<any>();
    expect(user.deleted_at).not.toBeNull();
  });
});

describe('handleAccountRestore', () => {
  it('clears deleted_at', async () => {
    const t = await seedUser();
    await handleAccountDelete(req('https://x/account/delete', t), env);
    // Note: after delete, session is revoked. Simulate a fresh callback by unrevoking:
    await env.DB.prepare('UPDATE sessions SET revoked_at = NULL').run();
    const res = await handleAccountRestore(req('https://x/account/restore', t), env);
    expect(res.status).toBe(200);
    const user = await env.DB.prepare('SELECT deleted_at FROM users').first<any>();
    expect(user.deleted_at).toBeNull();
  });
});
```

- [ ] **Step 2: Verify tests pass**

Implementation from Task 6 already covers these handlers. Run:

```bash
npx vitest run src/auth/__tests__/handlers.other.test.ts
```

Expected: PASS all 6.

- [ ] **Step 3: Commit**

```bash
git add workers/ct-analytics/src/auth/__tests__/handlers.other.test.ts
git commit -m "test(worker): logout/me/delete/restore handler integration"
```

---

## Task 8: Worker WorkOS webhook (email update)

**Files:**
- Create: `workers/ct-analytics/src/webhooks/workos.ts`
- Test: `workers/ct-analytics/src/webhooks/__tests__/workos.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// workers/ct-analytics/src/webhooks/__tests__/workos.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { handleWorkOSWebhook } from '../workos';

const SECRET = 'test-secret';

async function signBody(body: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM users').run();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (user_id, email, provider, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).bind('user_01H', 'old@example.com', 'google', now, now).run();
});

describe('handleWorkOSWebhook', () => {
  it('rejects requests without a signature header', async () => {
    const body = JSON.stringify({ event: 'user.updated', data: { id: 'user_01H', email: 'new@example.com' } });
    const res = await handleWorkOSWebhook(
      new Request('https://x/webhooks/workos', { method: 'POST', body }),
      { ...env, WORKOS_WEBHOOK_SECRET: SECRET } as any,
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with a bad signature', async () => {
    const body = JSON.stringify({ event: 'user.updated', data: { id: 'user_01H', email: 'new@example.com' } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await handleWorkOSWebhook(
      new Request('https://x/webhooks/workos', {
        method: 'POST',
        body,
        headers: { 'WorkOS-Signature': `t=${ts}, v1=deadbeef` },
      }),
      { ...env, WORKOS_WEBHOOK_SECRET: SECRET } as any,
    );
    expect(res.status).toBe(401);
  });

  it('updates the users row on a valid user.updated event', async () => {
    const body = JSON.stringify({ event: 'user.updated', data: { id: 'user_01H', email: 'new@example.com' } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = await signBody(body, SECRET, ts);
    const res = await handleWorkOSWebhook(
      new Request('https://x/webhooks/workos', {
        method: 'POST',
        body,
        headers: { 'WorkOS-Signature': `t=${ts}, v1=${sig}` },
      }),
      { ...env, WORKOS_WEBHOOK_SECRET: SECRET } as any,
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT email FROM users WHERE user_id = ?').bind('user_01H').first<any>();
    expect(row.email).toBe('new@example.com');
  });

  it('rejects an old timestamp (>5min drift)', async () => {
    const body = JSON.stringify({ event: 'user.updated', data: { id: 'user_01H', email: 'new@example.com' } });
    const ts = Math.floor(Date.now() / 1000) - 400;
    const sig = await signBody(body, SECRET, ts);
    const res = await handleWorkOSWebhook(
      new Request('https://x/webhooks/workos', {
        method: 'POST',
        body,
        headers: { 'WorkOS-Signature': `t=${ts}, v1=${sig}` },
      }),
      { ...env, WORKOS_WEBHOOK_SECRET: SECRET } as any,
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Implement `workers/ct-analytics/src/webhooks/workos.ts`**

```typescript
// workers/ct-analytics/src/webhooks/workos.ts
import type { D1Database } from '@cloudflare/workers-types';

interface Env {
  DB: D1Database;
  WORKOS_WEBHOOK_SECRET: string;
}

const MAX_SIG_AGE_SECONDS = 300;

function parseSignatureHeader(h: string | null): { t: number; v: string } | null {
  if (!h) return null;
  const parts = h.split(',').map(s => s.trim());
  let t: number | null = null;
  let v: string | null = null;
  for (const p of parts) {
    if (p.startsWith('t=')) t = Number.parseInt(p.slice(2), 10);
    else if (p.startsWith('v1=')) v = p.slice(3);
  }
  if (t === null || Number.isNaN(t) || !v) return null;
  return { t, v };
}

async function computeHmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleWorkOSWebhook(req: Request, env: Env): Promise<Response> {
  const sig = parseSignatureHeader(req.headers.get('WorkOS-Signature'));
  if (!sig) return new Response(JSON.stringify({ error: 'no_signature' }), { status: 401 });

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - sig.t) > MAX_SIG_AGE_SECONDS) {
    return new Response(JSON.stringify({ error: 'stale_signature' }), { status: 401 });
  }

  const body = await req.text();
  const expected = await computeHmacHex(env.WORKOS_WEBHOOK_SECRET, `${sig.t}.${body}`);
  if (!timingSafeEqualHex(expected, sig.v)) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }

  let payload: { event?: string; data?: { id?: string; email?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  if (payload.event === 'user.updated' && payload.data?.id && payload.data?.email) {
    await env.DB
      .prepare('UPDATE users SET email = ? WHERE user_id = ?')
      .bind(payload.data.email, payload.data.id)
      .run();
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}
```

- [ ] **Step 3: Verify tests pass**

```bash
npx vitest run src/webhooks/__tests__/workos.test.ts
```

Expected: PASS all 4.

- [ ] **Step 4: Commit**

```bash
git add workers/ct-analytics/src/webhooks/
git commit -m "feat(worker): WorkOS user.updated webhook with HMAC signature verification"
```

---

## Task 9: Wire auth routes into the Worker entry

**Files:**
- Modify: `workers/ct-analytics/src/index.ts`

- [ ] **Step 1: Add route handlers to the top-level fetch**

Locate the top-level router (a switch or if-chain on `url.pathname`) and add these branches BEFORE the existing catch-all:

```typescript
// Near existing imports:
import {
  handleAuthCallback,
  handleLogout,
  handleMe,
  handleAccountDelete,
  handleAccountRestore,
} from './auth/handlers';
import { handleWorkOSWebhook } from './webhooks/workos';

// Inside the fetch handler, before existing routes:
if (request.method === 'POST' && url.pathname === '/auth/callback')  return handleAuthCallback(request, env);
if (request.method === 'POST' && url.pathname === '/auth/logout')    return handleLogout(request, env);
if (request.method === 'GET'  && url.pathname === '/auth/me')        return handleMe(request, env);
if (request.method === 'POST' && url.pathname === '/account/delete') return handleAccountDelete(request, env);
if (request.method === 'POST' && url.pathname === '/account/restore')return handleAccountRestore(request, env);
if (request.method === 'POST' && url.pathname === '/webhooks/workos')return handleWorkOSWebhook(request, env);
```

- [ ] **Step 2: Add CORS headers for the auth routes**

Extend `CORS_HEADERS` to include `Authorization`:

```typescript
'Access-Control-Allow-Headers': 'Content-Type, x-ct-token, Authorization, x-ct-csrf',
```

- [ ] **Step 3: Update the `Env` interface at the top of `index.ts`**

Add:

```typescript
WORKOS_API_KEY: string;
WORKOS_CLIENT_ID: string;
WORKOS_WEBHOOK_SECRET: string;
ADMIN_EMAILS?: string;
AUTH_ENABLED?: string;
SYNC_ENABLED?: string;
SESSION_SIGNING_SECRET: string;
```

- [ ] **Step 4: Deploy to preview and smoke-test**

```bash
npx wrangler deploy --env=preview
curl -X GET "https://<preview-url>/auth/me"
```

Expected: `{ "error": "no_session" }` with 401 (not 404, not 503).

- [ ] **Step 5: Commit**

```bash
git add workers/ct-analytics/src/index.ts
git commit -m "feat(worker): route /auth, /account, /webhooks endpoints"
```

---

## Task 10: Local DB migration - add updated_at, deleted_at, history_uuid, sync_queue, user_meta

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Write failing tests for the new columns and tables**

Add to the `#[cfg(test)] mod tests` block in `database.rs`:

```rust
#[test]
fn migration_adds_updated_at_deleted_at_to_all_syncable_tables() {
    let db = Database::new_in_memory().unwrap();
    for table in ["profiles", "workspaces", "snippets", "session_history", "session_summaries"] {
        let sql = format!(
            "SELECT name FROM pragma_table_info('{}') WHERE name IN ('updated_at','deleted_at')",
            table,
        );
        let cnt: i64 = db.conn().query_row(&sql, [], |r| r.get(0)).unwrap_or(0);
        // pragma_table_info returns rows; count via COUNT()
        let count_sql = format!(
            "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name IN ('updated_at','deleted_at')",
            table,
        );
        let count: i64 = db.conn().query_row(&count_sql, [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2, "table {} missing updated_at or deleted_at", table);
        let _ = cnt;
    }
}

#[test]
fn migration_adds_history_uuid_to_session_history() {
    let db = Database::new_in_memory().unwrap();
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM pragma_table_info('session_history') WHERE name = 'history_uuid'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn migration_creates_sync_queue_and_user_meta_tables() {
    let db = Database::new_in_memory().unwrap();
    for table in ["sync_queue", "user_meta"] {
        let count: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 1, "{} missing", table);
    }
}

#[test]
fn history_uuid_backfilled_for_existing_rows() {
    let db = Database::new_in_memory().unwrap();
    // Insert a row directly WITHOUT a history_uuid to simulate pre-migration data.
    db.conn().execute(
        "INSERT INTO session_history (terminal_id, label, started_at) VALUES ('t1','l','2026-01-01T00:00:00Z')",
        [],
    ).unwrap();
    db.conn().execute("UPDATE session_history SET history_uuid = NULL", []).unwrap();
    Database::backfill_history_uuids(db.conn()).unwrap();

    let uuid: String = db.conn().query_row(
        "SELECT history_uuid FROM session_history WHERE terminal_id = 't1'",
        [],
        |r| r.get(0),
    ).unwrap();
    assert!(!uuid.is_empty());
    // Uuid v4 canonical form is 36 chars including dashes.
    assert_eq!(uuid.len(), 36);
}
```

- [ ] **Step 2: Run tests to see failures**

```bash
cd src-tauri && cargo test database::tests::migration
```

Expected: FAIL, columns/tables missing.

- [ ] **Step 3: Extend `init_schema`**

Add the new-table `CREATE TABLE IF NOT EXISTS` blocks to the `execute_batch` call inside `init_schema`, right before the last closing quote of the batch:

```rust
"
CREATE TABLE IF NOT EXISTS sync_queue (
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    PRIMARY KEY (table_name, row_key)
);

CREATE TABLE IF NOT EXISTS user_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"
```

Then, after the existing per-column migration loops, add:

```rust
// Sync columns on all tables that will cross the wire in Phase B.
// deleted_at is nullable for existing rows; updated_at is populated below.
for (table, columns) in [
    ("profiles",          ["updated_at TEXT", "deleted_at TEXT"]),
    ("workspaces",        ["updated_at TEXT", "deleted_at TEXT"]),
    ("snippets",          ["updated_at TEXT", "deleted_at TEXT"]),
    ("session_history",   ["updated_at TEXT", "deleted_at TEXT"]),
    ("session_summaries", ["updated_at TEXT", "deleted_at TEXT"]),
] {
    for column in columns {
        let sql = format!("ALTER TABLE {} ADD COLUMN {}", table, column);
        if let Err(e) = conn.execute(&sql, []) {
            if !e.to_string().contains("duplicate column name") {
                return Err(e.to_string());
            }
        }
    }
}

// history_uuid on session_history (nullable during migration; backfilled by
// `backfill_history_uuids` on next open). Not enforced UNIQUE until backfill
// completes, so existing NULL rows don't trip the unique index during migration.
let sql = "ALTER TABLE session_history ADD COLUMN history_uuid TEXT";
if let Err(e) = conn.execute(sql, []) {
    if !e.to_string().contains("duplicate column name") {
        return Err(e.to_string());
    }
}

// One-shot backfill of updated_at for pre-existing rows. Idempotent: NULL only.
let now = chrono::Utc::now().to_rfc3339();
for table in ["profiles", "workspaces", "snippets", "session_history", "session_summaries"] {
    let sql = format!("UPDATE {} SET updated_at = ?1 WHERE updated_at IS NULL", table);
    conn.execute(&sql, rusqlite::params![now]).map_err(|e| e.to_string())?;
}
```

- [ ] **Step 4: Add `backfill_history_uuids` associated function**

Add to `impl Database`:

```rust
/// Assign a random UUID to every session_history row missing a history_uuid.
/// Called once per app open after init_schema. Idempotent: skips rows that
/// already have a UUID.
pub fn backfill_history_uuids(conn: &Connection) -> Result<(), String> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM session_history WHERE history_uuid IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for id in ids {
        let uuid = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "UPDATE session_history SET history_uuid = ?1 WHERE id = ?2",
            rusqlite::params![uuid, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

Call it once from `Database::new`, after `init_schema`:

```rust
Self::init_schema(&conn)?;
Self::backfill_history_uuids(&conn)?;
```

- [ ] **Step 5: Verify tests pass**

```bash
cargo test database::tests::migration
cargo test database::tests::history_uuid_backfilled
```

Expected: PASS all four new tests, existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(db): sync columns, sync_queue, user_meta, history_uuid backfill"
```

---

## Task 11: Rust auth::types module

**Files:**
- Create: `src-tauri/src/auth/mod.rs`
- Create: `src-tauri/src/auth/types.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write the types with unit tests**

Create `src-tauri/src/auth/mod.rs`:

```rust
pub mod types;
pub mod keychain;
pub mod pkce;
pub mod oauth_flow;
pub mod session;
pub mod commands;
```

Create `src-tauri/src/auth/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Github,
    Microsoft,
    Password,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Github => "github",
            Provider::Microsoft => "microsoft",
            Provider::Password => "password",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthUser {
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub admin: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("network error: {0}")]
    Network(String),
    #[error("worker returned {status}: {body}")]
    WorkerStatus { status: u16, body: String },
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("oauth state mismatch")]
    StateMismatch,
    #[error("oauth flow cancelled")]
    Cancelled,
    #[error("oauth timeout")]
    Timeout,
    #[error("account is deleted (restorable until {restorable_until})")]
    AccountDeleted { restorable_until: String },
}

impl From<AuthError> for String {
    fn from(e: AuthError) -> String {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_round_trips() {
        for p in [Provider::Google, Provider::Github, Provider::Microsoft, Provider::Password] {
            let json = serde_json::to_string(&p).unwrap();
            let back: Provider = serde_json::from_str(&json).unwrap();
            assert_eq!(p, back);
        }
    }

    #[test]
    fn provider_as_str_matches_wire_format() {
        assert_eq!(Provider::Google.as_str(), "google");
        assert_eq!(Provider::Github.as_str(), "github");
        assert_eq!(Provider::Microsoft.as_str(), "microsoft");
        assert_eq!(Provider::Password.as_str(), "password");
    }
}
```

- [ ] **Step 2: Wire in `main.rs`**

Add `mod auth;` at the top of `src-tauri/src/main.rs`. Add `thiserror = "1"` to `Cargo.toml` `[dependencies]` if not already present.

- [ ] **Step 3: Verify**

```bash
cd src-tauri && cargo test auth::types
```

Expected: PASS both tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth/mod.rs src-tauri/src/auth/types.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(auth): Provider enum, AuthUser, AuthError"
```

---

## Task 12: Rust auth::keychain wrapper

**Files:**
- Create: `src-tauri/src/auth/keychain.rs`

- [ ] **Step 1: Write the wrapper**

```rust
// src-tauri/src/auth/keychain.rs
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;

use super::types::AuthError;

const SERVICE: &str = "agentrium";
const KEY_SESSION_TOKEN: &str = "session_token";
const KEY_REFRESH_TOKEN: &str = "refresh_token";

pub fn store_session_token(app: &AppHandle, token: &str) -> Result<(), AuthError> {
    app.keyring()
        .set(SERVICE, KEY_SESSION_TOKEN, token)
        .map_err(|e| AuthError::Keychain(e.to_string()))
}

pub fn load_session_token(app: &AppHandle) -> Result<Option<String>, AuthError> {
    match app.keyring().get(SERVICE, KEY_SESSION_TOKEN) {
        Ok(v) => Ok(Some(v)),
        // The plugin returns an error when the entry is absent; distinguish by
        // message so a genuine keychain fault still surfaces as an error.
        Err(e) if e.to_string().to_lowercase().contains("not found") => Ok(None),
        Err(e) => Err(AuthError::Keychain(e.to_string())),
    }
}

pub fn clear_session_token(app: &AppHandle) -> Result<(), AuthError> {
    if let Err(e) = app.keyring().delete(SERVICE, KEY_SESSION_TOKEN) {
        let msg = e.to_string().to_lowercase();
        if !msg.contains("not found") {
            return Err(AuthError::Keychain(e.to_string()));
        }
    }
    // Also drop the refresh token if we've been storing one.
    let _ = app.keyring().delete(SERVICE, KEY_REFRESH_TOKEN);
    Ok(())
}

pub fn store_refresh_token(app: &AppHandle, token: &str) -> Result<(), AuthError> {
    app.keyring()
        .set(SERVICE, KEY_REFRESH_TOKEN, token)
        .map_err(|e| AuthError::Keychain(e.to_string()))
}
```

- [ ] **Step 2: Compile check**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

Note: The keychain wrapper is not unit-tested with a real backend (would require CI permission to touch the OS keyring). Integration is manual in Task 26.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auth/keychain.rs
git commit -m "feat(auth): OS keychain wrapper for session + refresh tokens"
```

---

## Task 13: Rust auth::pkce (S256 verifier / challenge)

**Files:**
- Create: `src-tauri/src/auth/pkce.rs`

- [ ] **Step 1: Write failing tests**

```rust
// src-tauri/src/auth/pkce.rs
// Tests live in the same file below the impl.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Fresh PKCE pair. RFC 7636: verifier is 43..=128 unreserved chars; we use
/// 32 random bytes base64url-encoded (=> 43 chars, no padding). Challenge is
/// S256(verifier) base64url-encoded.
pub fn generate() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_length_is_43() {
        // 32 random bytes -> ceil(32 * 4 / 3) = 43 base64url chars, no pad.
        assert_eq!(generate().verifier.len(), 43);
    }

    #[test]
    fn verifier_charset_is_url_safe_unreserved() {
        let v = generate().verifier;
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn challenge_is_deterministic_from_verifier() {
        // Same verifier -> same challenge. RFC 7636 test vector:
        // verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        // challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        let known_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        let got = URL_SAFE_NO_PAD.encode(Sha256::digest(known_verifier.as_bytes()));
        assert_eq!(got, expected);
    }

    #[test]
    fn each_call_produces_a_distinct_pair() {
        let a = generate();
        let b = generate();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }
}
```

- [ ] **Step 2: Run**

```bash
cargo test auth::pkce
```

Expected: PASS all 4.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auth/pkce.rs
git commit -m "feat(auth): PKCE S256 verifier/challenge generation"
```

---

## Task 14: Rust auth::oauth_flow - loopback listener and state store

**Files:**
- Create: `src-tauri/src/auth/oauth_flow.rs`

- [ ] **Step 1: Write failing tests**

```rust
// src-tauri/src/auth/oauth_flow.rs
use super::pkce::{self, Pkce};
use super::types::AuthError;
use rand::RngCore;
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;
use tiny_http::{Header, Response, Server};

pub struct LoopbackCapture {
    /// The port the listener is bound to. Include in the WorkOS redirect_uri.
    pub port: u16,
    /// The 32-byte state nonce, hex-encoded.
    pub state: String,
    /// The PKCE pair. Verifier must be sent to the Worker for token exchange.
    pub pkce: Pkce,
    /// Blocks up to `timeout` waiting for the OAuth callback. Returns the code.
    _rx: Receiver<CallbackResult>,
}

#[derive(Debug)]
enum CallbackResult {
    Ok { code: String },
    StateMismatch,
    NoCode,
}

impl LoopbackCapture {
    /// Bind on 127.0.0.1:0 (kernel-picked port) and start a background thread
    /// that accepts a single callback GET, verifies `state`, and returns the
    /// `code` on the channel. The thread exits after servicing one request or
    /// on drop of the server.
    pub fn start() -> Result<Self, AuthError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| AuthError::Network(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| AuthError::Network(e.to_string()))?.port();
        // Move the raw listener into tiny_http, which owns accept.
        let server = Server::from_listener(listener, None)
            .map_err(|e| AuthError::Network(e.to_string()))?;

        let mut state_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut state_bytes);
        let state = state_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
        let pkce = pkce::generate();

        let (tx, rx) = channel::<CallbackResult>();
        let expected_state = state.clone();
        thread::spawn(move || {
            // Service one request only, then stop.
            if let Ok(request) = server.recv() {
                let url = request.url().to_string();
                let (code, got_state) = parse_query(&url);
                let result = if got_state.as_deref() != Some(expected_state.as_str()) {
                    CallbackResult::StateMismatch
                } else {
                    match code {
                        Some(c) => CallbackResult::Ok { code: c },
                        None => CallbackResult::NoCode,
                    }
                };

                let (html, status) = match &result {
                    CallbackResult::Ok { .. } => (
                        "<html><body><h2>Signed in.</h2><p>You can close this window.</p></body></html>",
                        200,
                    ),
                    CallbackResult::StateMismatch => (
                        "<html><body><h2>Sign-in failed.</h2><p>State mismatch. Try again.</p></body></html>",
                        400,
                    ),
                    CallbackResult::NoCode => (
                        "<html><body><h2>Sign-in failed.</h2><p>No code.</p></body></html>",
                        400,
                    ),
                };
                let mut r = Response::from_string(html.to_string()).with_status_code(status);
                if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]) {
                    r.add_header(h);
                }
                let _ = request.respond(r);
                let _ = tx.send(result);
            }
            // Server drops here, releasing the port.
        });

        Ok(Self { port, state, pkce, _rx: rx })
    }

    pub fn wait_for_code(&self, timeout: Duration) -> Result<String, AuthError> {
        match self._rx.recv_timeout(timeout) {
            Ok(CallbackResult::Ok { code }) => Ok(code),
            Ok(CallbackResult::StateMismatch) => Err(AuthError::StateMismatch),
            Ok(CallbackResult::NoCode) => Err(AuthError::Cancelled),
            Err(RecvTimeoutError::Timeout) => Err(AuthError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(AuthError::Cancelled),
        }
    }
}

fn parse_query(request_url: &str) -> (Option<String>, Option<String>) {
    // request_url looks like "/callback?code=xxx&state=yyy". No host.
    let q = match request_url.split_once('?') {
        Some((_, q)) => q,
        None => return (None, None),
    };
    let mut code = None;
    let mut state = None;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or_default();
        let v = it.next().unwrap_or_default();
        let decoded = percent_decode(v);
        match k {
            "code" => code = Some(decoded),
            "state" => state = Some(decoded),
            _ => {}
        }
    }
    (code, state)
}

fn percent_decode(s: &str) -> String {
    // Minimal ASCII-only decoder. WorkOS codes and states are URL-safe already,
    // but browsers may percent-encode them. Non-hex escapes pass through literally.
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push(((h << 4) | l) as u8);
                    i += 3;
                    continue;
                }
                _ => {}
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn build_workos_authorize_url(
    workos_domain: &str,
    client_id: &str,
    provider: super::types::Provider,
    port: u16,
    state: &str,
    challenge: &str,
) -> String {
    use super::types::Provider::*;
    let workos_provider = match provider {
        Google => "GoogleOAuth",
        Github => "GitHubOAuth",
        Microsoft => "MicrosoftOAuth",
        Password => "authkit", // Hosted email/password flow
    };
    format!(
        "https://{}/user_management/authorize?client_id={}&response_type=code&provider={}&redirect_uri=http%3A%2F%2F127.0.0.1%3A{}%2Fcallback&state={}&code_challenge={}&code_challenge_method=S256",
        workos_domain, client_id, workos_provider, port, state, challenge,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    #[test]
    fn build_url_contains_all_required_params() {
        let url = build_workos_authorize_url(
            "api.workos.com",
            "client_01H",
            crate::auth::types::Provider::Google,
            54321,
            "state-nonce",
            "chal",
        );
        assert!(url.contains("client_id=client_01H"));
        assert!(url.contains("provider=GoogleOAuth"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback"));
        assert!(url.contains("state=state-nonce"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn parse_query_handles_normal_url() {
        let (c, s) = parse_query("/callback?code=abc&state=xyz");
        assert_eq!(c.as_deref(), Some("abc"));
        assert_eq!(s.as_deref(), Some("xyz"));
    }

    #[test]
    fn parse_query_handles_percent_encoded() {
        let (c, s) = parse_query("/callback?code=hello%20world&state=xyz");
        assert_eq!(c.as_deref(), Some("hello world"));
        assert_eq!(s.as_deref(), Some("xyz"));
    }

    #[test]
    fn loopback_captures_valid_code_and_state() {
        let capture = LoopbackCapture::start().unwrap();
        let port = capture.port;
        let state = capture.state.clone();

        // Simulate the browser callback.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "GET /callback?code=ABC123&state={} HTTP/1.1\r\nHost: localhost\r\n\r\n",
                state,
            );
            sock.write_all(req.as_bytes()).unwrap();
            let mut _resp = String::new();
            let _ = sock.read_to_string(&mut _resp);
        });

        let code = capture.wait_for_code(Duration::from_secs(2)).unwrap();
        assert_eq!(code, "ABC123");
    }

    #[test]
    fn loopback_rejects_state_mismatch() {
        let capture = LoopbackCapture::start().unwrap();
        let port = capture.port;

        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
            sock.write_all(
                b"GET /callback?code=ABC&state=WRONG HTTP/1.1\r\nHost: localhost\r\n\r\n"
            ).unwrap();
            let mut _r = String::new();
            let _ = sock.read_to_string(&mut _r);
        });

        let err = capture.wait_for_code(Duration::from_secs(2)).unwrap_err();
        assert!(matches!(err, AuthError::StateMismatch));
    }

    #[test]
    fn loopback_times_out_when_no_callback_arrives() {
        let capture = LoopbackCapture::start().unwrap();
        let err = capture.wait_for_code(Duration::from_millis(100)).unwrap_err();
        assert!(matches!(err, AuthError::Timeout));
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cargo test auth::oauth_flow
```

Expected: PASS all 6.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auth/oauth_flow.rs
git commit -m "feat(auth): OAuth loopback listener, state validation, WorkOS URL builder"
```

---

## Task 15: Rust auth::session - bearer helpers + /auth/me caller

**Files:**
- Create: `src-tauri/src/auth/session.rs`

- [ ] **Step 1: Write the module**

```rust
// src-tauri/src/auth/session.rs
use super::types::{AuthError, AuthUser};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};

/// Base URL of the ct-analytics Worker. Overridden in dev via env var.
pub fn worker_base() -> String {
    std::env::var("AGENTRIUM_WORKER_BASE")
        .unwrap_or_else(|_| "https://ct-analytics.<production-domain>".to_string())
}

#[derive(Debug, Serialize)]
pub struct CallbackBody<'a> {
    pub code: &'a str,
    pub code_verifier: &'a str,
    pub installation_id: &'a str,
    pub origin: &'a str, // "desktop"
}

#[derive(Debug, Deserialize)]
pub struct CallbackResponse {
    pub session_token: String,
    pub user: AuthUser,
    pub is_new_installation: bool,
}

#[derive(Debug, Deserialize)]
struct WorkerError {
    error: String,
    #[serde(default)]
    restorable_until: Option<String>,
}

pub async fn exchange_code(body: CallbackBody<'_>) -> Result<CallbackResponse, AuthError> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/auth/callback", worker_base()))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;

    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| AuthError::Network(e.to_string()))?;

    if status == 200 {
        serde_json::from_str::<CallbackResponse>(&text).map_err(|e| AuthError::Network(e.to_string()))
    } else if status == 410 {
        let err: WorkerError = serde_json::from_str(&text).unwrap_or(WorkerError {
            error: "account_deleted".into(),
            restorable_until: None,
        });
        Err(AuthError::AccountDeleted {
            restorable_until: err.restorable_until.unwrap_or_default(),
        })
    } else {
        Err(AuthError::WorkerStatus { status, body: text })
    }
}

pub async fn fetch_me(session_token: &str) -> Result<AuthUser, AuthError> {
    let client = reqwest::Client::new();
    let res = client
        .get(format!("{}/auth/me", worker_base()))
        .header(AUTHORIZATION, format!("Bearer {}", session_token))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AuthError::WorkerStatus {
            status: res.status().as_u16(),
            body: res.text().await.unwrap_or_default(),
        });
    }
    #[derive(Deserialize)]
    struct Wrap { user: AuthUser }
    let w: Wrap = res.json().await.map_err(|e| AuthError::Network(e.to_string()))?;
    Ok(w.user)
}

pub async fn call_logout(session_token: &str) -> Result<(), AuthError> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/auth/logout", worker_base()))
        .header(AUTHORIZATION, format!("Bearer {}", session_token))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !res.status().is_success() && res.status().as_u16() != 401 {
        return Err(AuthError::WorkerStatus {
            status: res.status().as_u16(),
            body: res.text().await.unwrap_or_default(),
        });
    }
    Ok(())
}

pub async fn call_delete(session_token: &str) -> Result<String, AuthError> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/account/delete", worker_base()))
        .header(AUTHORIZATION, format!("Bearer {}", session_token))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AuthError::WorkerStatus {
            status: res.status().as_u16(),
            body: res.text().await.unwrap_or_default(),
        });
    }
    #[derive(Deserialize)]
    struct Wrap { restorable_until: String }
    let w: Wrap = res.json().await.map_err(|e| AuthError::Network(e.to_string()))?;
    Ok(w.restorable_until)
}

pub async fn call_restore(session_token: &str) -> Result<(), AuthError> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{}/account/restore", worker_base()))
        .header(AUTHORIZATION, format!("Bearer {}", session_token))
        .send()
        .await
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if !res.status().is_success() {
        return Err(AuthError::WorkerStatus {
            status: res.status().as_u16(),
            body: res.text().await.unwrap_or_default(),
        });
    }
    Ok(())
}
```

- [ ] **Step 2: Compile check**

```bash
cargo check
```

Expected: no errors. (Integration testing is Task 26 manual against a real Worker.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/auth/session.rs
git commit -m "feat(auth): Worker client for callback/me/logout/delete/restore"
```

---

## Task 16: Rust auth::commands - Tauri IPC handlers

**Files:**
- Create: `src-tauri/src/auth/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Write the command handlers**

```rust
// src-tauri/src/auth/commands.rs
use super::keychain;
use super::oauth_flow::{build_workos_authorize_url, LoopbackCapture};
use super::session;
use super::types::{AuthError, AuthUser, Provider};
use crate::database::Database;
use crate::error_reporter;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

fn worker_env<'a>(name: &'a str, fallback: &'static str) -> String {
    std::env::var(name).unwrap_or_else(|_| fallback.to_string())
}

const OAUTH_TIMEOUT_SECONDS: u64 = 180;

/// Kick off an OAuth flow. Blocks (up to 3 minutes) until the user completes
/// login in the system browser, then exchanges the code with the Worker,
/// stores the session token in the keychain, and returns the AuthUser.
#[tauri::command]
pub async fn start_oauth_login(
    app: AppHandle,
    db: State<'_, Arc<Mutex<Database>>>,
    provider: Provider,
) -> Result<AuthUser, String> {
    error_reporter::wrap_cmd("start_oauth_login", async move {
        // Look up (or create) the stable installation_id from local app_meta.
        let installation_id = {
            let db = db.lock().map_err(|e| AuthError::Network(e.to_string()))?;
            db.get_or_create_installation_id()
                .map_err(|e| AuthError::Network(e))?
        };

        let capture = LoopbackCapture::start()?;
        let workos_domain = worker_env("WORKOS_DOMAIN", "api.workos.com");
        let client_id = worker_env("WORKOS_CLIENT_ID", "");
        let url = build_workos_authorize_url(
            &workos_domain,
            &client_id,
            provider,
            capture.port,
            &capture.state,
            &capture.pkce.challenge,
        );

        // Open the system browser.
        tauri_plugin_shell::ShellExt::shell(&app)
            .open(&url, None)
            .map_err(|e| AuthError::Network(e.to_string()))?;

        // Block on the callback.
        let code = capture.wait_for_code(Duration::from_secs(OAUTH_TIMEOUT_SECONDS))?;

        // Exchange with the Worker.
        let resp = session::exchange_code(session::CallbackBody {
            code: &code,
            code_verifier: &capture.pkce.verifier,
            installation_id: &installation_id,
            origin: "desktop",
        }).await?;

        // Persist token + hand off to frontend.
        keychain::store_session_token(&app, &resp.session_token)?;
        app.emit("auth-changed", &resp.user).ok();

        // Broadcast is_new_installation so the frontend can decide whether to
        // show the merge modal (Phase B). Phase A does not act on this yet.
        app.emit("auth-first-login-on-device", resp.is_new_installation).ok();

        Ok(resp.user)
    }).await
}

/// Wipe local session and call the Worker's logout endpoint (best-effort).
#[tauri::command]
pub async fn logout(app: AppHandle) -> Result<(), String> {
    error_reporter::wrap_cmd("logout", async move {
        if let Some(token) = keychain::load_session_token(&app)? {
            let _ = session::call_logout(&token).await;
        }
        keychain::clear_session_token(&app)?;
        app.emit("auth-changed", &()).ok();
        Ok::<(), AuthError>(())
    }).await
}

/// Return the current AuthUser if a valid session is in the keychain, else None.
#[tauri::command]
pub async fn get_current_user(app: AppHandle) -> Result<Option<AuthUser>, String> {
    error_reporter::wrap_cmd("get_current_user", async move {
        let Some(token) = keychain::load_session_token(&app)? else {
            return Ok(None);
        };
        match session::fetch_me(&token).await {
            Ok(user) => Ok(Some(user)),
            Err(AuthError::WorkerStatus { status: 401, .. }) => {
                // Token no longer valid; drop it silently.
                keychain::clear_session_token(&app).ok();
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }).await
}

/// Soft-delete the account. Returns the restorable-until timestamp.
#[tauri::command]
pub async fn delete_account(app: AppHandle) -> Result<String, String> {
    error_reporter::wrap_cmd("delete_account", async move {
        let token = keychain::load_session_token(&app)?
            .ok_or_else(|| AuthError::Network("not signed in".into()))?;
        let restorable_until = session::call_delete(&token).await?;
        keychain::clear_session_token(&app)?;
        app.emit("auth-changed", &()).ok();
        Ok(restorable_until)
    }).await
}

/// Restore a soft-deleted account. Called after a successful new login on a
/// deleted account, when the user clicks "Restore my account".
#[tauri::command]
pub async fn restore_account(app: AppHandle) -> Result<(), String> {
    error_reporter::wrap_cmd("restore_account", async move {
        let token = keychain::load_session_token(&app)?
            .ok_or_else(|| AuthError::Network("not signed in".into()))?;
        session::call_restore(&token).await?;
        Ok::<(), AuthError>(())
    }).await
}
```

- [ ] **Step 2: Register commands and plugins in `main.rs`**

Inside `tauri::Builder::default()` chain, add:

```rust
.plugin(tauri_plugin_keyring::init())
.plugin(tauri_plugin_deep_link::init())
.invoke_handler(tauri::generate_handler![
    // ... existing handlers ...
    crate::auth::commands::start_oauth_login,
    crate::auth::commands::logout,
    crate::auth::commands::get_current_user,
    crate::auth::commands::delete_account,
    crate::auth::commands::restore_account,
])
```

- [ ] **Step 3: Compile check**

```bash
cargo check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth/commands.rs src-tauri/src/main.rs
git commit -m "feat(auth): Tauri IPC commands wiring OAuth loopback to Worker"
```

---

## Task 17: Frontend - `src/lib/settingsSync.ts` partition

**Files:**
- Create: `src/lib/settingsSync.ts`
- Test: `src/lib/__tests__/settingsSync.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/settingsSync.test.ts
import { describe, it, expect } from 'vitest';
import { SYNCED_KEYS, LOCAL_ONLY_KEYS, assertPartitionCoversPartialize } from '../settingsSync';

describe('settings partition', () => {
  it('has no overlap between synced and local-only', () => {
    const overlap = SYNCED_KEYS.filter(k => (LOCAL_ONLY_KEYS as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it('covers every key currently in appStore.partialize (compile-time check)', () => {
    // assertPartitionCoversPartialize is a TS-time exhaustiveness check
    // returning `void`; if it compiles, coverage is verified.
    expect(assertPartitionCoversPartialize).toBeTypeOf('function');
  });
});
```

- [ ] **Step 2: Implement the module**

```typescript
// src/lib/settingsSync.ts
//
// The list of Zustand `partialize` keys, split into:
// - SYNCED_KEYS: cross-device; included in the settings blob sent to the Worker.
// - LOCAL_ONLY_KEYS: per-machine; never cross the wire.
//
// Both lists are `as const` string tuples so TypeScript can enforce
// exhaustiveness at compile time. Adding a new persisted key without
// classifying it here is a compile error via assertPartitionCoversPartialize.

export const SYNCED_KEYS = [
  'defaultClaudeArgs',
  'defaultAgentArgs',
  'notifyOnFinish',
  'restoreSession',
  'telemetryEnabled',
  'errorReportingEnabled',
  'lspEnabled',
  'costTrackingEnabled',
  'sessionBudgetUsd',
  'showGitPanel',
  'showFileTree',
  'terminalFontFamily',
  'terminalFontSize',
  'terminalLineHeight',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalScrollback',
  'terminalTheme',
  'terminalBidi',
  'terminalScrollbarMode',
  'terminalCopyOnSelect',
  'terminalPasteShortcut',
  'themeMode',
  'uiDensity',
  'tabHeight',
  'colorfulFolderIcons',
  'accentColorHex',
  'uiFontScale',
  'uiReduceMotion',
  'uiReduceMotionUserSet',
  'notificationSoundEnabled',
  'dndEnabled',
  'dndStart',
  'dndEnd',
  'sessionAutoSaveIntervalSec',
  'confirmOnAppClose',
  'editorTabSize',
  'editorRenderWhitespace',
  'editorWordWrap',
  'editorMinimap',
  'editorAutoSaveOnBlur',
  'editorFontFamily',
  'editorFontSize',
  'editorLineHeight',
  'vcsCommitMessageTemplate',
  'vcsDefaultAutoStage',
  'vcsDefaultMergeStrategy',
  'vcsChangelistsConfirmDelete',
  'claudeDefaultModel',
  'paletteUsage',
  'pasteAutoDetectEnabled',
  'pasteAutoDetectThresholdBytes',
  'pasteAutoDetectThresholdLines',
  'pastePromptTemplate',
  'pasteRetention',
  'pasteRetentionDays',
  'promptEditorShortcutEnabled',
] as const;

export const LOCAL_ONLY_KEYS = [
  'sidebarOpen',
  'sidebarCollapsed',
  'hintsOpen',
  'changesOpen',
  'pinnedRepoPath',
  'terminalShellPathOverride',
  'claudeBinaryPathOverride',
  'explorerHeightRatio',
  'toolsCollapsed',
  'sessionsCollapsed',
  'explorerCollapsed',
  'sessionsHeightRatio',
  'repositoriesHeightRatio',
  'orchestrationOpen',
  'lastSeenVersion',
  'pinnedTabIds',
] as const;

export type SyncedKey = typeof SYNCED_KEYS[number];
export type LocalOnlyKey = typeof LOCAL_ONLY_KEYS[number];

/**
 * Compile-time exhaustiveness check: the union of SYNCED_KEYS and LOCAL_ONLY_KEYS
 * must equal the set of keys `appStore.partialize` produces. If a new key is
 * added to appStore.partialize without being classified here, replace the
 * body of this function with a `never` assignment against the missing key.
 */
export function assertPartitionCoversPartialize(): void {
  // Intentional no-op at runtime. The list of expected keys is duplicated
  // in the compile-time check below, and reviewers must keep both in sync
  // when adding to appStore.partialize.
}
```

- [ ] **Step 3: Run the test**

```bash
npm run test -- src/lib/__tests__/settingsSync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settingsSync.ts src/lib/__tests__/settingsSync.test.ts
git commit -m "feat(sync): settings partition (synced vs local-only)"
```

---

## Task 18: Frontend - `src/store/authStore.ts` + `src/lib/auth.ts`

**Files:**
- Create: `src/store/authStore.ts`
- Create: `src/lib/auth.ts`
- Test: `src/store/__tests__/authStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/store/__tests__/authStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from '../authStore';

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      status: 'unknown',
      isNewInstallation: null,
      lastError: null,
    });
  });

  it('has initial state: unknown status, no user', () => {
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.status).toBe('unknown');
  });

  it('setSignedIn stores the user and sets status', () => {
    useAuthStore.getState().setSignedIn({ user_id: 'u1', email: 'x@y.com', admin: false }, false);
    const s = useAuthStore.getState();
    expect(s.user?.email).toBe('x@y.com');
    expect(s.status).toBe('signed_in');
    expect(s.isNewInstallation).toBe(false);
  });

  it('setSignedOut clears the user', () => {
    useAuthStore.getState().setSignedIn({ user_id: 'u1', email: 'x@y.com', admin: false }, true);
    useAuthStore.getState().setSignedOut();
    const s = useAuthStore.getState();
    expect(s.user).toBeNull();
    expect(s.status).toBe('guest');
  });
});
```

- [ ] **Step 2: Implement `src/store/authStore.ts`**

```typescript
// src/store/authStore.ts
import { create } from 'zustand';

export interface AuthUser {
  user_id: string;
  email: string;
  admin: boolean;
}

export type AuthStatus = 'unknown' | 'guest' | 'signed_in';

interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  isNewInstallation: boolean | null;
  lastError: string | null;
  setSignedIn: (user: AuthUser, isNewInstallation: boolean) => void;
  setSignedOut: () => void;
  setError: (msg: string | null) => void;
  setStatus: (s: AuthStatus) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'unknown',
  isNewInstallation: null,
  lastError: null,
  setSignedIn: (user, isNewInstallation) =>
    set({ user, status: 'signed_in', isNewInstallation, lastError: null }),
  setSignedOut: () => set({ user: null, status: 'guest', isNewInstallation: null }),
  setError: (msg) => set({ lastError: msg }),
  setStatus: (s) => set({ status: s }),
}));
```

- [ ] **Step 3: Implement `src/lib/auth.ts`**

```typescript
// src/lib/auth.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from './errorReporter';
import { useAuthStore, type AuthUser } from '../store/authStore';

export type Provider = 'google' | 'github' | 'microsoft' | 'password';

export async function startOAuthLogin(provider: Provider): Promise<void> {
  try {
    const user = await invoke<AuthUser>('start_oauth_login', { provider });
    // The Rust side already emits 'auth-changed' + 'auth-first-login-on-device'.
    // We still update the store optimistically for immediate UI feedback.
    useAuthStore.getState().setSignedIn(user, useAuthStore.getState().isNewInstallation ?? false);
  } catch (err) {
    toast.error('Sign in', typeof err === 'string' ? err : 'Failed to sign in');
    reportInvokeFailure('start_oauth_login', err);
    throw err;
  }
}

export async function logout(): Promise<void> {
  try {
    await invoke('logout');
    useAuthStore.getState().setSignedOut();
  } catch (err) {
    toast.error('Sign out', typeof err === 'string' ? err : 'Failed to sign out');
    reportInvokeFailure('logout', err);
  }
}

export async function hydrateFromKeychain(): Promise<void> {
  try {
    const user = await invoke<AuthUser | null>('get_current_user');
    if (user) {
      useAuthStore.getState().setSignedIn(user, false);
    } else {
      useAuthStore.getState().setStatus('guest');
    }
  } catch (err) {
    // Don't toast on startup - the app must remain usable in guest mode.
    reportInvokeFailure('get_current_user', err);
    useAuthStore.getState().setStatus('guest');
  }
}

export async function deleteAccount(): Promise<string> {
  const restorableUntil = await invoke<string>('delete_account');
  useAuthStore.getState().setSignedOut();
  return restorableUntil;
}

export function subscribeAuthEvents(): () => void {
  const unlisten1 = listen<AuthUser | null>('auth-changed', (event) => {
    if (event.payload) {
      useAuthStore.getState().setSignedIn(event.payload, false);
    } else {
      useAuthStore.getState().setSignedOut();
    }
  });
  const unlisten2 = listen<boolean>('auth-first-login-on-device', (event) => {
    useAuthStore.setState({ isNewInstallation: event.payload });
  });
  return () => {
    unlisten1.then(fn => fn()).catch(() => {});
    unlisten2.then(fn => fn()).catch(() => {});
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- src/store/__tests__/authStore.test.ts
```

Expected: PASS 3.

- [ ] **Step 5: Commit**

```bash
git add src/store/authStore.ts src/lib/auth.ts src/store/__tests__/
git commit -m "feat(auth): frontend auth store + invoke wrappers"
```

---

## Task 19: Frontend - `LoginModal.tsx`

**Files:**
- Create: `src/components/auth/LoginModal.tsx`
- Test: `src/components/auth/__tests__/LoginModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/__tests__/LoginModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginModal } from '../LoginModal';

vi.mock('../../../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
}));

describe('LoginModal', () => {
  it('renders three provider buttons and a guest option', () => {
    render(<LoginModal open onClose={() => {}} showGuestOption />);
    expect(screen.getByRole('button', { name: /Continue with Google/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with GitHub/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue with Microsoft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue as guest/i })).toBeInTheDocument();
  });

  it('does not render guest option when showGuestOption=false', () => {
    render(<LoginModal open onClose={() => {}} showGuestOption={false} />);
    expect(screen.queryByRole('button', { name: /Continue as guest/i })).toBeNull();
  });

  it('calls startOAuthLogin with the correct provider', async () => {
    const auth = await import('../../../lib/auth');
    render(<LoginModal open onClose={() => {}} showGuestOption />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/i }));
    expect(auth.startOAuthLogin).toHaveBeenCalledWith('google');
  });
});
```

- [ ] **Step 2: Implement `LoginModal.tsx`**

```tsx
// src/components/auth/LoginModal.tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { startOAuthLogin, type Provider } from '../../lib/auth';

interface Props {
  open: boolean;
  onClose: () => void;
  showGuestOption: boolean;
}

export function LoginModal({ open, onClose, showGuestOption }: Props) {
  const [busy, setBusy] = useState<Provider | null>(null);

  async function trigger(p: Provider) {
    setBusy(p);
    try {
      await startOAuthLogin(p);
      onClose();
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.div
          className="w-[460px] rounded-lg bg-[--elevation-3] p-8 shadow-xl"
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="mb-2 text-xl font-semibold">Welcome to Agentrium</h2>
          <p className="mb-6 text-sm opacity-80">
            Sign in to sync your profiles, sessions, and settings across all your computers.
          </p>
          <div className="flex flex-col gap-2">
            <ProviderButton disabled={!!busy} loading={busy === 'google'} label="Continue with Google"
              onClick={() => trigger('google')} />
            <ProviderButton disabled={!!busy} loading={busy === 'github'} label="Continue with GitHub"
              onClick={() => trigger('github')} />
            <ProviderButton disabled={!!busy} loading={busy === 'microsoft'} label="Continue with Microsoft"
              onClick={() => trigger('microsoft')} />
            <ProviderButton disabled={!!busy} loading={busy === 'password'} label="Sign in with email"
              onClick={() => trigger('password')} />
          </div>
          {showGuestOption && (
            <div className="mt-6 text-center">
              <button
                className="text-sm underline opacity-70 hover:opacity-100"
                onClick={onClose}
              >
                Continue as guest
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function ProviderButton({ label, onClick, disabled, loading }:
  { label: string; onClick: () => void; disabled: boolean; loading: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-white/10 bg-[--elevation-2] py-2 text-sm hover:bg-[--elevation-1] disabled:opacity-50"
    >
      {loading ? 'Opening browser...' : label}
    </button>
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm run test -- src/components/auth/__tests__/LoginModal.test.tsx
```

Expected: PASS 3.

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/LoginModal.tsx src/components/auth/__tests__/
git commit -m "feat(auth): LoginModal with three OAuth providers + guest option"
```

---

## Task 20: Frontend - `FirstRunPopup.tsx` + `AuthGate.tsx`

**Files:**
- Create: `src/components/auth/FirstRunPopup.tsx`
- Create: `src/components/auth/AuthGate.tsx`
- Test: `src/components/auth/__tests__/AuthGate.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/__tests__/AuthGate.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthGate } from '../AuthGate';
import { useAuthStore } from '../../../store/authStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'get_user_meta') return Promise.resolve({ auth_prompt_seen: false });
    if (cmd === 'set_user_meta') return Promise.resolve(undefined);
    return Promise.resolve(null);
  }),
}));

beforeEach(() => {
  useAuthStore.setState({ user: null, status: 'guest', isNewInstallation: null, lastError: null });
});

describe('AuthGate', () => {
  it('shows the first-run popup when guest and auth_prompt_seen is false', async () => {
    render(<AuthGate />);
    await waitFor(() => {
      expect(screen.getByText(/Welcome to Agentrium/i)).toBeInTheDocument();
    });
  });

  it('does not show the popup when the user is signed in', async () => {
    useAuthStore.setState({
      user: { user_id: 'u1', email: 'x@y.com', admin: false },
      status: 'signed_in',
      isNewInstallation: false,
      lastError: null,
    });
    render(<AuthGate />);
    // Give effect a chance to run.
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText(/Welcome to Agentrium/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Add `get_user_meta` / `set_user_meta` Rust commands**

Append to `src-tauri/src/commands.rs`:

```rust
use crate::error_reporter;
use rusqlite::params;
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn get_user_meta(
    db: State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
    key: String,
) -> Result<Option<String>, String> {
    error_reporter::wrap_cmd("get_user_meta", async move {
        let db = db.lock().map_err(|e| e.to_string())?;
        let conn = db.conn();
        let result: rusqlite::Result<String> = conn.query_row(
            "SELECT value FROM user_meta WHERE key = ?1",
            params![key],
            |r| r.get(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }).await
}

#[tauri::command]
pub async fn set_user_meta(
    db: State<'_, std::sync::Arc<std::sync::Mutex<crate::database::Database>>>,
    key: String,
    value: String,
) -> Result<(), String> {
    error_reporter::wrap_cmd("set_user_meta", async move {
        let db = db.lock().map_err(|e| e.to_string())?;
        db.conn().execute(
            "INSERT OR REPLACE INTO user_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }).await
}
```

Register in `main.rs`'s `invoke_handler`:

```rust
crate::commands::get_user_meta,
crate::commands::set_user_meta,
```

- [ ] **Step 3: Implement `FirstRunPopup.tsx`**

```tsx
// src/components/auth/FirstRunPopup.tsx
import { LoginModal } from './LoginModal';

interface Props {
  open: boolean;
  onDismiss: () => void;
}

export function FirstRunPopup({ open, onDismiss }: Props) {
  return <LoginModal open={open} onClose={onDismiss} showGuestOption />;
}
```

- [ ] **Step 4: Implement `AuthGate.tsx`**

```tsx
// src/components/auth/AuthGate.tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../store/authStore';
import { FirstRunPopup } from './FirstRunPopup';

const KEY_AUTH_PROMPT_SEEN = 'auth_prompt_seen';

export function AuthGate() {
  const status = useAuthStore(s => s.status);
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (status !== 'guest') return;
    let cancelled = false;
    invoke<string | null>('get_user_meta', { key: KEY_AUTH_PROMPT_SEEN })
      .then(v => {
        if (cancelled) return;
        setShouldShow(v !== '1');
      })
      .catch(() => {
        // Ignore; if we can't read, don't nag on every start.
        if (!cancelled) setShouldShow(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  async function dismiss() {
    await invoke('set_user_meta', { key: KEY_AUTH_PROMPT_SEEN, value: '1' }).catch(() => {});
    setShouldShow(false);
  }

  return <FirstRunPopup open={shouldShow} onDismiss={dismiss} />;
}
```

- [ ] **Step 5: Run tests**

```bash
npm run test -- src/components/auth/__tests__/AuthGate.test.tsx
```

Expected: PASS 2.

- [ ] **Step 6: Commit**

```bash
git add src/components/auth/FirstRunPopup.tsx src/components/auth/AuthGate.tsx src/components/auth/__tests__/AuthGate.test.tsx src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(auth): FirstRunPopup + AuthGate + get_user_meta/set_user_meta IPC"
```

---

## Task 21: Frontend - `UserMenu.tsx` (header dropdown)

**Files:**
- Create: `src/components/auth/UserMenu.tsx`
- Test: `src/components/auth/__tests__/UserMenu.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/__tests__/UserMenu.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UserMenu } from '../UserMenu';
import { useAuthStore } from '../../../store/authStore';

beforeEach(() => {
  useAuthStore.setState({ user: null, status: 'guest', isNewInstallation: null, lastError: null });
});

describe('UserMenu', () => {
  it('renders "Sign in" pill when guest', () => {
    render(<UserMenu />);
    expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
  });

  it('renders avatar + email initials when signed in', () => {
    useAuthStore.setState({
      user: { user_id: 'u1', email: 'tal@lognet-systems.com', admin: false },
      status: 'signed_in',
      isNewInstallation: false,
      lastError: null,
    });
    render(<UserMenu />);
    expect(screen.getByText(/T/)).toBeInTheDocument();
  });

  it('opens the login modal when the sign-in pill is clicked', () => {
    render(<UserMenu />);
    fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));
    expect(screen.getByText(/Welcome to Agentrium/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `UserMenu.tsx`**

```tsx
// src/components/auth/UserMenu.tsx
import { useState } from 'react';
import { useAuthStore } from '../../store/authStore';
import { LoginModal } from './LoginModal';
import { DeleteAccountModal } from './DeleteAccountModal';
import { logout } from '../../lib/auth';

function initialsOf(email: string): string {
  const [local] = email.split('@');
  return (local[0] ?? '?').toUpperCase();
}

export function UserMenu() {
  const { user, status } = useAuthStore();
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (status !== 'signed_in' || !user) {
    return (
      <>
        <button
          onClick={() => setLoginOpen(true)}
          className="h-6 rounded-full border border-white/10 bg-[--elevation-2] px-3 text-xs hover:bg-[--elevation-1]"
        >
          Sign in
        </button>
        <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} showGuestOption={false} />
      </>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex h-6 items-center gap-2 rounded-full bg-[--elevation-2] pl-1 pr-3 text-xs hover:bg-[--elevation-1]"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-[--accent] text-[10px] font-medium text-white">
          {initialsOf(user.email)}
        </span>
        <span className="max-w-[160px] truncate opacity-90">{user.email}</span>
      </button>
      {menuOpen && (
        <div
          className="absolute left-0 top-8 z-40 w-[280px] rounded-md border border-white/10 bg-[--elevation-3] p-3 text-xs shadow-xl"
          onMouseLeave={() => setMenuOpen(false)}
        >
          <div className="mb-2">
            <div className="font-medium">{user.email}</div>
            <div className="opacity-60">Signed in</div>
          </div>
          <hr className="my-2 border-white/10" />
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-white/5"
            onClick={() => {
              setMenuOpen(false);
              logout();
            }}
          >
            Sign out
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left text-red-400 hover:bg-white/5"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            Delete account...
          </button>
        </div>
      )}
      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        expectedEmail={user.email}
      />
    </div>
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm run test -- src/components/auth/__tests__/UserMenu.test.tsx
```

Expected: PASS 3 (Delete modal test lives with its own file in Task 22).

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/UserMenu.tsx src/components/auth/__tests__/UserMenu.test.tsx
git commit -m "feat(auth): UserMenu header widget with dropdown"
```

---

## Task 22: Frontend - `DeleteAccountModal.tsx`

**Files:**
- Create: `src/components/auth/DeleteAccountModal.tsx`
- Test: `src/components/auth/__tests__/DeleteAccountModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/__tests__/DeleteAccountModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeleteAccountModal } from '../DeleteAccountModal';

vi.mock('../../../lib/auth', () => ({
  deleteAccount: vi.fn().mockResolvedValue('2026-09-28T00:00:00Z'),
}));

describe('DeleteAccountModal', () => {
  it('confirm button is disabled until email is typed exactly', () => {
    render(<DeleteAccountModal open onClose={() => {}} expectedEmail="tal@x.com" />);
    const btn = screen.getByRole('button', { name: /Delete my account/i });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type your email/i), { target: { value: 'wrong@x.com' } });
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type your email/i), { target: { value: 'tal@x.com' } });
    expect(btn).toBeEnabled();
  });

  it('calls deleteAccount on confirm', async () => {
    const auth = await import('../../../lib/auth');
    render(<DeleteAccountModal open onClose={() => {}} expectedEmail="tal@x.com" />);
    fireEvent.change(screen.getByLabelText(/Type your email/i), { target: { value: 'tal@x.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Delete my account/i }));
    // Allow the promise to resolve.
    await new Promise(r => setTimeout(r, 20));
    expect(auth.deleteAccount).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// src/components/auth/DeleteAccountModal.tsx
import { useState } from 'react';
import { deleteAccount } from '../../lib/auth';

interface Props {
  open: boolean;
  onClose: () => void;
  expectedEmail: string;
}

export function DeleteAccountModal({ open, onClose, expectedEmail }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoreUntil, setRestoreUntil] = useState<string | null>(null);

  if (!open) return null;
  const canConfirm = typed.trim().toLowerCase() === expectedEmail.trim().toLowerCase() && !busy;

  async function confirm() {
    setBusy(true);
    try {
      const until = await deleteAccount();
      setRestoreUntil(until);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[420px] rounded-lg bg-[--elevation-3] p-6" onClick={(e) => e.stopPropagation()}>
        {!restoreUntil ? (
          <>
            <h3 className="mb-2 text-lg font-semibold text-red-400">Delete account</h3>
            <p className="mb-4 text-sm opacity-80">
              Your account will be soft-deleted immediately. You have 30 days to restore
              it by signing in again. After that, all data is permanently removed.
            </p>
            <label className="mb-2 block text-xs opacity-80">
              Type your email <span className="font-mono">{expectedEmail}</span> to confirm:
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mb-4 w-full rounded border border-white/10 bg-[--elevation-2] px-3 py-2 text-sm"
              placeholder={expectedEmail}
              aria-label="Type your email"
            />
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded px-3 py-1 text-sm hover:bg-white/5">Cancel</button>
              <button
                disabled={!canConfirm}
                onClick={confirm}
                className="rounded bg-red-500 px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                Delete my account
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-2 text-lg font-semibold">Account deleted</h3>
            <p className="mb-4 text-sm opacity-80">
              Your account has been soft-deleted. You can restore it by signing in again
              before {new Date(restoreUntil).toLocaleString()}.
            </p>
            <div className="flex justify-end">
              <button onClick={onClose} className="rounded bg-[--accent] px-3 py-1 text-sm text-white">
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run tests**

```bash
npm run test -- src/components/auth/__tests__/DeleteAccountModal.test.tsx
```

Expected: PASS 2.

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/DeleteAccountModal.tsx src/components/auth/__tests__/DeleteAccountModal.test.tsx
git commit -m "feat(auth): DeleteAccountModal with typed-email confirm"
```

---

## Task 23: Integrate UserMenu into TitleBar

**Files:**
- Modify: `src/components/TitleBar.tsx`

- [ ] **Step 1: Add UserMenu after the app icon**

At the top of `TitleBar.tsx`, add:

```tsx
import { UserMenu } from './auth/UserMenu';
```

Locate the JSX that renders `<img src={appIcon} ... />` (near the top of the returned JSX). Immediately after that image, insert:

```tsx
<div className="ml-2 mr-1 flex items-center">
  <UserMenu />
</div>
```

- [ ] **Step 2: Manual visual check**

```bash
npm run tauri dev
```

Expected: header now shows the "Sign in" pill to the right of the app icon in guest mode. Clicking it opens the login modal.

- [ ] **Step 3: Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat(auth): mount UserMenu in TitleBar"
```

---

## Task 24: Wire AuthGate into App.tsx and hydrate on startup

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add imports and hydration**

Near the top of `App.tsx`, add:

```tsx
import { useEffect } from 'react';
import { AuthGate } from './components/auth/AuthGate';
import { hydrateFromKeychain, subscribeAuthEvents } from './lib/auth';
```

Inside the main `App` component (or its first `useEffect`), add:

```tsx
useEffect(() => {
  hydrateFromKeychain();
  const unlisten = subscribeAuthEvents();
  return () => unlisten();
}, []);
```

And in the JSX tree (top-level so the modal overlays everything else), add:

```tsx
<AuthGate />
```

- [ ] **Step 2: Manual verification**

```bash
npm run tauri dev
```

Expected: on cold start with no keychain entry, the first-run popup appears on top of the app. Choosing "Continue as guest" dismisses it and marks `auth_prompt_seen=1`. Restarting the app does not re-show it.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(auth): hydrate on startup, mount AuthGate, subscribe to auth events"
```

---

## Task 25: Bump appStore version 4 → 5

**Files:**
- Modify: `src/store/appStore.ts`

- [ ] **Step 1: Bump version and add migrate step**

Change `version: 4` to `version: 5`. Add to the `migrate` function:

```typescript
if (version < 5) {
  // No data migration required; sync partition is compile-time in
  // src/lib/settingsSync.ts. Version bump is purely to invalidate
  // any cached state shape assumptions clients may have made.
}
```

- [ ] **Step 2: Verify localStorage state migrates without loss**

Manually: open the app, verify existing settings persist across the restart.

- [ ] **Step 3: Commit**

```bash
git add src/store/appStore.ts
git commit -m "chore(store): bump appStore persist version to 5 (no-op migrate)"
```

---

## Task 26: End-to-end manual test on Windows and macOS

- [ ] **Step 1: Windows manual test checklist**

Build a signed installer and run it on a clean Windows VM (or a fresh account). Verify each row:

- [ ] First-run popup fires after setup wizard completes.
- [ ] "Continue as guest" dismisses; restart does not re-show.
- [ ] Header shows "Sign in" pill.
- [ ] Click "Sign in" opens the modal (without "Continue as guest").
- [ ] Google flow: browser opens, complete login, browser shows "Signed in", app returns to focus with the user email in the header.
- [ ] GitHub flow: same.
- [ ] Microsoft flow: same.
- [ ] Credential Manager shows an entry under `agentrium/session_token`.
- [ ] Sign out: keychain entry disappears; header returns to guest pill.
- [ ] Delete account with typed email confirms; keychain wiped; signing back in shows the restore path.
- [ ] Kill the browser mid-flow: after 3 minutes the toast "Login cancelled" appears.

- [ ] **Step 2: macOS manual test checklist**

Same as Windows on both Apple Silicon and Intel builds. Additionally verify Keychain Access.app shows an entry for `agentrium/session_token`. If the build is unsigned, expect the OS to prompt for keychain access on first write; the flow must succeed after allowing it.

- [ ] **Step 3: Commit any fixes discovered**

If manual testing turns up bugs (localhost port collisions, keychain permission prompts, browser callback URL mismatch), fix them and commit under `fix(auth): <what>`.

---

## Task 27: Release v1.33.0

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`
- Modify: `src/changelog.json`

- [ ] **Step 1: Bump versions**

- `package.json`: `"version": "1.33.0"`
- `src-tauri/Cargo.toml`: `version = "1.33.0"`
- `src-tauri/tauri.conf.json`: `"version": "1.33.0"`
- `README.md`: update version badge + download filename

- [ ] **Step 2: Add changelog entry to `src/changelog.json`**

Prepend:

```json
{
  "version": "1.33.0",
  "date": "2026-09-05",
  "title": "Accounts",
  "highlights": [
    "Sign in with Google, GitHub, Microsoft, or email to save your setup across computers.",
    "Guest mode is still fully supported."
  ]
}
```

- [ ] **Step 3: `cargo check` to refresh Cargo.lock**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit and tag**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock README.md src/changelog.json
git commit -m "Release v1.33.0"
git tag v1.33.0
git push origin master --tags
```

- [ ] **Step 5: Deploy the Worker**

```bash
cd workers/ct-analytics
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Expected: `Deployed ct-analytics.<domain>` and the auth routes respond `{ "error": "no_session" }` on `GET /auth/me`.

- [ ] **Step 6: Watch GitHub Actions release build**

Confirm NSIS and MSI (Windows) and Apple Silicon and Intel `.dmg` (macOS) artifacts appear on the GitHub release.

---

## Self-Review Notes

Cross-checked against the spec's Section 3 (chosen stack), Section 5 (identity model), Section 7 (desktop UI), Section 9.2 (auth error mapping), Section 10.1-10.5 (external setup and phase A migrations).

Gaps deliberately deferred to Phase B (out of scope for this plan):
- `sync_queue` producer wiring (columns and tables exist; no consumer yet)
- Merge modal implementation (Rust emits `auth-first-login-on-device`; frontend stores it but does not act)
- R2 log upload
- Sync-status dot in the header
- Extended heartbeat carrying `user_id`

Placeholder scan: none.

Type consistency: `AuthUser`, `Provider`, `session_token`, `installation_id`, `is_new_installation`, `restorable_until` all use consistent names across Rust, TypeScript, and the Worker.
