# Agentrium: Authentication, Cloud Sync, and Sharing

- **Date:** 2026-09-11
- **Status:** Design approved, ready for implementation planning
- **Owner:** Tal Ayash
- **Target release:** v1.34.0
- **Supersedes:** [2026-08-29-account-auth-and-sync-design.md](2026-08-29-account-auth-and-sync-design.md)
- **Related code paths:** `src-tauri/src/database.rs`, `src-tauri/src/error_reporter.rs`, `src-tauri/src/credentials.rs`, `src/store/appStore.ts`, `src/components/TitleBar.tsx`, `workers/ct-analytics/src/index.ts`

## 0. Why this spec exists (relationship to 2026-08-29 spec)

An earlier spec chose Cloudflare Workers + D1 + WorkOS as the backend stack, with sync but no sharing. This spec supersedes it after a re-brainstorm surfaced three requirement changes:

1. **Sharing** (public snapshot links for profiles / hints / custom agents) is now a Phase-1 requirement. The old spec listed sharing as an explicit non-goal.
2. **Vercel-primary** stack chosen over Cloudflare-primary. Auth.js on Next.js is the shortest path from zero to "OAuth working end-to-end" — estimated 3–4 days saved vs. hand-rolling auth on Workers. WorkOS's abstraction layer is unnecessary given only Google + GitHub are needed.
3. **Session history sync deferred to post-v1.** The privacy commitment (holding user terminal transcripts) and storage cost (up to 10 MB per session, thousands of sessions per user) is too high for v1.

**What we kept from the old spec:**

- Telemetry attribution goes through the existing `ct-analytics` Cloudflare Worker. Extend the existing heartbeat / error-report payload with an optional `user_id`. Do not duplicate this infrastructure on Vercel.
- Local SQLite migration approach: idempotent `ALTER TABLE ... ADD COLUMN` following the existing `database.rs::init_schema` pattern.
- Last-write-wins per row for sync conflicts. No CRDT, no three-way merge.
- Guest mode remains fully supported and preserves all existing offline functionality — every operation that works today keeps working when signed out.
- OS keychain for token storage via the existing `credentials::SecretStore` (backed by `keyring` crate).

**What changed vs. the old spec:**

- Backend platform: Cloudflare Workers → Vercel (Next.js).
- Database: Cloudflare D1 → Neon Postgres (installed via Vercel Marketplace).
- Identity provider: WorkOS AuthKit → Auth.js (direct OAuth to Google + GitHub, plus native email+password).
- OAuth callback pattern: loopback HTTP server (deep-link as fallback) → deep-link scheme primary (loopback removed).
- Providers: Google + GitHub + Microsoft → Google + GitHub only.
- Sharing added as a first-class feature (see Section 8).
- No admin dashboard in Phase 1 (deferred).
- No session history sync in Phase 1 (deferred).
- No R2 log-blob storage in Phase 1.
- One phase (v1.34.0) instead of three (v1.33.0 / v1.34.0 / v1.35.0).

## 1. Executive summary

Add optional user accounts to Agentrium with three connected features that ship together in v1.34.0:

- **Cloud sync** — profiles, hints, custom agents, workspaces, and app settings sync across every PC the user signs in to. Session history and credentials stay strictly local.
- **Sharing** — a user can create a public snapshot link for a profile, hint pack, or custom agent. Recipients open the link in a browser, land on a preview page, and click through to import into their own Agentrium (whether logged in or not).
- **Telemetry attribution** — the existing anonymous error-report / heartbeat payload gains an optional `user_id` field, so when a signed-in user reports a bug, it can be traced back to them.

Identity is served by **Auth.js** on **Vercel** with Google + GitHub providers plus email+password. Application data lives in **Neon Postgres** provisioned through the Vercel Marketplace. Sharing landing pages are Next.js server components on the same Vercel deploy. Telemetry attribution extends the existing `ct-analytics` Cloudflare Worker.

Guest mode remains fully supported. All existing local functionality works when signed out. A single "first launch after upgrade" popup offers Google / GitHub / email / continue-as-guest and is never re-shown unprompted.

## 2. Non-goals (explicit)

- **Session history sync.** Terminal transcripts stay on the machine that created them. Reasoning: privacy commitment + storage cost. Reconsider if sync users specifically ask.
- **Credential sync.** API keys in the OS keyring never leave the machine. Non-negotiable — a leaked API key is a real financial and security incident.
- **Live subscription sharing.** Shares are frozen snapshots at creation time. Recipient gets their own copy; sender's later edits do not propagate. Live shares would need a permission model, notification UI, and stream infrastructure.
- **Team / organization accounts.** Every user is a single-person account. No shared workspaces, no admin-managed profiles.
- **Email verification for email+password signup.** Reasoning: avoids the operational cost of an email provider (Resend / Postmark) for v1. Trade-off is that someone could register with an email they do not own, but they cannot recover it, so incentive is low.
- **CRDT or three-way merge.** Last-write-wins per row by `updated_at` is the ceiling for v1.
- **Two-factor authentication.** Auth.js supports it via TOTP later if needed.
- **Custom domain in Phase 1.** Use Vercel's assigned `agentrium-api.vercel.app`. Custom domain is a branding upgrade for post-v1.
- **Admin dashboard.** With a single user (the developer), reading Postgres directly is fine. Revisit when the user count justifies UI.
- **Migration of existing anonymous `installation_id` heartbeats into user accounts.** Anonymous telemetry from before signup stays anonymous; heartbeats after signup are attributed forward.

