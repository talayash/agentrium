# Error Reporter - Design

**Date:** 2026-05-07
**Status:** Approved (awaiting implementation plan)
**Target version:** ClaudeTerminal next minor (post-1.20.7)

## 1. Goal

Capture errors that happen on end-user machines and forward them to the existing `ct-analytics` Cloudflare Worker so they can be triaged and fixed. Reporting is transparent (no UI interruption), survives network failure (drop silently), and ships only scrubbed metadata.

## 2. Sources captured

| Source tag      | What it catches                                                                |
|-----------------|--------------------------------------------------------------------------------|
| `rust_panic`    | Any Rust thread panic, via `std::panic::set_hook` in `main.rs`.                |
| `rust_command`  | `Result::Err(String)` returned from any `#[command]` handler in `commands.rs`. |
| `frontend`      | `window.onerror`, `onunhandledrejection`, and React `ErrorBoundary` catches.   |

Explicitly **not** captured: `console.error`, third-party library warnings, network errors that the app already surfaces to the user (those are not bugs).

## 3. Architecture

```
FRONTEND (React)                          BACKEND (Rust)                    WORKER (Cloudflare)
─────────────────                         ──────────────                    ──────────────────
window.onerror ──┐                        panic::set_hook ──┐
onunhandledrej. ─┤                                          │
<ErrorBoundary> ─┼──invoke('report_error', payload)─────────┤
                 │                                          ▼
                 │                                  error_reporter::report
                 │                                          │
                 │                                  ┌───────┴────────┐
                 │                                  │ enabled flag?  │
                 │                                  │ fingerprint    │
                 │                                  │ dedup (60s)    │
                 │                                  │ scrub          │
                 │                                  └───────┬────────┘
                 │                                          ▼
                 │                          POST /error_report  ────────►  /error_report route
                 │                          x-ct-token: INGEST_TOKEN              │
                 │                          5s timeout, fire-and-forget           ▼
                 │                                                            D1: errors table
```

Single ingest path: every error source ends up calling `error_reporter::report(...)` in Rust. The Rust module owns the dedup map, scrubbing, network call, and the source-of-truth `enabled` flag.

## 4. Worker side

### 4.1 New D1 table

Created via `npx wrangler d1 execute claude-terminal --command "..."` (no migration framework in use). Schema:

```sql
CREATE TABLE IF NOT EXISTS errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,            -- server-side ISO8601
  installation_id TEXT    NOT NULL,
  app_version     TEXT    NOT NULL,
  os              TEXT    NOT NULL,
  country         TEXT    NOT NULL,            -- request.cf?.country, 'XX' fallback
  source          TEXT    NOT NULL,            -- 'rust_panic' | 'rust_command' | 'frontend'
  kind            TEXT,                        -- e.g. 'TypeError', 'PtyOpenError', or null
  message         TEXT    NOT NULL,            -- scrubbed, ≤ 2 KB
  stack           TEXT,                        -- scrubbed, ≤ 8 KB, or null
  fingerprint     TEXT    NOT NULL             -- 16-char hex prefix of sha256
);
CREATE INDEX IF NOT EXISTS idx_errors_ts          ON errors(ts);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_install     ON errors(installation_id);
```

### 4.2 New route - `POST /error_report`

Wired into `workers/ct-analytics/src/index.ts` next to `/heartbeat` and `/update_check`. Mirrors `handleHeartbeat`:

1. Auth: `requireToken(request, env.INGEST_TOKEN)` (existing helper).
2. Parse JSON body. Required: `installation_id`, `app_version`, `os`, `source`, `message`. Optional: `kind`, `stack`, `fingerprint`.
3. Validate via the existing `clampString` helper (lengths: id ≤ 128, version ≤ 32, os ≤ 32, source ≤ 16, kind ≤ 64, message ≤ 2048, stack ≤ 8192, fingerprint ≤ 16).
4. Resolve country from `request.cf?.country` exactly like `normalize()`.
5. Per-installation rate limit via KV: `rl:errors:{installation_id}`, TTL 60s. On hit, return `{ ok: true, throttled: true }`.
6. Insert one row into `errors` (server-supplied `ts` = `new Date().toISOString()`).
7. Return `{ ok: true }`.

