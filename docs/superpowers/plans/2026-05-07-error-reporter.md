# Error Reporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Rust panics, Tauri command errors, and frontend exceptions and forward them to the existing `ct-analytics` Cloudflare Worker so they can be triaged from D1.

**Architecture:** Single ingest path. Every error source ends up calling `error_reporter::report(...)` in Rust, which scrubs PII, dedupes by fingerprint (60s window in-memory), and POSTs to a new `/error_report` route on the existing worker. The worker writes one row per non-throttled report into a new `errors` D1 table. A daily Worker cron deletes rows older than 90 days. A Settings toggle (`errorReportingEnabled`, default `true`) gates everything; the Rust flag is the source of truth and is set by the frontend after mount. Failures are dropped silently - no retry queue.

**Tech Stack:** Rust (tokio, reqwest, sha2 for fingerprints), TypeScript/React (xstate-free vanilla handlers + class ErrorBoundary), Cloudflare Workers (D1, KV, cron triggers), Zustand (persisted setting).

**Spec:** [`docs/superpowers/specs/2026-05-07-error-reporter-design.md`](../specs/2026-05-07-error-reporter-design.md)

**Note for the implementing engineer - pragmatic refinements vs. the spec:**

1. The spec describes wrapping each command's `.map_err` (Option A). With 103 commands in `commands.rs` averaging multiple `?` operators, that's hundreds of edits. The plan implements the same Option-A intent with a single body-wrapping helper - `wrap_cmd("name", async move { ... }).await` - so each command gets exactly one explicit wrap. Same observability, far less churn.
2. The spec calls for a new `src/components/ErrorBoundary.tsx`. The codebase already has an `ErrorBoundary` class inline at the top of `src/App.tsx`. The plan extends that class instead of creating a new file.

---

## Files Touched

### Created
- `src-tauri/src/error_reporter.rs` - reporter module (state, scrub, fingerprint, dedup, send).
- `src/lib/errorReporter.ts` - tiny frontend helper that invokes the Tauri command.
- `workers/ct-analytics/migrations/0001_errors_table.sql` - D1 migration for the new table (versionable, vs. ad-hoc `wrangler d1 execute`).

### Modified
- `src-tauri/Cargo.toml` - add `sha2` dependency.
- `src-tauri/src/main.rs` - register `mod error_reporter`, set panic hook, init reporter in `setup`, register two new IPC commands.
- `src-tauri/src/commands.rs` - add `wrap_cmd` helper, add `report_error` and `set_error_reporting_enabled` IPC commands, wrap every existing `#[command]` body that returns `Result`.
- `workers/ct-analytics/src/index.ts` - add `ErrorReportBody` interface, `handleErrorReport` route, `scheduled` cron handler, route wiring.
- `workers/ct-analytics/wrangler.jsonc` - add `triggers.crons` entry.
- `src/main.tsx` - install global `error` and `unhandledrejection` listeners before React mounts.
- `src/App.tsx` - extend the existing `ErrorBoundary` to call `reportError` and show a generic fallback (no leaked `error.message`); push `errorReportingEnabled` to Rust on mount.
- `src/store/appStore.ts` - add persisted `errorReportingEnabled` field + `setErrorReportingEnabled` action.
- `src/components/SettingsModal.tsx` - add toggle row that updates the store and pushes the new value to Rust.

---

## Phase 1 - Worker side (deployable independently)

### Task 1: Add D1 migration for the `errors` table

**Files:**
- Create: `workers/ct-analytics/migrations/0001_errors_table.sql`

The repo's `package.json` already has `db:migrate:remote` / `db:migrate:local` scripts pointing at `wrangler d1 migrations apply ct-analytics-db`, but no `migrations/` folder exists yet. We add one.

- [ ] **Step 1: Create the migrations directory and SQL file**

Create `workers/ct-analytics/migrations/0001_errors_table.sql` with exactly this content:

```sql
CREATE TABLE IF NOT EXISTS errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  installation_id TEXT    NOT NULL,
  app_version     TEXT    NOT NULL,
  os              TEXT    NOT NULL,
  country         TEXT    NOT NULL,
  source          TEXT    NOT NULL,
  kind            TEXT,
  message         TEXT    NOT NULL,
  stack           TEXT,
  fingerprint     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_errors_ts          ON errors(ts);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_install     ON errors(installation_id);
```

- [ ] **Step 2: Apply the migration locally to verify it parses**

From `workers/ct-analytics/`:

```powershell
npx wrangler d1 migrations apply ct-analytics-db --local
```

Expected: prints `Migrations to be applied: 0001_errors_table.sql` then `🚣 Applied 1 migration`. If the migration file is malformed, wrangler prints a SQL parse error.

- [ ] **Step 3: Verify the table exists locally**

```powershell
npx wrangler d1 execute ct-analytics-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='errors'"
```

Expected: a single row `name=errors`.

- [ ] **Step 4: Commit**

```powershell
git add workers/ct-analytics/migrations/0001_errors_table.sql
git commit -m "feat(worker): add errors D1 table migration"
```

---

### Task 2: Add the `/error_report` route to the worker

**Files:**
- Modify: `workers/ct-analytics/src/index.ts`

- [ ] **Step 1: Add the request body interface**

Append below the existing `HeartbeatBody` interface (around line 35):

```ts
interface ErrorReportBody {
  installation_id?: unknown;
  app_version?: unknown;
  os?: unknown;
  source?: unknown;
  kind?: unknown;
  message?: unknown;
  stack?: unknown;
  fingerprint?: unknown;
}

interface NormalizedErrorReport {
  installation_id: string;
  app_version: string;
  os: string;
  country: string;
  source: string;
  kind: string | null;
  message: string;
  stack: string | null;
  fingerprint: string;
}
```

- [ ] **Step 2: Add a normalizer for error reports**

Add right below the existing `normalize` function:

```ts
const ALLOWED_SOURCES = new Set(['rust_panic', 'rust_command', 'frontend']);

function normalizeError(body: ErrorReportBody, request: Request): NormalizedErrorReport | null {
  const installation_id = clampString(body.installation_id, 128);
  const app_version = clampString(body.app_version, 32);
  const os = clampString(body.os, 32);
  const source = clampString(body.source, 16);
  const message = clampString(body.message, 2048);
  if (!installation_id || !app_version || !os || !source || !message) return null;
  if (!ALLOWED_SOURCES.has(source)) return null;

  const country =
    typeof (request as Request & { cf?: { country?: string } }).cf?.country === 'string'
      ? ((request as Request & { cf?: { country?: string } }).cf!.country as string).toUpperCase().slice(0, 2)
      : 'XX';

  return {
    installation_id,
    app_version,
    os: os.toLowerCase(),
    country,
    source,
    kind: clampString(body.kind, 64),
    message,
    stack: clampString(body.stack, 8192),
    fingerprint: clampString(body.fingerprint, 16) ?? 'unknown',
  };
}
```

- [ ] **Step 3: Add the route handler**

Add this function below `handleHeartbeat`:

```ts
async function handleErrorReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ErrorReportBody;
  try {
    body = (await request.json()) as ErrorReportBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const payload = normalizeError(body, request);
  if (!payload) return json({ error: 'invalid_payload' }, 400);

  const rateKey = `rl:errors:${payload.installation_id}`;
  if (await env.KV_BINDING.get(rateKey)) {
    return json({ ok: true, throttled: true });
  }
  ctx.waitUntil(env.KV_BINDING.put(rateKey, '1', { expirationTtl: RATE_LIMIT_TTL_SECONDS }));

  try {
    await env.DB.prepare(
      'INSERT INTO errors (ts, installation_id, app_version, os, country, source, kind, message, stack, fingerprint) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        new Date().toISOString(),
        payload.installation_id,
        payload.app_version,
        payload.os,
        payload.country,
        payload.source,
        payload.kind,
        payload.message,
        payload.stack,
        payload.fingerprint,
      )
      .run();
  } catch (err) {
    console.error('[error_report] D1 insert failed:', err);
    return json({ error: 'db_error' }, 500);
  }

  return json({ ok: true });
}
```

- [ ] **Step 4: Wire the route into the `fetch` switch**

Inside the existing `try { ... }` in the default export's `fetch`, add this branch immediately after the `/update_check` branch:

```ts
if (request.method === 'POST' && url.pathname === '/error_report') {
  const denied = requireToken(request, env.INGEST_TOKEN);
  if (denied) return denied;
  return await handleErrorReport(request, env, ctx);
}
```

- [ ] **Step 5: Type-check**

From `workers/ct-analytics/`:

```powershell
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```powershell
git add workers/ct-analytics/src/index.ts
git commit -m "feat(worker): add /error_report ingest route"
```

---

### Task 3: Add the 90-day cleanup cron

**Files:**
- Modify: `workers/ct-analytics/wrangler.jsonc`
- Modify: `workers/ct-analytics/src/index.ts`

- [ ] **Step 1: Add the cron trigger to wrangler.jsonc**

Replace the file contents with:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ct-analytics",
  "main": "src/index.ts",
  "compatibility_date": "2025-02-04",
  "observability": {
    "enabled": true
  },
  "triggers": {
    "crons": ["0 3 * * *"]
  },
  "kv_namespaces": [
    {
      "binding": "KV_BINDING",
      "id": "8d7e4237d2284ed6b9ecbab1bdebe9a3"
    }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ct-analytics-db",
      "database_id": "cedefc3c-2992-48aa-98b2-b8380670db92"
    }
  ]
}
```

- [ ] **Step 2: Add the `scheduled` handler to the worker**

In `workers/ct-analytics/src/index.ts`, change the `export default { ... } satisfies ExportedHandler<Env>` block to include both handlers. Replace:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

with:

```ts
export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await env.DB.prepare("DELETE FROM errors WHERE ts < datetime('now', '-90 days')").run();
    } catch (err) {
      console.error('[scheduled] error cleanup failed:', err);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
```

(The closing `} satisfies ExportedHandler<Env>;` stays as-is at the end.)

- [ ] **Step 3: Type-check**

```powershell
cd workers/ct-analytics
npx tsc --noEmit
cd ../..
```

Expected: no errors.

- [ ] **Step 4: Commit**

```powershell
git add workers/ct-analytics/src/index.ts workers/ct-analytics/wrangler.jsonc
git commit -m "feat(worker): add 90-day errors cleanup cron"
```

---

### Task 4: Deploy the worker and run a smoke test

**Files:** None (deployment + manual verification only).

- [ ] **Step 1: Apply the migration to the production D1 instance**

```powershell
cd workers/ct-analytics
npx wrangler d1 migrations apply ct-analytics-db --remote
```

Expected: `🚣 Applied 1 migration`. (If it says "0 migrations to apply", the table already exists - verify with the next step.)

- [ ] **Step 2: Verify the remote table**

```powershell
npx wrangler d1 execute ct-analytics-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='errors'"
```

Expected: one row `errors`.

- [ ] **Step 3: Deploy the worker**

```powershell
npx wrangler deploy
```

Expected: deploy success, prints worker URL `https://ct-analytics.claude-terminal.workers.dev` and the cron schedule.

- [ ] **Step 4: Smoke-test the new route**