## 3. Stack and rationale

| Layer | Choice | Why |
|---|---|---|
| Identity, auth | Auth.js (v5) on Next.js App Router | Free, open-source, first-class Google/GitHub/Credentials providers, drop-in Postgres adapter |
| API compute | Next.js Route Handlers on Vercel Serverless | Same repo as landing pages; native Auth.js integration; free tier covers expected load |
| Database | Neon Postgres via Vercel Marketplace | One-click install; generous free tier; auto-pauses when idle; branching for preview deploys |
| Session/JWT strategy | JWT sessions (Auth.js default) | Stateless, no session table lookups, works cleanly with Bearer-token desktop client |
| Desktop token storage | OS keychain via existing `credentials::SecretStore` (`keyring` crate) | Already integrated in Agentrium; survives WebView2 renderer XSS; never in localStorage |
| OAuth callback bridge | Custom URL scheme (`agentrium://`) via `tauri-plugin-deep-link` | Cleaner UX than loopback; matches Slack / Discord / Linear / GitHub Desktop pattern; already-mature Tauri plugin |
| Sharing landing pages | Next.js server components at `/share/[id]` | Same Vercel deploy as API; SEO / preview cards work; deep-link handoff button |
| Telemetry attribution | Existing `ct-analytics` Cloudflare Worker (extended) | Do not duplicate the heartbeat / error-report infrastructure; add optional `user_id` to existing payload shape |
| Email provider | None in v1 | Skip email verification; add Resend later if abuse appears |

### Alternatives considered and rejected

- **Clerk** — nicer pre-built UI components but Tauri's WebView cannot embed Clerk's iframe-based flows cleanly, and Clerk's pricing scales at 10K MAU vs. Auth.js being free forever. Rejected.
- **WorkOS AuthKit** (from the old spec) — brings a hosted flow and Microsoft provider out of the box, but requires an extra third-party dependency and per-provider setup in the WorkOS dashboard on top of the provider's own OAuth app. For Google + GitHub only, direct OAuth via Auth.js is simpler. Rejected for v1.
- **Cloudflare-primary (better-auth on Workers + D1)** — closer fit to Agentrium's local SQLite, but hand-rolling auth on Workers costs 3-4 days over Auth.js. Rejected for velocity.
- **Supabase full-stack** — would replace Neon with Postgres+RLS, replace Auth.js with Supabase Auth. Comparable in complexity. Rejected because Auth.js has stronger Next.js integration and Supabase's advantages (Realtime, Storage) are not needed for this design.

## 4. Architecture

```
                    Google / GitHub (external)
                            │
                            │ OAuth 2.0 + PKCE
                            ▼
   ┌──────────────────────────────────────────────────┐
   │  agentrium-api  (Vercel — Next.js App Router)    │
   │  ────────────────────────────────────────────    │
   │  /api/auth/*     Auth.js — Google, GitHub,       │
   │                  Credentials (email+password)    │
   │  /api/me         Get current user                │
   │  /api/sync/pull  Delta pull since cursor         │
   │  /api/sync/push  Batch upsert with LWW           │
   │  /api/share      Create share                    │
   │  /api/share/mine List / revoke own shares        │
   │  /api/share/:id  Resolve share (public)          │
   │  /share/[id]     Public landing page (SSR)       │
   │  /account        Web dashboard (post-v1 polish)  │
   └───────────────┬──────────────────────────────────┘
                   │
                   │  SQL over pooled connection
                   ▼
           ┌───────────────────┐
           │  Neon Postgres    │
           │  (Vercel          │
           │  Marketplace)     │
           └───────────────────┘

   ┌──────────────────────────────────────────────────┐
   │  ct-analytics  (Cloudflare Worker — existing)    │
   │  ────────────────────────────────────────────    │
   │  POST /heartbeat  (extended: optional user_id)   │
   │  POST /errors     (extended: optional user_id)   │
   │  D1 tables: extended with optional user_id col   │
   └──────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │  Agentrium (Tauri client — Rust + React)         │
   │  ────────────────────────────────────────────    │
   │  New Rust modules:                               │
   │    auth.rs           OAuth flow, deep-link       │
   │                      callback, token refresh     │
   │    sync.rs           Push/pull loop, LWW,        │
   │                      sync_queue                  │
   │    api_client.rs     HTTP client + auto-refresh  │
   │    share.rs          Create / resolve / import   │
   │  Extended:                                       │
   │    credentials.rs    Store auth tokens too       │
   │    error_reporter.rs Attach user_id when authed  │
   │    database.rs       Migrations for sync columns │
   │  New React components:                           │
   │    LoginModal.tsx    First-launch popup          │
   │    HeaderAuth.tsx    Sign-in button / user chip  │
   │    ShareDialog.tsx   Create share, copy URL      │
   │    ImportShareModal  Deep-link import handler    │
   │    SyncStatusChip    Header sync indicator       │
   │    MySharesPanel     In SettingsModal            │
   │  New store:                                      │
   │    authStore.ts      user, mode, tokens (in-mem) │
   │  Deep-link plugin:   tauri-plugin-deep-link      │
   │  Registered scheme:  agentrium://                │
```

