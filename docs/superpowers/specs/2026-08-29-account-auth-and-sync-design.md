# Account authentication and cross-device sync

- **Date:** 2026-08-29
- **Status:** Design approved, ready for implementation planning
- **Owner:** Tal Ayash
- **Related code paths:** `src-tauri/src/database.rs`, `src/store/appStore.ts`, `src/components/TitleBar.tsx`, `workers/ct-analytics/src/index.ts`

## 1. Executive summary

Add optional user accounts to Agentrium so end users can sign in on multiple PCs and have their profiles, workspaces, snippets, settings, and session history follow them. Guest mode remains fully supported. Ships in three phases behind killswitch env vars.

Identity is delegated to **WorkOS AuthKit** (Google, GitHub, Microsoft social, plus email/password). Application data lives in the existing **Cloudflare Worker + D1 + KV** stack that already powers `/stat` analytics, plus **R2** for session log bodies. The admin `/stat` dashboard becomes a small Cloudflare Pages site gated by the same login system, with a new Users tab for tracking who is using the app.

No 2FA in v1. No plan/tier concept in v1. No cross-device session resume (Claude Code CLI stores actual session state on-disk per machine outside this app's control).

## 2. Non-goals

- Cross-device Claude Code session *resume*. Session history metadata and log bodies sync so the user can browse from any PC, but resuming with `claude --resume <id>` still requires the Claude Code CLI's local state on that PC.
- Multi-user collaboration on the same resource. Each user has private data; no sharing, no team accounts.
- CRDT or three-way merge on conflicts. Last-write-wins per row is the ceiling for v1.
- Migrating anonymous `installation_id` heartbeats retroactively into user accounts. Once a user logs in, their `installation_id` is linked forward; historical anonymous heartbeats stay anonymous.
- A managed subscription tier. Every user gets the same features. Plans are a follow-up when there is a reason for them.
- Feature parity between guest and logged-in mode. Guest mode has no cloud data. There is no "local-only account" concept.

## 3. Chosen stack and rationale

| Layer | Choice | Why |
|---|---|---|
| Identity provider | WorkOS AuthKit | 1M MAU free; hosted flow works naturally for desktop OAuth via loopback; ships Google/GitHub/Microsoft with a toggle; supports email/password without extra wiring |
| API compute | Cloudflare Workers (extend existing `ct-analytics`) | Already deployed, already handles heartbeats; sharing the runtime avoids duplicating WorkOS session verification into two services |
| User database | Cloudflare D1 (extend existing) | Same engine as local SQLite; schema shapes port over cleanly; already bound to the Worker |
| Session store | D1 `sessions` table with SHA-256 token hashes | Simple, revocable, no separate KV lookup needed |
| Blob storage | Cloudflare R2 | Session log bodies uploaded via presigned URLs; ingress is free, storage is cheap |
| CAPTCHA (future) | Cloudflare Turnstile | Not in v1; noted for later if email signup abuse appears |
| Admin dashboard | Cloudflare Pages (new project under `workers/`) | Same repo, separate deploy; independent rollback |
| Desktop session storage | OS keychain via `tauri-plugin-keyring` | Never store session tokens in localStorage; keychain survives WebView2 renderer XSS |

Alternatives considered and rejected:

- **Fully Cloudflare-native (better-auth on Workers + D1)**. Attractive because no third party sees user emails, but adds meaningful implementation and maintenance surface (email delivery, password reset flows, provider registrations, session refresh logic). WorkOS's free tier and hosted flow buy 3 to 4 days of saved work at zero incremental cost.
- **Clerk**. Comparable to WorkOS but Clerk's pre-built React components are the value prop and Tauri's WebView cannot embed browser-based OAuth iframes cleanly. Also priced above 10K MAU vs WorkOS's 1M.
- **Supabase full-stack**. Would replace D1 with Postgres for user data, forking us off Cloudflare for half of ct-analytics's storage. The consistency benefit of keeping ct-analytics data in one Cloudflare project outweighs Supabase's slightly better RLS ergonomics.

## 4. Phase sequencing

The three subsystems are speced together so the shared data model is designed once, but they ship as three independent releases with killswitch env vars for rapid rollback.

| Phase | Ships in | Target | User-visible surface |
|---|---|---|---|
| A - Identity | v1.33.0 (~1 week) | Login, header widget, first-run popup, delete account | Sign in / sign out works end to end; no sync yet |
| B - Sync | v1.34.0 (~2 weeks after A) | Debounced push, cursor pull, merge modal, R2 log upload | Data crosses devices |
| C - Admin dashboard | v1.35.0 (~1 week after B) | Cloudflare Pages site, Users tab, admin_audit | New `/stat` dashboard for tracking users |

Phase A ships the sync tables and local schema migrations even though the sync loop is dormant. This decouples the risky one-shot DB migration from the code change that starts using it, so phase B is code-only.

## 5. Identity model

### 5.1 Data ownership

- **WorkOS is the source of truth for identity**: email, provider, password hash (if used), OAuth tokens, email verification state.
- **D1 is the source of truth for application state**, keyed on the WorkOS user_id (a stable ULID like `user_01H...`).
- The Tauri app **never talks to WorkOS directly**. All identity operations route through the Worker, which holds the WorkOS API key. This keeps the API key server-side and gives the Worker a single choke point for admin flag application and audit logging.

### 5.2 D1 schema additions

```sql
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,              -- WorkOS user id, source of truth
  email TEXT NOT NULL,                   -- denormalized for admin search; refreshed on webhook
  provider TEXT NOT NULL,                -- 'google' | 'github' | 'microsoft' | 'password'
  created_at TEXT NOT NULL,              -- first-ever signup timestamp (ISO8601)
  last_seen_at TEXT NOT NULL,            -- updated on every authed request
  deleted_at TEXT,                       -- soft-delete tombstone; NULL for active
  admin INTEGER NOT NULL DEFAULT 0       -- 1 = /stat access; seeded from ADMIN_EMAILS env
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_last_seen_at ON users(last_seen_at);

CREATE TABLE user_installations (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  first_linked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  os TEXT,
  os_version TEXT,
  app_version TEXT,
  PRIMARY KEY (installation_id, user_id)
);
-- Many-to-many on purpose: one user, N PCs; one PC (shared) linked to N users over time.

CREATE TABLE sessions (
  session_token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the raw token
  user_id TEXT NOT NULL REFERENCES users(user_id),
  installation_id TEXT NOT NULL,         -- which PC this session belongs to (NULL for browser)
  origin TEXT NOT NULL,                  -- 'desktop' | 'dashboard'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

Session tokens are 32 random bytes, hex-encoded (64 chars). D1 stores only the SHA-256 hash. Raw tokens exist only in the OS keychain (desktop) or in an HttpOnly `ct_session` cookie (dashboard). A D1 dump does not enable impersonation.

### 5.3 Denormalized email

`users.email` is a denormalized copy of the WorkOS-side email. It is refreshed by a `POST /webhooks/workos` endpoint that receives the `user.updated` event from WorkOS, signature-verified with `WORKOS_WEBHOOK_SECRET`. The endpoint updates `users.email` and `users.provider` when they change on the WorkOS side.

## 6. Sync engine

### 6.1 Sync model

Per-row upsert with tombstones and a client-driven cursor pull. Every syncable row locally and in D1 has two columns:

- `updated_at TEXT NOT NULL` (RFC3339 with milliseconds, client's local clock at write time)
- `deleted_at TEXT` (soft-delete tombstone)

Conflict resolution is last-write-wins by row `updated_at`. Server never rewrites `updated_at`. Skew is acceptable for a solo user editing their own data.

### 6.2 D1 sync tables

```sql
CREATE TABLE user_profiles (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,           -- ConfigProfile.id, matches local
  name TEXT NOT NULL,
  description TEXT,
  working_directory TEXT NOT NULL,
  claude_args TEXT NOT NULL,          -- JSON
  env_vars TEXT NOT NULL,             -- JSON
  is_default INTEGER NOT NULL,
  preview_json TEXT,
  agent TEXT NOT NULL,
  agent_args_json TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, profile_id)
);
-- user_workspaces, user_snippets, user_session_summaries mirror this shape.

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,        -- Zustand partialize, sync-safe keys only
  updated_at TEXT NOT NULL
);

