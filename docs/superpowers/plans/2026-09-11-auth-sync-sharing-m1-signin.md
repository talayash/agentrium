# M1: Sign In End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent spec:** [2026-09-11-auth-sync-sharing-design.md](../specs/2026-09-11-auth-sync-sharing-design.md)

**Milestone:** M1 (of 3). M2 covers sync + more providers. M3 covers sharing + telemetry attribution.

**Goal:** Ship end-to-end "Sign in with Google" for Agentrium: user clicks button in a first-launch popup, completes Google OAuth in the browser, returns to a Tauri window that shows their name and avatar in the header. Guest mode is fully supported. No sync yet, no other providers yet, no sharing yet.

**Architecture:** A new Next.js project `agentrium-api` deployed to Vercel hosts a custom OAuth broker endpoint that wraps Google via Auth.js v5, mints a JWT + opaque refresh token, and redirects to the desktop app via the `agentrium://` custom URL scheme. Neon Postgres (provisioned via Vercel Marketplace) stores users and refresh tokens. The Tauri client uses `tauri-plugin-deep-link` to receive the callback, PKCE + a state nonce to defend against interception, and the existing `credentials::SecretStore` (`keyring` crate) to persist the refresh token in the OS keychain.

**Tech Stack:**
- **Backend:** Next.js 15 (App Router), Auth.js v5, Drizzle ORM, Neon Postgres, Vercel Serverless Functions
- **Desktop Rust:** `tauri-plugin-deep-link`, `tauri-plugin-shell` (already present), `reqwest`, `sha2`, `base64`, `rand`, `serde_json`, `uuid`, `url`
- **Desktop TypeScript / React 18:** existing Zustand, existing `@tauri-apps/api/core`
- **Testing:** Vitest, Rust `#[cfg(test)]` unit tests, manual end-to-end for OAuth roundtrip.

**Prerequisites (external, do these before Task 1):**

- ✅ Google OAuth Web application client already created; redirect URIs include `http://localhost:3000/api/auth/callback/google` and `https://agentrium-api.vercel.app/api/auth/callback/google`. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are in your password manager.
- ✅ You are signed in to Vercel (`vercel login` or via the Vercel MCP session).
- ✅ You have a GitHub account and can create a new repo.

## File structure created / modified by this plan

**New repo `agentrium-api/` (create as a sibling to `agentrium/`, or your preferred location):**

```
agentrium-api/
├── package.json
├── tsconfig.json
├── next.config.js
├── .gitignore
├── .env.local.example
├── drizzle.config.ts
├── db/
│   └── schema.ts               # Drizzle schema for users, accounts, refresh_tokens
├── src/
│   ├── lib/
│   │   ├── auth.ts             # Auth.js configuration
│   │   ├── db.ts               # Drizzle client
│   │   ├── jwt.ts              # JWT sign/verify + refresh token helpers
│   │   └── pending.ts          # In-memory pending desktop-OAuth store
│   └── app/
│       ├── api/
│       │   ├── auth/
│       │   │   ├── [...nextauth]/route.ts    # Auth.js catch-all
│       │   │   ├── desktop/
│       │   │   │   ├── start/route.ts        # Desktop OAuth entry
│       │   │   │   └── finish/route.ts       # Desktop OAuth completion + redirect
│       │   │   └── refresh/route.ts          # Trade refresh_token for new JWT
│       │   └── me/route.ts                   # Return current user
│       ├── page.tsx            # Placeholder landing (says "Agentrium API")
│       └── layout.tsx          # Minimal root layout
```

**Modified in `agentrium/` (this repo):**

*Rust:*
- `src-tauri/Cargo.toml` — add deps
- `src-tauri/tauri.conf.json` — add deep-link scheme
- `src-tauri/capabilities/default.json` — grant deep-link permissions
- `src-tauri/src/main.rs` — register plugin, wire deep-link handler
- `src-tauri/src/database.rs` — add `user_meta` table migration
- `src-tauri/src/credentials.rs` — add helpers for refresh token storage
- `src-tauri/src/commands.rs` — register new IPC commands

*Rust (new):*
- `src-tauri/src/auth.rs` — OAuth flow orchestration, PKCE, state, deep-link handling

*TypeScript / React (new):*
- `src/lib/auth.ts` — client-side wrappers for auth IPC commands + event listeners
- `src/store/authStore.ts` — Zustand store for `user`, `mode`, in-memory access token
- `src/components/LoginModal.tsx` — first-launch popup (Google + Guest for M1)
- `src/components/HeaderAuth.tsx` — sign-in pill / user chip in header

*TypeScript / React (modified):*
- `src/App.tsx` — first-launch popup gating; wire `auth-changed` event listener
- `src/components/TitleBar.tsx` — insert `<HeaderAuth />` in left slot
- `src/changelog.json` — add entry for the M1 preview release

---

## Task 1: Scaffold the `agentrium-api` Next.js project

**Files:**
- Create: `agentrium-api/package.json`, `agentrium-api/tsconfig.json`, `agentrium-api/next.config.js`, `agentrium-api/.gitignore`, `agentrium-api/src/app/layout.tsx`, `agentrium-api/src/app/page.tsx`

Do NOT create this inside `agentrium/` — create it as a sibling directory. Confirm with the user which parent directory before running.

- [ ] **Step 1: Create the project via the Next.js scaffolder**

Run in the parent directory that will hold `agentrium-api/`:

```bash
npx create-next-app@15 agentrium-api --typescript --app --no-tailwind --no-eslint --src-dir --import-alias "@/*" --turbopack
```

Answer any leftover prompts with defaults. Result: `agentrium-api/` directory with a starter Next.js 15 App Router project.

- [ ] **Step 2: Replace `src/app/page.tsx` with a placeholder**

Overwrite `agentrium-api/src/app/page.tsx`:

```tsx
export default function Page() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Agentrium API</h1>
      <p>This service handles authentication for the Agentrium desktop app. There is nothing to see here.</p>
    </main>
  );
}
```

- [ ] **Step 3: Verify local dev server boots**

```bash
cd agentrium-api
npm run dev
```

Open `http://localhost:3000` in a browser. Expected: "Agentrium API" heading renders. Kill the server (`Ctrl+C`).

- [ ] **Step 4: Initialize git**

```bash
cd agentrium-api
git init
git add .
git commit -m "chore: scaffold agentrium-api Next.js project"
```

---

## Task 2: Configure environment variable template

**Files:**
- Create: `agentrium-api/.env.local.example`

- [ ] **Step 1: Create the example env file**

Write `agentrium-api/.env.local.example`:

```bash
# Google OAuth (from Google Cloud Console)
GOOGLE_CLIENT_ID=paste-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-paste-here

# Auth.js secret (generate with: openssl rand -base64 32)
AUTH_SECRET=paste-32-random-bytes-base64

# Public URL of this deployment (no trailing slash)
AUTH_URL=http://localhost:3000

# Neon Postgres connection string (set automatically by Vercel Marketplace integration)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Allowed desktop callback schemes (comma-separated, no spaces)
DESKTOP_CALLBACK_ALLOWLIST=agentrium://auth-return
```

- [ ] **Step 2: Copy to `.env.local` for local dev**

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` and paste the real values from your password manager for `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Generate a fresh `AUTH_SECRET`:

```bash
openssl rand -base64 32
```

Paste the output as `AUTH_SECRET`. Leave `DATABASE_URL` as the placeholder for now — we set it after Neon is provisioned (Task 5).

- [ ] **Step 3: Verify `.env.local` is git-ignored**

```bash
cat .gitignore | grep -q "^.env" && echo "OK: .env is ignored" || echo "MISSING: .env not ignored"
```