**Two deploys, one client, one telemetry extension.** No custom domain. No email provider. No third-party identity abstraction.

**Trust boundary:** JWT signed by the API, verified in the client only for informational display (name in header). The client never trusts JWTs it holds — every API call re-verifies server-side. Refresh tokens are opaque, stored in the OS keychain, never exposed to JavaScript.

## 5. Data model (Neon Postgres)

### 5.1 Auth.js core tables

Auth.js provisions these automatically via its Postgres adapter — do not hand-write them:

- `users` — `id UUID PRIMARY KEY, email TEXT UNIQUE, name TEXT, image TEXT, email_verified TIMESTAMPTZ`
- `accounts` — OAuth account links (one row per provider per user)
- `sessions` — kept for the JWT adapter but effectively unused since we use JWT strategy
- `verification_tokens` — used for email verification if we ever add it

Auth.js also gets an extra `credentials` table (for email+password) via the Credentials provider adapter.

### 5.2 Syncable resources

All syncable tables share the same shape. Only payload columns differ.

```sql
CREATE TABLE profiles (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  working_directory TEXT,
  claude_args    JSONB NOT NULL DEFAULT '[]',
  env_vars       JSONB NOT NULL DEFAULT '{}',   -- secrets stripped client-side
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  agent          TEXT NOT NULL DEFAULT 'claude',
  agent_args_json JSONB,
  updated_at     TIMESTAMPTZ NOT NULL,          -- LWW key; client's local clock
  deleted_at     TIMESTAMPTZ,                   -- soft delete tombstone
  client_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ON profiles (user_id, updated_at);
CREATE INDEX ON profiles (user_id) WHERE deleted_at IS NULL;
```

Same shape for `hints`, `custom_agents`, `workspaces`. Payload columns mirror the corresponding local SQLite tables in Agentrium today.

### 5.3 App settings

One row per user; not a per-record table:

```sql
CREATE TABLE app_settings (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings    JSONB NOT NULL,                   -- sync-safe keys only
  updated_at  TIMESTAMPTZ NOT NULL
);
```

**Sync-safe key partition** lives in a new `src/lib/settingsSync.ts` module and mirrors what the 2026-08-29 spec listed in section 6.4. In summary: theme, accent color, density, font scale, terminal appearance, editor prefs, notification prefs, sync-relevant defaults. **Local-only** keys: sidebar/grid/split UI state, path overrides, pinned tabs, last-seen version, restore banners.

### 5.4 Shares

```sql
CREATE TABLE shares (
  id                TEXT PRIMARY KEY,             -- 10-char base62 (~60 bits)
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type     TEXT NOT NULL,                -- 'profile' | 'hint' | 'custom_agent'
  resource_snapshot JSONB NOT NULL,               -- frozen copy, secrets stripped
  resource_name     TEXT NOT NULL,                -- for landing page preview
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  view_count        INTEGER NOT NULL DEFAULT 0    -- incremented on landing-page render
);
CREATE INDEX ON shares (user_id, created_at DESC);
```

Share IDs are generated server-side using a CSPRNG and base62-encoded to 10 chars (~60 bits, ~1.15 × 10¹⁸ space). Not enumerable. Collision-checked (retry on conflict, expected zero retries at this cardinality).

### 5.5 Local SQLite additions

Following the existing `database.rs::init_schema` idempotent pattern (loop over `ALTER TABLE ... ADD COLUMN`, ignore "duplicate column name"):

- `profiles`, `hints`, `custom_agents`, `workspaces`: add columns `id TEXT`, `updated_at TEXT`, `deleted_at TEXT`, `client_version INTEGER DEFAULT 1`, `sync_state TEXT DEFAULT 'local_only'`.
- Existing rows without `id` get a fresh UUID via one-shot `UPDATE ... SET id = ?, updated_at = ? WHERE id IS NULL` in Rust code.
- New table `sync_queue`:

```sql
CREATE TABLE sync_queue (
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (table_name, row_key)
);
```

- New table `user_meta`:

```sql
CREATE TABLE user_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Well-known keys: 'logged_in_user_id', 'last_pull_cursor', 'auth_prompt_seen',
--                  'pending_merge_action', 'access_token_expires_at'.
```

Refresh tokens are **not** in `user_meta` — they live only in the OS keychain via `credentials::SecretStore`.

## 6. Auth flows

### 6.1 OAuth (Google, GitHub) — deep-link handshake

1. User clicks `[Sign in with Google]` in `LoginModal`.
2. Frontend invokes `start_oauth_login('google')` IPC.
3. Rust `auth.rs`:
   - Generates 32-byte random `state` nonce.
   - Generates PKCE `code_verifier` (43-char) and `code_challenge` (SHA-256 → base64url).
   - Stores `{ state, code_verifier, expiry: now + 3min }` in in-memory `OAuthPendingMap`.
   - Opens system browser via `tauri_plugin_shell::open` to `https://agentrium-api.vercel.app/api/auth/signin/google?state=<X>&callback=agentrium://auth-return&code_challenge=<Y>&code_challenge_method=S256`.
