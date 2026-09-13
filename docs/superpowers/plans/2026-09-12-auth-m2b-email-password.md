# M2b: Email + Password Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent spec:** [2026-09-11-auth-sync-sharing-design.md](../specs/2026-09-11-auth-sync-sharing-design.md) §6.2.

**Milestone:** M2b. Ships on the existing `feat/m1-auth-signin` branch as part of `v1.34.0-preview` (M1+M2a+M2b bundled per user decision).

**Goal:** Add a third sign-in option alongside Google/GitHub OAuth — email + password, entirely in-app (no browser hop). Server hashes with argon2id, issues the same JWT + refresh token pair as OAuth, and the frontend hydrates auth state identically.

**Architecture:**
- Server: extend the `users` table with a nullable `password_hash TEXT` column. Two new broker endpoints under the existing `/api/auth/desktop/*` namespace (matching M1's OAuth pattern): `POST /api/auth/desktop/signup` and `POST /api/auth/desktop/signin-credentials`. Both use existing `signAccessToken` / `generateRefreshToken` helpers to issue tokens, and return `{ access_token, refresh_token }` as JSON (no HTML/deep-link roundtrip needed — the client is talking directly to the broker over HTTPS).
- Client: two new Rust IPC commands (`signup_credentials`, `signin_credentials`) that POST to the broker, store the refresh token in the OS keychain via `credentials::store_refresh_token`, and emit `auth-tokens-received` (same event M1 uses). Frontend adds an inline form to `LoginModal` behind a toggle. No JS-side network calls — all HTTP goes through Rust for consistency and to keep credentials off the JS heap.
- Not using Auth.js `Credentials` provider because that's browser-session-oriented; our desktop client already bypasses Auth.js for the OAuth deep-link flow. Consistency wins.

**Tech Stack:**
- **Backend:** existing Next.js 15 + Drizzle + Neon. New dep: `@node-rs/argon2` (npm) for OWASP-recommended password hashing. Zod for input validation (already a dep).
- **Client (Rust):** existing `reqwest`, `serde_json`, `keyring`. No new deps.
- **Client (TS/React):** existing Zustand, React 18. No new deps.

**Prerequisites:**
- ✅ M1 + M2a landed on `feat/m1-auth-signin` (broker deployed on Vercel, sync working).
- ✅ `users` table exists (Auth.js schema from M1).
- ✅ `signAccessToken`, `generateRefreshToken`, `refreshTokens` table all exist.

## Scope — what's IN vs OUT

**IN:**
- `POST /api/auth/desktop/signup` — validates email format + password length, hashes password, creates user + stores hash, issues tokens.
- `POST /api/auth/desktop/signin-credentials` — validates email + password against stored hash, issues tokens.
- Rust IPC: `signup_credentials(email, password)` and `signin_credentials(email, password)`.
- LoginModal inline email+password form under a "Use email + password" toggle.
- "Create account" ↔ "Sign in" mode toggle within the form.
- Error surfacing: "Wrong email or password" (both cases, no user enumeration), "Email already registered" (signup with duplicate).

**OUT (spec non-goals):**
- Email verification. Explicitly deferred (spec §2 non-goal — operational cost of an email provider isn't justified for v1).
- Password reset flow. Deferred until email verification exists (chicken-and-egg).
- Two-factor authentication. Spec §2 non-goal.
- Rate limiting on the signup/signin endpoints. Reasonable for a solo-user preview; would need Cloudflare Turnstile or similar for production scale. Track as follow-up.
- Password strength meter in the UI. Spec §6.2: minimum 8 chars, no other requirements. Argon2 handles the crypto.
- OAuth account linking (e.g. "your email already has a Google account — sign in with Google?"). If duplicate email at signup, we return an error and let the user try Google/GitHub sign-in explicitly.

## File structure created / modified

**New files (server — Next.js):**
- `agentrium-api/src/lib/password.ts` — argon2id hash/verify helpers + password length validation
- `agentrium-api/src/lib/password.test.ts`
- `agentrium-api/src/app/api/auth/desktop/signup/route.ts`
- `agentrium-api/src/app/api/auth/desktop/signup/route.test.ts`
- `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.ts`
- `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.test.ts`

**Modified files (server):**
- `agentrium-api/db/schema.ts` — add `passwordHash: text('password_hash')` to `users` table
- `agentrium-api/package.json` — add `@node-rs/argon2` dep

**New files (client — Rust):**
- (none — new commands added to existing `src-tauri/src/auth.rs`)

**Modified files (client — Rust):**
- `src-tauri/src/auth.rs` — add `signup_credentials` and `signin_credentials` commands + shared helper
- `src-tauri/src/main.rs` — register the two new commands in `.invoke_handler`

**New files (client — TS/React):**
- (none — new wrappers added to existing `src/lib/auth.ts`)

**Modified files (client — TS/React):**
- `src/lib/auth.ts` — add `signupCredentials` and `signinCredentials` wrappers
- `src/components/LoginModal.tsx` — add inline form + toggle
- `src/components/TitleBar.auth.test.tsx` — cover the email+password flow

---

## Task 1: Broker — add `password_hash` column to users

**Files:**
- Modify: `agentrium-api/db/schema.ts`

- [x] **Step 1: Extend the users table**

In `agentrium-api/db/schema.ts`, change the `users` table definition to include a nullable `password_hash` column. Put it below `image` for readability. Full new definition:

```typescript
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name'),
  email: text('email').unique().notNull(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  // M2b: nullable so OAuth-only users (no password) coexist with
  // email+password users. Argon2id hash produced by src/lib/password.ts.
  passwordHash: text('password_hash'),
});
```

Auth.js's DrizzleAdapter reads the users table by property name for the standard fields; adding an unknown column is safe (adapter ignores it).

- [x] **Step 2: Verify typecheck**

```
cd C:/Users/talay/agentrium-api
npx tsc --noEmit
```

Must exit 0.

- [x] **Step 3: Generate the migration**

```
cd C:/Users/talay/agentrium-api
npx dotenv -e .env.local -- npx drizzle-kit generate
```

Should produce a new file under `db/migrations/` like `0002_<random>.sql` containing:
```sql
ALTER TABLE "users" ADD COLUMN "password_hash" text;
```

- [x] **Step 4: Commit (do NOT push migration to Neon yet)**

```bash
git add db/schema.ts db/migrations/
git commit -m "feat(auth): add nullable password_hash column to users"
```

Applying to Neon is deferred until Task 6 lands (all schema + endpoints ready).

---

## Task 2: Broker — install argon2 dep + password helpers

**Files:**
- Modify: `agentrium-api/package.json`
- Create: `agentrium-api/src/lib/password.ts`
- Create: `agentrium-api/src/lib/password.test.ts`

- [x] **Step 1: Install `@node-rs/argon2`**

```
cd C:/Users/talay/agentrium-api
npm install @node-rs/argon2
```

Verify `package.json` shows `"@node-rs/argon2": "^X.Y.Z"` in `dependencies`.

- [x] **Step 2: Create the password helper module**

Write `agentrium-api/src/lib/password.ts`:

```typescript
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

export interface PasswordValidation {
  ok: boolean;
  error?: string;
}

/**
 * Enforce the spec's minimum 8-char rule + an upper bound so a caller can't
 * OOM the argon2 hasher. All other complexity is delegated to argon2.
 */
export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password must be a string' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_LENGTH} characters` };
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, error: `Password must be at most ${MAX_LENGTH} characters` };
  }
  return { ok: true };
}