Expected: `OK: .env is ignored` (Next.js's scaffolder includes this by default). If missing, add these lines to `.gitignore`:

```
.env
.env.local
.env*.local
```

- [ ] **Step 4: Commit**

```bash
git add .env.local.example .gitignore
git commit -m "chore: add env template"
```

---

## Task 3: Push to a new GitHub repo

- [ ] **Step 1: Create a private GitHub repo**

Use the GitHub MCP or manually via https://github.com/new. Repo name: `agentrium-api`. Visibility: **Private** (contains OAuth callback URLs and DB config even in code; keep private for at least M1).

- [ ] **Step 2: Add the remote and push**

Replace `<your-github-username>` below:

```bash
cd agentrium-api
git remote add origin https://github.com/<your-github-username>/agentrium-api.git
git branch -M main
git push -u origin main
```

Expected: initial commit + Task 2 commit visible on GitHub.

---

## Task 4: Deploy the scaffold to Vercel

- [ ] **Step 1: Deploy via Vercel MCP**

Use the Vercel MCP tool `deploy_to_vercel`. Point it at the local `agentrium-api/` directory or link it to the GitHub repo you just created (either works — GitHub link gives you preview deploys per push).

- [ ] **Step 2: Confirm the production URL**

After the first deploy, capture the assigned URL. It should be `https://agentrium-api.vercel.app`. If Vercel picked a different subdomain (e.g., `agentrium-api-<hash>.vercel.app` because the name is taken), STOP and tell the user — the Google OAuth redirect URIs already registered depend on this exact hostname.

- [ ] **Step 3: Visit the production URL in a browser**

Expected: the "Agentrium API" page from Task 1 renders. If Vercel shows an error page, check the deployment logs via the Vercel MCP `get_deployment_build_logs` tool before continuing.

---

## Task 5: Provision Neon Postgres via Vercel Marketplace

- [ ] **Step 1: Install Neon integration**

Use the Vercel MCP `buy_addon` tool (Neon has a free tier that requires no payment) or manually: dashboard.vercel.com → your team → Integrations → Neon → Install → link to `agentrium-api` project.

- [ ] **Step 2: Confirm env vars are injected**

Vercel auto-sets `DATABASE_URL` on the `agentrium-api` project. Verify via the Vercel MCP or dashboard: Settings → Environment Variables → look for `DATABASE_URL` (should have Development, Preview, and Production scopes checked).

- [ ] **Step 3: Pull env vars locally**

```bash
cd agentrium-api
npx vercel env pull .env.local
```

This overwrites your local `.env.local` with the Vercel values. Re-paste the `AUTH_SECRET` and `DESKTOP_CALLBACK_ALLOWLIST` values if they got wiped (Vercel doesn't have them yet).

- [ ] **Step 4: Set the remaining env vars on Vercel**

Use the Vercel MCP or dashboard. Add these to all environments (Development, Preview, Production):

```
GOOGLE_CLIENT_ID=<from password manager>
GOOGLE_CLIENT_SECRET=<from password manager>
AUTH_SECRET=<the openssl rand output from Task 2>
AUTH_URL=https://agentrium-api.vercel.app
DESKTOP_CALLBACK_ALLOWLIST=agentrium://auth-return
```

**Verify:** re-run `npx vercel env pull .env.local`, open `.env.local`, all keys should be populated.

---

## Task 6: Install backend dependencies

- [ ] **Step 1: Install Auth.js v5 + Drizzle + Postgres driver + JWT + Zod**

```bash
cd agentrium-api
npm install next-auth@beta @auth/drizzle-adapter drizzle-orm postgres jose zod
npm install -D drizzle-kit @types/node
```

Note: `next-auth@beta` is Auth.js v5. Auth.js v5 requires Node 18+ (Vercel is on 20). `jose` provides JWT sign/verify. `zod` for request body validation.

- [ ] **Step 2: Verify no install errors**

Check the output. Expected: "added N packages" with no `ERR!` or unresolved-peer warnings other than optional ones. If there are real errors, resolve before continuing.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install auth stack (next-auth v5, drizzle, jose, zod)"
```

---

## Task 7: Define the Drizzle schema

**Files:**
- Create: `agentrium-api/db/schema.ts`
- Create: `agentrium-api/drizzle.config.ts`

- [ ] **Step 1: Write the schema**

Create `agentrium-api/db/schema.ts`:

```typescript
import { pgTable, text, timestamp, uuid, integer, jsonb, primaryKey } from 'drizzle-orm/pg-core';

// Auth.js core tables (must match adapter expectations exactly)
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name'),
  email: text('email').unique().notNull(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.provider, t.providerAccountId] }) })
);

export const sessions = pgTable('sessions', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: uuid('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.identifier, t.token] }) })
);

// Desktop-specific: refresh tokens issued to the Tauri client.
// Raw token lives in the OS keychain; only the SHA-256 hash is stored here.
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { mode: 'date' }),
  clientInfo: jsonb('client_info'), // { app_version, os, installation_id? }
});
```

- [ ] **Step 2: Configure Drizzle Kit**

Create `agentrium-api/drizzle.config.ts`:

```typescript
import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
```

- [ ] **Step 3: Generate the first migration**

```bash
cd agentrium-api
npx drizzle-kit generate --name init
```

Expected: a new file appears at `db/migrations/0000_init.sql` containing `CREATE TABLE` statements for all 5 tables.

- [ ] **Step 4: Apply the migration to Neon**

```bash
npx drizzle-kit migrate
```

Expected: "Applying migration 0000_init". If it fails with a connection error, verify `DATABASE_URL` in `.env.local` matches the Neon connection string in Vercel's env vars.

- [ ] **Step 5: Commit**

```bash
git add db/ drizzle.config.ts package.json
git commit -m "feat(db): drizzle schema + initial migration for auth tables"
```

---

## Task 8: Wire the Drizzle client

**Files:**
- Create: `agentrium-api/src/lib/db.ts`

- [ ] **Step 1: Create the client**

Write `agentrium-api/src/lib/db.ts`:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../db/schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Vercel Serverless Functions: use a pooled connection.
// Local dev: same code path works.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export * from '../../db/schema';
```

- [ ] **Step 2: Smoke-test the client**

Create a temporary file `agentrium-api/scripts/db-smoke.ts`:

```typescript
import { db, users } from '../src/lib/db';

async function main() {
  const result = await db.select().from(users).limit(1);
  console.log('users query returned', result.length, 'rows');
  process.exit(0);
}

main().catch((e) => {
  console.error('DB smoke failed:', e);
  process.exit(1);
});
```

Run:

```bash
npx tsx scripts/db-smoke.ts
```

Expected: `users query returned 0 rows`. If it errors, fix before proceeding. Delete the script after verifying:

```bash
rm scripts/db-smoke.ts
rmdir scripts
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(db): drizzle client wired to DATABASE_URL"
```

---

## Task 9: Auth.js configuration (browser flow, cookie-based)

This task sets up Auth.js's standard flow. It's used by the desktop broker (Task 11) as a sub-flow. Standalone, it also gives us a working browser sign-in for smoke testing.

**Files:**
- Create: `agentrium-api/src/lib/auth.ts`
- Create: `agentrium-api/src/app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Write the Auth.js config**

Create `agentrium-api/src/lib/auth.ts`:

```typescript
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from './db';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: { strategy: 'jwt' },
  secret: process.env.AUTH_SECRET,
  trustHost: true, // required for Vercel preview URLs
});
```

- [ ] **Step 2: Wire the catch-all route**

Create `agentrium-api/src/app/api/auth/[...nextauth]/route.ts`:

```typescript
import { handlers } from '@/lib/auth';
export const { GET, POST } = handlers;
```

- [ ] **Step 3: Smoke test — browser sign-in**

Start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000/api/auth/signin` in a browser. Expected: Auth.js's default sign-in page with a "Sign in with Google" button. Click it → complete Google OAuth → land on `/` with a session cookie set.

- [ ] **Step 4: Kill the dev server and commit**

```bash
git add src/lib/auth.ts src/app/api/auth/
git commit -m "feat(auth): auth.js v5 config with google provider + drizzle adapter"
```

---

## Task 10: JWT + refresh-token helpers

**Files:**
- Create: `agentrium-api/src/lib/jwt.ts`
- Create: `agentrium-api/src/lib/pending.ts`
- Create: `agentrium-api/src/lib/jwt.test.ts`

- [ ] **Step 1: Write the JWT helper module**

Create `agentrium-api/src/lib/jwt.ts`:

```typescript
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'crypto';

const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);

export type DesktopJWT = {
  sub: string;    // user id
  email: string;
  name?: string;
  image?: string;
};

const ACCESS_TOKEN_TTL_SEC = 15 * 60;         // 15 min
const REFRESH_TOKEN_TTL_DAYS = 30;

export async function signAccessToken(payload: DesktopJWT): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .setSubject(payload.sub)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<DesktopJWT> {
  const { payload } = await jwtVerify(token, secret);
  return {
    sub: payload.sub!,
    email: payload.email as string,
    name: payload.name as string | undefined,
    image: payload.image as string | undefined,
  };
}

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex'); // 64-char hex
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function refreshTokenExpiryDate(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 2: Write the pending-desktop-flow store**

Create `agentrium-api/src/lib/pending.ts`:

```typescript
// In-memory store for pending desktop OAuth flows.
// Serverless caveat: Vercel Functions can be spawned in parallel across regions,
// so a flow started on instance A may not be visible on instance B. Acceptable
// for M1 because the same request typically continues on the same warm instance.
// Post-M1 hardening: move to Vercel KV or Neon (short-TTL row).