4. Auth.js on Vercel:
   - Validates the request came from a known callback (`agentrium://auth-return` is in the allowlist).
   - Redirects browser to Google with its own state cookie + PKCE values.
5. User approves on Google.
6. Google redirects to `https://agentrium-api.vercel.app/api/auth/callback/google?code=...&state=<google state>`.
7. Auth.js exchanges the code with Google, creates/updates the `users` row, issues:
   - Access token: JWT, 15-min expiry, signed with `AUTH_SECRET`, payload `{ sub, email, name, image }`.
   - Refresh token: opaque 32 random bytes, hex-encoded, hashed in DB.
8. Auth.js redirects browser to `agentrium://auth-return?token=<jwt>&refresh=<refresh>&state=<original app state>`.
9. OS launches Agentrium's registered deep-link handler (or focuses the running instance).
10. `tauri-plugin-deep-link::on_open_url` fires. Rust `auth.rs`:
    - Parses the URL. Validates `state` matches a pending entry within the 3-minute window.
    - Stores `refresh` in OS keychain under service `agentrium.auth` key `refresh_token`.
    - Holds `token` in `authStore` (in-memory only). Records `access_token_expires_at` in `user_meta` for auto-refresh.
    - Emits `auth-changed` Tauri event with `{ user_id, email, name, image }`.
11. Frontend:
    - `LoginModal` closes.
    - `HeaderAuth` re-renders with the user chip.
    - `sync::start()` begins the debounced sync loop.
    - If this is the first successful login on a device with `sync_state = 'local_only'` rows, run **guest → account migration** (§6.4).

**Failure modes:**

- **State mismatch or expired:** `on_open_url` returns error, `LoginModal` shows toast "Sign-in expired, try again." No stored state.
- **User cancels in browser:** the deep-link never fires. `OAuthPendingMap` GCs the entry after 3 min. UI has a "Cancel" button on the modal that clears the pending entry.
- **Deep-link handler fails to launch:** Auth.js callback page has a fallback "Copy this code and paste into Agentrium" flow (paste box in `LoginModal`). Undocumented in the primary UX; only surfaces if the primary flow errors out.
- **Auth.js returns error page:** modal shows generic "Sign-in failed" with a "Try again" button. Full error logged via `error_reporter::report_bg`.

### 6.2 Email + password

Auth.js `Credentials` provider. Flow is entirely in-app, no browser hop:

- `LoginModal` shows toggle "Or use email + password" that expands to inline form: email, password, "Sign in" / "Create account" buttons.
- Form submits directly to `POST https://agentrium-api.vercel.app/api/auth/signin/credentials` or `POST /api/auth/signup`.
- Server hashes password with `argon2id` (Auth.js default via `@node-rs/argon2`) at signup.
- Server issues same JWT + refresh token pair as OAuth flow.
- Response body includes `{ token, refresh, user }`. Frontend stores tokens exactly as OAuth path.
- No email verification (see non-goal). Duplicate email = error at signup, prompts "Sign in instead?"

Password rules: minimum 8 chars, no other requirement. Bcrypt/Argon2 handles the hard part.

### 6.3 Guest mode

- `LoginModal` has `[Continue as guest]` link at the bottom (not styled as a primary button).
- Click → `authStore.mode = 'guest'`. Set `user_meta.auth_prompt_seen = 1`. Close modal.
- Header shows `[Sign in]` button in top-right.
- All existing local functionality works. `sync_queue` accumulates entries but nothing is pushed.
- When a guest triggers a sync-requiring feature (currently only sharing), an inline dialog appears: "Sharing requires an account. [Sign in] [Cancel]." No popup takeover.

### 6.4 Guest → account migration

Runs immediately after a successful login (OAuth or email+password) if `authStore.previousMode === 'guest'` and any local row has `sync_state = 'local_only'`.

**Algorithm:**

1. Count local rows per table with `sync_state = 'local_only'`.
2. If total is 0, skip silently.
3. If total > 0, no confirmation prompt — just do it. (Design decision from brainstorm: seamless upgrade; asking creates friction.)
4. Wrap in single SQLite transaction:
   - Bump `updated_at = now()` on every `local_only` row.
   - Enqueue every row into `sync_queue`.
   - Flip `sync_state = 'synced'` on every row.
5. Fire the sync pusher immediately (not debounced).
6. On successful push, show a toast: `Imported N profiles, M hints, K agents, W workspaces into your account.` Only for counts > 0.
7. On push failure, keep `sync_state = 'synced'` — the `sync_queue` handles retries, no need to re-do the migration.

**Edge case: user signs in on machine A (uploads), then signs in on machine B (which also has local guest data).** Machine B's guest data collides with machine A's already-synced data by *no key* (fresh UUIDs) — both sides survive as separate records. No merge modal, no dedup. If the user wants to clean up, they do it manually. This is a rare case for solo users; do not over-engineer.

## 7. Sync engine

### 7.1 Model

Per-row upsert with tombstones and a client-driven cursor pull. Conflict resolution is last-write-wins by `updated_at`. Server never rewrites `updated_at`. Clock skew is acceptable for a solo user editing their own data.

### 7.2 Endpoints

All rooted at `https://agentrium-api.vercel.app`.