CREATE TABLE user_session_history (
  user_id TEXT NOT NULL,
  history_uuid TEXT NOT NULL,             -- new stable cross-device id (local gains it too)
  terminal_id TEXT NOT NULL,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  agent TEXT NOT NULL,
  origin_installation_id TEXT NOT NULL,   -- which PC recorded it
  origin_working_directory TEXT,          -- read-only text on other PCs
  claude_session_id TEXT,
  log_r2_key TEXT,                        -- 'users/<user_id>/logs/<history_uuid>.log.gz'
  log_size_bytes INTEGER,
  log_uploaded_at TEXT,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (user_id, history_uuid)
);
```

### 6.3 Local schema additions

Following the existing `database.rs::init_schema` idempotent pattern (loop over `ALTER TABLE ... ADD COLUMN`, ignore "duplicate column name"):

- `profiles`, `workspaces`, `snippets`, `session_history`, `session_summaries`: add `updated_at TEXT` and `deleted_at TEXT`. Existing rows backfilled with `updated_at = now()` via a one-shot `UPDATE ... WHERE updated_at IS NULL`.
- `session_history`: add `history_uuid TEXT UNIQUE`. Existing rows backfilled with `Uuid::new_v4()`. The autoincrement `id` stays for existing local queries.
- New table `sync_queue`:

```sql
CREATE TABLE sync_queue (
  table_name TEXT NOT NULL,       -- 'profiles', 'workspaces', 'settings', ...
  row_key TEXT NOT NULL,          -- primary key of the local row (or 'settings')
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (table_name, row_key)
);
```

- New table `user_meta` (local): stores `logged_in_user_id`, `last_pull_cursor`, `auth_prompt_seen`, `pending_merge_choice`.

### 6.4 Sync-safe settings partition

The Zustand `partialize` list in `src/store/appStore.ts` is split into two constant arrays in a new `src/lib/settingsSync.ts` module:

**Synced (cross-device)**: `defaultAgentArgs`, `defaultClaudeArgs`, `notifyOnFinish`, `restoreSession`, `telemetryEnabled`, `errorReportingEnabled`, `lspEnabled`, `costTrackingEnabled`, `sessionBudgetUsd`, `showGitPanel`, `showFileTree`, all `terminal*` appearance keys, all `editor*` keys, all `vcs*` keys, `themeMode`, `uiDensity`, `tabHeight`, `colorfulFolderIcons`, `accentColorHex`, `uiFontScale`, `uiReduceMotion`, `uiReduceMotionUserSet`, `dnd*`, `sessionAutoSaveIntervalSec`, `confirmOnAppClose`, `notificationSoundEnabled`, `pasteAutoDetectEnabled`, `pasteAutoDetectThresholdBytes`, `pasteAutoDetectThresholdLines`, `pastePromptTemplate`, `pasteRetention`, `pasteRetentionDays`, `promptEditorShortcutEnabled`, `claudeDefaultModel`, `paletteUsage`.

**Local-only (per-machine)**: `pinnedRepoPath`, `terminalShellPathOverride`, `claudeBinaryPathOverride`, `sidebarOpen`, `sidebarCollapsed`, `hintsOpen`, `changesOpen`, `gridMode`, `gridLayout`, `gridTerminalIds`, `splitMode`, `splitTerminalIds`, `splitRatio`, `splitOrientation`, `openFiles`, `activeFilePath`, `pendingRestoreConfigs`, `showRestoreBanner`, `sessionsCollapsed`, `explorerCollapsed`, `explorerHeightRatio`, `sessionsHeightRatio`, `repositoriesHeightRatio`, `pinnedTabIds`, `lastSeenVersion`.

The partition is compile-time. Any new Zustand key must be classified in `settingsSync.ts`; a `never`-exhaustiveness check in TypeScript catches new keys that were missed.

### 6.5 Endpoints

All under the extended `ct-analytics` Worker.

- `POST /auth/callback` (body: `{ code, code_verifier, installation_id, origin: 'desktop'|'dashboard' }`) exchanges the WorkOS OAuth code, upserts `users`, creates a `sessions` row, returns `{ session_token, user: { user_id, email, provider }, is_new_installation }`. For `origin: 'dashboard'`, also sets HttpOnly `ct_session` cookie with `SameSite=Lax; Secure`.
- `POST /auth/logout` (Bearer or cookie) revokes the current `sessions` row.
- `GET /auth/me` returns the current user; used for header hydration.
- `POST /webhooks/workos` receives WorkOS user.updated events; verifies signature.
- `POST /account/delete` sets `users.deleted_at`, revokes all sessions, schedules R2 prefix for GC.
- `POST /account/restore` clears `deleted_at` if within 30 days.
- `POST /sync/pull` (body: `{ cursor: <ISO8601 or null> }`) returns `{ rows: {...}, deletions: {...}, next_cursor }` for everything with `updated_at > cursor`.
- `POST /sync/push` (body: `{ profiles?, workspaces?, snippets?, session_history?, settings?, deletions? }`) upserts by primary key when incoming `updated_at` >= stored. Returns `{ accepted: [...], skipped: [...] }`.
- `POST /sync/session-log/upload-url` (body: `{ history_uuid, log_size_bytes }`) returns a presigned R2 PUT URL, TTL 5 minutes, with `Content-Length` bound. Rejects if `log_size_bytes > 10 * 1024 * 1024`.
- `GET /sync/session-log/:history_uuid/download-url` returns a presigned R2 GET URL, TTL 5 minutes.
- `GET /admin/users?q=&sort=&order=&limit=50&cursor=` paginated, admin-gated.
- `GET /admin/users/:user_id` per-user detail, admin-gated.
- `POST /admin/users/:user_id/revoke_sessions` force-logout, admin-gated.
- `GET /admin/audit?since=&limit=` admin action trail, admin-gated.
- Existing `POST /heartbeat` extended with optional `user_id` field; when present and a valid session accompanies it, additionally upserts `user_installations` and refreshes `users.last_seen_at`.

### 6.6 Client cadence

Wrap every local write (`save_profile`, `save_workspace`, `insert_session_history`, `update_session_ended`, `save_snippet`, `save_session_summary`, and any change to a sync-safe setting) in a `SyncEnqueue` module. On write:

1. Bump the row's `updated_at`.
2. Insert / update the matching `sync_queue` row.
3. Schedule a debounced `POST /sync/push` in 5 seconds.
4. Coalesce subsequent scheduling calls into the same batch.

Pusher behavior:

- Reads up to 500 rows or 512 KB from `sync_queue` per batch.
- On 2xx: deletes the drained queue rows.
- On 4xx (except 401 with refresh): reports via `error_reporter::report_bg`, drops the queue rows to prevent infinite retry of a poison row, and surfaces a persistent-failure toast.
- On 5xx or network error: increments `attempts`, next attempt in `min(30 * 2^attempts, 3600)` seconds with 20% jitter.

Full pull runs on:

1. App startup after auth check completes, using `user_meta.last_pull_cursor`.
2. Window focus, throttled to at most once per 30 seconds.
3. Explicit "Sync now" in the header dropdown.

Log upload is triggered by the existing `terminal-finished` event: client gzips the log file at `session_history.log_path`, requests a presigned URL, PUTs directly to R2, then pushes the `log_r2_key`/`log_size_bytes`/`log_uploaded_at` row update through the normal sync path.

### 6.7 Merge-on-first-login modal

On the first successful login on a device that has non-empty local sync tables:

1. Client does `POST /sync/pull` with `cursor=null` and counts rows per table.
2. Modal presents totals side by side: "Account: 12 profiles, 3 workspaces, 47 sessions. This PC: 3 profiles, 1 workspace, 0 sessions."
3. Three actions:
   - **Merge (keep both)**: union by primary key; on collision `updated_at` wins.
   - **Replace local with account**: wipe local sync tables (respecting foreign keys), apply pulled rows.
   - **Push local up to account**: bump every local `updated_at` to `now()`, enqueue all rows in `sync_queue`, push.
4. Chosen action runs as a single SQLite transaction locally, then the normal push loop takes over.

The choice is persisted in `user_meta.pending_merge_choice` before running so an app crash mid-transaction can be resumed on next launch.

## 7. Desktop UI

### 7.1 Header (left side of `TitleBar.tsx`)

New slot between the app icon and the sidebar toggle. Three states: **Guest** (a "Sign in" pill), **Logged in, synced** (avatar with initials, email preview, sync-status dot), **Logged in, syncing** (same but dot is a half-filled circle).

Sync-status dot colors:
- Green: last successful sync within 60 seconds
- Amber: sync in flight
- Red: sync failure past 5 minutes with pending changes
- Grey: offline (no network)

Dropdown from the signed-in state:

```
TA   Tal Ayash
     tal@lognet-systems.com
     Signed in with Microsoft