type Pending = {
  desktopState: string;
  callback: string;      // e.g. "agentrium://auth-return"
  codeChallenge: string; // PKCE challenge (S256 of desktop's verifier)
  createdAt: number;
};

const store = new Map<string, Pending>();

const TTL_MS = 3 * 60 * 1000; // 3 min

function gc() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now - v.createdAt > TTL_MS) store.delete(k);
  }
}

export function putPending(brokerState: string, entry: Pending): void {
  gc();
  store.set(brokerState, entry);
}

export function takePending(brokerState: string): Pending | null {
  gc();
  const entry = store.get(brokerState);
  if (!entry) return null;
  store.delete(brokerState); // one-time use
  return entry;
}
```

- [ ] **Step 3: Write unit tests for JWT helpers**

Create `agentrium-api/src/lib/jwt.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken } from './jwt';

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret-must-be-at-least-32-chars-long!!';
});

describe('JWT helpers', () => {
  it('signs and verifies a token round-trip', async () => {
    const token = await signAccessToken({ sub: 'user-1', email: 'a@b.com', name: 'A' });
    const payload = await verifyAccessToken(token);
    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('a@b.com');
    expect(payload.name).toBe('A');
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken({ sub: 'user-1', email: 'a@b.com' });
    const bad = token.slice(0, -5) + 'XXXXX';
    await expect(verifyAccessToken(bad)).rejects.toThrow();
  });
});

describe('refresh token', () => {
  it('generates raw + hash, hash is deterministic', () => {
    const { raw, hash } = generateRefreshToken();
    expect(raw).toHaveLength(64);
    expect(hash).toHaveLength(64);
    expect(hashRefreshToken(raw)).toBe(hash);
  });

  it('generates different tokens each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.raw).not.toBe(b.raw);
  });
});
```

- [ ] **Step 4: Install Vitest**

```bash
cd agentrium-api
npm install -D vitest
```

Add to `package.json` scripts:

```json
"test": "vitest",
"test:run": "vitest run"
```

- [ ] **Step 5: Run the tests**

```bash
npm run test:run
```

Expected: 4 passing tests. If any fail, fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jwt.ts src/lib/pending.ts src/lib/jwt.test.ts package.json package-lock.json
git commit -m "feat(auth): jwt helpers + pending desktop flow store + tests"
```

---

## Task 11: Desktop OAuth broker — `/api/auth/desktop/start`

This is the entry point for the Tauri client. It stores the desktop's state + PKCE challenge, then kicks off a normal Auth.js Google sign-in.

**Files:**
- Create: `agentrium-api/src/app/api/auth/desktop/start/route.ts`
- Create: `agentrium-api/src/app/api/auth/desktop/start/route.test.ts`

- [ ] **Step 1: Write the route**

Create `agentrium-api/src/app/api/auth/desktop/start/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { putPending } from '@/lib/pending';

const querySchema = z.object({
  provider: z.enum(['google']),                  // GitHub, email/pass added in M2
  state: z.string().min(16).max(256),
  callback: z.string().startsWith('agentrium://'),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
  }
  const { provider, state, callback, code_challenge } = parsed.data;

  const allowlist = (process.env.DESKTOP_CALLBACK_ALLOWLIST ?? '').split(',').map(s => s.trim());
  if (!allowlist.includes(callback)) {
    return NextResponse.json({ error: 'callback_not_allowed' }, { status: 400 });
  }

  // Generate our own broker-side state and store the desktop's context.
  const brokerState = randomBytes(24).toString('hex');
  putPending(brokerState, {
    desktopState: state,
    callback,
    codeChallenge: code_challenge,
    createdAt: Date.now(),
  });

  // Redirect the user's browser to Auth.js's Google sign-in, telling it to
  // return to our desktop-finish endpoint with the broker state as callbackUrl.
  const finishUrl = new URL('/api/auth/desktop/finish', process.env.AUTH_URL);
  finishUrl.searchParams.set('broker_state', brokerState);

  const signInUrl = new URL('/api/auth/signin/google', process.env.AUTH_URL);
  signInUrl.searchParams.set('callbackUrl', finishUrl.toString());

  return NextResponse.redirect(signInUrl);
}
```

- [ ] **Step 2: Write a unit test for query validation**

Create `agentrium-api/src/app/api/auth/desktop/start/route.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { GET } from './route';
import { NextRequest } from 'next/server';

beforeAll(() => {
  process.env.AUTH_URL = 'http://localhost:3000';
  process.env.DESKTOP_CALLBACK_ALLOWLIST = 'agentrium://auth-return';
});

function makeReq(qs: Record<string, string>): NextRequest {
  const u = new URL('http://localhost:3000/api/auth/desktop/start');
  for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  return new NextRequest(u);
}

describe('/api/auth/desktop/start', () => {
  it('400s when required params are missing', async () => {
    const res = await GET(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('400s on a callback not in the allowlist', async () => {
    const res = await GET(makeReq({
      provider: 'google',
      state: 'x'.repeat(32),
      callback: 'evil://haha',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    }));
    expect(res.status).toBe(400);
  });

  it('redirects to /api/auth/signin/google when valid', async () => {
    const res = await GET(makeReq({
      provider: 'google',
      state: 'x'.repeat(32),
      callback: 'agentrium://auth-return',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/api/auth/signin/google');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm run test:run
```

Expected: previous tests still pass + 3 new tests pass (total 7).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/auth/desktop/start/
git commit -m "feat(auth): desktop OAuth broker entry point + tests"
```

---

## Task 12: Desktop OAuth broker — `/api/auth/desktop/finish`

This runs after the user completes Auth.js's Google flow. It reads the current Auth.js session, mints a desktop JWT + refresh token, persists the refresh token, and redirects the browser to `agentrium://auth-return?token=...&refresh=...&state=...`.

**Files:**
- Create: `agentrium-api/src/app/api/auth/desktop/finish/route.ts`

- [ ] **Step 1: Write the route**

Create `agentrium-api/src/app/api/auth/desktop/finish/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db, refreshTokens } from '@/lib/db';
import { takePending } from '@/lib/pending';
import { signAccessToken, generateRefreshToken, refreshTokenExpiryDate } from '@/lib/jwt';

export async function GET(req: NextRequest) {
  const brokerState = req.nextUrl.searchParams.get('broker_state');
  if (!brokerState) {
    return renderFailure('missing_broker_state');
  }

  const pending = takePending(brokerState);
  if (!pending) {
    return renderFailure('unknown_or_expired_broker_state');
  }

  const session = await auth();
  if (!session?.user?.id) {
    return renderFailure('no_session_after_signin');
  }

  const user = session.user;

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email!,
    name: user.name ?? undefined,
    image: user.image ?? undefined,
  });

  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshHash,
    expiresAt: refreshTokenExpiryDate(),
  });

  const returnUrl = new URL(pending.callback);
  returnUrl.searchParams.set('token', accessToken);
  returnUrl.searchParams.set('refresh', refreshRaw);
  returnUrl.searchParams.set('state', pending.desktopState);

  // Render an HTML page that redirects to the custom scheme.
  // Direct 302 to agentrium:// works in most browsers but a short HTML page
  // handles cases where the browser blocks non-http schemes silently.
  return new NextResponse(
    `<!doctype html>