- `POST /api/sync/pull` — body: `{ since: <ISO8601 or null>, tables?: [string] }`. Returns `{ profiles: [...], hints: [...], custom_agents: [...], workspaces: [...], app_settings?: {...}, server_time: <ISO8601> }`. Only rows with `updated_at > since`, capped at 1000 rows total (client re-pulls with the new cursor if truncated). If `since` is null, full snapshot; the response includes soft-deleted rows so the client can prune.
- `POST /api/sync/push` — body: `{ profiles?: [...], hints?: [...], custom_agents?: [...], workspaces?: [...], app_settings?: {...} }`. Server applies each record:
  - If existing row's `updated_at >= incoming.updated_at`: skip (older loses).
  - Else: upsert (including `deleted_at`).
  - Returns `{ accepted: { table: [ids] }, skipped: { table: [ids] } }`. Client marks accepted rows as synced.
- `POST /api/sync/push` cap: 500 rows or 512 KB per call, whichever hits first. Client batches accordingly.

**Auth:** all `/api/sync/*` require `Authorization: Bearer <access_token>`. On 401, the client auto-refreshes once via `/api/auth/refresh` (returns new access + rotated refresh token) and retries. On second 401, forces logout.

### 7.3 Cadence

- **On app startup**, after auth check: pull with `since = user_meta.last_pull_cursor`.
- **Every 5 minutes** while app is open: pull if cursor is > 5 min old.
- **After any local mutation** on a syncable resource: enqueue into `sync_queue` in the same SQLite transaction, then schedule a debounced push in 5 seconds.
- **On explicit "Sync now"** in the header dropdown: pull + push immediately, bypass debounce.
- **On window focus** (via existing focus event): pull if cursor > 30 sec old, throttled.

### 7.4 Pusher behavior

- Reads up to 500 rows or 512 KB from `sync_queue` per batch.
- **2xx response:** deletes drained queue rows, updates `sync_state = 'synced'` on the pushed rows.
- **4xx (except 401):** reports via `error_reporter::report_bg('sync_push_4xx', ...)`, drops the queue rows (prevents infinite retry of poison rows), surfaces a persistent toast if this happens 3+ times per minute.
- **401:** attempt refresh, retry once, then force-logout if still 401.
- **5xx or network error:** increment `attempts`, next attempt in `min(30 * 2^attempts, 3600)` seconds with 20% jitter.

### 7.5 SQLite migration (one-time, on Agentrium upgrade)

Following existing pattern in `database.rs::init_schema`:

1. `ALTER TABLE` for each syncable table: add `id`, `updated_at`, `deleted_at`, `client_version`, `sync_state`.
2. Rust backfill loop: for every row where `id IS NULL`, `UPDATE ... SET id = <new UUID>, updated_at = <now>, sync_state = 'local_only'`.
3. Create `sync_queue` and `user_meta` tables.

Migration is idempotent (safe to re-run) and does not touch existing data beyond backfilling nulls.

## 8. Sharing flow

### 8.1 Create

- Right-click a shareable resource (profile / hint / custom agent) → `Share…` context menu item.
- Opens `ShareDialog`:
  - Preview panel shows what will be sent: resource name, args, hint description (whichever fields apply). **Secrets and env-var values matching `/API_KEY|TOKEN|SECRET|PASSWORD/i` are visibly stripped ("value hidden")**.
  - Warning banner: *"Anyone with this link can import a copy. You can revoke the link anytime."*
  - `[Create share link]` button.
- On click:
  - Frontend calls `POST /api/share` with `{ resource_type, snapshot }` (client does the stripping; server also strips as defense-in-depth).
  - Server generates ID, inserts row, returns `{ id, url }`.
  - Client copies URL to clipboard via existing `copyText()` helper.
  - Toast: `Share link copied to clipboard.`
- **Guest users:** the context menu item is present but disabled. Tooltip: `Sign in to share.` Clicking a disabled item opens `LoginModal`.

### 8.2 Landing page (public, no auth needed)

- URL: `https://agentrium-api.vercel.app/share/aB3xK9pQr2`
- Next.js server component:
  - `GET /share/[id]` → fetch share by ID → check `revoked_at IS NULL` → increment `view_count` (fire-and-forget) → render.
  - If revoked or 404: render "This share is no longer available" page.
  - Else: render landing page with owner name, resource type badge, resource name, redacted preview, `[Open in Agentrium]` primary button, `[What is Agentrium?]` secondary link.
- `[Open in Agentrium]` triggers `agentrium://import/aB3xK9pQr2` deep link.
- If Agentrium is not installed, the OS shows its default "no app registered for this scheme" behavior. We accept that in v1; a download prompt is a v2 polish.

### 8.3 Import (deep link handler)

- `tauri-plugin-deep-link::on_open_url` recognizes the `import/<id>` path.
- Rust `share.rs::handle_import(id)`:
  - Fetches `GET /api/share/:id` (no auth needed — public resolution endpoint).
  - Emits `share-import-received` event with the payload.
- Frontend `ImportShareModal`:
  - Shows preview (same content as landing page) + `[Import]` `[Cancel]` buttons.
  - On import: generates a fresh UUID for the new local record (does NOT reuse the source ID), inserts locally with `sync_state = 'local_only'` (if guest) or `'synced'` and enqueue push (if authed), toast confirms.

### 8.4 Revoke