---
Sync status: Synced 34s ago
Sync now
---
Manage account            (opens WorkOS-hosted profile in system browser)
Sign out
Delete account...         (danger-styled, typed-email confirm)
```

### 7.2 First-run popup

Fires the first time the app boots after upgrading to (or fresh-installing) an auth-enabled version, *after* the existing setup wizard completes. Gate: `user_meta.auth_prompt_seen` is set to 1 on any interaction (login attempt, "Continue as guest", or Esc). Never re-fires unprompted.

Modal is ~460px wide, centered, no dismiss X. Three provider buttons, an "or sign in with email" toggle that expands to reveal the email+password form, and a "Continue as guest" link at the bottom.

The same modal (minus "Continue as guest") is reused when the header's "Sign in" pill is clicked.

### 7.3 OAuth loopback flow

Windows and macOS desktop OAuth uses the loopback pattern:

1. Frontend calls `invoke('start_oauth_login', { provider })`.
2. Rust backend binds a `tiny_http` listener on `127.0.0.1:0` (kernel-picked port), generates a 32-byte `state` nonce and PKCE code_verifier / S256 challenge, stores them in memory.
3. Backend builds `https://api.workos.com/user_management/authorize?client_id=...&provider=<google|github|microsoft>&redirect_uri=http://127.0.0.1:<port>/callback&state=<nonce>&code_challenge=<challenge>&code_challenge_method=S256` and opens it via `tauri_plugin_shell::open`.
4. User completes login in the system browser. WorkOS redirects to the loopback with `?code=...&state=...`.
5. Listener validates `state`, closes, POSTs `{ code, code_verifier, installation_id, origin: 'desktop' }` to the Worker's `/auth/callback`.
6. Worker returns `{ session_token, user, is_new_installation }`.
7. Backend stores `session_token` in the OS keychain via `tauri-plugin-keyring` under service `agentrium` key `session_token`, emits `auth-changed` to the frontend.
8. Frontend runs the merge-decision path if `is_new_installation`, then enables the debounced-sync loop.