No `daily_stats` aggregation - wrangler-querying is sufficient for v1.

### 4.3 Retention cron - 90-day cleanup

Worker cron added to `workers/ct-analytics/wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["0 3 * * *"]   // daily at 03:00 UTC
  }
}
```

A `scheduled` handler in `index.ts` deletes old rows:

```ts
async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  await env.DB.prepare("DELETE FROM errors WHERE ts < datetime('now', '-90 days')").run();
}
```

(Exported alongside the existing `fetch` handler.)

### 4.4 Triage / read access

```bash
npx wrangler d1 execute claude-terminal \
  --command "SELECT ts, app_version, os, source, kind, message FROM errors ORDER BY ts DESC LIMIT 50"
```

No dashboard / `/stats/errors` route in v1.

## 5. Rust side

### 5.1 New module `src-tauri/src/error_reporter.rs`

Public API:

```rust
pub enum ErrorSource { RustPanic, RustCommand, Frontend }

pub fn init(installation_id: String, app_version: String);

pub async fn report(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
);

pub fn report_blocking(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
);

pub fn set_enabled(enabled: bool);
```

Internals:

- `OnceCell<ReporterState>` initialized by `init()`. Holds:
  - `installation_id: String`
  - `app_version: String`
  - `enabled: AtomicBool` (default **false** - flipped on by App.tsx after reading the persisted setting)
  - `dedup: Mutex<HashMap<String, Instant>>` (key = fingerprint, value = last-sent time)
- `INGEST_TOKEN: Option<&str> = option_env!("CT_INGEST_TOKEN")` - same build-time gate as `telemetry.rs`. Unset → reporter no-ops.
- `scrub(s: &str) -> String` - replaces `C:\Users\<name>\` and `file:///C:/Users/<name>/` with `<user>`. Applied to `message` and `stack` before send.
- Length clamps: `message` ≤ 2 KB, `stack` ≤ 8 KB after scrubbing.
- `fingerprint(source: ErrorSource, kind: Option<&str>, message: &str, stack: Option<&str>) -> String` - first 16 hex chars of `sha256(format!("{source_tag}|{kind_str}|{first_line}"))`. `first_line` = first non-empty line of `stack` if `Some`, else first non-empty line of `message`. `kind_str` = `kind.unwrap_or("")`.
- Dedup window: 60s, scoped per-process (in-memory map; no persistence across restarts). `should_send(fp: &str, now: Instant) -> bool` returns `false` if the same `fp` was sent within the window; on `true`, updates the map. Map is opportunistically pruned (entries older than 60s removed) on each call. `now` is parameterized so unit tests can inject a fake clock.
- `report()` flow: `enabled` check → scrub → fingerprint → dedup check → `tokio::spawn` POST with 5s `reqwest::Client` timeout. All errors `eprintln!`-logged; never propagated.
- `report_blocking()` is the sync entry used by the panic hook. Strategy: `tokio::runtime::Handle::try_current()` → if `Ok`, `handle.spawn(...)`; else create a temporary `tokio::runtime::Builder::new_current_thread().enable_all().build()` and `block_on(timeout(send_future, 5s))`. This ensures panics on non-Tokio threads still get reported.

### 5.2 Panic hook in `main.rs`

Set **before** `tauri::Builder::default()` runs:

```rust
std::panic::set_hook(Box::new(|info| {
    let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    let kind = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    error_reporter::report_blocking(
        error_reporter::ErrorSource::RustPanic, kind, msg, Some(backtrace),
    );
}));
```

`RUST_BACKTRACE=1` is not required because `Backtrace::force_capture()` always captures.

### 5.3 Tauri command wrappers in `commands.rs` - Option A (explicit)

