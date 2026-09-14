# Admin Dashboard (`/admin`) Design

**Date:** 2026-09-13
**Status:** Approved in brainstorming, awaiting spec review
**Supersedes:** the "admin dashboard" non-goal in `2026-09-11-auth-sync-sharing-design.md` (Section 2, Section 15) and the archived Phase C plan `2026-08-29-account-auth-phase-c-admin-dashboard.md`.

## 1. Goal

One password-protected page at `https://www.agentrium.app/admin` that replaces `/stat` and `/inbox` and adds account data from the Neon Postgres behind `agentrium-api`. It answers, in one place: who is online, who signed up, what broke, and who wrote to us.

Chosen layout: **tabbed single page** (direction B from the brainstorm). Five tabs, one page shell, the URL hash selects the tab.

## 2. Non-goals

- Per-user admin accounts, roles, or an audit log. One shared password.
- Write actions on accounts (revoke sessions, delete user, edit profile). Read-only.
- Charts of signed-in daily actives over time. Today-only signed-in count in v1.
- Changing what the desktop client reports beyond the additive `client` object in Section 7.
- Mobile-first polish. The page must not break on a phone, but desktop is the target.

## 3. Repositories touched

| Repo | Role | Change |
| --- | --- | --- |
| `talayash/claude-terminal-website` (Astro 6, Vercel) | Serves `/admin`, holds secrets in edge functions | New page, new and changed `api/*.js` edge proxies, tests |
| `talayash/agentrium` `workers/ct-analytics` (Cloudflare Worker, D1 + KV) | Telemetry, errors, feedback | Two new token-gated routes: login rate limit, installation match |
| `talayash/agentrium-api` (Next.js 15, Drizzle, Neon) | Accounts and sync data | New read-only `/api/admin/*` routes, two migrations, `client_info` writes |
| `talayash/agentrium` desktop | Sends device info at sign-in and refresh | Additive `client` object in three request bodies |

Deploy order: API migrations, API routes, Worker, website, desktop release.

## 4. Page structure

File: `src/pages/admin.astro`. `<meta name="robots" content="noindex, nofollow, noarchive">` like the pages it replaces.

### 4.1 Shell

- Header: logo, "Admin", the `/admin` path pill, a live pill ("N active now"), last-refresh time, refresh button, logout button.
- Sticky tab bar directly under the header. Tabs: **Overview · Users · Telemetry · Errors · Inbox**.
- Tab badges: Errors shows the number of distinct error groups in the last 24 hours; Inbox shows unread count. Badges hide at zero.
- `location.hash` is the tab state: `#overview` (default), `#users`, `#telemetry`, `#errors`, `#inbox`. Changing tab writes the hash; `hashchange` renders. Unknown hash falls back to overview.
- Only the active tab's panel is in the DOM flow; the others are `hidden`. Each panel fetches on first activation and then on its own poll cadence while visible.
- Style: the site's Midnight Glass tokens (`--night-*`, `--accent`), Inter, `.surface` cards. Dark canvas. The two legacy pages already read `--coral` and `--ink`, which alias into this palette, so their markup moves in unchanged.

### 4.2 Login state

On load the page renders only a centered login card and calls `GET /api/admin-session`. A 204 swaps the card for the shell and starts fetching. A 401 keeps the card. The card has one password field and a submit button. Errors shown inline: "Wrong password." for 401, "Too many attempts. Try again in N minutes." for 429 (N from the `Retry-After` header), "Server misconfigured." for 500. Logout posts to `/api/admin-logout`, then reloads.

### 4.3 Overview tab

- Live banner: active now (15 min window), versions/OS/countries active, and "N signed in" out of active-now once the installation match is available.
- Four KPI tiles: Daily active users today (subtitle "N signed in"), Total installations, Accounts (subtitle "+N in 7 days"), Errors in 7 days (subtitle "N installations affected").
- Two charts: DAU last 30 days (existing line-area renderer from `/stat`), Signups last 90 days (new bar renderer; one bar per day, zero days drawn as baseline).
- Recent accounts: the ten newest users, same columns as the Users table, with a "See all" link that switches to `#users`.
- Poll: live and today every 15 s, history and summary every 5 min, visibility-gated like `/stat`.

### 4.4 Users tab