Failure modes:
- **Loopback port blocked**: 8-second bind timeout; fall back to custom URI scheme `agentrium://auth/callback`, registered in `tauri.conf.json` under `bundle.deepLink`.
- **User cancels in browser**: 3-minute overall timeout; listener drops, soft toast "Login cancelled".
- **State mismatch**: listener returns 400, Rust returns error to frontend.
- **Worker returns non-2xx**: modal shows error with "Try again" button; no partial state stored.

### 7.4 Logout and re-login

Logout confirm: "Sign out? Your synced data stays on the cloud and will be restored next time you sign in."

- Client calls `POST /auth/logout` (revokes the `sessions` row).
- Client wipes the keychain token.
- **Local sync data stays intact.** The user is now in guest mode with the data they had a moment ago.

Re-login:
- Same account on this PC: Worker sees the `installation_id` already linked, returns `is_new_installation: false`. Client skips the merge modal, resumes pushing. Any guest-mode edits get pushed on the first debounced fire.
- Different account on this PC: `is_new_installation: true`. Merge modal fires.

### 7.5 Delete account

Dropdown entry opens a confirm modal that requires typing the user's email. On confirm:

- Client calls `POST /account/delete`.
- Worker sets `users.deleted_at = now()`, revokes all sessions, enqueues R2 prefix `users/<user_id>/*` for cron deletion in 30 days.
- Client wipes local sync tables and keychain token.
- Header returns to guest mode.
- If the user signs back in to the same account within 30 days, the Worker's `/auth/callback` checks `users.deleted_at IS NOT NULL` and returns `410 { error: 'account_deleted', restorable_until }`. Login modal shows the restore path with a "Restore my account" button that clears `deleted_at` and cancels the R2 GC.