Every existing `#[command]` returning `Result<T, String>` gets its error-construction site (whether `.map_err`, `?` with a `From` impl, or hand-written `Err(format!(...))`) wrapped so the string is reported before being returned. Commands with infallible bodies (no `Result` return) are skipped. Pattern:

```rust
fn report_command_err(name: &'static str, err: &str) {
    tokio::spawn(error_reporter::report(
        ErrorSource::RustCommand, Some(name.to_string()), err.to_string(), None,
    ));
}

// At every command call site:
.map_err(|e| {
    let s = e.to_string();
    report_command_err("create_terminal", &s);
    s
})
```

Mechanical, ~25 sites, grep-able. No macro.

### 5.4 New IPC command - `report_error`

```rust
#[derive(Deserialize)]
struct FrontendErrorPayload {
    kind: Option<String>,
    message: String,
    stack: Option<String>,
}

#[command]
async fn report_error(payload: FrontendErrorPayload) -> Result<(), String> {
    error_reporter::report(
        ErrorSource::Frontend,
        payload.kind,
        payload.message,
        payload.stack,
    ).await;
    Ok(())
}
```

This command never returns `Err` - even if reporting fails internally, we don't want to surface that to the frontend (which would just trigger another error report). Registered in `tauri::Builder::default().invoke_handler(...)`.

### 5.5 New IPC command - `set_error_reporting_enabled`

```rust
#[command]
fn set_error_reporting_enabled(enabled: bool) -> Result<(), String> {
    error_reporter::set_enabled(enabled);
    Ok(())
}
```

### 5.6 Wiring in `main.rs`

Order:

1. `std::panic::set_hook(...)` - first, so panics during init are caught.
2. `error_reporter::init(installation_id, app_version)` - alongside the existing `telemetry::send_heartbeat(...)` setup. Default `enabled = false`.
3. Tauri builder runs.
4. Frontend mounts, reads persisted setting, calls `set_error_reporting_enabled(true|false)`.

## 6. Frontend side

### 6.1 New helper `src/lib/errorReporter.ts`

```ts
import { invoke } from '@tauri-apps/api/core';

export function reportError(kind: string, message: string, stack?: string) {
  invoke('report_error', {
    payload: { kind, message: scrub(message), stack: stack ? scrub(stack) : null },
  }).catch(() => { /* swallow - never let reporter break the app */ });
}

function scrub(s: string): string {
  return s
    .replace(/C:\\Users\\[^\\]+\\/g, 'C:\\Users\\<user>\\')
    .replace(/file:\/\/\/C:\/Users\/[^/]+\//g, 'file:///C:/Users/<user>/');
}
```

The Rust side scrubs again as defense in depth.

### 6.2 Global handlers in `src/main.tsx`

Installed once at startup, **before** `ReactDOM.createRoot(...).render(...)`:

```ts
window.addEventListener('error', (e) => {
  reportError(e.error?.name ?? 'Error', e.message, e.error?.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  reportError(
    r?.name ?? 'UnhandledRejection',
    typeof r === 'string' ? r : (r?.message ?? String(r)),
    r?.stack,
  );
});
```

### 6.3 New `src/components/ErrorBoundary.tsx`

Class component with `componentDidCatch`. Wraps the **entire** app tree in `App.tsx` (whole-tree boundary, not per-section). Fallback UI: generic "Something went wrong" panel with a Reload button (`window.location.reload()`). No leaked error details to the user.

```tsx
componentDidCatch(error: Error, info: React.ErrorInfo) {
  reportError(
    error.name,
    error.message,
    `${error.stack ?? ''}\n\nReact stack:${info.componentStack}`,
  );
}
```

App.tsx:

```tsx
<ErrorBoundary>
  <TitleBar />
  <Sidebar />
  ...existing tree...
</ErrorBoundary>
```

### 6.4 Coverage matrix