Read `INGEST_TOKEN` from memory file `C:\Users\tal\.claude\projects\<...>\memory\ct_analytics_tokens.md` (it's documented there). Then:

```powershell
$token = "<INGEST_TOKEN>"
$body = '{"installation_id":"smoke-test","app_version":"0.0.0","os":"windows","source":"frontend","kind":"TypeError","message":"smoke test","stack":"at smoke (file:///C:/Users/test/app.js:1:1)","fingerprint":"smoketest"}'
Invoke-RestMethod -Uri https://ct-analytics.claude-terminal.workers.dev/error_report `
  -Method Post -Headers @{ "x-ct-token" = $token; "content-type" = "application/json" } `
  -Body $body
```

Expected: `ok = True`.

- [ ] **Step 5: Verify the row landed**

```powershell
npx wrangler d1 execute ct-analytics-db --remote --command "SELECT id, ts, source, message FROM errors WHERE installation_id='smoke-test' ORDER BY id DESC LIMIT 1"
cd ../..
```

Expected: one row with `source='frontend'` and `message='smoke test'`.

- [ ] **Step 6: Verify rate limiting**

Re-run the same `Invoke-RestMethod` immediately. Expected: `ok = True; throttled = True`. (If `throttled` is missing, the rate limit isn't working - debug `rl:errors:smoke-test` KV key.)

- [ ] **Step 7: Clean up the smoke-test row and commit**

```powershell
cd workers/ct-analytics
npx wrangler d1 execute ct-analytics-db --remote --command "DELETE FROM errors WHERE installation_id='smoke-test'"
cd ../..
```

No commit needed - Phase 1 is complete and deployed.

---

## Phase 2 - Rust `error_reporter` module (TDD, no integration yet)

### Task 5: Add `sha2` dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dependency**

Insert after the `regex = "1"` line in `[dependencies]`:

```toml
sha2 = "0.10"
```

- [ ] **Step 2: Verify it resolves**

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: builds successfully (may take a minute the first time).

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: add sha2 for error_reporter fingerprints"
```

---

### Task 6: Create the module skeleton + scrub function (TDD)

**Files:**
- Create: `src-tauri/src/error_reporter.rs`
- Modify: `src-tauri/src/main.rs` (add `mod error_reporter;`)

- [ ] **Step 1: Register the module**

In `src-tauri/src/main.rs`, add after `mod telemetry;`:

```rust
mod error_reporter;
```

- [ ] **Step 2: Write the failing test for `scrub`**

Create `src-tauri/src/error_reporter.rs` with:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorSource {
    RustPanic,
    RustCommand,
    Frontend,
}

impl ErrorSource {
    pub fn as_tag(&self) -> &'static str {
        match self {
            ErrorSource::RustPanic => "rust_panic",
            ErrorSource::RustCommand => "rust_command",
            ErrorSource::Frontend => "frontend",
        }
    }
}

pub fn scrub(input: &str) -> String {
    // TODO
    input.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_replaces_windows_user_path() {
        let input = r"thread panicked at C:\Users\alice\code\app\src\main.rs:42:10";
        let out = scrub(input);
        assert_eq!(
            out,
            r"thread panicked at C:\Users\<user>\code\app\src\main.rs:42:10"
        );
    }

    #[test]
    fn scrub_replaces_file_uri_user_path() {
        let input = "at handler (file:///C:/Users/alice/app/index.js:1:1)";
        let out = scrub(input);
        assert_eq!(out, "at handler (file:///C:/Users/<user>/app/index.js:1:1)");
    }

    #[test]
    fn scrub_leaves_other_paths_alone() {
        let input = r"C:\ProgramData\foo and /usr/share/bar";
        assert_eq!(scrub(input), input);
    }

    #[test]
    fn scrub_replaces_multiple_occurrences() {
        let input = r"C:\Users\bob\one and C:\Users\bob\two";
        assert_eq!(scrub(input), r"C:\Users\<user>\one and C:\Users\<user>\two");
    }

    #[test]
    fn source_tags_are_stable() {
        assert_eq!(ErrorSource::RustPanic.as_tag(), "rust_panic");
        assert_eq!(ErrorSource::RustCommand.as_tag(), "rust_command");
        assert_eq!(ErrorSource::Frontend.as_tag(), "frontend");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

```powershell
cd src-tauri
cargo test error_reporter::tests::scrub_replaces_windows_user_path
cd ..
```

Expected: FAIL on `scrub_replaces_windows_user_path` (the stub returns input unchanged).

- [ ] **Step 4: Implement `scrub` correctly**

Replace the placeholder `scrub` body with:

```rust
pub fn scrub(input: &str) -> String {
    use std::sync::OnceLock;
    static WIN_USER: OnceLock<regex::Regex> = OnceLock::new();
    static FILE_URI_USER: OnceLock<regex::Regex> = OnceLock::new();
    let win = WIN_USER.get_or_init(|| regex::Regex::new(r"C:\\Users\\[^\\]+\\").unwrap());
    let uri = FILE_URI_USER.get_or_init(|| regex::Regex::new(r"file:///C:/Users/[^/]+/").unwrap());
    let step1 = win.replace_all(input, r"C:\Users\<user>\");
    let step2 = uri.replace_all(&step1, "file:///C:/Users/<user>/");
    step2.into_owned()
}
```

- [ ] **Step 5: Run all module tests**

```powershell
cd src-tauri
cargo test error_reporter
cd ..
```

Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/error_reporter.rs src-tauri/src/main.rs
git commit -m "feat(error_reporter): add ErrorSource enum and scrub helper"
```

---

### Task 7: Add the fingerprint function (TDD)

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

- [ ] **Step 1: Add the failing tests**

Append inside the `mod tests` block:

```rust
    #[test]
    fn fingerprint_is_stable_for_identical_inputs() {
        let a = fingerprint(ErrorSource::RustPanic, Some("PtyOpenError"), "boom", Some("at foo\nat bar"));
        let b = fingerprint(ErrorSource::RustPanic, Some("PtyOpenError"), "boom", Some("at foo\nat bar"));
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn fingerprint_changes_with_source() {
        let a = fingerprint(ErrorSource::RustPanic, None, "boom", None);
        let b = fingerprint(ErrorSource::Frontend, None, "boom", None);
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_uses_first_stack_line_when_present() {
        let with_stack = fingerprint(ErrorSource::Frontend, None, "ignored", Some("at A\nat B"));
        let other_stack = fingerprint(ErrorSource::Frontend, None, "ignored", Some("at A\nat C"));
        // First line is the same ("at A") so fingerprint matches even with different deeper frames.
        assert_eq!(with_stack, other_stack);
    }

    #[test]
    fn fingerprint_falls_back_to_message_when_stack_missing() {
        let a = fingerprint(ErrorSource::Frontend, None, "msg one", None);
        let b = fingerprint(ErrorSource::Frontend, None, "msg two", None);
        assert_ne!(a, b);
    }
```

- [ ] **Step 2: Add a stub so the tests compile**

In the module body (before the `#[cfg(test)]`):

```rust
pub fn fingerprint(
    source: ErrorSource,
    kind: Option<&str>,
    message: &str,
    stack: Option<&str>,
) -> String {
    let _ = (source, kind, message, stack);
    String::new()
}
```

- [ ] **Step 3: Run to verify tests fail**

```powershell
cd src-tauri
cargo test error_reporter::tests::fingerprint
cd ..
```

Expected: 4 failures (length 0 instead of 16, equal hashes for unequal inputs, etc.).

- [ ] **Step 4: Implement `fingerprint`**

Replace the stub with:

```rust
pub fn fingerprint(
    source: ErrorSource,
    kind: Option<&str>,
    message: &str,
    stack: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    let first_line = stack
        .and_then(|s| s.lines().find(|l| !l.trim().is_empty()))
        .or_else(|| message.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or("")
        .trim();
    let kind_str = kind.unwrap_or("");
    let mut h = Sha256::new();
    h.update(source.as_tag().as_bytes());
    h.update(b"|");
    h.update(kind_str.as_bytes());
    h.update(b"|");
    h.update(first_line.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(16);
    for b in digest.iter().take(8) {
        use std::fmt::Write;
        write!(&mut out, "{:02x}", b).unwrap();
    }
    out
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```powershell
cd src-tauri
cargo test error_reporter
cd ..
```

Expected: all tests pass (5 scrub + 4 fingerprint = 9).

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error_reporter): add fingerprint hashing"
```

---

### Task 8: Add dedup state with injectable clock (TDD)

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

- [ ] **Step 1: Add the failing tests**

Append inside `mod tests`:

```rust
    use std::time::{Duration, Instant};

    #[test]
    fn should_send_first_time_returns_true() {
        let dedup = Dedup::new();
        let now = Instant::now();
        assert!(dedup.should_send("abc", now));
    }

    #[test]
    fn should_send_within_window_returns_false() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        let t1 = t0 + Duration::from_secs(30);
        assert!(!dedup.should_send("abc", t1));
    }

    #[test]
    fn should_send_after_window_returns_true() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        let t1 = t0 + Duration::from_secs(61);
        assert!(dedup.should_send("abc", t1));
    }

    #[test]
    fn should_send_distinct_fingerprints_independent() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        assert!(dedup.should_send("def", t0));
    }
```

- [ ] **Step 2: Add stub so tests compile**

In the module body:

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEDUP_WINDOW: Duration = Duration::from_secs(60);

pub struct Dedup {
    map: Mutex<HashMap<String, Instant>>,
}

impl Dedup {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    pub fn should_send(&self, _fp: &str, _now: Instant) -> bool {
        true
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

```powershell
cd src-tauri
cargo test error_reporter::tests::should_send
cd ..
```

Expected: `should_send_within_window_returns_false` fails (stub always returns true).

- [ ] **Step 4: Implement `should_send`**

Replace the stub with:

```rust
    pub fn should_send(&self, fp: &str, now: Instant) -> bool {
        let mut map = match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(), // poisoned mutex; recover by taking the data
        };
        // Opportunistic prune: drop expired entries.
        map.retain(|_, t| now.saturating_duration_since(*t) <= DEDUP_WINDOW);
        if let Some(last) = map.get(fp) {
            if now.saturating_duration_since(*last) <= DEDUP_WINDOW {
                return false;
            }
        }
        map.insert(fp.to_string(), now);
        true
    }
```

- [ ] **Step 5: Run tests**

```powershell
cd src-tauri
cargo test error_reporter
cd ..
```

Expected: all 13 tests pass (5 + 4 + 4).

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error_reporter): add Dedup with injectable clock"
```

---

### Task 9: Add reporter state singleton + enable flag

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

- [ ] **Step 1: Add tests for the enabled flag**

Append inside `mod tests`:

```rust
    #[test]
    fn enabled_defaults_to_false_before_init() {
        // Note: state is process-global; this test relies on running before any init().
        // With cargo test default (single binary), other tests don't call init(),
        // so this stays valid.
        assert!(!is_enabled());
    }

    #[test]
    fn set_enabled_flips_the_flag() {
        // Force a known state.
        set_enabled(false);
        assert!(!is_enabled());
        set_enabled(true);
        assert!(is_enabled());
        set_enabled(false);
    }
```

- [ ] **Step 2: Add the singleton + flag**

In the module body, near the top (above the `Dedup` block):

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static REPORTER: OnceLock<ReporterState> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);

struct ReporterState {
    installation_id: String,
    app_version: String,
    dedup: Dedup,
}

pub fn init(installation_id: String, app_version: String) {
    let _ = REPORTER.set(ReporterState {
        installation_id,
        app_version,
        dedup: Dedup::new(),
    });
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}
```

- [ ] **Step 3: Run tests**

```powershell
cd src-tauri
cargo test error_reporter
cd ..
```

Expected: all tests pass (now 15 total).

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error_reporter): add singleton state and enable flag"
```

---

### Task 10: Add the async `report` send path

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

There's no clean unit test for the network call (no DI of HTTP client without major churn). We test indirectly: `report` short-circuits when disabled or when the build-time token is missing, and the dedup path is already covered. The actual HTTP call is verified by the Phase 4 manual smoke test.

- [ ] **Step 1: Add `Serialize` payload + the public functions**

At the top of the module body, add:

```rust
use serde::Serialize;

const WORKER_URL: &str = "https://ct-analytics.claude-terminal.workers.dev";
const INGEST_TOKEN: Option<&str> = option_env!("CT_INGEST_TOKEN");
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MESSAGE_MAX: usize = 2048;
const STACK_MAX: usize = 8192;

#[derive(Serialize)]
struct ErrorReportPayload<'a> {
    installation_id: &'a str,
    app_version: &'a str,
    os: &'a str,
    source: &'static str,
    kind: Option<&'a str>,
    message: &'a str,
    stack: Option<&'a str>,
    fingerprint: &'a str,
}
```

Then add the public `report` function:

```rust
pub async fn report(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
) {
    if !is_enabled() {
        return;
    }
    let token = match INGEST_TOKEN {
        Some(t) if !t.is_empty() => t,
        _ => return,
    };
    let state = match REPORTER.get() {
        Some(s) => s,
        None => {
            eprintln!("[error_reporter] report() called before init(); skipping");
            return;
        }
    };

    let scrubbed_message = clamp(scrub(&message), MESSAGE_MAX);
    let scrubbed_stack = stack.map(|s| clamp(scrub(&s), STACK_MAX));
    let fp = fingerprint(source, kind.as_deref(), &scrubbed_message, scrubbed_stack.as_deref());

    if !state.dedup.should_send(&fp, Instant::now()) {
        return;
    }

    let payload = ErrorReportPayload {
        installation_id: &state.installation_id,
        app_version: &state.app_version,
        os: std::env::consts::OS,
        source: source.as_tag(),
        kind: kind.as_deref(),
        message: &scrubbed_message,
        stack: scrubbed_stack.as_deref(),
        fingerprint: &fp,
    };

    let client = match reqwest::Client::builder().timeout(SEND_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[error_reporter] http client build failed: {}", e);
            return;
        }
    };

    match client
        .post(format!("{}/error_report", WORKER_URL))
        .header("x-ct-token", token)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                eprintln!("[error_reporter] worker responded {}", resp.status());
            }
        }
        Err(e) => {
            eprintln!("[error_reporter] send failed: {}", e);
        }
    }
}