## 8. Admin `/stat` extensions

### 8.1 Access model

Existing static-token gate stays for CLI use (`x-ct-token: <STATS_TOKEN>`). Browser flow uses cookie-based auth:

1. `/stat/*` and `/admin/*` requests read `ct_session` cookie; look up `sessions` row; check `users.admin = 1`.
2. Not authed: 302 to `/stat/login`.
3. Not admin: 403.
4. Admin: allow and audit-log.

Admin flag is seeded from `ADMIN_EMAILS` env var. On every `/auth/callback` completion, the Worker sets `users.admin = 1` for any email in that list (idempotent). Adding an admin means redeploying with an updated env var. No in-UI admin toggle in v1.

### 8.2 Dashboard hosting

Cloudflare Pages project under `workers/ct-analytics-dashboard/`. Small React SPA. Deployed independently from the Worker. Talks to Worker endpoints via `fetch` with credentials. Login page has one "Sign in" panel with the three OAuth buttons; browser-native flow (no loopback).

### 8.3 Additional D1 table

```sql
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- 'view_users', 'view_user', 'revoke_sessions', 'view_audit'
  target_user_id TEXT,
  details_json TEXT,                  -- e.g. {"query": "foo", "cursor": "..."}
  at TEXT NOT NULL,
  ip TEXT,
  country TEXT
);
CREATE INDEX idx_admin_audit_at ON admin_audit(at);
CREATE INDEX idx_admin_audit_target ON admin_audit(target_user_id);
```

Every admin endpoint writes one `admin_audit` row *before* returning its response.

### 8.4 Users tab

Response shape for `GET /admin/users`:

```json
{
  "rows": [
    {
      "user_id": "user_01H...",
      "email": "tal@lognet-systems.com",
      "provider": "microsoft",
      "created_at": "2026-01-15T09:12:00Z",
      "last_seen_at": "2026-08-29T14:03:12Z",
      "app_version": "1.32.2",
      "installation_count": 2,
      "session_count_30d": 43
    }
  ],
  "next_cursor": "base64(last_seen_at,user_id)",
  "totals": {
    "total": 1247,
    "signups_24h": 12,
    "signups_7d": 58,
    "signups_30d": 203
  }
}
```

Per-user detail (`GET /admin/users/:user_id`) surfaces:

- Overview: email, provider, created_at, last_seen_at, current app_version, installations count
- Installations table (installation_id, os, os_version, app_version, first_linked_at, last_seen_at)
- Sessions per day sparkline (last 30 days)
- Sync footprint (log storage bytes, last push, last pull)
- Actions: "Revoke all sessions" (confirm), "View audit for this user"

**Never exposed to admin**: log file contents, settings contents, session labels, workspace names, snippet contents. The admin surface is metadata-only. This is the privacy boundary; do not cross it without explicit user consent captured in the audit trail.

### 8.5 Heartbeat extension

The existing `POST /heartbeat` body gains an optional `user_id` field. When present and a valid session token accompanies the request, the Worker:

1. Runs the existing anonymous-heartbeat path (unchanged).
2. Upserts `user_installations` for `(installation_id, user_id)`, refreshing `last_seen_at`, `os`, `os_version`, `app_version`.
3. Updates `users.last_seen_at`.

When `user_id` is absent (guest mode), only the anonymous path runs. This means guest users still contribute to DAU, and the "last seen" and "current app version" columns in the Users tab are refreshed by the ordinary heartbeat rather than a separate polling loop.

## 9. Errors, offline, security

### 9.1 Offline behavior

Every local mutation succeeds against local SQLite unconditionally. `sync_queue` durability inside the same SQLite transaction as the mutation means an app crash between "wrote row" and "queued push" cannot silently drop the sync intent. Pushers are picked up mid-flight on next launch.

Pull failures are silent (log only). Next window-focus or startup retries. No user-visible toast unless a persistent failure has real user changes waiting for >5 minutes.

### 9.2 Auth-error mapping

| Scenario | Server response | Client action |
|---|---|---|
| Session expired mid-request | 401 `{ error: 'session_expired' }` | Silent refresh via WorkOS refresh token; retry request once; if refresh fails, force logout + toast |
| Session revoked | 401 `{ error: 'session_revoked' }` | Wipe keychain, guest state, toast "You were signed out on another device" |
| Email unverified past 7 days | 403 `{ error: 'email_unverified' }` | Non-dismissable banner "Verify your email to enable sync"; sync loop pauses; guest-mode-with-local-data continues |
| Account soft-deleted | 410 `{ error: 'account_deleted', restorable_until }` | Login modal shows restore path |
| WorkOS down | 502 `{ error: 'auth_provider_unavailable' }` | Toast "Sign-in temporarily unavailable" |
| Rate limited | 429 with `Retry-After` | Backoff + retry once transparently; only surface on recurrence |

### 9.3 Sync conflicts and clock skew

`updated_at` is the client's local clock at write time (RFC3339 with milliseconds). Server never rewrites. NTP handles nearly all real-world drift. If two PCs edit the same row in the same 5-second window and skew flips the order, the older-clock write loses. Acceptable for a solo user.

### 9.4 Log upload edge cases

- **Upload fails mid-flight**: local `session_history.log_r2_key` stays NULL. Retry on next sync tick with max 3 attempts, then abandon (metadata syncs; body is unavailable from other PCs).
- **Log too large**: hard cap 10 MB. Tail-truncate with a marker `[log truncated - X.YMB elided]` at the top. Presigned URL enforces `Content-Length` bound so a client cannot smuggle more.
- **Download URL expires**: 5-minute TTL; client fetches a fresh URL if the user clicks the log after expiry.

### 9.5 Security surface

- **Session tokens**: 32 crypto-random bytes, stored server-side as SHA-256 hash. Raw tokens only in OS keychain (desktop) or HttpOnly cookie (dashboard).
- **PKCE S256** on every OAuth flow. Verifier held in Rust memory only, never persisted.
- **CORS**: Worker allowlists only `stat.agentrium.app` origin for cookie-carrying requests. Desktop uses Bearer, no CORS surface.
- **CSRF**: dashboard uses `SameSite=Lax` cookie + double-submit `x-ct-csrf` header on state-changing endpoints. Desktop immune (Bearer, no cookie).
- **Input caps** (413 above these): profile name <= 255, `claude_args` JSON <= 8 KB, `env_vars` JSON <= 8 KB, snippet content <= 256 KB, settings blob <= 64 KB.
- **R2**: presigned URLs only. Path-scoped to `users/<user_id>/*`, 5-minute TTL. Bucket not public.
- **D1**: all queries parameterized (D1 driver enforces).
- **Log content is PII**: no Worker-side logging of log-file contents. Presigned-URL request logs only `history_uuid` and byte count.