/**
 * Argon2id with @node-rs/argon2 defaults (per OWASP). Output includes salt +
 * parameters embedded in the string, so verify() re-parses them; we never
 * store salt separately.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

/**
 * Returns true if the plaintext matches the stored hash. Argon2 verify is
 * constant-time by construction. Rejected passwords produce false, not
 * throws — callers should NOT differentiate "user not found" from "wrong
 * password" externally (prevents email enumeration).
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plaintext);
  } catch {
    // Malformed hash (e.g. legacy user row with garbage) → treat as mismatch.
    return false;
  }
}
```

- [x] **Step 3: Add tests**

Write `agentrium-api/src/lib/password.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validatePassword, hashPassword, verifyPassword } from './password';

describe('validatePassword', () => {
  it('rejects passwords shorter than 8 chars', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('1234567').ok).toBe(false);
  });

  it('accepts 8-char passwords', () => {
    expect(validatePassword('12345678').ok).toBe(true);
    expect(validatePassword('password').ok).toBe(true);
  });

  it('rejects excessively long passwords', () => {
    expect(validatePassword('x'.repeat(201)).ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validatePassword(null as any).ok).toBe(false);
    expect(validatePassword(undefined as any).ok).toBe(false);
    expect(validatePassword(12345678 as any).ok).toBe(false);
  });
});

describe('hashPassword + verifyPassword', () => {
  it('round-trips a valid password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-password-here')).toBe(true);
    expect(await verifyPassword(b, 'same-password-here')).toBe(true);
  });

  it('returns false on malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});
```

- [x] **Step 4: Run + commit**

```
cd C:/Users/talay/agentrium-api
npx tsc --noEmit
npx vitest run src/lib/password.test.ts
```

All must pass.

```bash
git add package.json package-lock.json src/lib/password.ts src/lib/password.test.ts
git commit -m "feat(auth): argon2id password hash + verify helpers"
```

---

## Task 3: Broker — `POST /api/auth/desktop/signup` endpoint

**Files:**
- Create: `agentrium-api/src/app/api/auth/desktop/signup/route.ts`
- Create: `agentrium-api/src/app/api/auth/desktop/signup/route.test.ts`

- [x] **Step 1: Write the route**

Path from route → `../../../../../lib/` is the standard depth. Copy the same relative path pattern used by `/api/auth/desktop/finish/route.ts`.

Write `agentrium-api/src/app/api/auth/desktop/signup/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, users, refreshTokens } from '../../../../../lib/db';
import { signAccessToken, generateRefreshToken, refreshTokenExpiryDate } from '../../../../../lib/jwt';
import { validatePassword, hashPassword } from '../../../../../lib/password';

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string(),
  name: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.format() },
      { status: 400 },
    );
  }
  const { email, password, name } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) {
    return NextResponse.json({ error: 'invalid_password', message: passwordCheck.error }, { status: 400 });
  }

  // Duplicate-email check up front. Deliberately DOES reveal that the email
  // exists at signup (spec §6.2 "prompts 'Sign in instead?'"). Sign-in path
  // hides the same signal to prevent user enumeration on brute-force attempts.
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1);
  if (existing[0]) {
    return NextResponse.json({ error: 'email_taken' }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

  const inserted = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      name: name ?? null,
      passwordHash,
    })
    .returning({ id: users.id, email: users.email, name: users.name });
  const user = inserted[0];
  if (!user) {
    return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
  }

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name ?? undefined,
  });
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshHash,
    expiresAt: refreshTokenExpiryDate(),
  });

  return NextResponse.json({
    access_token: accessToken,
    refresh_token: refreshRaw,
    user: { id: user.id, email: user.email, name: user.name },
  });
}
```

- [x] **Step 2: Write the contract tests**

Write `agentrium-api/src/app/api/auth/desktop/signup/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the password module so tests don't pay argon2's ~50ms cost.
vi.mock('../../../../../lib/password', () => ({
  validatePassword: vi.fn().mockReturnValue({ ok: true }),
  hashPassword: vi.fn().mockResolvedValue('$argon2id$mocked'),
}));

// Mock the jwt module.
vi.mock('../../../../../lib/jwt', () => ({
  signAccessToken: vi.fn().mockResolvedValue('mock-jwt'),
  generateRefreshToken: vi.fn().mockReturnValue({ raw: 'refresh-raw', hash: 'refresh-hash' }),
  refreshTokenExpiryDate: vi.fn().mockReturnValue(new Date('2027-01-01')),
}));

// Mock the DB with a controllable query chain.
let existingByEmail: { id: string }[] = [];
let insertReturning: { id: string; email: string; name: string | null }[] = [];
const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  limit: async () => existingByEmail,
};
const insertChain: any = {
  values: () => insertChain,
  returning: async () => insertReturning,
};
vi.mock('../../../../../lib/db', () => ({
  db: {
    select: () => selectChain,
    insert: () => insertChain,
  },
  users: { id: {}, email: {}, name: {} },
  refreshTokens: {},
}));

import { POST } from './route';
import { validatePassword } from '../../../../../lib/password';

function req(body: unknown) {
  return { headers: { get: () => null }, json: async () => body } as any;
}

beforeEach(() => {
  existingByEmail = [];
  insertReturning = [];
  vi.clearAllMocks();
  (validatePassword as any).mockReturnValue({ ok: true });
});

describe('POST /api/auth/desktop/signup', () => {
  it('400 on invalid body', async () => {
    const r = await POST(req({ email: 'not-email' }));
    expect(r.status).toBe(400);
  });

  it('400 on invalid password (short)', async () => {
    (validatePassword as any).mockReturnValue({ ok: false, error: 'too short' });
    const r = await POST(req({ email: 'a@b.co', password: 'x' }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_password');
  });

  it('409 on email already taken', async () => {
    existingByEmail = [{ id: 'existing-user-uuid' }];
    const r = await POST(req({ email: 'a@b.co', password: 'password123' }));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe('email_taken');
  });

  it('happy path returns access_token + refresh_token + user', async () => {
    existingByEmail = [];
    insertReturning = [{ id: 'new-uuid', email: 'a@b.co', name: 'Alice' }];
    const r = await POST(req({ email: 'a@b.co', password: 'password123', name: 'Alice' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.access_token).toBe('mock-jwt');
    expect(body.refresh_token).toBe('refresh-raw');
    expect(body.user).toEqual({ id: 'new-uuid', email: 'a@b.co', name: 'Alice' });
  });

  it('lowercases + trims the email before insert/query', async () => {
    existingByEmail = [];
    insertReturning = [{ id: 'x', email: 'user@example.com', name: null }];
    const r = await POST(req({ email: '  USER@Example.COM  ', password: 'password123' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.user.email).toBe('user@example.com');
  });
});
```

- [x] **Step 3: Run + commit**

```
cd C:/Users/talay/agentrium-api
npx tsc --noEmit
npx vitest run src/app/api/auth/desktop/signup/route.test.ts
```

All 5 tests must pass.

```bash
git add src/app/api/auth/desktop/signup/
git commit -m "feat(auth): POST /api/auth/desktop/signup with argon2id + duplicate-email 409"
```

---

## Task 4: Broker — `POST /api/auth/desktop/signin-credentials` endpoint

**Files:**
- Create: `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.ts`
- Create: `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.test.ts`

- [x] **Step 1: Write the route**

Write `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, users, refreshTokens } from '../../../../../lib/db';
import { signAccessToken, generateRefreshToken, refreshTokenExpiryDate } from '../../../../../lib/jwt';
import { verifyPassword } from '../../../../../lib/password';

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().max(200),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { email, password } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const row = await db
    .select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  const user = row[0];

  // Constant response for both "no such user" and "wrong password" —
  // prevents email enumeration via signin. verifyPassword returns false
  // on null/empty hash so users with only OAuth accounts (passwordHash = NULL)
  // silently fail to sign in with a password too.
  if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
    name: user.name ?? undefined,
  });
  const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refreshHash,
    expiresAt: refreshTokenExpiryDate(),
  });

  return NextResponse.json({
    access_token: accessToken,
    refresh_token: refreshRaw,
    user: { id: user.id, email: user.email, name: user.name },
  });
}
```

- [x] **Step 2: Write the contract tests**

Write `agentrium-api/src/app/api/auth/desktop/signin-credentials/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../lib/password', () => ({
  verifyPassword: vi.fn(),
}));

vi.mock('../../../../../lib/jwt', () => ({
  signAccessToken: vi.fn().mockResolvedValue('mock-jwt'),
  generateRefreshToken: vi.fn().mockReturnValue({ raw: 'refresh-raw', hash: 'refresh-hash' }),
  refreshTokenExpiryDate: vi.fn().mockReturnValue(new Date('2027-01-01')),
}));

let userByEmail: { id: string; email: string; name: string | null; passwordHash: string | null }[] = [];
const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  limit: async () => userByEmail,
};
const insertChain: any = {
  values: async () => undefined,
};
vi.mock('../../../../../lib/db', () => ({
  db: {
    select: () => selectChain,
    insert: () => insertChain,
  },
  users: { id: {}, email: {}, name: {}, passwordHash: {} },
  refreshTokens: {},
}));

import { POST } from './route';
import { verifyPassword } from '../../../../../lib/password';

function req(body: unknown) {
  return { headers: { get: () => null }, json: async () => body } as any;
}

beforeEach(() => {
  userByEmail = [];
  vi.clearAllMocks();
});

describe('POST /api/auth/desktop/signin-credentials', () => {
  it('400 on invalid body', async () => {
    const r = await POST(req({ email: 'not-an-email', password: 'x' }));
    expect(r.status).toBe(400);
  });

  it('401 when user not found (no email enumeration)', async () => {
    userByEmail = [];
    const r = await POST(req({ email: 'nobody@x.co', password: 'password123' }));
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('invalid_credentials');
  });

  it('401 when user exists but has no password hash (OAuth-only account)', async () => {
    userByEmail = [{ id: 'u1', email: 'a@b.co', name: 'A', passwordHash: null }];
    const r = await POST(req({ email: 'a@b.co', password: 'password123' }));
    expect(r.status).toBe(401);
    expect((verifyPassword as any)).not.toHaveBeenCalled();
  });

  it('401 when password wrong', async () => {
    userByEmail = [{ id: 'u1', email: 'a@b.co', name: 'A', passwordHash: 'hash' }];
    (verifyPassword as any).mockResolvedValue(false);
    const r = await POST(req({ email: 'a@b.co', password: 'wrong' }));
    expect(r.status).toBe(401);
  });

  it('happy path returns tokens', async () => {
    userByEmail = [{ id: 'u1', email: 'a@b.co', name: 'A', passwordHash: 'hash' }];
    (verifyPassword as any).mockResolvedValue(true);
    const r = await POST(req({ email: 'a@b.co', password: 'right' }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.access_token).toBe('mock-jwt');
    expect(body.refresh_token).toBe('refresh-raw');
    expect(body.user).toEqual({ id: 'u1', email: 'a@b.co', name: 'A' });
  });

  it('lowercases + trims email before lookup', async () => {
    userByEmail = [{ id: 'u1', email: 'user@example.com', name: null, passwordHash: 'hash' }];
    (verifyPassword as any).mockResolvedValue(true);
    const r = await POST(req({ email: '  USER@Example.COM  ', password: 'right' }));
    expect(r.status).toBe(200);
  });
});
```

- [x] **Step 3: Run + commit**

```
cd C:/Users/talay/agentrium-api
npx tsc --noEmit
npx vitest run src/app/api/auth/desktop/signin-credentials/route.test.ts
```

All 6 tests must pass.

```bash
git add src/app/api/auth/desktop/signin-credentials/
git commit -m "feat(auth): POST /api/auth/desktop/signin-credentials (constant-time on user-not-found)"
```

---

## Task 5: Broker — full-suite verification + push to Neon

**Files:**
- No new files. Verify the whole broker.

- [x] **Step 1: Full suite green**

```
cd C:/Users/talay/agentrium-api
npx vitest run
```

Total count should be 20 (from M2a) + 5 (Task 2 password) + 5 (Task 3 signup) + 6 (Task 4 signin) = **36 tests**.

- [x] **Step 2: Apply the schema migration to Neon**

Task 1 generated a migration file; push it now:

```
cd C:/Users/talay/agentrium-api
yes | npx dotenv -e .env.local -- npx drizzle-kit push
```

Should apply `ALTER TABLE "users" ADD COLUMN "password_hash" text;` — verify the output says `[✓] Changes applied`.

- [x] **Step 3: Verify the column exists on Neon**

```
cd C:/Users/talay/agentrium-api
npx dotenv -e .env.local -- node -e "const postgres=require('postgres');const sql=postgres(process.env.DATABASE_URL);(async()=>{const rows=await sql\`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users' ORDER BY ordinal_position\`;for(const r of rows)console.log(' -',r.column_name);await sql.end();})().catch(e=>{console.error(e.message);process.exit(1);});"
```

Expected output includes `- password_hash`.

- [x] **Step 4: Commit the applied migration + push broker to origin**

The migration file was already committed in Task 1. Now push:

```
cd C:/Users/talay/agentrium-api
git push origin master
```

Vercel auto-deploys. Wait ~60s. Verify the new routes are reachable:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://agentrium-api.vercel.app/api/auth/desktop/signup -H "Content-Type: application/json" -d '{}'
```

Expected: `400` (invalid body — proves the endpoint exists and validated). If `404`, the deploy hasn't landed yet — wait and retry.

---

## Task 6: Rust — `signup_credentials` + `signin_credentials` IPC commands

**Files:**
- Modify: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/main.rs`

- [x] **Step 1: Add shared post-signin helper**

The two commands do the same thing post-broker-response (store refresh in keychain, emit event). Extract a helper. Add to `src-tauri/src/auth.rs`:

```rust
/// Response shape from the broker's credentials-based auth endpoints
/// (`/api/auth/desktop/signup` and `.../signin-credentials`).
#[derive(Debug, Deserialize)]
struct CredentialsAuthResponse {
    access_token: String,
    refresh_token: String,
    // `user` is echoed back but the frontend fetches it fresh via
    // fetch_current_user, so we ignore it here.
}

/// Store the refresh token in the OS keychain and emit auth-tokens-received
/// so the frontend hydrates identically to the OAuth deep-link path.
/// Called by both signup_credentials and signin_credentials on success.
fn complete_credentials_auth(
    app: &tauri::AppHandle,
    tokens: CredentialsAuthResponse,
) -> Result<(), String> {
    credentials::store_refresh_token(&tokens.refresh_token)?;
    let payload = AuthTokensReceivedPayload {
        access_token: tokens.access_token,
        // Credentials flow has no PKCE state — pass an empty string.
        // The frontend's auth-tokens-received listener doesn't require it
        // (state matching is only meaningful for the OAuth deep-link path
        // where CSRF via URL query is a concern).
        state: String::new(),
    };
    app.emit("auth-tokens-received", payload).map_err(|e| format!("emit failed: {e}"))?;
    Ok(())
}
```

- [x] **Step 2: Add the `signup_credentials` command**

```rust
#[derive(Debug, Serialize)]
struct SignupRequest<'a> {
    email: &'a str,
    password: &'a str,
    name: Option<&'a str>,
}

/// Register a new email+password account with the broker. On success, stores
/// the refresh token + emits `auth-tokens-received` so the frontend hydrates
/// exactly like the OAuth path. Errors are propagated as user_err (not
/// telemetry-worthy caller-side mistakes).
#[command]
pub async fn signup_credentials(
    app: tauri::AppHandle,
    email: String,
    password: String,
    name: Option<String>,
) -> Result<(), String> {
    wrap_cmd("signup_credentials", async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{API_BASE}/api/auth/desktop/signup"))
            .json(&SignupRequest {
                email: &email,
                password: &password,
                name: name.as_deref(),
            })
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let error_code = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
            let message = body.get("message").and_then(|v| v.as_str()).map(String::from);
            // 409 = duplicate email is the ONE case the UI explicitly handles
            // ("Sign in instead?"). Everything else is generic.
            let user_msg = match (status.as_u16(), error_code) {
                (409, _) => "email_taken".to_string(),
                (400, "invalid_password") => message.unwrap_or_else(|| "Invalid password".into()),
                (400, _) => "Invalid signup details".into(),
                _ => format!("Signup failed ({status})"),
            };
            return Err(error_reporter::user_err(user_msg));
        }

        let tokens: CredentialsAuthResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        complete_credentials_auth(&app, tokens)
    })
    .await
}
```

- [x] **Step 3: Add the `signin_credentials` command**

```rust
#[derive(Debug, Serialize)]
struct SigninCredentialsRequest<'a> {
    email: &'a str,
    password: &'a str,
}

/// Sign in with email + password. On success, stores the refresh token +
/// emits `auth-tokens-received`.
#[command]
pub async fn signin_credentials(
    app: tauri::AppHandle,
    email: String,
    password: String,
) -> Result<(), String> {
    wrap_cmd("signin_credentials", async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{API_BASE}/api/auth/desktop/signin-credentials"))
            .json(&SigninCredentialsRequest {
                email: &email,
                password: &password,
            })
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let user_msg = match status.as_u16() {
                401 => "invalid_credentials".to_string(),
                400 => "Invalid sign-in details".to_string(),
                _ => format!("Sign-in failed ({status})"),
            };
            return Err(error_reporter::user_err(user_msg));
        }

        let tokens: CredentialsAuthResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        complete_credentials_auth(&app, tokens)
    })
    .await
}
```

- [x] **Step 4: Register both commands in `main.rs`**

Grep `.invoke_handler` to find the handler list. Add near the other `auth::` entries:

```rust
auth::signup_credentials,
auth::signin_credentials,
```

- [x] **Step 5: Verify + commit**

```
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

Must exit 0 + all 295 tests pass. No new Rust tests here (contract is covered by the broker tests + we'll add FE integration tests later).

```bash
git add src-tauri/src/auth.rs src-tauri/src/main.rs
git commit -m "feat(auth): signup_credentials + signin_credentials IPC commands"
```

---

## Task 7: Frontend — `lib/auth.ts` wrappers

**Files:**
- Modify: `src/lib/auth.ts`

- [x] **Step 1: Add wrappers**

Append to `src/lib/auth.ts` (near the existing `startOAuthLogin` wrapper):

```typescript
/**
 * Register a new email+password account. On success the deep-link-equivalent
 * event fires from Rust and the store hydrates automatically. Throws with a
 * short error code on failure — LoginModal maps to user-friendly text.
 * Codes: 'email_taken' (409), 'invalid_password' (weak), or a generic string.
 */