- `SettingsModal` gains a `Shares` tab powered by `MySharesPanel`.
- Renders `GET /api/share/mine` — returns `[{ id, resource_type, resource_name, created_at, view_count }]`.
- Each row has `[Copy link]` and `[Revoke]` actions.
- Revoke: `POST /api/share/:id/revoke` (auth required, ownership checked). Sets `revoked_at = now()`. Landing page thereafter renders the "no longer available" state.
- Revocation is irreversible in v1 (no un-revoke UI). Reasoning: undo requires storing intent + audit; not worth it for the rarity of accidental revokes.

### 8.5 What is NOT shareable

- Workspaces (personal machine state — sharing a workspace layout across users has no clear semantics).
- App settings.
- Credentials (never leave the machine, period).
- Session history (deferred entirely).

## 9. Telemetry attribution (extension to ct-analytics)

The existing `ct-analytics` Cloudflare Worker handles anonymous heartbeats and error reports today, using `installation_id` as the correlation key.

**Changes required:**

- Extend the D1 tables for heartbeats and error reports to add a nullable `user_id TEXT` column. Idempotent migration in `workers/ct-analytics/migrations/`.
- Extend the request handlers to accept an optional `user_id` field. When present, store it. Do not validate ownership or authenticate — the Vercel API owns identity; this Worker only tags. Trade-off: a malicious client could tag someone else's user_id, but this only affects telemetry attribution (not auth), so blast radius is zero.
- Client change: in `src-tauri/src/error_reporter.rs`, when reporting, read `authStore` state (via a shared `AuthContext` singleton) and include `user_id` in the payload if signed in.

**No other changes to ct-analytics.** In particular, the Cloudflare Worker does NOT:
- Serve auth endpoints.
- Store sync data.
- Handle share landing pages.
- Know about the Vercel deploy at all beyond receiving `user_id` strings.

Rationale: the two systems are independently deployable and independently rollback-able. Losing the Worker breaks telemetry but not the app. Losing Vercel breaks auth/sync/share but not telemetry.

## 10. Desktop UI

### 10.1 Header widget (`HeaderAuth.tsx`)

Slot in existing `TitleBar.tsx`, between the app icon and the sidebar toggle. States:

- **Guest:** `[Sign in]` pill button, muted color.
- **Authed, sync green:** small circle avatar (from `user.image` or initials fallback) + dropdown chevron. Dot in corner is green.
- **Authed, sync in flight:** same but dot pulses amber.
- **Authed, sync errored (persistent):** red dot.
- **Authed, offline:** grey dot.

Dropdown menu when authed:

```
[avatar] Tal Ayash
         tal@example.com
         Signed in with Google
─────────────────────────────
Sync status: Synced 34s ago
Sync now
─────────────────────────────
Account settings          (opens https://agentrium-api.vercel.app/account
                           in system browser — v1 landing is minimal)
Manage shares             (opens SettingsModal → Shares tab)
Sign out
─────────────────────────────
Delete account…           (danger style; requires typed-email confirm)
```

### 10.2 `LoginModal.tsx`

- Width ~460px, centered, no dismiss X (dismiss = "Continue as guest" or Esc).
- Buttons (top to bottom):
  - `[Sign in with Google]` — full-width, brand blue.
  - `[Sign in with GitHub]` — full-width, dark grey.
  - `─── or ───` divider.
  - `Email` + `Password` inputs.
  - `[Sign in]` + `[Create account]` toggle-pair.
  - Small link at bottom: `Continue as guest →`.
- First-launch trigger: after existing setup wizard completes AND `user_meta.auth_prompt_seen != 1`.
- Re-open trigger: user clicks `[Sign in]` pill in header. Same modal, "Continue as guest" hidden.

### 10.3 `ShareDialog.tsx`

Compact modal (~500px). Shows redacted resource preview + warning + `[Create share link]` primary + `[Cancel]` secondary. On success, shows the link in a copy-box with a `[Copy again]` button, then auto-closes after 3 sec unless user interacts.

### 10.4 `ImportShareModal.tsx`

Fires via `share-import-received` event. Shows resource preview (owner name, resource name, type badge, safe fields) + `[Import]` primary + `[Cancel]`.

### 10.5 `SyncStatusChip.tsx`

Embedded in the header dropdown. Renders `Synced N seconds ago` / `Syncing…` / `Sync paused (offline)` / `Sync failed — retrying`. Clicking `Sync now` fires immediate push+pull.

### 10.6 `MySharesPanel.tsx`

New `Shares` tab in existing `SettingsModal`. Table: `Name | Type | Created | Views | Actions`. Actions: `Copy link` / `Revoke` (with confirm dialog).

## 11. Security

- **JWT signing:** Auth.js default HS256 with `AUTH_SECRET` (generated via `openssl rand -base64 32`). Post-v1 upgrade path to RS256 with a key pair if we ever need multi-service JWT verification.
- **Access tokens:** 15-min TTL. Held in memory only, never persisted.
- **Refresh tokens:** opaque 32 random bytes, hex. Stored in OS keychain (`credentials::SecretStore`) on client; hashed with SHA-256 in Postgres. Rotated on each use.
- **PKCE:** S256 mandatory on OAuth deep-link flow. Verifier held in Rust process memory only.
- **Deep-link hijack protection:** an attacker who registers `agentrium://` on the same OS can intercept the callback URL. Mitigations:
  - PKCE — attacker doesn't have the verifier, so the code is useless.
  - State — attacker can't produce a valid state matching a real pending flow.
  - 3-minute pending-flow TTL narrows the window.
  - Post-v1: consider verifying Agentrium's own OS registration on startup and warning if another app takes it over.