fn clamp(mut s: String, max: usize) -> String {
    if s.len() > max {
        // Truncate at a char boundary.
        while !s.is_char_boundary(max) {
            s.pop();
        }
        s.truncate(max);
    }
    s
}
```

- [ ] **Step 2: Verify it compiles**

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: builds cleanly. (`reqwest` is already a dependency for `telemetry.rs`.)

- [ ] **Step 3: Run tests**

```powershell
cd src-tauri
cargo test error_reporter
cd ..
```

Expected: all tests still pass.

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error_reporter): add async report() send path"
```

---

### Task 11: Add `report_blocking` for the panic hook

**Files:**
- Modify: `src-tauri/src/error_reporter.rs`

The panic hook fires on whichever thread panicked, which may not be a Tokio runtime thread. With `panic = "abort"` in release, the process is going to die - we get one shot.

- [ ] **Step 1: Implement `report_blocking`**

Append after the `report` function:

```rust
pub fn report_blocking(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
) {
    let fut = report(source, kind, message, stack);

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        // We're on a Tokio thread; spawn and detach. In release with panic=abort
        // the process will likely die before completion, but in debug builds it
        // runs to completion since the panic hook returns and the runtime stays up.
        handle.spawn(fut);
        return;
    }

    // No runtime - build a one-shot single-threaded runtime and drive `fut` to
    // completion (or our 5s timeout). Best-effort.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[error_reporter] failed to build temp runtime: {}", e);
            return;
        }
    };
    rt.block_on(async {
        // The 5s timeout inside report() bounds the wait.
        fut.await;
    });
}
```