- Search input, debounced 300 ms, matches email and name case-insensitively.
- Table columns: user (avatar initial, email, name), provider (Google, GitHub, Email), signed up, last seen, devices, app version, OS, profiles, workspaces. Relative times with the absolute time in `title`.
- "Load more" button uses the keyset cursor from the API. Page size 50.
- Clicking a row opens a right-side detail panel with: identity, the linked OAuth providers, up to 20 devices (created, expires, revoked reason, app version, OS, installation id truncated to 8 chars), and the sync footprint lists (profiles with agent and updated time, custom agents, workspaces with terminal count). Deleted sync rows appear struck through.
- The panel never shows env vars, hashes, or tokens because the API never returns them (Section 6).

### 4.5 Telemetry tab

The body of today's `stat.astro` moved in verbatim: live banner, KPI cards, total installations, DAU and heartbeat charts, version adoption stacked area, today's distributions, raw payload. Its script is refactored into shared modules (Section 4.8) so Overview can reuse the renderers. Behaviour is unchanged.

### 4.6 Errors tab

Renders the ct-analytics `/errors/summary` payload, the same data the `/errors` slash command reads:

- Window selector: 1, 7, 30, 90 days (default 7).
- KPI row: total errors, affected installations, unique groups.
- Top groups list (limit 50): occurrences, users, source pill, kind, message, versions, first and last seen. Each row is a `<details>` that expands to the stack in a scrollable `<pre>`.
- Breakdown bars: by source, by version, by OS (existing distribution bar renderer).
- By day: line-area chart for the window.
- Poll every 5 min while visible.

### 4.7 Inbox tab

The body of today's `inbox.astro` moved in verbatim: totals, unread filter, refresh, message cards with "mark read". Its fetches keep `credentials: 'include'`; the browser now sends the session cookie instead of a Basic Auth header, and the page code does not change. Poll every 60 s while visible. Marking a message read also decrements the tab badge.

### 4.8 Front-end module layout

Astro compiles `<script>` imports, so the page logic moves out of inline scripts into `src/lib/admin/`:

- `tabs.ts`: `parseTab(hash): Tab`, `tabHash(tab): string`, `TABS` list. Pure, tested.
- `format.ts`: `formatNumber`, `timeAgo`, `countryFlag`, `osIcon`, `osLabel`, `compareVersionDesc`, `escapeHtml`. Moved from `stat.astro`, tested.
- `charts.ts`: `renderLineArea`, `renderStackedArea`, `renderBars` (new), `renderDistribution`. Moved from `stat.astro`, take an `SVGElement` rather than an id.
- `session.ts`: `checkSession()`, `login(password)`, `logout()`. Thin fetch wrappers.
- `panels/overview.ts`, `panels/users.ts`, `panels/telemetry.ts`, `panels/errors.ts`, `panels/inbox.ts`: one `mount(root)` / `activate()` / `deactivate()` each.
- `admin.astro` `<script>` wires tabs to panels.

All user-controlled strings go through `textContent` or `escapeHtml`, as the current pages do.

## 5. Authentication and session

### 5.1 Cookie

- Name `agentrium_admin`, value `<expires_unix>.<hmac_hex>`, HMAC-SHA-256 over the expires string with `ADMIN_SESSION_SECRET` via Web Crypto. `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` (30 days).
- `api/_lib/admin-session.js` exports `requireAdminSession(request)` returning `null` when valid or a 401 JSON response, `issueSessionCookie()`, `clearSessionCookie()`. Verification is a constant-time compare of the recomputed HMAC and a check that `expires_unix > now`.
- Files under `api/_lib/` are not deployed as functions by Vercel (leading underscore).

### 5.2 Endpoints

| Route | Method | Behaviour |
| --- | --- | --- |
| `/api/admin-login` | POST `{ password }` | Rate limit check (5.3). Constant-time compare with `ADMIN_PASSWORD`. 204 + `Set-Cookie` on match, 401 otherwise. 500 `server_misconfigured` if either env var is missing. |
| `/api/admin-session` | GET | 204 if cookie valid, 401 otherwise. |
| `/api/admin-logout` | POST | 204 + expired `Set-Cookie`. |

### 5.3 Login rate limit

10 attempts per IP per 15 minutes. State lives in the ct-analytics KV because Vercel edge functions have no shared memory. `admin-login.js` reads the client IP from `x-forwarded-for` (first hop) and calls the Worker:

`POST https://ct-analytics.claude-terminal.workers.dev/admin/login_attempt` with header `x-ct-token: CT_STATS_TOKEN` and body `{ "ip": "<ip>" }`. The Worker hashes the IP with its existing `hashIP(ip, STATS_TOKEN)` and increments `rl:admin_login:<hash>` with a 15-minute TTL. Response `{ "allowed": true, "remaining": 7 }` or `{ "allowed": false, "retry_after_seconds": 612 }`. The raw IP is never stored. A successful login does not reset the counter; the window simply expires. If the Worker is unreachable, login fails closed with 503 `rate_limiter_unavailable`.

### 5.4 Gating the proxies

Every data proxy calls `requireAdminSession` first. That includes the existing `stats.js`, `stats-live.js`, `stats-history.js` (currently ungated) and `feedback-list.js`, `feedback-mark-read.js` (currently HTTP Basic Auth, which is removed). `INBOX_PASSWORD` is deleted from Vercel once `/admin` ships.

## 6. Data sources and proxies

### 6.1 Website edge proxies (`api/*.js`)

| Proxy | Upstream | Notes |
| --- | --- | --- |
| `stats.js`, `stats-live.js`, `stats-history.js` | Worker `/stats`, `/stats/live`, `/stats/history` | Existing, now session-gated |
| `feedback-list.js`, `feedback-mark-read.js` | Worker `/feedback/list`, `/feedback/mark_read` | Existing, Basic Auth replaced by session |
| `errors-summary.js` | Worker `/errors/summary` | New. Forwards `days`, `limit` |
| `admin-summary.js` | API `/api/admin/summary` then Worker `/stats/match` | New. Merges (6.4) and strips installation ids before responding |
| `admin-users.js` | API `/api/admin/users` | New. Forwards `q`, `cursor`, `limit` |
| `admin-user.js` | API `/api/admin/users/{id}` | New. `id` from query string, validated as UUID |

API proxies send `x-admin-token: ADMIN_API_TOKEN`. Worker proxies send `x-ct-token: CT_STATS_TOKEN`. All respond `cache-control: no-store` and pass upstream status through; network failure is 502 `upstream_unreachable`, as today.

### 6.2 New Worker routes (`workers/ct-analytics/src/index.ts`)

Both require `x-ct-token`.

- `POST /admin/login_attempt` `{ ip }` → see 5.3.
- `POST /stats/match` `{ installation_ids: string[] }` (max 5000, each ≤ 128 chars) → `{ active_today, active_now }`. `active_today` counts ids present in `daily_dau` for today's UTC date (one `IN (...)` query per chunk of 100). `active_now` counts ids with a `live:<id>` KV key, checked with `KV.get` in parallel batches of 50. Returns 400 `invalid_payload` on a malformed body.

### 6.3 New API routes (`agentrium-api/src/app/api/admin/*`)

All require header `x-admin-token` equal to `ADMIN_API_TOKEN` (constant-time compare in `src/lib/admin-auth.ts`); otherwise 401 `unauthorized`. Missing env var is 500 `server_misconfigured`. Responses are `no-store`. Rate limit 120/min per IP using the existing `ratelimit.ts`.

`GET /api/admin/summary`

```json
{
  "generated_at": "2026-09-13T12:41:07.000Z",
  "users": { "total": 23, "last_7d": 2, "last_30d": 9,
             "by_provider": { "google": 14, "github": 6, "email": 3 } },
  "signups_by_day": [ { "date": "2026-06-16", "count": 0 }, ... 90 entries ... ],
  "devices": { "active": 27, "by_app_version": { "1.33.7": 19, "1.33.6": 8 },
               "by_os": { "windows": 20, "macos": 7 } },
  "sync": { "profiles": 61, "custom_agents": 4, "workspaces": 17, "users_with_sync": 18 },
  "active_installation_ids": [ "…" ]
}
```

- `by_provider`: a user counts as `email` when `password_hash` is not null and has no `accounts` row; otherwise the provider of one linked `accounts` row (alphabetical, since `accounts` has no timestamp; a user has at most one row per provider, so this only matters for multi-provider users).
- `devices.active`: refresh tokens with `revoked_at IS NULL AND expires_at > now()`. `by_app_version` and `by_os` come from `client_info` on those rows; rows without `client_info` count under `"unknown"`.
- `active_installation_ids`: distinct `client_info->>'installation_id'` over active devices. Consumed by the website proxy only, never by the browser.
- `sync.*`: counts of rows with `deleted_at IS NULL`; `users_with_sync` counts distinct users with at least one such row.