<html>
  <head><title>Signing in to Agentrium…</title></head>
  <body style="font-family: system-ui; padding: 2rem;">
    <h1>Signed in successfully</h1>
    <p>Returning to Agentrium…</p>
    <p>If nothing happens, <a href="${escapeHtml(returnUrl.toString())}">click here</a>.</p>
    <script>window.location.href = ${JSON.stringify(returnUrl.toString())};</script>
  </body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function renderFailure(reason: string): NextResponse {
  return new NextResponse(
    `<!doctype html>
<html>
  <head><title>Sign-in failed</title></head>
  <body style="font-family: system-ui; padding: 2rem;">
    <h1>Sign-in failed</h1>
    <p>Reason: <code>${escapeHtml(reason)}</code></p>
    <p>Please close this window and try again from Agentrium.</p>
  </body>
</html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}
```

- [ ] **Step 2: Deploy to Vercel + smoke-test the full browser flow**

Push to git and let Vercel auto-deploy:

```bash
git add src/app/api/auth/desktop/finish/
git commit -m "feat(auth): desktop OAuth broker finish endpoint"
git push
```

Wait for deploy to finish (check via Vercel MCP `get_deployment` or dashboard).

Manually test in a browser:

```
https://agentrium-api.vercel.app/api/auth/desktop/start?provider=google&state=teststate32characterslongxxxxx&callback=agentrium%3A%2F%2Fauth-return&code_challenge=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&code_challenge_method=S256
```

Expected sequence:
1. Redirected to Google sign-in.
2. After completing Google → redirected to `/api/auth/desktop/finish?broker_state=...`.
3. HTML page appears: "Signed in successfully — Returning to Agentrium…"
4. Browser attempts to navigate to `agentrium://auth-return?token=...&refresh=...&state=teststate...`. Since Agentrium isn't handling the scheme yet, the browser will likely show a "protocol not registered" or "open with?" dialog. **This is expected and correct.**

---

## Task 13: `/api/me` and `/api/auth/refresh` endpoints

**Files:**
- Create: `agentrium-api/src/app/api/me/route.ts`
- Create: `agentrium-api/src/app/api/auth/refresh/route.ts`

- [ ] **Step 1: `/api/me` — used by desktop client to validate token + hydrate user info**

Create `agentrium-api/src/app/api/me/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '@/lib/jwt';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (!match) {
    return NextResponse.json({ error: 'missing_bearer' }, { status: 401 });
  }

  try {
    const payload = await verifyAccessToken(match[1]);
    return NextResponse.json({
      user: {
        id: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        image: payload.image ?? null,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
}
```

- [ ] **Step 2: `/api/auth/refresh` — trade a refresh token for a new access token**

Create `agentrium-api/src/app/api/auth/refresh/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db, users, refreshTokens } from '@/lib/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { hashRefreshToken, generateRefreshToken, signAccessToken, refreshTokenExpiryDate } from '@/lib/jwt';

const bodySchema = z.object({
  refresh_token: z.string().length(64),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const hash = hashRefreshToken(parsed.data.refresh_token);

  const rows = await db
    .select({ rt: refreshTokens, user: users })
    .from(refreshTokens)
    .innerJoin(users, eq(users.id, refreshTokens.userId))
    .where(
      and(
        eq(refreshTokens.tokenHash, hash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: 'invalid_refresh_token' }, { status: 401 });
  }

  // Rotate: revoke old, mint new.
  const now = new Date();
  await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.id, row.rt.id));

  const { raw: newRaw, hash: newHash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: row.user.id,
    tokenHash: newHash,
    expiresAt: refreshTokenExpiryDate(),
  });

  const newAccess = await signAccessToken({
    sub: row.user.id,
    email: row.user.email,
    name: row.user.name ?? undefined,
    image: row.user.image ?? undefined,
  });

  return NextResponse.json({ access_token: newAccess, refresh_token: newRaw });
}
```

- [ ] **Step 3: Deploy and smoke-test `/api/me`**

Push, wait for deploy.

Test with `curl` using a token from the full flow — repeat the Task 12 browser flow, when you land on the redirect HTML page, inspect the target URL to grab the `token=...` value. Then:

```bash
curl -H "Authorization: Bearer PASTE_TOKEN_HERE" https://agentrium-api.vercel.app/api/me
```

Expected: JSON with your user info.

Test 401:

```bash
curl -H "Authorization: Bearer garbage" https://agentrium-api.vercel.app/api/me
```

Expected: `{"error":"invalid_token"}` with 401.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/me src/app/api/auth/refresh
git commit -m "feat(auth): /api/me and /api/auth/refresh endpoints"
git push
```

---

## Task 14: Add `tauri-plugin-deep-link` to Agentrium

**Files** (in `agentrium/` repo — switch context back):
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add Rust deps**

Edit `src-tauri/Cargo.toml`. Under `[dependencies]`, add:

```toml
tauri-plugin-deep-link = "2"
sha2 = "0.10"
base64 = "0.22"
rand = "0.8"
url = "2"
urlencoding = "2"
reqwest = { version = "0.12", features = ["json"] }
```

If any are already present, skip that line. Run:

```bash
cd src-tauri
cargo check
```

Expected: compiles, `Cargo.lock` updated.

- [ ] **Step 2: Register the deep-link scheme in `tauri.conf.json`**

Edit `src-tauri/tauri.conf.json`. Find the `bundle` section, add (or merge):

```json
"bundle": {
  "deepLink": {
    "schemes": ["agentrium"]
  }
}
```

Find the top-level `plugins` section (or create one if missing):

```json
"plugins": {
  "deep-link": {
    "desktop": {
      "schemes": ["agentrium"]
    }
  }
}
```

- [ ] **Step 3: Grant deep-link capabilities**

Edit `src-tauri/capabilities/default.json`. Find the `permissions` array, add:

```json
"deep-link:default",
"deep-link:allow-get-current"
```

- [ ] **Step 4: Sanity build**

```bash
cd src-tauri
cargo check
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(auth): add tauri-plugin-deep-link and register agentrium:// scheme"
```

---

## Task 15: Register the deep-link plugin and wire the callback in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the plugin registration**

Find the `.plugin(...)` chain inside `tauri::Builder::default()` in `src-tauri/src/main.rs`. Add:

```rust
.plugin(tauri_plugin_deep_link::init())
```

Add near the top of the setup callback (inside `.setup(|app| { ... })`):

```rust
use tauri_plugin_deep_link::DeepLinkExt;
let handle = app.handle().clone();
app.deep_link().on_open_url(move |event| {
    for url in event.urls() {
        // Route to auth.rs handler once implemented in Task 20.
        // For now, log to prove the wiring works.
        println!("[deep-link] received: {}", url);
    }
});
```

- [ ] **Step 2: Register the scheme on the current OS (dev-time)**

Deep links only work on Windows if the scheme is registered in the registry. Tauri's installer does this at install time, but for `npm run tauri dev` you must register manually. Add this inside `.setup()` too:

```rust
#[cfg(desktop)]
{
    use tauri_plugin_deep_link::DeepLinkExt;
    // register() is idempotent; safe to call every launch during dev.
    let _ = app.deep_link().register("agentrium");
}
```

- [ ] **Step 3: Rebuild and manually fire a deep link**

```bash
npm run tauri dev
```

Wait for the app to boot. Then, in a separate terminal:

**Windows:**
```powershell
Start-Process "agentrium://test?hello=world"
```

**macOS:**
```bash
open "agentrium://test?hello=world"
```

Expected: the Agentrium terminal running `npm run tauri dev` prints something like:
```
[deep-link] received: agentrium://test?hello=world
```

If nothing prints, the scheme isn't registered. Check the Windows registry (`reg query HKEY_CLASSES_ROOT\agentrium`) or macOS `Info.plist` (`CFBundleURLTypes`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(auth): register agentrium:// deep-link scheme and log callbacks"
```

---

## Task 16: Create `auth.rs` module scaffold with `PendingMap`

**Files:**
- Create: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/main.rs` (add `mod auth;`)

- [ ] **Step 1: Create the module with types + pending-map**

Create `src-tauri/src/auth.rs`:

```rust
//! OAuth flow orchestration for Agentrium desktop.
//!
//! Flow (see docs/superpowers/specs/2026-09-11-auth-sync-sharing-design.md §6.1):
//! 1. Frontend invokes `start_oauth_login`.
//! 2. We generate state + PKCE verifier/challenge, store in `PendingMap`.
//! 3. Open browser to https://agentrium-api.vercel.app/api/auth/desktop/start?...
//! 4. Backend redirects through Google, then to agentrium://auth-return?token=...&state=...
//! 5. Deep-link handler validates state, stores refresh token in keychain, emits auth-changed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PENDING_TTL: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, Clone)]
pub struct PendingFlow {
    pub state: String,
    pub code_verifier: String,
    pub created_at: Instant,
}

#[derive(Default, Debug)]
pub struct PendingMap {
    inner: Mutex<HashMap<String, PendingFlow>>,
}

impl PendingMap {
    pub fn insert(&self, flow: PendingFlow) {
        self.gc();
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        guard.insert(flow.state.clone(), flow);
    }

    pub fn take(&self, state: &str) -> Option<PendingFlow> {
        self.gc();
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        guard.remove(state)
    }

    fn gc(&self) {
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        let now = Instant::now();
        guard.retain(|_, v| now.duration_since(v.created_at) < PENDING_TTL);
    }
}

/// Generate a random 32-byte state, base64url-encoded (no padding).
pub fn generate_state() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Generate a PKCE verifier (43-128 chars base64url) and derive the challenge.
pub fn generate_pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = URL_SAFE_NO_PAD.encode(buf); // 43 chars
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub image: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_43_chars_and_unique() {
        let a = generate_state();
        let b = generate_state();
        assert_eq!(a.len(), 43); // 32 bytes -> 43 base64url no-pad chars
        assert_ne!(a, b);
    }

    #[test]
    fn pkce_challenge_matches_sha256_of_verifier() {
        let (verifier, challenge) = generate_pkce();
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge, expected);
    }

    #[test]
    fn pending_map_take_removes_entry() {
        let map = PendingMap::default();
        let state = "abc".to_string();
        map.insert(PendingFlow {
            state: state.clone(),
            code_verifier: "v".into(),
            created_at: Instant::now(),
        });
        assert!(map.take(&state).is_some());
        assert!(map.take(&state).is_none());
    }

    #[test]
    fn pending_map_gcs_expired() {
        let map = PendingMap::default();
        map.insert(PendingFlow {
            state: "old".into(),
            code_verifier: "v".into(),
            created_at: Instant::now() - Duration::from_secs(300),
        });
        assert!(map.take("old").is_none());
    }
}
```

- [ ] **Step 2: Declare the module in `main.rs`**

Add near the top of `src-tauri/src/main.rs`, alongside the other `mod X;` declarations:

```rust
mod auth;
```

- [ ] **Step 3: Run the Rust tests**

```bash
cd src-tauri
cargo test auth::tests
```

Expected: 4 passing tests.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "feat(auth): auth.rs skeleton with PendingMap, PKCE, state generation + tests"
```