### 9.6 Data lifecycle

| Kind | Retention | Purge mechanism |
|---|---|---|
| Tombstones | 30 days | Server cron |
| Session logs (R2 blobs) | Last 100 per user | Nightly cron trims blob + sets `log_r2_key=NULL` (metadata row survives) |
| Expired sessions | Deleted after `expires_at + 24h` | Nightly cron |
| Soft-deleted accounts | 30 days | Cron cascades: D1 rows for `user_id`, R2 prefix `users/<user_id>/*` |
| `admin_audit` | Kept indefinitely | None |

### 9.7 Telemetry integration

Follows the pattern in CLAUDE.md exactly:

- **Frontend user-initiated flows** (login, logout, delete, merge choice): `reportInvokeFailure('<command>', err)` from `src/lib/errorReporter.ts`.
- **Frontend background** (sync retries): swallow silently with a one-line comment; only report after persistent failure past 5 minutes with pending user changes.
- **Rust background** (sync pusher tokio task): `error_reporter::report_bg('sync_push', ...)` for real failures.
- **Rust commands**: `wrap_cmd` for auth/logout/delete/merge-choice IPC handlers. Validation errors (invalid email, malformed OAuth state) go through `error_reporter::user_err` so they surface to the user but skip telemetry.
- **Silent 401 refresh** is expected, not reported.

## 10. Migration and rollout

### 10.1 External setup (do before writing code)

1. **WorkOS**: create account, create Organization, get API key. Enable Google, GitHub, Microsoft providers in AuthKit. For each provider, register an OAuth app on the provider side (Google Cloud Console, GitHub Developer Settings, Azure App Registrations) and paste the client IDs into WorkOS.
2. **Redirect URIs in WorkOS**: `http://127.0.0.1:*/callback` (loopback wildcard), `agentrium://auth/callback` (fallback), `https://stat.agentrium.app/auth/callback` (dashboard).
3. **Webhook**: `POST https://ct-analytics.<your-domain>/webhooks/workos` for `user.updated`; capture signing secret.
4. **Cloudflare**: extend `wrangler.toml` with R2 binding `R2_LOGS`. Create new D1 migration files. Create Pages project for phase C.
5. **DNS**: `stat.agentrium.app` CNAME to Cloudflare Pages (phase C only).

### 10.2 New env vars / secrets on the Worker

```
WORKOS_API_KEY               (secret)
WORKOS_CLIENT_ID
WORKOS_WEBHOOK_SECRET        (secret)
WORKOS_REDIRECT_URIS         "http://127.0.0.1,agentrium://auth/callback,https://stat.agentrium.app/auth/callback"
ADMIN_EMAILS                 "tal.ayash@lognet-systems.com"
SESSION_SIGNING_SECRET       (secret, 32 bytes, used for CSRF double-submit)
AUTH_ENABLED                 "true"
SYNC_ENABLED                 "true"
```

Existing `INGEST_TOKEN` and `STATS_TOKEN` continue to work.

### 10.3 Local schema migrations by phase

**Phase A**:
- `ALTER TABLE profiles ADD COLUMN updated_at TEXT` (and other syncable tables)
- `ALTER TABLE profiles ADD COLUMN deleted_at TEXT` (and other syncable tables)
- `ALTER TABLE session_history ADD COLUMN history_uuid TEXT UNIQUE`
- One-shot backfill: `UPDATE ... SET updated_at = now() WHERE updated_at IS NULL`
- Backfill `history_uuid` for existing rows in Rust code (one pass per open).
- New tables: `sync_queue`, `user_meta`.

**Phase B**: no client-side schema changes.

**Phase C**: no client-side change.

### 10.4 Zustand store version bump

`appStore.ts` currently at `version: 4`. Phase A bumps to `version: 5`. The `migrate` function does not move data; the sync partition is compile-time via `src/lib/settingsSync.ts`.

### 10.5 Tauri config additions (phase A)

- `Cargo.toml`: `tauri-plugin-keyring`, `tauri-plugin-deep-link`, `tiny_http`, `rand`, `sha2`.
- `tauri.conf.json`: `bundle.deepLink.schemes = ["agentrium"]`, `plugins.deepLink = {}`.
- `capabilities/default.json`: allow the keyring plugin's `get`/`set`/`delete` and deep-link's `on-open-url`.