`GET /api/admin/users?q=&cursor=&limit=50`

```json
{
  "total": 23,
  "items": [ {
    "id": "uuid", "email": "dana@example.com", "name": "Dana", "image": null,
    "provider": "google", "created_at": "…", "last_seen_at": "…",
    "devices": 1, "app_version": "1.33.7", "os": "windows",
    "profiles": 3, "custom_agents": 0, "workspaces": 1
  } ],
  "next_cursor": "base64url(created_at|id)" 
}
```

- Order: `created_at DESC, id DESC`. Keyset cursor. `limit` clamped 1 to 100. `q` applies `ILIKE '%q%'` on `email` and `name`; `total` respects `q`.
- `last_seen_at`: `MAX(refresh_tokens.created_at)` for the user. Rotation issues a new row on every refresh (roughly every 15 minutes while the app runs), so this tracks activity well enough without a new column.
- `app_version`, `os`: from `client_info` of the newest refresh token; null when absent.

`GET /api/admin/users/{id}`

```json
{
  "user": { …same fields as a list item… },
  "accounts": [ { "provider": "google", "provider_account_id_tail": "…4821" } ],
  "devices": [ { "id": "uuid", "created_at": "…", "expires_at": "…", "revoked_at": null,
                 "revoked_reason": null,
                 "client_info": { "app_version": "1.33.7", "os": "windows", "installation_id": "…" } } ],
  "sync": {
    "profiles": [ { "id": "uuid", "name": "Backend", "agent": "claude", "updated_at": "…", "deleted_at": null } ],
    "custom_agents": [ { "id": "uuid", "name": "…", "binary": "…", "updated_at": "…", "deleted_at": null } ],
    "workspaces": [ { "id": "uuid", "name": "…", "terminals": 4, "updated_at": "…", "deleted_at": null } ]
  }
}
```

- `devices`: newest 20 rows, revoked included.
- Never returned by any admin route: `password_hash`, `token_hash`, `accounts.*_token`, `id_token`, `profiles.env_vars`, `profiles.claude_args`, `profiles.working_directory`, `workspaces.terminals` contents (only the count), `sessions`.
- 404 `not_found` for an unknown id, 400 `invalid_id` for a non-UUID.

### 6.4 Overview merge in `admin-summary.js`

1. Fetch API summary.
2. POST its `active_installation_ids` to Worker `/stats/match`.
3. Respond with the API body minus `active_installation_ids`, plus `"signed_in": { "active_today": n, "active_now": n }`. If the match call fails, `signed_in` is `null` and the page shows "signed in: n/a" rather than failing the whole tile.

## 7. Schema and contract changes in `agentrium-api`

### 7.1 Migration `0007_users_created_at`

```sql
ALTER TABLE "users" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
UPDATE "users" u SET "created_at" = COALESCE(
  (SELECT MIN(r."created_at") FROM "refresh_tokens" r WHERE r."user_id" = u."id"), now());
CREATE INDEX "users_created_at_idx" ON "users" ("created_at" DESC, "id" DESC);
```

`db/schema.ts` gains `createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()` on `users`. The Auth.js adapter ignores unknown columns with defaults, so OAuth signup keeps working; `adapter.test.ts` gains an assertion that a created user has `created_at` set.

### 7.2 `client_info` is written

Request bodies for `POST /api/auth/desktop/token`, `POST /api/auth/desktop/signin-credentials`, `POST /api/auth/desktop/signup`, and `POST /api/auth/refresh` accept an optional

```json
"client": { "app_version": "1.33.7", "os": "windows", "installation_id": "uuid" }
```

validated with zod: each field an optional string, trimmed, 1 to 64 characters; unknown keys stripped. The stored `client_info` is exactly this object. On refresh, if the body carries no `client`, the new token inherits the previous token's `client_info`, so a single old-style refresh does not erase device info. The README API contract section documents the field. Existing tests are extended; `token/route.test.ts` asserts the stored row's `client_info`.

### 7.3 Desktop change (`src-tauri/src/auth.rs`)