- [ ] **Step 2: Verify it compiles**

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: clean build.

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/src/error_reporter.rs
git commit -m "feat(error_reporter): add report_blocking for panic hook"
```

---

## Phase 3 - Rust integration (panic hook + IPC + command wrapping)

### Task 12: Set the panic hook and initialize the reporter in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Set the panic hook before the Tauri builder**

In `src-tauri/src/main.rs`, replace the start of `fn main()` (currently `fn main() { tauri::Builder::default()...`) with:

```rust
fn main() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let kind = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        error_reporter::report_blocking(
            error_reporter::ErrorSource::RustPanic,
            kind,
            msg,
            Some(backtrace),
        );
    }));

    tauri::Builder::default()
```

(The rest of the function body is unchanged.)

- [ ] **Step 2: Initialize the reporter inside `setup`**

In the existing `.setup(|app| { ... })` block, change:

```rust
        .setup(|app| {
            let db = database::Database::new()?;
            let terminal_manager = terminal::TerminalManager::new();

            app.manage(AppState {
                terminals: Arc::new(Mutex::new(terminal_manager)),
                db: Arc::new(Mutex::new(db)),
            });

            Ok(())
        })
```

to:

```rust
        .setup(|app| {
            let db = database::Database::new()?;
            let installation_id = db.get_or_create_installation_id().unwrap_or_default();
            let app_version = app.package_info().version.to_string();
            error_reporter::init(installation_id, app_version);

            let terminal_manager = terminal::TerminalManager::new();

            app.manage(AppState {
                terminals: Arc::new(Mutex::new(terminal_manager)),
                db: Arc::new(Mutex::new(db)),
            });

            Ok(())
        })
```

- [ ] **Step 3: Verify it compiles**

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: clean build.

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/main.rs
git commit -m "feat(error_reporter): wire panic hook and init in main.rs"
```

---

### Task 13: Add the `wrap_cmd` helper + frontend IPC commands in `commands.rs`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the helper and IPC commands**

At the **top** of `src-tauri/src/commands.rs`, after the existing `use` statements, add:

```rust
use std::future::Future;
use crate::error_reporter::{self, ErrorSource};

/// Wrap a Tauri command body so any `Err(String)` it returns is also reported
/// to the error_reporter (fire-and-forget). The command's behavior is unchanged.
pub async fn wrap_cmd<T, F>(name: &'static str, fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    match fut.await {
        Ok(v) => Ok(v),
        Err(e) => {
            tokio::spawn(error_reporter::report(
                ErrorSource::RustCommand,
                Some(name.to_string()),
                e.clone(),
                None,
            ));
            Err(e)
        }
    }
}

#[derive(serde::Deserialize)]
pub struct FrontendErrorPayload {
    pub kind: Option<String>,
    pub message: String,
    pub stack: Option<String>,
}

#[command]
pub async fn report_error(payload: FrontendErrorPayload) -> Result<(), String> {
    error_reporter::report(
        ErrorSource::Frontend,
        payload.kind,
        payload.message,
        payload.stack,
    )
    .await;
    Ok(())
}

#[command]
pub fn set_error_reporting_enabled(enabled: bool) -> Result<(), String> {
    error_reporter::set_enabled(enabled);
    Ok(())
}
```