| Failure                                            | Caught by               |
|----------------------------------------------------|-------------------------|
| Render exception in a component                    | ErrorBoundary           |
| Event handler throws                               | `window.onerror`        |
| Promise rejection without `.catch()`               | `onunhandledrejection`  |
| `await invoke()` rejection that's not caught       | `onunhandledrejection`  |
| Errors inside `reportError` itself                 | `.catch()` swallow      |

## 7. Settings opt-out

### 7.1 UI

`src/components/SettingsModal.tsx` gets one new toggle row alongside the existing settings:

```
[x] Send error reports
    Helps fix crashes. No personal data - Windows usernames are scrubbed.
```

### 7.2 Persistence

New field `errorReportingEnabled: boolean` (default `true`) on the existing Zustand `appStore` slice that's already persisted via `zustand/middleware/persist`.

### 7.3 Plumbing

- On `App.tsx` mount: read `useAppStore.getState().errorReportingEnabled` and call `invoke('set_error_reporting_enabled', { enabled })`.
- On toggle: `SettingsModal` updates the store **and** calls `invoke('set_error_reporting_enabled', { enabled })`.
- `reportError()` in `errorReporter.ts` reads the same Zustand value and short-circuits when off (avoids the IPC round-trip). Rust-side `enabled` flag is the source of truth.

### 7.4 Early-startup behavior

Rust `enabled` defaults to `false`. Panics that happen between process start and the first `set_error_reporting_enabled` call are **not** reported. This is the privacy-conservative default and is acceptable given the rarity of pre-mount panics.

## 8. Build-time gating

Identical to `telemetry.rs`: `option_env!("CT_INGEST_TOKEN")` at compile time. Without the env var, every `report` call no-ops with an `eprintln!`. Dev/unsigned builds therefore never post.

## 9. Testing

### 9.1 Rust unit tests (`error_reporter.rs`, `#[cfg(test)]`)

- `scrub()` rewrites `C:\Users\X\path` and `file:///C:/Users/X/path` correctly; leaves `C:\ProgramData\...` and other paths alone.
- `fingerprint()` is stable for identical inputs and differs across sources/messages.
- `should_send(fp, now)` returns `false` for a fingerprint sent within the last 60s and `true` after the window expires (test passes a fake `Instant`).
- `enabled = false` causes `report()` to short-circuit before hashing.

### 9.2 Worker - manual

```bash
curl -X POST https://ct-analytics.claude-terminal.workers.dev/error_report \
  -H "x-ct-token: $INGEST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"installation_id":"test","app_version":"0.0.0","os":"windows","source":"frontend","kind":"TypeError","message":"x is not a function","stack":"at foo (file:///C:/Users/test/app.js:1:1)","fingerprint":"abc123"}'

npx wrangler d1 execute claude-terminal --command "SELECT * FROM errors ORDER BY id DESC LIMIT 1"
```

### 9.3 End-to-end smoke

- Add `throw new Error('e2e-frontend')` to a button handler → click → row appears in D1 with `source='frontend'`.
- Add `panic!("e2e-rust")` to a Tauri command → trigger it → row with `source='rust_panic'`.
- Toggle setting off → repeat both → no rows.
- Disable network (airplane mode) → trigger error → app keeps running, `eprintln!` shows timeout, no row.

## 10. Rollout

1. Migrate D1 table on the live Worker (`wrangler d1 execute --remote ...`).
2. Add cron + `scheduled` handler to the Worker. Deploy via `wrangler deploy`.
3. Ship the new client code in the next minor release. CI's `CT_INGEST_TOKEN` is already wired (`release.yml`).
4. After 1–2 weeks of telemetry, decide whether to add a `/stats/errors` route + dashboard panel.

## 11. Out of scope (v1)

- Disk-based or in-memory retry queue when offline.
- `console.error` capture.
- Sentry-style grouping UI / inline error viewer.
- `/stats/errors` route on the worker.
- `daily_stats` aggregations for errors.
- PII review beyond Windows username scrubbing.