### 10.6 Testing plan

**Phase A**
- Rust unit: OAuth state generation and validation, PKCE verifier/challenge round-trip, keychain save/read/delete round-trip.
- Rust integration: mock a WorkOS callback, assert session stored, `auth-changed` fired.
- Frontend unit: first-run popup gating, login modal state, header widget states.
- Manual: real Google/GitHub/Microsoft flow on Windows + macOS. Verify keychain entries appear in Credential Manager / Keychain Access.
- Manual: kill loopback listener mid-flight, verify graceful timeout + toast.

**Phase B**
- Rust unit: `sync_queue` enqueue/dequeue, batching cap (500 rows / 512 KB), backoff schedule.
- Rust unit: merge decision logic against synthetic local + cloud counts.
- Rust integration: local Miniflare + D1 in-memory, push then pull round-trip, assert row equality including `updated_at`.
- Concurrent test: two synthetic clients pushing the same row in the same 100 ms window, assert last-write-wins and older client sees `skipped: [id]`.
- Log upload: mock R2, verify presigned URL flow + retry-with-backoff on transient failure.
- Manual: install v1.34.0 on two physically distinct PCs, edit a profile on each, verify convergence in <30 s.

**Phase C**
- Playwright: dashboard login flow, assert cookie set + admin gate.
- Playwright: search a user by email substring, click through to detail drawer.
- Unit: `admin_audit` writes precede endpoint responses (assert order).
- Manual: revoke-sessions on your own admin session; verify force-logout on the desktop app within 60 s of window focus.

### 10.7 Rollback per phase

- **Phase A**: revert desktop client version and users go back to no-auth. Local data untouched, dormant WorkOS accounts survive. Server-side, `AUTH_ENABLED=false` blocks new logins without breaking existing keychain tokens (they expire within ~1h).
- **Phase B**: `SYNC_ENABLED=false` returns 503 on `/sync/*`; clients pause the pusher on next attempt. Local data untouched. If a bad push corrupted D1, the 30-day tombstone retention gives a window to `UPDATE ... SET deleted_at = NULL` for affected rows.
- **Phase C**: dashboard is a separate Pages deploy, instant rollback via Cloudflare deployment history. No desktop impact.

### 10.8 Release checklist per phase

Follows `.claude/commands/publish.md`:

1. Bump `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md` version.
2. Add a `changelog.json` entry for What's New modal.
   - Phase A: "Sign in to save your setup across computers."
   - Phase B: "Your profiles, sessions, and settings now sync across every PC you sign in to."
   - Phase C: no user-visible note (internal).
3. `cargo check` in `src-tauri/` to update `Cargo.lock`.
4. Commit, tag `v1.33.0` / `v1.34.0` / `v1.35.0`, push commit and tag.
5. Worker deploy is separate: `cd workers/ct-analytics && npx wrangler d1 migrations apply DB && npx wrangler deploy`. Phase-A desktop release requires the Worker's auth endpoints already live on prod.

### 10.9 Calendar estimate

| Phase | Estimate | Cumulative |
|---|---|---|
| A - Identity | 1 week | week 1 |
| B - Sync | 2 weeks | week 3 |
| C - Admin dashboard | 1 week | week 4 |

## 11. Open questions and follow-ups (post v1)

- **Cross-device session resume**: harder problem because Claude Code CLI stores state per-machine. Possible v2 via a resume manifest that captures enough context to re-hydrate on another PC.
- **Turnstile on email signup**: monitor abuse; add if needed.
- **In-UI admin promotion**: currently env-var only. Add if you need to add teammates without a deploy.
- **Plan tiers**: not needed until there is a reason.
- **Two-factor authentication**: WorkOS supports it via a toggle. Add when the user base or usage patterns justify it.
- **Team accounts / sharing**: out of scope; would need a new sharing-permission model.

## 12. Glossary

- **installation_id**: existing anonymous per-install UUID stored in local `app_meta`. Persists across launches on the same machine. Sent with every heartbeat and now with every sync request.
- **user_id**: WorkOS ULID assigned on first signup. Stable across the user's lifetime.
- **session_token**: opaque 32-byte credential exchanged for a session. Never rewritten by the server; revoked by setting `sessions.revoked_at`.
- **history_uuid**: stable cross-device id for a session_history row. Introduced by this spec because the existing autoincrement `id` is not portable.
- **Sync-safe key**: a Zustand `partialize` key whose value is not machine-specific and therefore is included in the settings blob crossing the wire.
- **Merge modal**: the one-time UI shown on first login on a device with local data, offering merge / replace / push.