export async function signupCredentials(
  email: string,
  password: string,
  name?: string,
): Promise<void> {
  await invoke('signup_credentials', { email, password, name });
}

/**
 * Sign in with email + password. Same hydration path as OAuth. Throws with
 * 'invalid_credentials' on wrong email/password (constant response — no user
 * enumeration).
 */
export async function signinCredentials(
  email: string,
  password: string,
): Promise<void> {
  await invoke('signin_credentials', { email, password });
}
```

Note: no `reportInvokeFailure` at this layer — LoginModal's error handling is user-facing and doesn't need telemetry on validation errors. The Rust side uses `error_reporter::user_err` so the broker's 400/401/409 responses don't hit telemetry.

- [x] **Step 2: Verify + commit**

```
cd C:/Users/talay/agentrium
npx tsc --noEmit
```

Must exit 0.

```bash
git add src/lib/auth.ts
git commit -m "feat(auth): signupCredentials + signinCredentials FE wrappers"
```

---

## Task 8: Frontend — LoginModal email+password form

**Files:**
- Modify: `src/components/LoginModal.tsx`

- [x] **Step 1: Rewrite LoginModal with the toggle + form**

Full new content of `src/components/LoginModal.tsx`:

```tsx
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import {
  startOAuthLogin,
  markAuthPromptSeen,
  signupCredentials,
  signinCredentials,
} from '../lib/auth';
import { useAuthStore } from '../store/authStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface LoginModalProps {
  onClose: () => void;
}