- **CORS:** Vercel API rejects browser requests from origins other than the landing-page domain and `null` (Tauri's origin). Bearer requests from desktop don't hit CORS.
- **CSRF:** N/A — API is Bearer-only, no cookies used from Agentrium.
- **Rate limiting:** Vercel Edge Middleware. `/api/auth/*` = 10 req/min per IP. `/api/sync/push` = 60 req/min per user. `/api/share` create = 20 req/hour per user. `/share/[id]` = 200 req/min per IP (landing page GC).
- **Share ID entropy:** 60 bits ≈ 5.7 × 10¹⁷ space. Brute-force enumeration infeasible even without rate limiting; rate limit is defense-in-depth.
- **Secret stripping** (share + sync payloads):
  - Client-side allowlist filter: keys matching `/API_KEY|TOKEN|SECRET|PASSWORD|BEARER/i` → value replaced with `null` before push.
  - Server-side same filter re-applied as defense-in-depth.
- **Input caps** (413 above these): profile name ≤ 255 chars, `claude_args` JSON ≤ 8 KB, `env_vars` JSON ≤ 8 KB (excluding stripped secrets), share snapshot ≤ 64 KB.
- **Delete Account:** `POST /api/account/delete`, requires JWT + password re-entry (or OAuth re-auth). Cascades to all owned rows in one transaction. Immediate; no 30-day grace in v1.
- **Postgres queries:** all parameterized via Prisma or `postgres` driver — no string concatenation.

## 12. Telemetry integration (frontend + backend)

Follows the existing pattern in `CLAUDE.md`:

- **Frontend user-initiated auth flows** (login, logout, share create, share revoke, delete account): `.catch(err => { toast.error(...); reportInvokeFailure('<command>', err); })` from `src/lib/errorReporter.ts`.
- **Frontend background sync:** silent `.catch(() => {})` on transient errors, one-line comment. Surface via toast only after persistent failure with pending user changes for > 5 min.
- **Rust background sync pusher tokio task:** `error_reporter::report_bg('sync_push', ...)` for real failures.
- **Rust auth/share/sync IPC handlers:** `wrap_cmd` for telemetry attribution. Validation errors (invalid email, malformed OAuth state) go through `error_reporter::user_err` — surfaces to user, skips telemetry.
- **Silent 401 refresh** is expected, not reported.
- **When signed in, error_reporter payload gains `user_id`** (see §9).

## 13. Testing plan

**Rust unit:**
- `auth.rs`: PKCE verifier/challenge round-trip, state generation entropy, `OAuthPendingMap` GC after 3 min.
- `sync.rs`: `sync_queue` enqueue/dequeue, LWW resolver (older loses, newer wins, tombstone semantics), 500-row / 512-KB batching cap, exponential backoff schedule.
- `share.rs`: secret-stripping filter, deep-link URL parsing.
- `credentials.rs`: keychain round-trip for `refresh_token`.

**API integration** (Vitest + a Neon branch DB):
- Every endpoint: happy path + 401 (missing/expired token) + 400 (malformed body) + 500 (DB error, mocked).
- Sync push/pull round-trip: insert on client A, pull on client B, verify equality including timestamps.
- Concurrent push: two synthetic clients push the same row in the same 100ms window, assert LWW correctness and `skipped` in response for the older writer.
- Share resolve after revocation → 410.

**Frontend unit:** first-run popup gating, `LoginModal` state transitions, `HeaderAuth` state rendering (5 states), `SyncStatusChip` states.

**End-to-end** (Playwright via MCP):
- Sign in with Google (using a mocked provider or a dedicated test account).
- Share flow: create → open landing in a second browser → deep-link → import.
- Revoke: create → revoke → landing shows "no longer available."

**Manual test matrix:**
- Windows 11 + macOS: full Google OAuth flow.
- Windows 11 + macOS: full GitHub OAuth flow.
- Windows 11 + macOS: email+password signup + login.
- Verify keychain entries appear in Windows Credential Manager / macOS Keychain Access.
- Kill browser before deep-link fires — verify UI recovers within 3 min timeout.
- Two physical machines: sign in on both, edit a profile on machine A, verify machine B reflects it within 30 sec.
- Share a profile from machine A, import on machine B in a browser.
- Guest → account migration: use as guest, create 3 profiles, sign in, verify all 3 appear on the second machine after sync.

## 14. Migration and rollout

### 14.1 External setup (completed before code)

- ✅ Google OAuth Web application client created (Google Cloud Console, project "Agentrium").
- ✅ GitHub OAuth App created (GitHub Developer Settings).
- ⬜ Vercel project `agentrium-api` created and Neon Postgres provisioned via Marketplace.
- ⬜ Vercel env vars set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET` (generated), `DATABASE_URL` (auto-set by Neon integration).

### 14.2 Repository additions

New repo alongside main Agentrium: `agentrium-api` (Next.js). Alternatively, add as `packages/api/` in a Turborepo — decision deferred to implementation plan.

### 14.3 Local schema migrations (Phase 1, ships in v1.34.0)

- `ALTER TABLE` additions to `profiles`, `hints`, `custom_agents`, `workspaces`.
- Backfill missing `id` and `updated_at` in Rust startup code (idempotent).
- New tables: `sync_queue`, `user_meta`.
- Follows existing `database.rs::init_schema` pattern exactly.

### 14.4 Tauri config additions

- `Cargo.toml`: `tauri-plugin-deep-link`, `reqwest` (if not already present), `sha2`, `base64`, `rand`.
- `tauri.conf.json`: `bundle.deepLink.schemes = ["agentrium"]`, `plugins.deepLink = {}`.
- `capabilities/default.json`: allow `deep-link:default` + keyring plugin operations (`credential` service already permitted).

### 14.5 Environment variables

**On the Vercel `agentrium-api` project:**

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
AUTH_SECRET                 (openssl rand -base64 32)
AUTH_URL                    https://agentrium-api.vercel.app
DATABASE_URL                (Neon auto-set)
NEXT_PUBLIC_APP_ORIGIN      https://agentrium-api.vercel.app
```

**On the ct-analytics Worker (new):**

```
# No new secrets. Only D1 migration.
```

**On the Agentrium client (compile-time consts):**

```rust
pub const AGENTRIUM_API_URL: &str = "https://agentrium-api.vercel.app";
```

### 14.6 Release checklist (follow `.claude/commands/publish.md`)

1. Bump `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md` version to `1.34.0`.
2. `src/changelog.json` entry:
   - Title: `Sign in and sync across your PCs`
   - Body: `Sign in with Google, GitHub, or email/password to sync your profiles, hints, and custom agents across every computer you use Agentrium on. Share profiles with anyone via a public link. Guest mode continues to work as before — no account required.`
3. `cargo check` in `src-tauri/` to update `Cargo.lock`.
4. Commit + tag `v1.34.0` + push.
5. Vercel deploy: separately, `vercel --prod` from the `agentrium-api` project after tests pass on preview.
6. ct-analytics migration: `cd workers/ct-analytics && npx wrangler d1 migrations apply DB && npx wrangler deploy`.
7. GitHub Actions builds installers, signs them, publishes release. Existing users auto-update via `tauri-plugin-updater`.

### 14.7 Rollback

- **Client:** revert to prior version. Local `sync_queue` and `user_meta` tables are harmless if unused; keychain refresh tokens are inert. No data loss.
- **Vercel API:** `vercel rollback` to previous deployment. Data in Postgres survives; a rollback pauses new writes but reads keep working.
- **Postgres data corruption:** Neon has point-in-time recovery — restore to a branch, migrate.
- **Auth completely broken:** flip `AUTH_ENABLED=false` env var → server returns 503 on all `/api/auth/*` endpoints. Client falls back to guest mode; existing local data untouched.

## 15. Open questions and follow-ups (post-v1)

- **Custom domain.** When we ship v1.34.0, users see `agentrium-api.vercel.app` in the OAuth consent screen. Post-v1: register `agentrium.app` and migrate redirect URIs.
- **Email verification.** Add if abuse appears. Resend integration is a 1-day change.
- **Session history sync.** Requires R2 or similar blob storage, and a serious privacy conversation. Revisit when a user asks.
- **Microsoft OAuth.** Add via Azure App Registrations if a user asks (enterprise reach).
- **Admin dashboard.** Read Postgres directly for now. Add UI when user count > 100.
- **Live subscription sharing.** Explicit non-goal for v1; revisit if the sharing feature gets traction and users want "follow" semantics.
- **Team accounts.** Deferred indefinitely; would need a new sharing/permission model.
- **Password reset.** Currently no flow — users can only reset via email verification, which we skipped. Add when email provider is added.
- **Account deletion 30-day grace period.** V1 hard-deletes immediately. Add restore window if users report accidental deletion.

## 16. Glossary

- **`installation_id`** — existing anonymous per-install UUID in local `app_meta`. Persists across launches. Sent with heartbeats and error reports. Unchanged by this spec.
- **`user_id`** — UUID assigned by Auth.js on first signup. Stable across the user's lifetime. Optional field on error reports and heartbeats when signed in.
- **Access token** — short-lived JWT (15 min). Held in memory only. Presented as `Authorization: Bearer <token>`.
- **Refresh token** — opaque 32 random bytes, hex-encoded. Stored in OS keychain client-side; SHA-256 hash server-side. Rotated on every use.
- **Sync-safe key** — a Zustand `partialize` key whose value is not machine-specific and is therefore included in the settings blob crossing the wire.
- **`sync_state`** — per-row local column: `'local_only'` (never pushed) | `'synced'` (server has it) | `'pending'` (in sync_queue).
- **LWW (last-write-wins)** — conflict resolution rule: incoming write wins iff `incoming.updated_at > existing.updated_at`.
- **Share snapshot** — a frozen JSON copy of a resource stored in the `shares.resource_snapshot` column. Independent of the source resource; not affected by later edits.
- **PKCE (Proof Key for Code Exchange)** — OAuth 2.0 extension that binds an auth code to the specific client that started the flow via a client-generated verifier/challenge pair.