---

## Task 17: Extend `credentials.rs` for auth token storage

**Files:**
- Modify: `src-tauri/src/credentials.rs`

`credentials.rs` currently uses the `keyring` crate to store API keys. We add three helpers for the auth refresh token using the same crate.

- [ ] **Step 1: Read current `credentials.rs` for its patterns**

Open `src-tauri/src/credentials.rs`. Note the service name convention already in use (probably `"agentrium"` or `"claudeterminal"`). Match whatever's there.

- [ ] **Step 2: Add the helpers**

Append to `src-tauri/src/credentials.rs`:

```rust
// ---- Auth refresh token storage ---------------------------------------------

const AUTH_SERVICE: &str = "agentrium.auth";
const REFRESH_TOKEN_KEY: &str = "refresh_token";

pub fn store_refresh_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(AUTH_SERVICE, REFRESH_TOKEN_KEY)
        .map_err(|e| format!("keyring entry: {e}"))?;
    entry.set_password(token).map_err(|e| format!("keyring set: {e}"))
}

pub fn read_refresh_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(AUTH_SERVICE, REFRESH_TOKEN_KEY)
        .map_err(|e| format!("keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get: {e}")),
    }
}

pub fn clear_refresh_token() -> Result<(), String> {
    let entry = keyring::Entry::new(AUTH_SERVICE, REFRESH_TOKEN_KEY)
        .map_err(|e| format!("keyring entry: {e}"))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}

#[cfg(test)]
mod auth_token_tests {
    use super::*;

    #[test]
    #[ignore] // Requires a real OS keychain; run manually with `cargo test -- --ignored`.
    fn round_trip_refresh_token() {
        let value = "test-value-12345";
        store_refresh_token(value).unwrap();
        assert_eq!(read_refresh_token().unwrap().as_deref(), Some(value));
        clear_refresh_token().unwrap();
        assert!(read_refresh_token().unwrap().is_none());
    }
}
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri
cargo check
```

Expected: no errors.

- [ ] **Step 4: Run the ignored keychain test manually**

```bash
cargo test credentials::auth_token_tests -- --ignored
```

Expected: passes. On Windows, verify the credential appears in Credential Manager (Control Panel → Credential Manager → Windows Credentials → `agentrium.auth`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/credentials.rs
git commit -m "feat(auth): keychain helpers for refresh token storage"
```

---

## Task 18: Add `user_meta` SQLite table to `database.rs`

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Find `init_schema` in `database.rs`**

Open `src-tauri/src/database.rs` and locate the `init_schema` function. Note the pattern — it's a series of `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` calls with error-swallowing for the "duplicate column" case.

- [ ] **Step 2: Add the `user_meta` table**

Inside `init_schema`, after the existing `CREATE TABLE` calls, add:

```rust
conn.execute(
    "CREATE TABLE IF NOT EXISTS user_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    )",
    [],
)?;
```

- [ ] **Step 3: Add typed accessor helpers**

Append to `database.rs` (inside the `impl Database` block):

```rust
pub fn get_user_meta(&self, key: &str) -> Result<Option<String>, String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM user_meta WHERE key = ?1",
        [key],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
    .map(|opt| opt.flatten())
}

pub fn set_user_meta(&self, key: &str, value: Option<&str>) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO user_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_user_meta(&self, key: &str) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM user_meta WHERE key = ?1", [key])
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

If `use rusqlite::OptionalExtension;` isn't already imported at the top of the file, add it.

- [ ] **Step 4: Add a unit test**

In the existing `#[cfg(test)]` module in `database.rs`, add:

```rust
#[test]
fn user_meta_round_trip() {
    let db = Database::new_in_memory().unwrap();
    db.set_user_meta("auth_prompt_seen", Some("1")).unwrap();
    assert_eq!(db.get_user_meta("auth_prompt_seen").unwrap().as_deref(), Some("1"));
    db.delete_user_meta("auth_prompt_seen").unwrap();
    assert!(db.get_user_meta("auth_prompt_seen").unwrap().is_none());
}
```

If `Database::new_in_memory` doesn't exist yet, add a `#[cfg(test)]` constructor that opens `":memory:"`.

- [ ] **Step 5: Run tests**

```bash
cd src-tauri
cargo test database::tests::user_meta_round_trip
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(auth): user_meta table + get/set/delete helpers"
```

---

## Task 19: Implement `start_oauth_login` IPC command

**Files:**
- Modify: `src-tauri/src/auth.rs` (append IPC command)
- Modify: `src-tauri/src/main.rs` (register app state + command)

- [ ] **Step 1: Add app state for `PendingMap`**

In `src-tauri/src/main.rs`, add to the `.manage(...)` calls in the setup:

```rust
.manage(std::sync::Arc::new(auth::PendingMap::default()))
```

- [ ] **Step 2: Implement the command**

Append to `src-tauri/src/auth.rs`:

```rust
use std::sync::Arc;
use tauri::{command, State};
use tauri_plugin_shell::ShellExt;

const API_BASE: &str = "https://agentrium-api.vercel.app";
const CALLBACK_URL: &str = "agentrium://auth-return";

#[derive(Debug, Serialize)]
pub struct StartOAuthLoginResult {
    pub opened_url: String,
}

#[command]
pub async fn start_oauth_login(
    provider: String,
    app_handle: tauri::AppHandle,
    pending: State<'_, Arc<PendingMap>>,
) -> Result<StartOAuthLoginResult, String> {
    if provider != "google" {
        return Err(format!("provider not supported in M1: {provider}"));
    }

    let state = generate_state();
    let (verifier, challenge) = generate_pkce();

    pending.insert(PendingFlow {
        state: state.clone(),
        code_verifier: verifier,
        created_at: Instant::now(),
    });

    let url = format!(
        "{API_BASE}/api/auth/desktop/start?provider={provider}&state={state}&callback={cb}&code_challenge={challenge}&code_challenge_method=S256",
        provider = provider,
        state = urlencoding::encode(&state),
        cb = urlencoding::encode(CALLBACK_URL),
        challenge = urlencoding::encode(&challenge),
    );

    app_handle
        .shell()
        .open(&url, None)
        .map_err(|e| format!("failed to open browser: {e}"))?;

    Ok(StartOAuthLoginResult { opened_url: url })
}
```

- [ ] **Step 3: Register the command**

Find the `tauri::generate_handler![...]` macro call in `main.rs` and add `auth::start_oauth_login` to the list.

- [ ] **Step 4: Compile check**

```bash
cd src-tauri
cargo check
```

Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(auth): start_oauth_login IPC command opens broker URL in browser"
```

---

## Task 20: Implement deep-link handler that completes the OAuth flow

**Files:**
- Modify: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the handler function**

Append to `src-tauri/src/auth.rs`:

```rust
use tauri::{Emitter, Manager};
use url::Url;

use crate::credentials;

#[derive(Debug, Serialize, Clone)]
pub struct AuthTokensReceivedPayload {
    pub access_token: String,
    pub state: String,
}