(`#[command]` matches the existing file's style - there's already a `use tauri::command;` at the top of `commands.rs`. If for any reason that import isn't visible, fall back to `#[tauri::command]`.)

- [ ] **Step 2: Register the new commands in `main.rs`**

In `src-tauri/src/main.rs`, inside `tauri::generate_handler![ ... ]`, add at the end (just before the closing `]`):

```rust
            commands::report_error,
            commands::set_error_reporting_enabled,
```

- [ ] **Step 3: Verify it compiles**

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: clean build, possibly a `dead_code` warning about `wrap_cmd` (we'll start using it next task - that's fine for this commit).

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(error_reporter): add wrap_cmd helper and frontend IPC commands"
```

---

### Task 14: Wrap every existing `#[command]` body with `wrap_cmd`

**Files:**
- Modify: `src-tauri/src/commands.rs`

There are 103 functions defined in this file; the ones registered as Tauri commands are the 80+ listed in `main.rs`'s `generate_handler!`. The mechanical edit is: for each `#[command] / #[tauri::command]` function whose return type is `Result<T, String>`, wrap the entire body with `wrap_cmd("function_name", async move { /* original body */ }).await`.

Pattern transformation - a function that today reads:

```rust
#[command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    label: String,
    /* ... */
) -> Result<String, String> {
    // original body using ?, .map_err, etc.
    let id = some_call().map_err(|e| e.to_string())?;
    Ok(id)
}
```

becomes:

```rust
#[command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    label: String,
    /* ... */
) -> Result<String, String> {
    wrap_cmd("create_terminal", async move {
        // original body, unchanged
        let id = some_call().map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
}
```

Wrapping is idempotent (a wrapped command compiles and behaves identically apart from the side effect of the report). If a command captures `state: State<'_, AppState>` it must move into the closure - `async move` captures by move, which is what we want.

**Two existing commands are already special and should NOT be wrapped:**

1. `report_error` - wrapping it would risk an infinite loop if the report itself fails (it doesn't currently, but defense in depth). Skip.
2. `set_error_reporting_enabled` - trivially infallible; wrapping is noise. Skip.

Wrap every other function listed in `tauri::generate_handler!` in `main.rs`. The list is in `src-tauri/src/main.rs:38-123`. Functions in `commands.rs` that are *not* listed in `generate_handler!` are private helpers - leave them alone.

The plan splits this work into 5 batches by ~20 commands each, so the engineer can commit between batches and bisect easily if any wrap breaks the build.

- [ ] **Step 1: Wrap batch 1 - terminal lifecycle (10 commands)**

These are at the top of `commands.rs`. Wrap each body with `wrap_cmd("name", async move { ... }).await`:

```
create_terminal
write_to_terminal
resize_terminal
close_terminal
get_terminals
update_terminal_label
update_terminal_nickname
create_script_terminal
create_shell_terminal
get_terminal_changes
```

`get_terminals` returns `Vec<...>` directly without `Result` - leave unwrapped if its signature isn't `Result<_, String>`. Verify each function signature before wrapping. (`get_terminals` per `main.rs` is registered, but if its signature is `pub async fn get_terminals(...) -> Vec<TerminalInfo>` then it's infallible and skip it. Check the signature with `Grep` if unsure.)

After editing this batch:

```powershell
cd src-tauri
cargo check
cd ..
```

Expected: clean build.

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat(error_reporter): wrap terminal commands with wrap_cmd"
```

- [ ] **Step 2: Wrap batch 2 - profiles, workspaces, sessions (16 commands)**

```
save_profile
get_profiles
delete_profile
get_workspaces
delete_workspace
save_workspace
load_workspace
save_session_for_restore
get_last_session
clear_last_session
get_session_history
get_session_log
read_log_file
delete_session_history
save_session_summary
get_session_summary
```

Same procedure. Verify return types before wrapping; commit after `cargo check` succeeds:

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat(error_reporter): wrap profile/workspace/session commands"
```

- [ ] **Step 3: Wrap batch 3 - git + worktrees (16 commands)**

```
get_path_changes
get_file_diff
get_path_file_diff
git_create_branch
get_repo_remote_refs
get_upstream_branch
git_pull_branch
get_worktree_info
list_worktrees
get_repo_branches
checkout_branch
git_commit
git_push
git_stage_files
git_unstage_files
git_stash_push
git_list_stashes
git_stash_apply
git_stash_pop
git_stash_drop
create_worktree
remove_worktree
git_discard_file
get_git_head_content
```

Commit:

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat(error_reporter): wrap git/worktree commands"
```

- [ ] **Step 4: Wrap batch 4 - claude config, snippets, hints, system (15 commands)**

```
get_claude_version
check_claude_update
update_claude_code
get_hints
check_system_requirements
install_claude_code
open_external_url
send_notification
save_snippet
get_snippets
delete_snippet
read_claude_settings
write_claude_settings
list_claude_agents
read_claude_agent
write_claude_agent
delete_claude_agent
list_claude_commands
read_claude_command
write_claude_command
delete_claude_command
```

Commit:

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat(error_reporter): wrap claude config/snippets/system commands"
```

- [ ] **Step 5: Wrap batch 5 - orchestration, files, search, telemetry (~17 commands)**

```
get_active_teams
get_team_tasks
summarize_session
list_memory_files
read_memory_file
write_memory_file
list_claude_md_files
scan_git_repos
list_directory
read_text_file
write_text_file
list_package_scripts
search_in_files
get_installation_id
send_telemetry_heartbeat
```

Skip `report_error` and `set_error_reporting_enabled` per the note above.

Final commit:

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat(error_reporter): wrap remaining commands"
```

- [ ] **Step 6: Final build + smoke check**

```powershell
cd src-tauri
cargo build
cd ..
```

Expected: clean release-ish build. Address any warnings about unwrapped `Result<_, String>` commands the engineer missed - the `dead_code` warning on `wrap_cmd` should now be gone.

---

## Phase 4 - Frontend integration

### Task 15: Add the frontend `errorReporter.ts` helper

**Files:**
- Create: `src/lib/errorReporter.ts`

- [ ] **Step 1: Create the helper**

Create `src/lib/errorReporter.ts` (the `lib/` directory may not exist yet; create it):

```ts
import { invoke } from '@tauri-apps/api/core';

const MESSAGE_MAX = 2048;
const STACK_MAX = 8192;

export function reportError(kind: string, message: string, stack?: string): void {
  const m = clamp(scrub(message), MESSAGE_MAX);
  const s = stack ? clamp(scrub(stack), STACK_MAX) : null;
  invoke('report_error', { payload: { kind: kind ?? null, message: m, stack: s } }).catch(() => {
    // Swallow - never let the reporter break the app.
  });
}

function scrub(s: string): string {
  return s
    .replace(/C:\\Users\\[^\\]+\\/g, 'C:\\Users\\<user>\\')
    .replace(/file:\/\/\/C:\/Users\/[^/]+\//g, 'file:///C:/Users/<user>/');
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
npm run build
```

Expected: build succeeds. (No tests for this - the project has no frontend test runner.)

- [ ] **Step 3: Commit**

```powershell
git add src/lib/errorReporter.ts
git commit -m "feat(frontend): add reportError helper"
```

---

### Task 16: Install global error listeners in `src/main.tsx`

**Files:**
- Modify: `src/main.tsx`

- [ ] **Step 1: Add listeners before React mounts**

Replace `src/main.tsx` contents with:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { reportError } from './lib/errorReporter';

window.addEventListener('error', (e) => {
  const err = e.error as Error | undefined;
  reportError(err?.name ?? 'Error', e.message ?? 'Unknown error', err?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const name = r?.name ?? 'UnhandledRejection';
  const message =
    typeof r === 'string' ? r : r?.message ?? (r === undefined ? 'undefined' : String(r));
  reportError(name, message, r?.stack);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 2: Verify build**

```powershell
npm run build
```

Expected: success.

- [ ] **Step 3: Commit**

```powershell
git add src/main.tsx
git commit -m "feat(frontend): install global error and unhandledrejection listeners"
```

---

### Task 17: Extend the existing `ErrorBoundary` in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Update the imports**

At the top of `src/App.tsx`, add this import next to the existing imports:

```tsx
import { reportError } from './lib/errorReporter';
```

- [ ] **Step 2: Update the `ErrorBoundary` class**

Replace the existing class (lines 36–66 - the class that starts with `class ErrorBoundary extends Component`) with:

```tsx
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(
      error.name,
      error.message,
      `${error.stack ?? ''}\n\nReact stack:${info.componentStack ?? ''}`,
    );
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-bg-primary flex items-center justify-center">
          <div className="text-center max-w-md p-6">
            <h2 className="text-text-primary text-lg font-semibold mb-2">Something went wrong</h2>
            <p className="text-text-secondary text-sm mb-4">
              The app hit an unexpected error. Reload to recover.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-accent-primary hover:bg-accent-secondary text-white px-4 py-2 rounded-md text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
```

The state no longer carries `error: Error | null` because we don't surface the message to the user (see the spec - generic fallback only).

- [ ] **Step 3: Verify build**

```powershell
npm run build
```

Expected: success.

- [ ] **Step 4: Commit**

```powershell
git add src/App.tsx
git commit -m "feat(frontend): extend ErrorBoundary to report and show generic fallback"
```

---

### Task 18: Add `errorReportingEnabled` to the app store

**Files:**
- Modify: `src/store/appStore.ts`

- [ ] **Step 1: Add the field to the state interface**

In `src/store/appStore.ts`, find the `interface AppState { ... }` block. Add a new field next to `telemetryEnabled`:

```ts
  errorReportingEnabled: boolean;
```

And add the action declaration next to `setTelemetryEnabled`:

```ts
  setErrorReportingEnabled: (enabled: boolean) => void;
```

- [ ] **Step 2: Add the default value and the implementation**

In the `create<AppState>()(persist((set) => ({ ... })))` body, add after `telemetryEnabled: true,`:

```ts
      errorReportingEnabled: true,
```

And add the action body next to `setTelemetryEnabled`:

```ts
      setErrorReportingEnabled: (enabled) => set({ errorReportingEnabled: enabled }),
```

- [ ] **Step 3: Persist the new field**

Find the `partialize` block at the bottom of the file. Add to the returned object next to `telemetryEnabled: state.telemetryEnabled`:

```ts
        errorReportingEnabled: state.errorReportingEnabled,
```

- [ ] **Step 4: Verify build**

```powershell
npm run build
```

Expected: success.

- [ ] **Step 5: Commit**

```powershell
git add src/store/appStore.ts
git commit -m "feat(frontend): add persisted errorReportingEnabled setting"
```

---

### Task 19: Push the setting to Rust on app mount and on toggle

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add a sync effect inside the `App` function component**

Inside the `App()` function in `src/App.tsx`, near the other `useEffect` hooks (a good place is right above the telemetry heartbeat effect), add:

```tsx
  // Push the persisted error-reporting preference to Rust on mount.
  // The Rust flag defaults to false, so until this fires no panics are reported.
  useEffect(() => {
    const enabled = useAppStore.getState().errorReportingEnabled;
    invoke('set_error_reporting_enabled', { enabled }).catch(() => {});
  }, []);
```

Make sure `useEffect` and `invoke` are already imported at the top of the file - they are.

- [ ] **Step 2: Verify build**

```powershell
npm run build
```

Expected: success.

- [ ] **Step 3: Commit**

```powershell
git add src/App.tsx
git commit -m "feat(frontend): sync errorReportingEnabled to Rust on mount"
```

---

### Task 20: Add the toggle row to `SettingsModal`

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Pull the new field from the store**

In `src/components/SettingsModal.tsx`, change the `useAppStore` destructure (currently around line 20) to also pick up the new field:

```tsx
  const {
    closeSettings,
    defaultClaudeArgs,
    setDefaultClaudeArgs,
    notifyOnFinish,
    setNotifyOnFinish,
    restoreSession,
    setRestoreSession,
    telemetryEnabled,
    setTelemetryEnabled,
    errorReportingEnabled,
    setErrorReportingEnabled,
    showGitPanel,
    setShowGitPanel,
    showFileTree,
    setShowFileTree,
  } = useAppStore();
```

- [ ] **Step 2: Add the toggle UI section**

Find the `{/* Analytics */}` block. Add this new section directly below it (above `{/* Keyboard Shortcuts */}`):

```tsx
          {/* Error Reporting */}
          <div>
            <h3 className="text-text-primary text-[13px] font-medium mb-2">Error Reporting</h3>
            <div className="bg-bg-primary rounded-md ring-1 ring-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-text-primary text-[13px]">Send error reports</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    Helps fix crashes. No personal data - Windows usernames are scrubbed.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const next = !errorReportingEnabled;
                    setErrorReportingEnabled(next);
                    invoke('set_error_reporting_enabled', { enabled: next }).catch(() => {});
                  }}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    errorReportingEnabled ? 'bg-accent-primary' : 'bg-border-light'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      errorReportingEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
```

- [ ] **Step 3: Verify build**

```powershell
npm run build
```

Expected: success.

- [ ] **Step 4: Commit**

```powershell
git add src/components/SettingsModal.tsx
git commit -m "feat(frontend): add error reporting toggle to Settings"
```

---

## Phase 5 - End-to-end verification

### Task 21: Smoke-test the whole pipeline in a dev build

**Files:** None (manual verification + temporary code changes that get reverted).

This task uses the live worker - make sure `CT_INGEST_TOKEN` is exported in the shell before `npm run tauri dev`, otherwise the reporter no-ops with `eprintln!`.

- [ ] **Step 1: Set the build-time token**

In a fresh PowerShell:

```powershell
$env:CT_INGEST_TOKEN = "<paste from memory file ct_analytics_tokens.md>"
```

- [ ] **Step 2: Add a temporary frontend error trigger**

Edit `src/components/SettingsModal.tsx` and add a visible button at the very top of the content area (just inside `<div className="p-4 space-y-5 max-h-[70vh] overflow-y-auto">`):

```tsx
          <button
            onClick={() => { throw new Error('e2e-frontend-test'); }}
            className="bg-error/20 text-error px-3 py-2 rounded text-[12px]"
          >
            DEV: throw frontend error
          </button>
```

- [ ] **Step 3: Run the app in dev mode**

```powershell
npm run tauri dev
```

Open Settings (via the gear icon in the title bar or whatever opens `SettingsModal`). Verify the new "Send error reports" toggle is visible and ON.

- [ ] **Step 4: Trigger a frontend error**

Click the temporary "DEV: throw frontend error" button. Expected:
- The ErrorBoundary fallback ("Something went wrong" + Reload button) appears.
- A row appears in the worker. Verify with:

```powershell
cd workers/ct-analytics
npx wrangler d1 execute ct-analytics-db --remote --command "SELECT id, ts, source, kind, message FROM errors ORDER BY id DESC LIMIT 1"
cd ../..
```

Expected: `source='frontend'`, `kind='Error'`, `message='e2e-frontend-test'`.

- [ ] **Step 5: Trigger a Rust panic**

Stop the dev server. In `src-tauri/src/commands.rs`, find any command (e.g. `get_hints`) and add `panic!("e2e-rust-panic");` as the first line of its body inside the `wrap_cmd` closure. Restart `npm run tauri dev`. Trigger that command from the UI (open the Hints panel, F1 in this app). The app will likely close - that's expected with `panic = "abort"` in release; in debug it may stay up depending on the call stack.

Verify a row appeared:

```powershell
cd workers/ct-analytics
npx wrangler d1 execute ct-analytics-db --remote --command "SELECT id, ts, source, kind, message FROM errors WHERE source='rust_panic' ORDER BY id DESC LIMIT 1"
cd ../..
```

Expected: a row with `source='rust_panic'` and `kind` containing the file:line:column of the panic.

- [ ] **Step 6: Verify the opt-out works**

Revert the Rust panic test (remove the `panic!` line). Restart the app, open Settings, **toggle the error reporter OFF**. Trigger the frontend error button again. Verify (via the same D1 query) that **no new row** is added.

- [ ] **Step 7: Verify offline behavior**

With the reporter toggled back ON, disconnect the network (airplane mode or `Disable-NetAdapter` on the active adapter). Trigger the frontend error button. Verify:
- The app does not freeze or crash.
- The dev console shows `[error_reporter] send failed: ...` (the eprintln from `report`).
- Reconnecting and triggering again sends successfully.

- [ ] **Step 8: Revert the temporary test code**

Remove the "DEV: throw frontend error" button from `SettingsModal.tsx` (and any leftover `panic!` line). Verify the diff is clean:

```powershell
git diff
```

Expected: empty.

- [ ] **Step 9: Final commit (or no-op if nothing left to revert)**

If anything was missed:

```powershell
git status
git diff
git checkout -- <files>  # or commit if intentional
```

Phase 5 is complete. The error reporter is live in dev builds; CI signed builds pick up `CT_INGEST_TOKEN` automatically per `release.yml`.

---

## Out of Scope (per spec section 11)

- Disk-based or in-memory retry queue when offline.
- `console.error` capture.
- Sentry-style grouping UI / inline error viewer.
- `/stats/errors` route on the worker.
- `daily_stats` aggregations for errors.
- PII review beyond Windows username scrubbing.