type OAuthProvider = 'google' | 'github';
type FormMode = 'signin' | 'signup';

/**
 * First-launch sign-in prompt. Offers Google + GitHub OAuth (M1), inline
 * email + password (M2b), or "continue as guest".
 *
 * OAuth buttons don't close the modal themselves: they kick off the browser
 * hop; when the deep-link handler fires `auth-tokens-received`, App.tsx
 * unmounts the modal.
 *
 * Email + password is entirely in-app (no browser hop). On success the Rust
 * IPC path fires `auth-tokens-received` too, so hydration is uniform.
 */
export function LoginModal({ onClose }: LoginModalProps) {
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anyBusy = oauthBusy !== null || formBusy;

  const handleOAuth = async (provider: OAuthProvider) => {
    setOauthBusy(provider);
    setError(null);
    try {
      await startOAuthLogin(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOauthBusy(null);
      reportInvokeFailure('start_oauth_login', err);
    }
  };

  const handleGuest = async () => {
    try {
      await markAuthPromptSeen();
    } catch (err) {
      reportInvokeFailure('mark_auth_prompt_seen', err);
    }
    useAuthStore.getState().setGuest();
    onClose();
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFormBusy(true);
    try {
      if (formMode === 'signup') {
        await signupCredentials(email, password, name.trim() || undefined);
      } else {
        await signinCredentials(email, password);
      }
      // Success: the Rust IPC path stored the refresh token + fired
      // auth-tokens-received. App.tsx will unmount this modal when
      // authStore.mode flips to 'authed'.
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(userMessageFor(code, formMode));
      setFormBusy(false);
    }
  };

  const toggleFormMode = () => {
    setFormMode((m) => (m === 'signin' ? 'signup' : 'signin'));
    setError(null);
  };

  return (
    <Modal
      onClose={onClose}
      showHeader
      title="Sign in to Agentrium"
      panelClassName="w-full max-w-md"
    >
      <div className="p-5 space-y-3">
        <p className="text-[13px] text-text-secondary leading-relaxed pb-1">
          Sign in to sync your profiles, hints, and custom agents across your computers.
        </p>

        <button
          type="button"
          onClick={() => handleOAuth('google')}
          disabled={anyBusy}
          className="w-full h-10 px-4 flex items-center justify-center gap-3 rounded-md bg-white text-[#1f1f1f] text-[13px] font-medium ring-1 ring-black/10 hover:bg-[#f7f8f8] active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
        >
          {oauthBusy === 'google' ? (
            <Loader2 size={16} className="animate-spin text-[#1f1f1f]/60" />
          ) : (
            <GoogleG />
          )}
          <span>{oauthBusy === 'google' ? 'Opening browser…' : 'Sign in with Google'}</span>
        </button>

        <button
          type="button"
          onClick={() => handleOAuth('github')}
          disabled={anyBusy}
          className="w-full h-10 px-4 flex items-center justify-center gap-3 rounded-md bg-[#24292e] text-white text-[13px] font-medium hover:bg-[#32383f] active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
        >
          {oauthBusy === 'github' ? (
            <Loader2 size={16} className="animate-spin text-white/60" />
          ) : (
            <GitHubMark />
          )}
          <span>{oauthBusy === 'github' ? 'Opening browser…' : 'Sign in with GitHub'}</span>
        </button>

        {!formOpen && (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="w-full text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 pt-1 transition-colors"
          >
            Or use email + password
          </button>
        )}

        {formOpen && (
          <form onSubmit={handleFormSubmit} className="space-y-2 pt-1">
            <label className="block">
              <span className="text-[11px] text-text-tertiary">Email</span>
              <input
                type="email"
                autoComplete={formMode === 'signup' ? 'email' : 'username'}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={formBusy}
                className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-tertiary">Password</span>
              <input
                type="password"
                autoComplete={formMode === 'signup' ? 'new-password' : 'current-password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={formBusy}
                className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
              />
            </label>
            {formMode === 'signup' && (
              <label className="block">
                <span className="text-[11px] text-text-tertiary">Name (optional)</span>
                <input
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={formBusy}
                  className="w-full h-9 px-2.5 mt-0.5 rounded-md bg-elevation-2 ring-1 ring-inset ring-seam text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary disabled:opacity-50"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={anyBusy || email.length === 0 || password.length < 8}
              className="w-full h-10 px-4 flex items-center justify-center gap-2 rounded-md bg-accent-primary text-white text-[13px] font-medium hover:bg-accent-secondary active:scale-[0.98] transition-[background-color,transform] duration-100 disabled:opacity-50 disabled:cursor-default disabled:active:scale-100"
            >
              {formBusy && <Loader2 size={16} className="animate-spin" />}
              <span>
                {formBusy
                  ? formMode === 'signup'
                    ? 'Creating account…'
                    : 'Signing in…'
                  : formMode === 'signup'
                    ? 'Create account'
                    : 'Sign in'}
              </span>
            </button>
            <button
              type="button"
              onClick={toggleFormMode}
              disabled={formBusy}
              className="w-full text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 transition-colors disabled:opacity-50"
            >
              {formMode === 'signin'
                ? "Don't have an account? Create one"
                : 'Already have an account? Sign in'}
            </button>
          </form>
        )}

        {error && (
          <div
            role="alert"
            className="text-[12px] text-error bg-error/10 border border-error/30 rounded-md px-2.5 py-1.5"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center px-4 h-11 border-t border-[var(--seam)] bg-elevation-3">
        <button
          type="button"
          onClick={handleGuest}
          className="text-[12px] text-text-tertiary hover:text-text-secondary underline underline-offset-2 transition-colors"
        >
          Continue as guest
        </button>
      </div>
    </Modal>
  );
}

/**
 * Map Rust error codes to user-visible messages. Codes come from the two
 * IPC commands' `error_reporter::user_err` calls in auth.rs.
 */
function userMessageFor(code: string, mode: FormMode): string {
  if (code.includes('email_taken')) {
    return 'That email is already registered. Try signing in instead.';
  }
  if (code.includes('invalid_credentials')) {
    return 'Wrong email or password.';
  }
  if (code.toLowerCase().includes('password')) {
    // Passes through the broker's "Password must be at least 8 characters" etc.
    return code;
  }
  if (code.toLowerCase().includes('network')) {
    return 'Could not reach the server. Check your connection.';
  }
  return mode === 'signup' ? 'Could not create account. Please try again.' : 'Could not sign in. Please try again.';
}

// Google + GitHub brand icons (unchanged from M1).

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  );
}
```

- [x] **Step 2: Verify typecheck + build**

```
cd C:/Users/talay/agentrium
npx tsc --noEmit
```

Must exit 0.

- [x] **Step 3: Commit**

```bash
git add src/components/LoginModal.tsx
git commit -m "feat(auth): email + password form in LoginModal with mode toggle"
```

---

## Task 9: Frontend — extend TitleBar auth test with email+password flow

**Files:**
- Modify: `src/components/TitleBar.auth.test.tsx`

- [x] **Step 1: Extend mocks + add form-flow tests**

Extend `vi.mock('../lib/auth', ...)` at the top of the file to include the two new wrappers:

```typescript
vi.mock('../lib/auth', () => ({
  startOAuthLogin: vi.fn().mockResolvedValue(undefined),
  markAuthPromptSeen: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  signupCredentials: vi.fn().mockResolvedValue(undefined),
  signinCredentials: vi.fn().mockResolvedValue(undefined),
}));
```

Import them at the bottom of the import block:

```typescript
import {
  startOAuthLogin,
  markAuthPromptSeen,
  logout,
  signupCredentials,
  signinCredentials,
} from '../lib/auth';
```

Append at the end of the `describe('title bar auth interactions', () => {` block, before the closing brace:

```tsx
it('opens the email+password form under the "Or use email + password" link', async () => {
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  // Form is now visible
  expect(screen.getByLabelText(/Email/i)).toBeTruthy();
  expect(screen.getByLabelText(/Password/i)).toBeTruthy();
  // Default mode is Sign in
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

it('signs in with email + password', async () => {
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  await user.type(screen.getByLabelText(/Email/i), 'me@example.com');
  await user.type(screen.getByLabelText(/Password/i), 'password123');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(signinCredentials).toHaveBeenCalledWith('me@example.com', 'password123');
  expect(startDragging).not.toHaveBeenCalled();
});

it('creates an account when toggled to sign-up mode', async () => {
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  await user.click(screen.getByRole('button', { name: /Don't have an account\? Create one/i }));
  // Now in signup mode: name field appears, submit button says "Create account"
  expect(screen.getByLabelText(/Name/i)).toBeTruthy();
  await user.type(screen.getByLabelText(/Email/i), 'new@example.com');
  await user.type(screen.getByLabelText(/Password/i), 'password123');
  await user.type(screen.getByLabelText(/Name/i), 'New User');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  expect(signupCredentials).toHaveBeenCalledWith('new@example.com', 'password123', 'New User');
});

it('shows "Sign in instead" message on duplicate email', async () => {
  (signupCredentials as any).mockRejectedValueOnce(new Error('email_taken'));
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  await user.click(screen.getByRole('button', { name: /Create one/i }));
  await user.type(screen.getByLabelText(/Email/i), 'taken@example.com');
  await user.type(screen.getByLabelText(/Password/i), 'password123');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  // Async — wait for the error message
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toMatch(/already registered/i);
});

it('shows "Wrong email or password" on invalid credentials', async () => {
  (signinCredentials as any).mockRejectedValueOnce(new Error('invalid_credentials'));
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  await user.type(screen.getByLabelText(/Email/i), 'wrong@example.com');
  await user.type(screen.getByLabelText(/Password/i), 'wrongpassword');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toMatch(/wrong email or password/i);
});

it('submit button is disabled when password is shorter than 8 chars', async () => {
  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(screen.getByRole('button', { name: 'Or use email + password' }));
  await user.type(screen.getByLabelText(/Email/i), 'me@example.com');
  await user.type(screen.getByLabelText(/Password/i), 'short');
  const submit = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
});
```

Note: some previous tests in this file query `getByRole('button', { name: 'Sign in' })` and expect to find the header pill. After M2b, that name is ambiguous — both the header pill AND the form's submit button use "Sign in". If any existing test breaks because of this, disambiguate by scoping (e.g. `within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign in' })` for the form submit) or by using `name: /^Sign in$/i` with a specific parent. Adjust existing tests only if they now fail.

- [x] **Step 2: Run tests + commit**

```
cd C:/Users/talay/agentrium
npx vitest run src/components/TitleBar.auth.test.tsx
```

All tests must pass (existing + 6 new). Adjust any existing tests that break due to the "Sign in" name ambiguity.

```bash
git add src/components/TitleBar.auth.test.tsx
git commit -m "test(auth): email + password form interactions (signup, signin, errors, validation)"
```

---

## Task 10: Full-suite verification

**Files:**
- No new files.

- [x] **Step 1: Frontend full suite**

```
cd C:/Users/talay/agentrium
npm run test:run
```

Should be 594 (from M2a) + 6 (Task 9) = **~600 tests**. All must pass.

- [x] **Step 2: Rust full suite**

```
cd C:/Users/talay/agentrium
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

Should still be 295 tests. All must pass.

- [x] **Step 3: Broker full suite**

```
cd C:/Users/talay/agentrium-api
npx vitest run
```

Should be **36 tests** (per Task 5). All must pass.

- [x] **Step 4: TypeScript typecheck (both projects)**

```
cd C:/Users/talay/agentrium && npx tsc --noEmit
cd C:/Users/talay/agentrium-api && npx tsc --noEmit
```

Both must exit 0.

---

## Task 11: Manual E2E verification

> **Status 2026-09-13:** Server-side behaviour verified against the live broker
> with a throwaway account (created + deleted in Neon): signup 200 with tokens,
> duplicate email 409 `email_taken`, short password 400, signin 200 (same user
> id), wrong password and unknown email both 401 `invalid_credentials`, stored
> hash is argon2id. The in-app UI steps below still need a human on a QA build.

No code change. Prerequisites: prod (PID 19868) closed, or QA side-load ready (see M2a plan's `AGENTRIUM_INSTANCE_ID` env-var + `tauri build --config src-tauri/tauri.conf.qa.json` approach).

- [ ] **Step 1: Sign up a new account**

- Launch a fresh QA build (isolated DB + keychain).
- LoginModal appears. Click "Or use email + password" → click "Don't have an account? Create one".
- Enter a new email + password (>= 8 chars) + optional name → "Create account".
- Expected: modal closes, header chip shows your email/name, `SyncStatusChip` appears in titlebar.
- Verify in Neon: `SELECT id, email, name, password_hash IS NOT NULL AS has_password FROM users WHERE email = '<your-email>';` — should show the row with `has_password = true`.

- [ ] **Step 2: Sign out**

- Click account chip → Sign out. Chip reverts to "Sign in" pill.

- [ ] **Step 3: Sign in with the same email + password**

- Click "Sign in" → email+password form → sign in.
- Expected: chip restored, sync engine starts (per M2a).

- [ ] **Step 4: Wrong password**

- Sign out. Click "Sign in" → email+password → enter your email but wrong password → "Sign in".
- Expected: red error box "Wrong email or password."

- [ ] **Step 5: Duplicate email at signup**

- Click "Create one" → enter the same email you already used → password >= 8 chars → "Create account".
- Expected: red error box "That email is already registered. Try signing in instead."

- [ ] **Step 6: OAuth account cannot sign in with password**

- Sign out. Click Sign in with Google (or GitHub) → complete OAuth → note the Google-issued email.
- Sign out. Click "Or use email + password" → enter the Google-issued email + any password → "Sign in".
- Expected: "Wrong email or password" (because that user has `password_hash = NULL`).

- [ ] **Step 7: Sync interaction**

- Create a profile via the UI after signing in with email + password.
- Verify the profile appears in Neon under your user_id (confirms M2a sync still works with M2b users).

- [ ] **Step 8: Report**

Report to the plan owner: which steps passed, any surprises.

---

## Task 12: Push branch

- [x] **Step 1: Push agentrium branch**

```
cd C:/Users/talay/agentrium
git push origin feat/m1-auth-signin
```

Broker was already pushed in Task 5.

---

## Self-review checklist (fill in before executing)

- [x] **Spec §6.2 (email+password flow)** — Tasks 2 (hash), 3 (signup), 4 (signin), 6 (Rust IPC), 8 (LoginModal form)
- [x] **Spec §6.2 (minimum 8 chars)** — Task 2 `validatePassword` + Task 8 client-side `minLength` on input + disabled submit button
- [x] **Spec §6.2 (constant-time no-user-enumeration on signin)** — Task 4 (same 401 for missing user + wrong password + null hash)
- [x] **Spec §6.2 ("Sign in instead?" on duplicate signup)** — Task 3 (409 email_taken) + Task 8 (`userMessageFor` maps it to a friendly message)
- [x] **Spec §6.2 (no email verification)** — deliberately not implemented, documented in Scope
- [x] **Spec §6.2 (server issues same JWT + refresh pair)** — Tasks 3, 4 both use `signAccessToken` + `generateRefreshToken` + insert into `refreshTokens`
- [x] **Spec §6.2 (frontend stores tokens exactly as OAuth path)** — Task 6 `complete_credentials_auth` calls same `store_refresh_token` + emits same `auth-tokens-received` event

**Follow-ups flagged in Scope (not in this plan):**
- Rate limiting on `/signup` and `/signin-credentials`
- Password reset (blocked by lack of email verification)
- OAuth account linking ("your email already has a Google account")
- Password strength meter

---

## Definition of done for M2b

When all tasks are complete:

1. Fresh install → LoginModal offers Google, GitHub, "Or use email + password", or guest.
2. Clicking "Or use email + password" reveals a form with Sign in / Create account modes.
3. Creating an account with a valid email + 8+ char password succeeds; user chip appears with the entered name/email.
4. Signing in with that account works on the same or a different device.
5. Duplicate email at signup shows "already registered".
6. Wrong password at signin shows "wrong email or password" (identical to unknown-email response).
7. Signed-in user's `password_hash` column in Neon is populated (non-null, argon2id-formatted string).
8. Sync (M2a) continues to work identically for password-created users as for OAuth-created users.
9. Rust: 295 tests pass.
10. Frontend: ~600 tests pass.
11. Broker: 36 tests pass.