`exchange_code`, credential sign-in, signup, and `refresh` request bodies add the `client` object built from the existing app version, OS constant, and `installation_id` from `app_meta`. This is the only desktop change. It is additive on the wire, so older brokers ignore it and older clients keep working with the new broker. The existing `exchange_code` tests pin the body shape including `client`.

## 8. Environment variables

| Where | Name | Purpose |
| --- | --- | --- |
| Website (Vercel) | `ADMIN_PASSWORD` | The login password |
| Website | `ADMIN_SESSION_SECRET` | 32 random bytes, base64, signs the cookie |
| Website | `ADMIN_API_TOKEN` | Sent to agentrium-api admin routes |
| Website | `CT_STATS_TOKEN` | Existing, sent to the Worker |
| Website | `INBOX_PASSWORD` | Removed after launch |
| agentrium-api (Vercel) | `ADMIN_API_TOKEN` | Same value as the website's |
| Worker | `STATS_TOKEN` | Existing, unchanged |

The API `.env.local.example` and README list `ADMIN_API_TOKEN`. The website README gains an "Admin dashboard" section listing its three variables.

## 9. Error handling

- Proxies: pass upstream status through, 502 on network failure, 500 on missing env, never leak upstream error bodies from the API beyond `{ error }` codes.
- Page: every panel has a status pill (`loading… / ok · time / error: message`). A failed poll keeps the last good render. A 401 from any proxy while the dashboard is showing means the cookie expired; the page swaps back to the login card with the message "Session expired, sign in again."
- Login: fails closed when the rate limiter is unreachable (503).
- API admin routes: any thrown error is logged server-side and returned as 500 `internal_error`.

## 10. Testing

Website (`vitest`):
- `tests/admin-session.test.js`: cookie issue/verify round trip, tampered signature rejected, expired rejected, constant-time compare used.
- `tests/admin-login.test.js`: 204 on match with `Set-Cookie`, 401 on mismatch, 429 with `Retry-After` when the rate limiter denies, 503 when it is unreachable, 500 when env is missing. Worker fetch is mocked.
- `tests/admin-proxies.test.js`: each data proxy returns 401 without a cookie and forwards with the right header when the cookie is valid.
- `src/lib/admin/tabs.test.ts`, `format.test.ts`: pure function coverage.
- `content-lint.test.js`: add "admin.astro composes the five tabs" and "no page other than admin.astro fetches /api/admin-*"; keep the existing `/stat` alias assertions until the redirect lands, then retarget them to `admin.astro`.
- `build-smoke.test.js`: unchanged, must still pass.

Worker (`vitest` + Miniflare pool): `/admin/login_attempt` counts and denies at 11, TTL set; `/stats/match` counts correctly with seeded `daily_dau` and `live:` keys, rejects oversize payloads.

API (`vitest`): admin routes 401 without token; summary shape and provider classification; users list ordering, search, cursor continuation; detail 404 and field exclusion (assert `password_hash`, `env_vars`, `token_hash` never appear in the serialized body); `client_info` stored on token exchange and inherited on refresh.

Desktop (`cargo test`): `exchange_code` body includes `client` with the three fields.

Manual end-to-end before launch: sign in with a wrong password (401), eleven times (429), right password, all five tabs load real data, mark a message read, open a user detail, log out, reload shows login.

## 11. Rollout

1. Apply API migration `0007`, deploy API with admin routes and `client_info` writes, set `ADMIN_API_TOKEN`.
2. Deploy Worker with the two new routes.
3. Set website env vars, deploy website with `/admin`. `/stat` and `/inbox` still work.
4. Ship the desktop release that sends `client`. Device data fills in as users sign in or refresh.
5. Two weeks after step 3: add to `astro.config.mjs` `redirects: { '/stat': '/admin#telemetry', '/inbox': '/admin#inbox' }`, delete `stat.astro` and `inbox.astro`, remove `INBOX_PASSWORD`, retarget the content-lint alias tests.

Rollback: revert the website deploy; the API and Worker additions are inert without callers.

## 12. Open items resolved during design

- Rate limiting: through Worker KV, fail closed (chosen over "no limit, long password").
- Signed-in DAU history: out of scope for v1; today-only via `/stats/match`.
- Location of the page: website repo, not a new Cloudflare Pages project (the archived Phase C plan's `stat.agentrium.app` idea is dropped).