/// Called by the deep-link plugin when the OS routes `agentrium://` URLs to us.
///
/// Only handles `agentrium://auth-return?token=...&refresh=...&state=...`.
/// Other paths are ignored (M2/M3 will add `import/<id>` etc.).
pub fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[auth] bad deep-link URL {url}: {e}");
            return;
        }
    };

    // Some OSes route the path segment as host, some as path. Handle both.
    let is_auth_return = parsed.host_str() == Some("auth-return")
        || parsed.path() == "/auth-return";
    if !is_auth_return {
        return; // not for us
    }

    let mut token = None;
    let mut refresh = None;
    let mut state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "token" => token = Some(v.to_string()),
            "refresh" => refresh = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }

    let (Some(token), Some(refresh), Some(state)) = (token, refresh, state) else {
        eprintln!("[auth] missing token/refresh/state in deep-link URL");
        return;
    };

    let pending = app.state::<Arc<PendingMap>>();
    if pending.take(&state).is_none() {
        eprintln!("[auth] unknown or expired state; ignoring deep-link");
        return;
    }

    if let Err(e) = credentials::store_refresh_token(&refresh) {
        eprintln!("[auth] failed to store refresh token: {e}");
        let _ = app.emit("auth-error", &format!("keychain error: {e}"));
        return;
    }

    // Emit access token to the frontend. authStore fetches user via /api/me.
    let payload = AuthTokensReceivedPayload { access_token: token, state };
    if let Err(e) = app.emit("auth-tokens-received", payload) {
        eprintln!("[auth] failed to emit event: {e}");
    }
}
```

- [ ] **Step 2: Wire it into `main.rs`**

Replace the placeholder `println!("[deep-link] received: {}", url);` from Task 15 with:

```rust
crate::auth::handle_deep_link(&handle, &url.to_string());
```

The `handle` variable was cloned in Task 15 Step 1 before being moved into the closure.

- [ ] **Step 3: Compile check**

```bash
cd src-tauri
cargo check
```

Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "feat(auth): deep-link handler stores refresh token and emits auth-tokens-received"
```

---

## Task 21: Add `fetch_current_user`, `logout`, and auth-prompt commands

**Files:**
- Modify: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add commands**

Append to `src-tauri/src/auth.rs`:

```rust
use crate::database::Database;
use std::sync::Mutex;

#[command]
pub async fn fetch_current_user(access_token: String) -> Result<AuthUser, String> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/api/me"))
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("api returned {}", resp.status()));
    }

    #[derive(Deserialize)]
    struct MeResponse {
        user: AuthUser,
    }
    let body: MeResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    Ok(body.user)
}

#[command]
pub async fn logout(db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    credentials::clear_refresh_token()?;
    let guard = db.lock().map_err(|e| e.to_string())?;
    guard.delete_user_meta("logged_in_user_id")?;
    Ok(())
}

#[command]
pub async fn mark_auth_prompt_seen(db: State<'_, Arc<Mutex<Database>>>) -> Result<(), String> {
    let guard = db.lock().map_err(|e| e.to_string())?;
    guard.set_user_meta("auth_prompt_seen", Some("1"))?;
    Ok(())
}

#[command]
pub async fn get_auth_prompt_seen(db: State<'_, Arc<Mutex<Database>>>) -> Result<bool, String> {
    let guard = db.lock().map_err(|e| e.to_string())?;
    Ok(guard.get_user_meta("auth_prompt_seen")?.is_some())
}
```

- [ ] **Step 2: Register in `main.rs`**

Extend `tauri::generate_handler![...]` with:

```rust
auth::fetch_current_user,
auth::logout,
auth::mark_auth_prompt_seen,
auth::get_auth_prompt_seen,
```

- [ ] **Step 3: Compile**

```bash
cd src-tauri
cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "feat(auth): fetch_current_user, logout, auth-prompt-seen commands"
```

---

## Task 22: Frontend — `authStore.ts` Zustand store

**Files:**
- Create: `src/store/authStore.ts`
- Create: `src/store/authStore.test.ts`

- [ ] **Step 1: Write the store**

Create `src/store/authStore.ts`:

```typescript
import { create } from 'zustand';

export type AuthMode = 'unknown' | 'guest' | 'authed';

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};

type AuthState = {
  mode: AuthMode;
  user: AuthUser | null;
  accessToken: string | null; // in-memory only, never persisted
  setGuest: () => void;
  setAuthed: (user: AuthUser, accessToken: string) => void;
  setUnknown: () => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  mode: 'unknown',
  user: null,
  accessToken: null,
  setGuest: () => set({ mode: 'guest', user: null, accessToken: null }),
  setAuthed: (user, accessToken) => set({ mode: 'authed', user, accessToken }),
  setUnknown: () => set({ mode: 'unknown', user: null, accessToken: null }),
  clear: () => set({ mode: 'guest', user: null, accessToken: null }),
}));
```

Note: this store is deliberately NOT persisted via `zustand/middleware/persist`. Tokens must never touch localStorage.

- [ ] **Step 2: Write a test**

Create `src/store/authStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.getState().setUnknown();
  });

  it('starts in unknown mode', () => {
    expect(useAuthStore.getState().mode).toBe('unknown');
  });

  it('setGuest transitions mode', () => {
    useAuthStore.getState().setGuest();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('setAuthed stores user + token', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'a@b.com', name: null, image: null },
      'jwt-token',
    );
    expect(useAuthStore.getState().mode).toBe('authed');
    expect(useAuthStore.getState().user?.email).toBe('a@b.com');
    expect(useAuthStore.getState().accessToken).toBe('jwt-token');
  });

  it('clear returns to guest mode', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'a@b.com', name: null, image: null },
      'jwt-token',
    );
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm run test:run -- src/store/authStore.test.ts
```

Expected: 4 passing.

- [ ] **Step 4: Commit**

```bash
git add src/store/authStore.ts src/store/authStore.test.ts
git commit -m "feat(auth): zustand authStore + tests (mode/user/access-token, not persisted)"
```

---

## Task 23: Frontend — `lib/auth.ts` wrappers + event listener

**Files:**
- Create: `src/lib/auth.ts`

- [ ] **Step 1: Write wrappers**

Create `src/lib/auth.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useAuthStore, AuthUser } from '../store/authStore';

export async function startOAuthLogin(provider: 'google'): Promise<void> {
  await invoke<{ opened_url: string }>('start_oauth_login', { provider });
}

export async function markAuthPromptSeen(): Promise<void> {
  await invoke('mark_auth_prompt_seen');
}

export async function getAuthPromptSeen(): Promise<boolean> {
  return await invoke<boolean>('get_auth_prompt_seen');
}

export async function logout(): Promise<void> {
  await invoke('logout');
  useAuthStore.getState().clear();
}

export async function fetchCurrentUser(accessToken: string): Promise<AuthUser> {
  return await invoke<AuthUser>('fetch_current_user', { accessToken });
}

/**
 * Attach the auth-tokens-received listener. Call once on app boot.
 * Returns an unlisten function.
 */
export async function subscribeToAuthEvents(): Promise<UnlistenFn> {
  return await listen<{ access_token: string; state: string }>('auth-tokens-received', async (event) => {
    const { access_token } = event.payload;
    try {
      const user = await fetchCurrentUser(access_token);
      useAuthStore.getState().setAuthed(user, access_token);
      await markAuthPromptSeen();
    } catch (e) {
      console.error('[auth] failed to hydrate user after OAuth:', e);
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat(auth): frontend wrappers + auth-tokens-received listener"
```

---

## Task 24: Frontend — `LoginModal.tsx`

**Files:**
- Create: `src/components/LoginModal.tsx`
- Create: `src/components/LoginModal.test.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/LoginModal.tsx`:

```tsx
import React, { useState } from 'react';
import { startOAuthLogin, markAuthPromptSeen } from '../lib/auth';
import { useAuthStore } from '../store/authStore';

type Props = {
  onClose: () => void;
};

export function LoginModal({ onClose }: Props) {
  const [busy, setBusy] = useState<'google' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogle() {
    setBusy('google');
    setError(null);
    try {
      await startOAuthLogin('google');
      // The modal stays open until the auth-tokens-received event fires elsewhere
      // and transitions authStore. The App shell watches authStore and closes the modal.
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  async function handleGuest() {
    await markAuthPromptSeen();
    useAuthStore.getState().setGuest();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'grid', placeItems: 'center', zIndex: 1000,
      }}
    >
      <div style={{
        width: 460, padding: 32, borderRadius: 12,
        background: 'var(--elevation-2, #2b2d30)',
        color: 'var(--text-primary, #ffffff)',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}>
        <h2 id="login-modal-title" style={{ marginTop: 0 }}>Sign in to Agentrium</h2>
        <p style={{ opacity: 0.8, marginBottom: 24 }}>
          Sign in to sync your profiles, hints, and custom agents across your computers.
        </p>

        <button
          onClick={handleGoogle}
          disabled={busy !== null}
          style={{
            width: '100%', padding: '12px 16px', marginBottom: 12,
            background: '#3574F0', color: 'white', border: 'none', borderRadius: 6,
            cursor: busy ? 'wait' : 'pointer', fontSize: 14, fontWeight: 500,
          }}
        >
          {busy === 'google' ? 'Opening browser…' : 'Sign in with Google'}
        </button>

        {error && (
          <div role="alert" style={{ color: '#f88', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            onClick={handleGuest}
            style={{
              background: 'transparent', color: 'var(--text-secondary, #aaa)',
              border: 'none', cursor: 'pointer', fontSize: 13,
              textDecoration: 'underline',
            }}
          >
            Continue as guest →
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write a test**

Create `src/components/LoginModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginModal } from './LoginModal';
import { useAuthStore } from '../store/authStore';

vi.mock('../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
  markAuthPromptSeen: vi.fn().mockResolvedValue(undefined),
}));

import { startOAuthLogin, markAuthPromptSeen } from '../lib/auth';

describe('LoginModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setUnknown();
  });

  it('renders sign-in options', () => {
    render(<LoginModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: /sign in to agentrium/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument();
  });

  it('calls startOAuthLogin("google") on Google click', async () => {
    render(<LoginModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with google/i }));
    expect(startOAuthLogin).toHaveBeenCalledWith('google');
  });

  it('marks guest and closes on Continue as guest', async () => {
    const onClose = vi.fn();
    render(<LoginModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }));
    await new Promise(r => setTimeout(r, 0));
    expect(markAuthPromptSeen).toHaveBeenCalled();
    expect(useAuthStore.getState().mode).toBe('guest');
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm run test:run -- src/components/LoginModal.test.tsx
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add src/components/LoginModal.tsx src/components/LoginModal.test.tsx
git commit -m "feat(auth): LoginModal component (Google + Guest for M1) + tests"
```

---

## Task 25: Frontend — `HeaderAuth.tsx`

**Files:**
- Create: `src/components/HeaderAuth.tsx`
- Create: `src/components/HeaderAuth.test.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/HeaderAuth.tsx`:

```tsx
import React, { useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { logout } from '../lib/auth';
import { LoginModal } from './LoginModal';

export function HeaderAuth() {
  const { mode, user } = useAuthStore();
  const [showLogin, setShowLogin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  if (mode === 'unknown') {
    return null; // App hasn't decided yet; the first-launch popup covers this.
  }

  if (mode === 'guest') {
    return (
      <>
        <button
          onClick={() => setShowLogin(true)}
          style={{
            padding: '4px 12px', borderRadius: 999,
            background: 'var(--elevation-2, #2b2d30)',
            color: 'var(--text-primary, #fff)',
            border: '1px solid var(--border-subtle, #3a3a3a)',
            fontSize: 12, cursor: 'pointer',
          }}
        >
          Sign in
        </button>
        {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      </>
    );
  }

  // mode === 'authed'
  const label = user?.name ?? user?.email ?? 'Signed in';
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          padding: '4px 8px', borderRadius: 999,
          background: 'transparent', color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-subtle, #3a3a3a)',
          fontSize: 12, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        {user?.image ? (
          <img src={user.image} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />
        ) : (
          <span style={{
            width: 20, height: 20, borderRadius: '50%',
            background: '#3574F0', color: 'white',
            display: 'grid', placeItems: 'center', fontSize: 10,
          }}>
            {initials(label)}
          </span>
        )}
        <span>{label}</span>
      </button>
      {menuOpen && (
        <div role="menu" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)',
          minWidth: 200, padding: 4, borderRadius: 6,
          background: 'var(--elevation-3, #35373b)',
          border: '1px solid var(--border-subtle, #3a3a3a)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          zIndex: 500,
        }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle, #3a3a3a)' }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{user?.name ?? '(no name)'}</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>{user?.email}</div>
          </div>
          <button
            role="menuitem"
            onClick={async () => {
              setMenuOpen(false);
              await logout();
            }}
            style={{
              display: 'block', width: '100%', padding: '8px 12px',
              background: 'transparent', color: 'inherit', border: 'none',
              textAlign: 'left', cursor: 'pointer', fontSize: 12,
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function initials(s: string): string {
  const parts = s.trim().split(/\s+/);
  if (parts.length === 1) return (parts[0][0] ?? '?').toUpperCase();
  return ((parts[0][0] ?? '') + (parts[1][0] ?? '')).toUpperCase();
}
```

- [ ] **Step 2: Write tests**

Create `src/components/HeaderAuth.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeaderAuth } from './HeaderAuth';
import { useAuthStore } from '../store/authStore';

vi.mock('../lib/auth', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

describe('HeaderAuth', () => {
  beforeEach(() => {
    useAuthStore.getState().setUnknown();
  });

  it('renders nothing when mode is unknown', () => {
    const { container } = render(<HeaderAuth />);
    expect(container.firstChild).toBeNull();
  });

  it('renders Sign in button when mode is guest', () => {
    useAuthStore.getState().setGuest();
    render(<HeaderAuth />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders user name when authed', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    render(<HeaderAuth />);
    expect(screen.getByText('Tal Ayash')).toBeInTheDocument();
  });

  it('opens dropdown menu on click', () => {
    useAuthStore.getState().setAuthed(
      { id: 'u1', email: 'tal@example.com', name: 'Tal Ayash', image: null },
      'jwt',
    );
    render(<HeaderAuth />);
    fireEvent.click(screen.getByRole('button', { name: /tal ayash/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm run test:run -- src/components/HeaderAuth.test.tsx
```

Expected: 4 passing.

- [ ] **Step 4: Commit**

```bash
git add src/components/HeaderAuth.tsx src/components/HeaderAuth.test.tsx
git commit -m "feat(auth): HeaderAuth component with guest/authed states + dropdown"
```

---

## Task 26: Wire first-launch popup + refresh-on-boot in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add imports**

Add at the top of `src/App.tsx`:

```tsx
import { getAuthPromptSeen, subscribeToAuthEvents, fetchCurrentUser } from './lib/auth';
import { useAuthStore } from './store/authStore';
import { LoginModal } from './components/LoginModal';
import { invoke } from '@tauri-apps/api/core';
```

- [ ] **Step 2: Add state + boot effect inside the component**

Inside the top-level component body:

```tsx
const authMode = useAuthStore((s) => s.mode);
const [showLoginModal, setShowLoginModal] = useState(false);

useEffect(() => {
  let unlisten: (() => void) | undefined;
  (async () => {
    unlisten = await subscribeToAuthEvents();

    // Boot-time: try to rehydrate from refresh token (silent).
    // If successful, we're authed. Otherwise: guest or show first-launch popup.
    const rehydrated = await tryRehydrateAuth();
    if (rehydrated) return;

    const seen = await getAuthPromptSeen();
    if (!seen) {
      useAuthStore.getState().setUnknown();
      setShowLoginModal(true);
    } else {
      useAuthStore.getState().setGuest();
    }
  })();
  return () => { if (unlisten) unlisten(); };
}, []);

// Close the modal automatically once auth succeeds
useEffect(() => {
  if (authMode === 'authed') setShowLoginModal(false);
}, [authMode]);
```

Add a helper at file scope (outside the component):

```tsx
async function tryRehydrateAuth(): Promise<boolean> {
  try {
    // Ask Rust to read the refresh token from keychain and call /api/auth/refresh
    const result = await invoke<{ access_token: string } | null>('rehydrate_auth');
    if (!result) return false;
    const user = await fetchCurrentUser(result.access_token);
    useAuthStore.getState().setAuthed(user, result.access_token);
    return true;
  } catch (e) {
    console.warn('[auth] rehydrate failed:', e);
    return false;
  }
}
```

- [ ] **Step 3: Render the modal**

At the bottom of the component's JSX return, before the closing tag:

```tsx
{showLoginModal && <LoginModal onClose={() => setShowLoginModal(false)} />}
```

- [ ] **Step 4: Add the `rehydrate_auth` Rust command**

Append to `src-tauri/src/auth.rs`:

```rust
#[derive(Debug, Serialize)]
pub struct RehydrateResult {
    pub access_token: String,
}

#[command]
pub async fn rehydrate_auth() -> Result<Option<RehydrateResult>, String> {
    let refresh = match credentials::read_refresh_token()? {
        Some(v) => v,
        None => return Ok(None),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{API_BASE}/api/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        // Refresh token no longer valid; clear it so we don't try again next boot.
        let _ = credentials::clear_refresh_token();
        return Ok(None);
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: String,
        refresh_token: String,
    }
    let body: RefreshResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;

    // Store the rotated refresh token.
    credentials::store_refresh_token(&body.refresh_token)?;

    Ok(Some(RehydrateResult { access_token: body.access_token }))
}
```

Register it in `main.rs`'s `generate_handler!` list:

```rust
auth::rehydrate_auth,
```

- [ ] **Step 5: Compile check**

```bash
cd src-tauri && cargo check
cd .. && npm run build
```

Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "feat(auth): first-launch popup gating + boot-time auth rehydration"
```

---

## Task 27: Insert `HeaderAuth` into `TitleBar.tsx`

**Files:**
- Modify: `src/components/TitleBar.tsx`

- [ ] **Step 1: Add the import**

```tsx
import { HeaderAuth } from './HeaderAuth';
```

- [ ] **Step 2: Place the component**

Find a suitable slot in the title bar — most title bars have a left region (icon + menu) and a right region (window controls). Place `<HeaderAuth />` on the right side but LEFT of the min/max/close window buttons. Add:

```tsx
<div style={{ marginRight: 8 }}>
  <HeaderAuth />
</div>
```

- [ ] **Step 3: Manual visual check**

```bash
npm run tauri dev
```

Wait for the app. Expected: sign-in pill appears in the title bar next to window controls after the app decides mode = guest (or after first-launch modal is dismissed via "Continue as guest").

- [ ] **Step 4: Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat(auth): HeaderAuth widget in TitleBar"
```

---

## Task 28: End-to-end manual verification

No new code. This validates the full loop works.

- [ ] **Step 1: Reset local state**

Close any running Agentrium instances. Delete the `user_meta` row so the first-launch popup fires. Also clear the Windows Credential Manager entry `agentrium.auth` / `refresh_token` if present.

Easiest reset: delete the whole SQLite DB file — `%APPDATA%\com.claudeterminal.ClaudeTerminal\claudeterminal.db` (Windows) or wherever `ProjectDirs::from` resolves. **Destructive: don't do this if you have real profiles/workspaces you care about.**

- [ ] **Step 2: Boot and complete Google sign-in**

```bash
npm run tauri dev
```

- Wait for the app to launch.
- Expected: `LoginModal` appears immediately (first launch).
- Click `[Sign in with Google]`.
- Expected: system browser opens to `https://agentrium-api.vercel.app/api/auth/desktop/start?provider=google&...`.
- Auth.js redirects to Google's consent screen.
- Complete Google sign-in (using your Google account added as a test user in Google Cloud Console).
- Google redirects to `https://agentrium-api.vercel.app/api/auth/desktop/finish?broker_state=...`.
- The HTML page appears: "Signed in successfully — Returning to Agentrium…"
- The browser attempts `agentrium://auth-return?...` — OS routes it to the Agentrium instance.
- Expected in Agentrium: `LoginModal` closes automatically, `HeaderAuth` in title bar shows your name.

If it fails at any step, capture:
- Console output from `npm run tauri dev` (look for `[auth]` and `[deep-link]` prints).
- Browser network tab (any 4xx/5xx from Vercel).
- Vercel logs (via MCP `get_deployment_build_logs` or `get_runtime_logs`).

- [ ] **Step 3: Test sign out**

- Click the user chip in the title bar → dropdown appears → `Sign out`.
- Expected: chip reverts to `[Sign in]` pill.
- Verify the Credential Manager entry `agentrium.auth` is gone.

- [ ] **Step 4: Test guest mode**

- Sign out (if signed in).
- Delete the `auth_prompt_seen` row (or the whole DB) again.
- Restart the app.
- `LoginModal` appears → click `Continue as guest →`.
- Expected: modal closes, sign-in pill shows.
- Restart the app — `LoginModal` does NOT reappear (because `auth_prompt_seen = 1`).

- [ ] **Step 5: Test boot-time rehydration**

- Sign in successfully (per Step 2).
- Close the app fully.
- Reopen the app.
- Expected: `LoginModal` does NOT appear; the header shows your name IMMEDIATELY (before any UI interaction). This proves `rehydrate_auth` worked.

- [ ] **Step 6: Test re-open of sign-in via the pill**

- Sign out.
- Click the `[Sign in]` pill → `LoginModal` opens again.
- Cancel by clicking outside — should NOT dismiss (modal has no close X in M1). Instead click Continue as guest.
- OK: guest mode again.

---

## Task 29: Version bump + changelog entry for the M1 preview

Since M1 is a milestone toward v1.34.0 (not the full ship), tag this as `v1.33.8-m1` or similar preview version. Discuss with user which version convention to use before running `/publish`.

**Files:**
- Modify: `src/changelog.json`

- [ ] **Step 1: Add changelog entry**

Prepend to `src/changelog.json`:

```json
{
  "version": "1.33.8-m1",
  "date": "2026-09-XX",
  "title": "Preview: Sign in with Google",
  "body": "Early preview of account support. Sign in with a Google account to see your name in the header — no data syncs yet. Guest mode continues to work exactly as before. Full sync and additional providers are coming in v1.34.0."
}
```

- [ ] **Step 2: Discuss version convention with user**

**DO NOT bump the version files yet.** Ask the user:

> "M1 is a milestone toward v1.34.0. Publish options: (a) tag it as a preview `v1.33.8-m1` and ship to a limited group; (b) hold M1 in a branch and only ship the combined M1+M2 as v1.34.0-preview; (c) merge M1 to master but keep version at 1.33.7 until M2 is done."

Wait for the answer. Do NOT run `/publish` unilaterally.

- [ ] **Step 3: Commit**

```bash
git add src/changelog.json
git commit -m "docs: changelog entry for M1 sign-in preview"
```

---

## Self-review checklist (fill in before handing off)

Before executing this plan, run through the spec section by section and confirm each requirement has a task:

- [ ] **Spec §5.1 (Auth.js core tables)** — Task 7 (Drizzle schema)
- [ ] **Spec §5.5 (Local SQLite additions: user_meta)** — Task 18 (`sync_queue` deferred to M2)
- [ ] **Spec §6.1 (OAuth deep-link handshake)** — Tasks 11, 12, 15, 16, 19, 20
- [ ] **Spec §6.3 (Guest mode)** — Tasks 24, 26
- [ ] **Spec §10.1 (HeaderAuth widget)** — Task 25
- [ ] **Spec §10.2 (LoginModal)** — Task 24
- [ ] **Spec §11 (Security: PKCE, deep-link hijack protection, JWT signing)** — Tasks 10, 16, 20
- [ ] **Spec §13 (Testing plan for auth.rs unit tests, LoginModal state, HeaderAuth state)** — Tasks 16, 22, 24, 25
- [ ] **Spec §14.4 (Tauri config additions)** — Task 14
- [ ] **Spec §14.5 (Vercel env vars)** — Task 5
- [ ] **Spec §14.7 (Rollback: revert desktop client)** — implicit (no destructive migrations in M1)
- [ ] **Boot-time rehydration** — Task 26 (added because §14.7 requires clean rollback and rehydration is the mechanism for a returning authed user)

**Deferred to M2 (not in this plan):**
- Sync engine (§7)
- Guest → account data migration (§6.4)
- SQLite migrations for `sync_queue` and syncable-table columns (§5.5 partial)
- GitHub OAuth provider (§6.1)
- Email + password (§6.2)
- `SyncStatusChip` (§10.5)

**Deferred to M3 (not in this plan):**
- Sharing (§8)
- Telemetry attribution (§9, §12)
- `ShareDialog`, `ImportShareModal`, `MySharesPanel` (§10)

---

## Definition of done for M1

When all tasks above are complete:

1. On a fresh install (or wiped local DB), Agentrium shows `LoginModal` on first launch.
2. User can click "Sign in with Google" and complete a full OAuth roundtrip that ends with their name showing in the title bar.
3. User can click "Continue as guest" and never see the modal again unless they explicitly click the header sign-in pill.
4. Guest users see all existing Agentrium functionality unchanged.
5. Signed-in users can sign out via the header dropdown.
6. Restarting the app after sign-in re-hydrates the user (via keychain refresh → `/api/auth/refresh` → `/api/me`), so no re-login is needed until the refresh token expires (30 days).
7. All Rust unit tests pass (`cd src-tauri && cargo test`).
8. All frontend tests pass (`npm run test:run`).
9. All backend tests pass (`cd agentrium-api && npm run test:run`).
