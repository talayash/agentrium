# M2a: Sync Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Parent spec:** [2026-09-11-auth-sync-sharing-design.md](../specs/2026-09-11-auth-sync-sharing-design.md)

**Milestone:** M2a. Ships on the existing `feat/m1-auth-signin` branch as part of `v1.34.0-preview` (per user decision (b) to bundle M1+M2). M2b (email + password provider) is a separate plan.

**Goal:** Ship the cross-device cloud sync surface for a signed-in Agentrium user: `profiles`, `custom_agents`, and `workspaces` are pushed to the broker on mutation, pulled on boot/focus/interval, and reconciled last-write-wins. Add a pause/resume toggle in the account dropdown and a `SyncStatusChip` in the titlebar. Guest→account migration seeds a first-time signin's local rows into the account.

**Architecture:**
- Client uses SQLite `sync_queue` as an offline outbox: any mutation to a syncable row enqueues in the same transaction; a debounced Rust background task drains the queue via `POST /api/sync/push`. Pull uses a monotonic `updated_at` cursor stored in `user_meta.last_pull_cursor`.
- Server (`agentrium-api`) exposes two endpoints (`/api/sync/pull`, `/api/sync/push`) that read/write Postgres via Drizzle. Bearer-token auth against the JWT issued by the M1 broker; on 401 the client auto-refreshes once via `/api/auth/refresh`.
- Conflict resolution is last-write-wins per row by `updated_at`. Server never rewrites `updated_at`. Soft delete via `deleted_at` tombstone.
- Sync is per-device pausable via `user_meta.sync_enabled`; paused state stops the pusher/puller but keeps the outbox growing so resume drains cleanly.

**Tech Stack:**
- **Client (Rust):** existing `rusqlite`, `reqwest`, `serde_json`, `tokio`, `uuid`, `chrono`. New `Sync engine` module using `tokio::task::spawn` for background loops.
- **Client (TS/React):** existing Zustand, `@tauri-apps/api/event` for engine-emitted status events.
- **Server (Next.js on Vercel):** existing Drizzle + Neon Postgres from M1. Add sync tables to `db/schema.ts`, two new App Router routes.
- **Testing:** Vitest for FE + backend, Rust `#[cfg(test)]` unit tests, `cargo test --bins`.

**Prerequisites:**
- ✅ M1 landed (auth + broker + JWT + refresh).
- ✅ Vercel env vars for M1 (`AUTH_SECRET`, `DATABASE_URL`) already present.
- ✅ `feat/m1-auth-signin` branch on origin.

## Scope — what's IN vs OUT for M2a

**IN (this plan):**
- Syncable tables: `profiles`, `custom_agents`, `workspaces` (all three exist today, all are user-authored).
- SQLite migrations for those three + new `sync_queue` table.
- `/api/sync/pull` and `/api/sync/push` routes.
- Client sync engine with debounced push, cursor-based pull, LWW reconcile.
- Guest → account migration.
- `SyncStatusChip` in TitleBar.
- Sync pause/resume toggle in `HeaderAuth` dropdown (per user request during planning).

**OUT (deferred, note in plan for follow-up):**
- **`hints` sync** — the current `HintsPanel` reads static hints from `config.rs::HintCategory`; there is no user-editable `hints` SQLite table today. Adding sync here requires first designing "user-added hints" as a feature. Track as follow-up.
- **`app_settings` sync** — app preferences currently live in Zustand `persist` (localStorage). Migrating them into SQLite is a prerequisite, and the sync-safe/local-only key partition (spec §5.3) needs its own design pass. Track as follow-up.
- **`snippets` sync** — table exists but there is no UI for user creation today; scope creep. Track as follow-up.
- Sharing (spec §8) — M3.
- Telemetry attribution `user_id` field (spec §9) — M3.

**Rationale for exclusions:** M2a already spans 35+ tasks. Adding `hints`/`app_settings`/`snippets` doubles the design surface without changing the story shape — they're all "one more table on the same rails." Ship the rails first, add tables one at a time in follow-ups.

## File structure created / modified by this plan

**New files (client — Rust):**
- `src-tauri/src/sync.rs` — sync engine module (push loop, pull loop, LWW resolver, backoff)
- `src-tauri/src/sync_client.rs` — HTTP wrapper for `/api/sync/pull` and `/api/sync/push`

**New files (client — TS/React):**
- `src/lib/sync.ts` — client wrappers for sync IPC commands + status event subscription
- `src/store/syncStore.ts` — Zustand store for sync state (`status`, `enabled`, `lastPulledAt`, `queueDepth`)
- `src/components/SyncStatusChip.tsx` — titlebar chip

**New files (server — Next.js):**
- `agentrium-api/src/app/api/sync/pull/route.ts`
- `agentrium-api/src/app/api/sync/push/route.ts`
- `agentrium-api/src/lib/bearer.ts` — JWT bearer verifier used by sync routes
- `agentrium-api/src/lib/bearer.test.ts` — unit tests for bearer helper

**Modified files (client — Rust):**
- `src-tauri/src/database.rs` — add sync columns to `profiles`/`custom_agents`/`workspaces`, create `sync_queue`, backfill loop, `sync_queue` helpers, `user_meta` sync-enabled helpers
- `src-tauri/src/commands.rs` — register new sync/toggle commands
- `src-tauri/src/main.rs` — start sync engine on boot (guarded by auth + `sync_enabled`)
- `src-tauri/src/auth.rs` — trigger guest→account migration in the `auth-tokens-received` deep-link path; start sync engine after login
- `src-tauri/Cargo.toml` — no new deps expected (all listed crates already present)

**Modified files (client — TS/React):**
- `src/App.tsx` — subscribe to sync-status events, mount `SyncStatusChip` conditionally
- `src/components/TitleBar.tsx` — insert `SyncStatusChip` before `HeaderAuth`
- `src/components/HeaderAuth.tsx` — add sync toggle row in the account dropdown
- `src/lib/auth.ts` — start/stop sync in `logout()` and post-login hydration

**Modified files (server):**
- `agentrium-api/db/schema.ts` — add `profiles`, `custom_agents`, `workspaces` tables with the syncable shape from spec §5.2
- `agentrium-api/drizzle.config.ts` — no change (schema path already covers it)
- `agentrium-api/package.json` — no new deps

---

## Task 1: Add sync columns to `profiles` in `database.rs`

**Files:**
- Modify: `src-tauri/src/database.rs` (around the profiles migration loop at line ~196)

- [x] **Step 1: Extend the profiles ALTER TABLE loop**

The existing pattern is a loop over `ALTER TABLE profiles ADD COLUMN <col>`, swallowing "duplicate column name" errors. Add the sync columns to that same loop so they idempotently apply to legacy DBs and no-op on fresh installs (fresh `CREATE TABLE` doesn't include them either — that's fine because the ALTER runs on every boot).

Change the profiles migration column list from:
```rust
for column in [
    "preview_json TEXT",
    "agent TEXT NOT NULL DEFAULT 'claude'",
    "agent_args_json TEXT",
    "credential_bindings_json TEXT",
] {
```
to:
```rust
for column in [
    "preview_json TEXT",
    "agent TEXT NOT NULL DEFAULT 'claude'",
    "agent_args_json TEXT",
    "credential_bindings_json TEXT",
    // M2a sync columns. `updated_at` is the LWW key; ISO-8601 UTC.
    // `deleted_at` NULL means live, non-NULL means tombstone.
    // `sync_state` is one of 'local_only' | 'pending' | 'synced'.
    "updated_at TEXT",
    "deleted_at TEXT",
    "client_version INTEGER NOT NULL DEFAULT 1",
    "sync_state TEXT NOT NULL DEFAULT 'local_only'",
] {
```

Note `id TEXT PRIMARY KEY` already exists on `profiles`, so no id column added here.

- [x] **Step 2: Add the backfill loop for existing rows**

Immediately after the `ALTER TABLE profiles` loop, add:
```rust
// Backfill updated_at for pre-migration rows. Any row still on
// NULL was written before sync existed, so use `now()` — the first
// push will look like a fresh authoring event, which is correct.
conn.execute(
    "UPDATE profiles SET updated_at = ?1 WHERE updated_at IS NULL",
    params![chrono::Utc::now().to_rfc3339()],
)
.map_err(|e| e.to_string())?;
```

- [x] **Step 3: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): add sync columns + backfill for profiles"
```

**Landed as `91a2ce3`.** Code quality reviewer noted a follow-up suggestion for Tasks 5/7: consider adding a `CHECK (sync_state IN ('local_only','pending','synced'))` constraint or a Rust enum with `as_sql_str()` to prevent stringly-typed drift. Not blocking here.

---

## Task 2: Add sync columns to `custom_agents` in `database.rs`

**Files:**
- Modify: `src-tauri/src/database.rs`

- [x] **Step 1: Add a new ALTER TABLE migration loop for custom_agents** (landed `9a644bd`)

`custom_agents` already has `updated_at TEXT NOT NULL` — do not re-add it. Add the sync-specific ones alongside the existing profiles loop:

```rust
// M2a: custom_agents sync columns. `updated_at` and `id` already exist.
for column in [
    "deleted_at TEXT",
    "client_version INTEGER NOT NULL DEFAULT 1",
    "sync_state TEXT NOT NULL DEFAULT 'local_only'",
] {
    let sql = format!("ALTER TABLE custom_agents ADD COLUMN {}", column);
    if let Err(e) = conn.execute(&sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e.to_string());
        }
    }
}
```

No backfill needed — `updated_at` is already NOT NULL on this table.

- [x] **Step 2: Commit** (landed `9a644bd`)

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): add sync columns for custom_agents"
```

---

## Task 3: Add sync columns and refactor `workspaces` to TEXT id

**Files:**
- Modify: `src-tauri/src/database.rs`

Context: `workspaces` currently uses `id INTEGER PRIMARY KEY AUTOINCREMENT`. Sync needs a stable TEXT UUID that cross-device rows can share. We can't `ALTER` the primary key on SQLite, so we introduce a separate `sync_id TEXT UNIQUE` column, backfill it, and use `sync_id` as the network-facing key. Local INTEGER id keeps FK references (there aren't any) and stays stable.

- [x] **Step 1: Add a workspaces ALTER TABLE migration loop** (landed `cf606f4`)

```rust
// M2a: workspaces sync columns. Keep local INTEGER id intact; introduce
// a separate TEXT UUID sync_id used as the cross-device stable key.
for column in [
    "sync_id TEXT",
    "updated_at TEXT",
    "deleted_at TEXT",
    "client_version INTEGER NOT NULL DEFAULT 1",
    "sync_state TEXT NOT NULL DEFAULT 'local_only'",
] {
    let sql = format!("ALTER TABLE workspaces ADD COLUMN {}", column);
    if let Err(e) = conn.execute(&sql, []) {
        if !e.to_string().contains("duplicate column name") {
            return Err(e.to_string());
        }
    }
}
```

- [x] **Step 2: Backfill sync_id and updated_at for pre-migration rows** (landed `cf606f4`)

```rust
// Pre-migration workspaces get a fresh UUID sync_id and now() timestamp.
let workspace_ids: Vec<i64> = conn
    .prepare("SELECT id FROM workspaces WHERE sync_id IS NULL")
    .map_err(|e| e.to_string())?
    .query_map([], |row| row.get::<_, i64>(0))
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
let now = chrono::Utc::now().to_rfc3339();
for id in workspace_ids {
    let uuid = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "UPDATE workspaces SET sync_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![uuid, now, id],
    )
    .map_err(|e| e.to_string())?;
}
// Enforce uniqueness now that all rows have a sync_id.
conn.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_sync_id ON workspaces(sync_id)",
    [],
)
.map_err(|e| e.to_string())?;
```

- [x] **Step 3: Commit** (landed `cf606f4`)

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): add sync columns + TEXT sync_id for workspaces"
```

---

## Task 4: Create `sync_queue` table

**Files:**
- Modify: `src-tauri/src/database.rs` (inside the `init_schema` `execute_batch` block)

- [x] **Step 1: Add the sync_queue table to `init_schema`** (landed `04e3665`)

Add to the `CREATE TABLE IF NOT EXISTS` block (before the trailing indexes):

```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  PRIMARY KEY (table_name, row_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_enqueued_at ON sync_queue(enqueued_at);
```

- [x] **Step 2: Commit** (landed `04e3665`)

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): add sync_queue outbox table"
```

**Follow-ups flagged by code quality review of the 2-4 bundle (bake into subsequent tasks):**
- Task 5 or 7: add a Rust `SyncState` enum with `as_sql_str()` / `FromStr` so writers can't produce invalid strings like `'pendinng'`. Same argument applies to `AgentKind` on profiles (already precedent for stringly-typed).
- Task 8: `save_workspace` currently doesn't set `sync_id` / `updated_at` / `sync_state`, so every REPLACE produces NULL rows that are invisible to LWW. **Fix in Task 8** by having the writer stamp these fields. Also filter `WHERE name NOT LIKE '\_\_%' ESCAPE '\\'` (or equivalent) so ephemeral `__last_session__` rows never enqueue.
- Task 8 acceptance criterion: after every writer update, assert `SELECT COUNT(*) FROM <table> WHERE updated_at IS NULL = 0`.

---

## Task 5: `sync_queue` helper methods on `Database`

**Files:**
- Modify: `src-tauri/src/database.rs`

**Status: LANDED.** Bundle: `SyncState` enum precursor (`6203ae8`) → sync_queue helpers (`a3b4a8e`) → user_meta wrappers (`d9e0664`, Task 6) → touch/tombstone/mark_synced (`c923f14`, Task 7) → tombstone test coverage (`2ed261e`). 44/44 tests pass. Deferred to Task 8: enum-ify the `table: &str` parameter into a `SyncTable` compile-time allowlist if the spread of call sites justifies it (Minor per code review).

- [x] **Step 1: Add the `SyncQueueRow` struct** (bundle landed `a3b4a8e`; `SyncState` enum precursor at `6203ae8`)

Near the top of `database.rs`, alongside other model structs:

```rust
#[derive(Debug, Clone)]
pub struct SyncQueueRow {
    pub table_name: String,
    pub row_key: String,
    pub enqueued_at: String,
    pub attempts: i64,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
}
```

- [ ] **Step 2: Add the enqueue/dequeue/depth helpers on `impl Database`**

```rust
pub fn enqueue_sync(&self, table: &str, row_key: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    // INSERT OR REPLACE resets attempts to 0 so a re-enqueue after a
    // rewrite doesn't inherit the previous attempt's backoff state.
    self.conn.execute(
        "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
         VALUES (?1, ?2, ?3, 0, NULL)",
        params![table, row_key, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn peek_sync_queue(&self, limit: usize) -> Result<Vec<SyncQueueRow>, String> {
    let mut stmt = self
        .conn
        .prepare(
            "SELECT table_name, row_key, enqueued_at, attempts, last_attempt_at, last_error
             FROM sync_queue ORDER BY enqueued_at LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok(SyncQueueRow {
                table_name: r.get(0)?,
                row_key: r.get(1)?,
                enqueued_at: r.get(2)?,
                attempts: r.get(3)?,
                last_attempt_at: r.get(4)?,
                last_error: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_sync_queue_entries(&self, entries: &[(String, String)]) -> Result<(), String> {
    let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM sync_queue WHERE table_name = ?1 AND row_key = ?2")
            .map_err(|e| e.to_string())?;
        for (t, k) in entries {
            stmt.execute(params![t, k]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn record_sync_attempt(&self, table: &str, row_key: &str, error: Option<&str>) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    self.conn.execute(
        "UPDATE sync_queue
         SET attempts = attempts + 1, last_attempt_at = ?1, last_error = ?2
         WHERE table_name = ?3 AND row_key = ?4",
        params![now, error, table, row_key],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn sync_queue_depth(&self) -> Result<i64, String> {
    self.conn
        .query_row("SELECT COUNT(*) FROM sync_queue", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Add unit test**

Append to the existing `#[cfg(test)] mod tests` block in `database.rs`:

```rust
#[test]
fn sync_queue_enqueue_and_drain_cycle() {
    let db = Database::new_in_memory().unwrap();
    db.enqueue_sync("profiles", "p1").unwrap();
    db.enqueue_sync("profiles", "p2").unwrap();
    db.enqueue_sync("workspaces", "w1").unwrap();

    let rows = db.peek_sync_queue(100).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(db.sync_queue_depth().unwrap(), 3);

    db.delete_sync_queue_entries(&[
        ("profiles".into(), "p1".into()),
        ("workspaces".into(), "w1".into()),
    ])
    .unwrap();
    assert_eq!(db.sync_queue_depth().unwrap(), 1);

    let remaining = db.peek_sync_queue(100).unwrap();
    assert_eq!(remaining[0].row_key, "p2");
}

#[test]
fn record_sync_attempt_increments_and_stores_error() {
    let db = Database::new_in_memory().unwrap();
    db.enqueue_sync("profiles", "p1").unwrap();
    db.record_sync_attempt("profiles", "p1", Some("boom")).unwrap();
    db.record_sync_attempt("profiles", "p1", None).unwrap();
    let rows = db.peek_sync_queue(10).unwrap();
    assert_eq!(rows[0].attempts, 2);
    assert!(rows[0].last_attempt_at.is_some());
    // Second recorded attempt cleared the error message.
    assert!(rows[0].last_error.is_none());
}
```

- [ ] **Step 4: Run tests + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins database::tests::sync_queue
git add src-tauri/src/database.rs
git commit -m "feat(sync): enqueue/dequeue/attempt helpers for sync_queue"
```

---

## Task 6: `user_meta` helpers for `sync_enabled` and `last_pull_cursor`

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Add typed helpers**

The generic `get_user_meta`/`set_user_meta` already exist from M1. Add these thin wrappers so callers don't sprinkle string keys everywhere:

```rust
pub fn get_sync_enabled(&self) -> Result<bool, String> {
    // Default ON — sync is the reason a user signed in, so opt-out not opt-in.
    Ok(self.get_user_meta("sync_enabled")?.as_deref() != Some("0"))
}

pub fn set_sync_enabled(&self, enabled: bool) -> Result<(), String> {
    self.set_user_meta("sync_enabled", if enabled { "1" } else { "0" })
}

pub fn get_last_pull_cursor(&self) -> Result<Option<String>, String> {
    self.get_user_meta("last_pull_cursor")
}

pub fn set_last_pull_cursor(&self, cursor: &str) -> Result<(), String> {
    self.set_user_meta("last_pull_cursor", cursor)
}
```

- [ ] **Step 2: Unit test the sync_enabled default**

```rust
#[test]
fn sync_enabled_defaults_to_true_when_unset() {
    let db = Database::new_in_memory().unwrap();
    assert!(db.get_sync_enabled().unwrap());
    db.set_sync_enabled(false).unwrap();
    assert!(!db.get_sync_enabled().unwrap());
    db.set_sync_enabled(true).unwrap();
    assert!(db.get_sync_enabled().unwrap());
}
```

- [ ] **Step 3: Commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins database::tests::sync_enabled
git add src-tauri/src/database.rs
git commit -m "feat(sync): sync_enabled + last_pull_cursor user_meta helpers"
```

---

## Task 7: Sync-aware mutation helpers on `Database` for profiles/custom_agents/workspaces

**Files:**
- Modify: `src-tauri/src/database.rs`

**Context:** Existing mutations (`save_profile`, `save_custom_agent`, `save_workspace`, etc.) don't set `updated_at` or `sync_state='pending'`, and don't enqueue. Rather than modify every call site's SQL, add small helpers that wrap a mutation + queue-enqueue in one transaction and update the sync columns.

- [ ] **Step 1: Add `touch_sync_row` helper**

Bumps `updated_at`, sets `sync_state='pending'`, and enqueues in `sync_queue` — all in one transaction.

```rust
/// Mark a syncable row as needing push. Idempotent: calling twice on the
/// same row before the pusher drains it just bumps updated_at again.
///
/// Table names are the local SQLite table (profiles/custom_agents/workspaces).
/// row_key is the sync-facing key: `id` for profiles/custom_agents, `sync_id`
/// for workspaces (see task 3).
pub fn touch_sync_row(&self, table: &str, row_key: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let where_col = if table == "workspaces" { "sync_id" } else { "id" };
    let sql = format!(
        "UPDATE {table} SET updated_at = ?1, sync_state = 'pending' WHERE {where_col} = ?2"
    );
    tx.execute(&sql, params![now, row_key])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
         VALUES (?1, ?2, ?3, 0, NULL)",
        params![table, row_key, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark a syncable row as soft-deleted and enqueue the tombstone.
pub fn tombstone_sync_row(&self, table: &str, row_key: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let where_col = if table == "workspaces" { "sync_id" } else { "id" };
    let sql = format!(
        "UPDATE {table} SET updated_at = ?1, deleted_at = ?1, sync_state = 'pending' WHERE {where_col} = ?2"
    );
    tx.execute(&sql, params![now, row_key])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
         VALUES (?1, ?2, ?3, 0, NULL)",
        params![table, row_key, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// After a successful push, flip the row to `synced` if updated_at still
/// matches what was pushed (protects against a mutation racing the push).
pub fn mark_row_synced_if_unchanged(
    &self,
    table: &str,
    row_key: &str,
    pushed_updated_at: &str,
) -> Result<(), String> {
    let where_col = if table == "workspaces" { "sync_id" } else { "id" };
    let sql = format!(
        "UPDATE {table} SET sync_state = 'synced'
         WHERE {where_col} = ?1 AND updated_at = ?2 AND sync_state = 'pending'"
    );
    self.conn
        .execute(&sql, params![row_key, pushed_updated_at])
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Unit test the transactional behavior**

```rust
#[test]
fn touch_sync_row_enqueues_and_bumps_updated_at() {
    let db = Database::new_in_memory().unwrap();
    // Seed a profile row directly (bypassing save_profile so we control state).
    db.conn.execute(
        "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
         VALUES ('p1', 'Test', '/tmp', '[]', '{}', '2020-01-01T00:00:00Z', 'synced')",
        [],
    ).unwrap();

    db.touch_sync_row("profiles", "p1").unwrap();

    let (updated_at, sync_state): (String, String) = db.conn.query_row(
        "SELECT updated_at, sync_state FROM profiles WHERE id = 'p1'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert!(updated_at > "2020-01-01T00:00:00Z".to_string());
    assert_eq!(sync_state, "pending");

    assert_eq!(db.sync_queue_depth().unwrap(), 1);
}

#[test]
fn mark_row_synced_if_unchanged_is_race_safe() {
    let db = Database::new_in_memory().unwrap();
    db.conn.execute(
        "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
         VALUES ('p1', 'Test', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'pending')",
        [],
    ).unwrap();

    // Successful push: nothing has changed since the pushed timestamp -> flip to synced.
    db.mark_row_synced_if_unchanged("profiles", "p1", "2026-01-01T00:00:00Z").unwrap();
    let s: String = db.conn.query_row(
        "SELECT sync_state FROM profiles WHERE id = 'p1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(s, "synced");

    // Now the user edits the row while a stale push completes.
    db.conn.execute(
        "UPDATE profiles SET updated_at = '2026-06-01T00:00:00Z', sync_state = 'pending' WHERE id = 'p1'",
        [],
    ).unwrap();
    // Stale push tries to flip it — must NOT clobber pending state.
    db.mark_row_synced_if_unchanged("profiles", "p1", "2026-01-01T00:00:00Z").unwrap();
    let s: String = db.conn.query_row(
        "SELECT sync_state FROM profiles WHERE id = 'p1'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(s, "pending"); // still pending; the newer edit is not yet pushed
}
```

- [ ] **Step 3: Commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins database::tests
git add src-tauri/src/database.rs
git commit -m "feat(sync): touch/tombstone/mark_synced helpers with race-safe flip"
```

---

## Task 8: Wire existing mutation IPCs to enqueue sync

**Files:**
- Modify: `src-tauri/src/commands.rs` (or wherever save_profile / save_custom_agent / save_workspace live — grep for `#[command]` on those names)
- Modify: whichever files own `save_profile`, `delete_profile`, `save_custom_agent`, `delete_custom_agent`, `save_workspace`, `delete_workspace` (search first — layout may vary)

- [ ] **Step 1: Add `db.touch_sync_row(...)` calls after every successful mutation**

For each mutation IPC handler that already writes to a syncable table, add a `db.touch_sync_row(table, row_key)` call after the underlying `save_*` returns Ok. Example for profiles:

```rust
// In whichever file owns save_profile:
pub async fn save_profile(profile: ConfigProfile, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    let profile_id = profile.id.clone();
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap_or_else(|p| p.into_inner());
        db.save_profile(&profile)?;
        db.touch_sync_row("profiles", &profile_id)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("DB task failed: {e}"))??;
    Ok(())
}
```

For deletes, use `tombstone_sync_row` instead of touching + physical delete (spec §7: soft delete via `deleted_at`; server keeps the tombstone; client reads via `WHERE deleted_at IS NULL` filter). Since the app currently physically deletes on `delete_profile`, we shift the semantics: tombstone locally, filter reads.

```rust
pub async fn delete_profile(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap_or_else(|p| p.into_inner());
        db.tombstone_sync_row("profiles", &id)
    })
    .await
    .map_err(|e| format!("DB task failed: {e}"))?
}
```

- [ ] **Step 2: Filter tombstoned rows out of existing read paths**

Every `SELECT * FROM profiles`, `custom_agents`, `workspaces` call needs `WHERE deleted_at IS NULL` appended. Grep for the SELECT statements and add the filter. Confirm the frontend's `get_profiles` / `list_custom_agents` / `load_workspaces` return the filtered set.

Example patch pattern for a profiles SELECT:
```rust
// Before
"SELECT id, name, ... FROM profiles ORDER BY name"
// After
"SELECT id, name, ... FROM profiles WHERE deleted_at IS NULL ORDER BY name"
```

- [ ] **Step 3: Add a test that a tombstoned row is invisible to reads**

Add to `database.rs` tests:
```rust
#[test]
fn tombstoned_profile_is_excluded_from_get_profiles() {
    let db = Database::new_in_memory().unwrap();
    // Seed one live and one tombstoned row.
    db.conn.execute(
        "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at)
         VALUES ('live', 'Live', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z'),
                ('gone', 'Gone', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z')",
        [],
    ).unwrap();
    db.tombstone_sync_row("profiles", "gone").unwrap();

    let all = db.get_profiles().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "live");
}
```

- [ ] **Step 4: Commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins
git add -u src-tauri/src
git commit -m "feat(sync): enqueue on mutation, tombstone on delete, filter tombstones from reads"
```

---

## Task 9: Broker Drizzle schema for syncable tables

**Files:**
- Modify: `agentrium-api/db/schema.ts`

- [ ] **Step 1: Extend schema.ts with the three syncable tables**

Add near the existing table definitions (import `pgTable`, `text`, `boolean`, `jsonb`, `integer`, `timestamp`, `uuid`, `index` from `drizzle-orm/pg-core` as needed):

```typescript
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    workingDirectory: text('working_directory'),
    claudeArgs: jsonb('claude_args').notNull().default([]),
    envVars: jsonb('env_vars').notNull().default({}),
    isDefault: boolean('is_default').notNull().default(false),
    agent: text('agent').notNull().default('claude'),
    agentArgsJson: jsonb('agent_args_json'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    clientVersion: integer('client_version').notNull().default(1),
  },
  (t) => ({
    userUpdated: index('profiles_user_updated_idx').on(t.userId, t.updatedAt),
  }),
);

export const customAgents = pgTable(
  'custom_agents',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    binary: text('binary').notNull(),
    defaultArgs: jsonb('default_args').notNull().default([]),
    resumeFlag: text('resume_flag'),
    color: text('color').notNull(),
    requiredEnv: jsonb('required_env').notNull().default([]),
    bindings: jsonb('bindings').notNull().default([]),
    installUrl: text('install_url'),
    installHint: text('install_hint'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    clientVersion: integer('client_version').notNull().default(1),
  },
  (t) => ({
    userUpdated: index('custom_agents_user_updated_idx').on(t.userId, t.updatedAt),
  }),
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    terminals: jsonb('terminals').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    clientVersion: integer('client_version').notNull().default(1),
  },
  (t) => ({
    userUpdated: index('workspaces_user_updated_idx').on(t.userId, t.updatedAt),
  }),
);
```

- [ ] **Step 2: Export from db/index.ts (or equivalent) so route handlers can import**

If schema is re-exported through `src/lib/db.ts` (from M1), add the three new tables to that re-export.

- [ ] **Step 3: Generate + apply migration**

```bash
cd agentrium-api
npx drizzle-kit generate
npx drizzle-kit push
```

Confirm three new tables appear in Neon dashboard.

- [ ] **Step 4: Commit**

```bash
git add db/schema.ts src/lib/db.ts drizzle/*
git commit -m "feat(sync): add profiles/custom_agents/workspaces syncable tables"
```

---

## Task 10: Bearer-token JWT verifier for `/api/sync/*`

**Files:**
- Create: `agentrium-api/src/lib/bearer.ts`
- Create: `agentrium-api/src/lib/bearer.test.ts`

- [ ] **Step 1: Write the verifier**

```typescript
import { NextRequest } from 'next/server';
import { verifyAccessToken } from './jwt'; // existing from M1

export type BearerAuth =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 400; error: string };

/**
 * Extracts a Bearer access token from the Authorization header, verifies it
 * against AUTH_SECRET, and returns the user identity. Used by every /api/sync
 * route. On 401 the client will refresh once and retry (see spec §7.2).
 */
export async function requireBearer(req: NextRequest): Promise<BearerAuth> {
  const auth = req.headers.get('authorization') ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return { ok: false, status: 400, error: 'missing_bearer' };
  }
  try {
    const claims = await verifyAccessToken(token);
    if (!claims.sub || !claims.email) {
      return { ok: false, status: 401, error: 'invalid_claims' };
    }
    return { ok: true, userId: claims.sub, email: claims.email };
  } catch {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
}
```

- [ ] **Step 2: Unit test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { requireBearer } from './bearer';

vi.mock('./jwt', () => ({
  verifyAccessToken: vi.fn(),
}));
import { verifyAccessToken } from './jwt';

function reqWithAuth(header: string | null) {
  return { headers: { get: (k: string) => (k === 'authorization' ? header : null) } } as any;
}

describe('requireBearer', () => {
  it('rejects missing header', async () => {
    const r = await requireBearer(reqWithAuth(null));
    expect(r).toEqual({ ok: false, status: 400, error: 'missing_bearer' });
  });

  it('rejects non-Bearer scheme', async () => {
    const r = await requireBearer(reqWithAuth('Basic xxx'));
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(400);
  });

  it('rejects when jwt verification throws', async () => {
    (verifyAccessToken as any).mockRejectedValueOnce(new Error('expired'));
    const r = await requireBearer(reqWithAuth('Bearer bad'));
    expect(r).toEqual({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('returns identity on happy path', async () => {
    (verifyAccessToken as any).mockResolvedValueOnce({ sub: 'user1', email: 'x@y' });
    const r = await requireBearer(reqWithAuth('Bearer good'));
    expect(r).toEqual({ ok: true, userId: 'user1', email: 'x@y' });
  });
});
```

- [ ] **Step 3: Run tests + commit**

```bash
cd agentrium-api && npx vitest run src/lib/bearer.test.ts
git add src/lib/bearer.ts src/lib/bearer.test.ts
git commit -m "feat(sync): bearer JWT verifier for /api/sync routes"
```

---

## Task 11: `POST /api/sync/pull` route

**Files:**
- Create: `agentrium-api/src/app/api/sync/pull/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { db, profiles, customAgents, workspaces } from '../../../../lib/db';
import { requireBearer } from '../../../../lib/bearer';

const bodySchema = z.object({
  since: z.string().nullable(),
  tables: z.array(z.enum(['profiles', 'custom_agents', 'workspaces'])).optional(),
});

const PULL_ROW_CAP = 1000;

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.format() }, { status: 400 });
  }
  const { since, tables } = parsed.data;
  const wanted = new Set(tables ?? ['profiles', 'custom_agents', 'workspaces']);
  const sinceDate = since ? new Date(since) : new Date(0);

  const serverTime = new Date().toISOString();
  const out: Record<string, unknown[]> = {};
  let remaining = PULL_ROW_CAP;

  if (wanted.has('profiles') && remaining > 0) {
    const rows = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.userId, auth.userId), gt(profiles.updatedAt, sinceDate)))
      .limit(remaining);
    out.profiles = rows;
    remaining -= rows.length;
  }
  if (wanted.has('custom_agents') && remaining > 0) {
    const rows = await db
      .select()
      .from(customAgents)
      .where(and(eq(customAgents.userId, auth.userId), gt(customAgents.updatedAt, sinceDate)))
      .limit(remaining);
    out.custom_agents = rows;
    remaining -= rows.length;
  }
  if (wanted.has('workspaces') && remaining > 0) {
    const rows = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, auth.userId), gt(workspaces.updatedAt, sinceDate)))
      .limit(remaining);
    out.workspaces = rows;
    remaining -= rows.length;
  }

  return NextResponse.json({ ...out, server_time: serverTime, truncated: remaining === 0 });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sync/pull/route.ts
git commit -m "feat(sync): POST /api/sync/pull with cursor + per-table gate + 1000-row cap"
```

---

## Task 12: `POST /api/sync/push` route with LWW upsert

**Files:**
- Create: `agentrium-api/src/app/api/sync/push/route.ts`

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, gte } from 'drizzle-orm';
import { db, profiles, customAgents, workspaces } from '../../../../lib/db';
import { requireBearer } from '../../../../lib/bearer';

const rowBase = z.object({
  id: z.string().uuid(),
  updatedAt: z.string(), // ISO-8601
  deletedAt: z.string().nullable().optional(),
  clientVersion: z.number().int().default(1),
});

const profileRow = rowBase.extend({
  name: z.string(),
  description: z.string().nullable().optional(),
  workingDirectory: z.string().nullable().optional(),
  claudeArgs: z.array(z.string()).default([]),
  envVars: z.record(z.string()).default({}),
  isDefault: z.boolean().default(false),
  agent: z.string().default('claude'),
  agentArgsJson: z.record(z.array(z.string())).nullable().optional(),
});

const customAgentRow = rowBase.extend({
  name: z.string(),
  binary: z.string(),
  defaultArgs: z.array(z.string()).default([]),
  resumeFlag: z.string().nullable().optional(),
  color: z.string(),
  requiredEnv: z.array(z.string()).default([]),
  bindings: z.array(z.unknown()).default([]),
  installUrl: z.string().nullable().optional(),
  installHint: z.string().nullable().optional(),
});

const workspaceRow = rowBase.extend({
  name: z.string(),
  terminals: z.array(z.unknown()),
  createdAt: z.string(),
});

const bodySchema = z.object({
  profiles: z.array(profileRow).optional(),
  custom_agents: z.array(customAgentRow).optional(),
  workspaces: z.array(workspaceRow).optional(),
});

const PUSH_ROW_CAP = 500;

export async function POST(req: NextRequest) {
  const auth = await requireBearer(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', details: parsed.error.format() }, { status: 400 });
  }
  const total =
    (parsed.data.profiles?.length ?? 0) +
    (parsed.data.custom_agents?.length ?? 0) +
    (parsed.data.workspaces?.length ?? 0);
  if (total > PUSH_ROW_CAP) {
    return NextResponse.json({ error: 'too_many_rows', cap: PUSH_ROW_CAP }, { status: 400 });
  }

  const accepted: Record<string, string[]> = { profiles: [], custom_agents: [], workspaces: [] };
  const skipped: Record<string, string[]> = { profiles: [], custom_agents: [], workspaces: [] };

  // Per-table LWW: skip if server row's updatedAt >= incoming updatedAt.
  // Do it in one transaction so partial failures roll back cleanly.
  await db.transaction(async (tx) => {
    for (const row of parsed.data.profiles ?? []) {
      const existing = await tx
        .select({ updatedAt: profiles.updatedAt })
        .from(profiles)
        .where(and(eq(profiles.id, row.id), eq(profiles.userId, auth.userId)))
        .limit(1);
      const incoming = new Date(row.updatedAt);
      if (existing[0] && existing[0].updatedAt >= incoming) {
        skipped.profiles.push(row.id);
        continue;
      }
      await tx
        .insert(profiles)
        .values({ ...row, userId: auth.userId, updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null })
        .onConflictDoUpdate({
          target: profiles.id,
          set: { ...row, updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null },
          where: gte(new Date(row.updatedAt), profiles.updatedAt),
        });
      accepted.profiles.push(row.id);
    }
    // Repeat the same block for custom_agents and workspaces. Extract into a
    // helper if repetitive; per-table drift is expected long-term (e.g.
    // workspaces has createdAt), so inlined per-table is easier to read.
    for (const row of parsed.data.custom_agents ?? []) {
      const existing = await tx
        .select({ updatedAt: customAgents.updatedAt })
        .from(customAgents)
        .where(and(eq(customAgents.id, row.id), eq(customAgents.userId, auth.userId)))
        .limit(1);
      const incoming = new Date(row.updatedAt);
      if (existing[0] && existing[0].updatedAt >= incoming) {
        skipped.custom_agents.push(row.id);
        continue;
      }
      await tx
        .insert(customAgents)
        .values({ ...row, userId: auth.userId, updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null })
        .onConflictDoUpdate({
          target: customAgents.id,
          set: { ...row, updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null },
          where: gte(new Date(row.updatedAt), customAgents.updatedAt),
        });
      accepted.custom_agents.push(row.id);
    }
    for (const row of parsed.data.workspaces ?? []) {
      const existing = await tx
        .select({ updatedAt: workspaces.updatedAt })
        .from(workspaces)
        .where(and(eq(workspaces.id, row.id), eq(workspaces.userId, auth.userId)))
        .limit(1);
      const incoming = new Date(row.updatedAt);
      if (existing[0] && existing[0].updatedAt >= incoming) {
        skipped.workspaces.push(row.id);
        continue;
      }
      await tx
        .insert(workspaces)
        .values({ ...row, userId: auth.userId, createdAt: new Date(row.createdAt), updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null })
        .onConflictDoUpdate({
          target: workspaces.id,
          set: { ...row, updatedAt: incoming, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null },
          where: gte(new Date(row.updatedAt), workspaces.updatedAt),
        });
      accepted.workspaces.push(row.id);
    }
  });

  return NextResponse.json({ accepted, skipped });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/sync/push/route.ts
git commit -m "feat(sync): POST /api/sync/push with per-row LWW upsert"
```

---

## Task 13: Bearer contract test for pull + push

**Files:**
- Create: `agentrium-api/src/app/api/sync/pull/route.test.ts`
- Create: `agentrium-api/src/app/api/sync/push/route.test.ts`

- [ ] **Step 1: Mock db + bearer, verify handler behaviors**

For pull:
```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../lib/bearer', () => ({
  requireBearer: vi.fn(),
}));
vi.mock('../../../../lib/db', () => {
  const rows = [{ id: 'p1', name: 'p', updatedAt: new Date('2026-06-01') }];
  const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
  return {
    db: { select: () => chain },
    profiles: {}, customAgents: {}, workspaces: {},
  };
});

import { POST } from './route';
import { requireBearer } from '../../../../lib/bearer';

function req(body: unknown, headers: Record<string, string> = {}) {
  return { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body } as any;
}

describe('POST /api/sync/pull', () => {
  it('401s when bearer invalid', async () => {
    (requireBearer as any).mockResolvedValueOnce({ ok: false, status: 401, error: 'invalid_token' });
    const r = await POST(req({ since: null }));
    expect(r.status).toBe(401);
  });

  it('returns rows for authed user', async () => {
    (requireBearer as any).mockResolvedValueOnce({ ok: true, userId: 'u1', email: 'e' });
    const r = await POST(req({ since: null }));
    const body = await r.json();
    expect(body.profiles).toHaveLength(1);
    expect(body).toHaveProperty('server_time');
    expect(body.truncated).toBe(false);
  });

  it('400s malformed body', async () => {
    (requireBearer as any).mockResolvedValueOnce({ ok: true, userId: 'u1', email: 'e' });
    const r = await POST(req({ since: 42 }));
    expect(r.status).toBe(400);
  });
});
```

For push (similar shape — mock the transaction as `(cb) => cb(txMock)`, verify accepted/skipped semantics). Full test file follows the same pattern; see `pull/route.test.ts` and adapt.

- [ ] **Step 2: Commit**

```bash
cd agentrium-api && npx vitest run src/app/api/sync
git add src/app/api/sync
git commit -m "test(sync): contract tests for pull + push routes"
```

---

## Task 14: Rust `sync_client.rs` — HTTP wrapper for pull + push

**Files:**
- Create: `src-tauri/src/sync_client.rs`
- Modify: `src-tauri/src/main.rs` (register module)

- [ ] **Step 1: Write the client module**

```rust
//! Thin reqwest wrapper for `/api/sync/pull` and `/api/sync/push`.
//! Handles Bearer header + one-shot 401 refresh (spec §7.2).

use crate::{auth, error_reporter};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const API_BASE: &str = "https://agentrium-api.vercel.app";

#[derive(Debug, Serialize)]
pub struct PullRequest {
    pub since: Option<String>,
    pub tables: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub profiles: Option<Vec<Value>>,
    pub custom_agents: Option<Vec<Value>>,
    pub workspaces: Option<Vec<Value>>,
    pub server_time: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct PushRequest {
    pub profiles: Option<Vec<Value>>,
    pub custom_agents: Option<Vec<Value>>,
    pub workspaces: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
pub struct PushResponse {
    pub accepted: std::collections::HashMap<String, Vec<String>>,
    pub skipped: std::collections::HashMap<String, Vec<String>>,
}

pub struct SyncClient {
    http: reqwest::Client,
    access_token: String,
}

impl SyncClient {
    pub fn new(access_token: String) -> Self {
        Self { http: reqwest::Client::new(), access_token }
    }

    pub async fn pull(&mut self, req: PullRequest) -> Result<PullResponse, SyncError> {
        self.post_with_refresh("/api/sync/pull", &req).await
    }

    pub async fn push(&mut self, req: PushRequest) -> Result<PushResponse, SyncError> {
        self.post_with_refresh("/api/sync/push", &req).await
    }

    async fn post_with_refresh<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &mut self,
        path: &str,
        body: &Req,
    ) -> Result<Resp, SyncError> {
        let url = format!("{API_BASE}{path}");
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.access_token)
            .json(body)
            .send()
            .await
            .map_err(SyncError::Network)?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            // One-shot refresh, then retry. Force-logout on second 401 is
            // handled by the sync engine layer, not here.
            let new_token = auth::refresh_access_token()
                .await
                .map_err(SyncError::Refresh)?;
            self.access_token = new_token;
            let retry = self
                .http
                .post(&url)
                .bearer_auth(&self.access_token)
                .json(body)
                .send()
                .await
                .map_err(SyncError::Network)?;
            return self.decode(retry).await;
        }
        self.decode(resp).await
    }

    async fn decode<Resp: for<'de> Deserialize<'de>>(&self, resp: reqwest::Response) -> Result<Resp, SyncError> {
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SyncError::Server(status.as_u16(), text));
        }
        resp.json::<Resp>().await.map_err(SyncError::Decode)
    }
}

#[derive(Debug)]
pub enum SyncError {
    Network(reqwest::Error),
    Refresh(String),
    Server(u16, String),
    Decode(reqwest::Error),
}

impl SyncError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, SyncError::Server(401, _))
    }
}
```

- [ ] **Step 2: Register the module in `main.rs`**

Add `mod sync_client;` alongside the existing module declarations.

- [ ] **Step 3: Verify compilation**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync_client.rs src-tauri/src/main.rs
git commit -m "feat(sync): reqwest wrapper for /api/sync with one-shot 401 refresh"
```

---

## Task 15: `sync.rs` module scaffold + status types

**Files:**
- Create: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/main.rs` (register module)

- [ ] **Step 1: Write the module skeleton with status types + Tauri events**

```rust
//! Sync engine: background task that drains sync_queue via /api/sync/push
//! and pulls remote changes via /api/sync/pull. Life cycle is controlled
//! by `SyncHandle` which supports start/stop/pause/resume/sync-now and
//! survives access-token rotation.
//!
//! Emits `sync-status-changed` Tauri events so the frontend chip stays live.

use crate::{database::Database, sync_client};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Idle,
    Syncing,
    Paused,
    Offline,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusPayload {
    pub status: SyncStatus,
    pub queue_depth: i64,
    pub last_pulled_at: Option<String>,
    pub last_error: Option<String>,
}

pub enum SyncCommand {
    /// Push and pull now, bypassing debounce.
    SyncNow,
    /// Set `sync_enabled` state; when false, engine loops enter Paused.
    SetEnabled(bool),
    /// Access token rotated (post-refresh). Update the client.
    UpdateToken(String),
    /// Stop the engine (on logout).
    Shutdown,
}

pub struct SyncHandle {
    tx: mpsc::Sender<SyncCommand>,
}

impl SyncHandle {
    pub fn sync_now(&self) {
        let _ = self.tx.try_send(SyncCommand::SyncNow);
    }
    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.tx.try_send(SyncCommand::SetEnabled(enabled));
    }
    pub fn update_token(&self, token: String) {
        let _ = self.tx.try_send(SyncCommand::UpdateToken(token));
    }
    pub fn shutdown(&self) {
        let _ = self.tx.try_send(SyncCommand::Shutdown);
    }
}

pub fn start_engine(
    app: tauri::AppHandle,
    db: Arc<Mutex<Database>>,
    access_token: String,
) -> SyncHandle {
    let (tx, rx) = mpsc::channel::<SyncCommand>(16);
    tokio::spawn(run_engine(app, db, access_token, rx));
    SyncHandle { tx }
}

async fn run_engine(
    app: tauri::AppHandle,
    db: Arc<Mutex<Database>>,
    access_token: String,
    mut rx: mpsc::Receiver<SyncCommand>,
) {
    // Fleshed out in tasks 16-19.
    let _ = (app, db, access_token, rx);
}
```

- [ ] **Step 2: Register module + commit**

Add `mod sync;` to `main.rs`, then:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/sync.rs src-tauri/src/main.rs
git commit -m "feat(sync): sync engine scaffold with command channel + status types"
```

---

## Task 16: LWW resolver as a pure function + unit tests

**Files:**
- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Add the resolver**

```rust
/// Compare two ISO-8601 timestamps and return whether `incoming` should win.
/// LWW: incoming wins iff strictly newer than local. Tie goes to local.
/// This is the client-side counterpart to the server's `>=` skip check —
/// the server treats equal timestamps as "older loses"; the client is
/// permissive and keeps its local copy on ties.
pub fn incoming_wins(local_updated_at: &str, incoming_updated_at: &str) -> bool {
    incoming_updated_at > local_updated_at
}
```

- [ ] **Step 2: Unit tests**

Inside `#[cfg(test)] mod tests` in `sync.rs`:

```rust
use super::*;

#[test]
fn incoming_wins_when_strictly_newer() {
    assert!(incoming_wins("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"));
}

#[test]
fn incoming_loses_when_older() {
    assert!(!incoming_wins("2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z"));
}

#[test]
fn tie_goes_to_local() {
    assert!(!incoming_wins("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z"));
}
```

- [ ] **Step 3: Run + commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins sync::tests
git add src-tauri/src/sync.rs
git commit -m "feat(sync): LWW resolver with tie-to-local"
```

---

## Task 17: Sync engine push loop implementation

**Files:**
- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Fill in the push loop**

Replace `run_engine`'s body with the full state machine:

```rust
use std::time::Duration;
use tauri::Emitter;

const PUSH_BATCH_ROW_CAP: usize = 500;
const DEBOUNCE_MS: u64 = 5_000;
const PULL_INTERVAL_MS: u64 = 5 * 60 * 1_000;

async fn run_engine(
    app: tauri::AppHandle,
    db: Arc<Mutex<Database>>,
    mut access_token: String,
    mut rx: mpsc::Receiver<SyncCommand>,
) {
    let mut enabled = db.lock().await.get_sync_enabled().unwrap_or(true);
    let mut client = sync_client::SyncClient::new(access_token.clone());
    let mut debounce_tick = tokio::time::interval(Duration::from_millis(1_000));
    let mut pull_tick = tokio::time::interval(Duration::from_millis(PULL_INTERVAL_MS));
    let mut dirty_since: Option<tokio::time::Instant> = None;
    let mut last_status = SyncStatus::Idle;

    emit_status(&app, &db, SyncStatus::Idle, None).await;

    // Boot-time pull if enabled.
    if enabled {
        do_pull(&app, &db, &mut client).await;
    }

    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(SyncCommand::SyncNow) => {
                    if enabled {
                        do_push(&app, &db, &mut client).await;
                        do_pull(&app, &db, &mut client).await;
                    }
                }
                Some(SyncCommand::SetEnabled(e)) => {
                    enabled = e;
                    let _ = db.lock().await.set_sync_enabled(e);
                    if e {
                        emit_status(&app, &db, SyncStatus::Idle, None).await;
                        do_push(&app, &db, &mut client).await;
                        do_pull(&app, &db, &mut client).await;
                    } else {
                        emit_status(&app, &db, SyncStatus::Paused, None).await;
                    }
                }
                Some(SyncCommand::UpdateToken(t)) => {
                    access_token = t.clone();
                    client = sync_client::SyncClient::new(t);
                }
                Some(SyncCommand::Shutdown) | None => break,
            },
            _ = debounce_tick.tick() => {
                if !enabled { continue; }
                // Detect new queue entries by comparing depth to last-seen.
                let depth = db.lock().await.sync_queue_depth().unwrap_or(0);
                if depth > 0 && dirty_since.is_none() {
                    dirty_since = Some(tokio::time::Instant::now());
                }
                if let Some(since) = dirty_since {
                    if since.elapsed() >= Duration::from_millis(DEBOUNCE_MS) {
                        do_push(&app, &db, &mut client).await;
                        dirty_since = None;
                    }
                }
            },
            _ = pull_tick.tick() => {
                if !enabled { continue; }
                do_pull(&app, &db, &mut client).await;
            }
        }
    }
    let _ = last_status; // silence unused
}
```

- [ ] **Step 2: Add `do_push` implementation**

```rust
async fn do_push(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) {
    emit_status(app, db, SyncStatus::Syncing, None).await;
    let queue = match db.lock().await.peek_sync_queue(PUSH_BATCH_ROW_CAP) {
        Ok(q) => q,
        Err(e) => { emit_status(app, db, SyncStatus::Error, Some(e)).await; return; }
    };
    if queue.is_empty() {
        emit_status(app, db, SyncStatus::Idle, None).await;
        return;
    }

    // Group by table, resolve each row to its full JSON payload.
    let (profiles, custom_agents, workspaces) = collect_rows(db, &queue).await;

    let req = sync_client::PushRequest {
        profiles: if profiles.is_empty() { None } else { Some(profiles.iter().map(|(_, v)| v.clone()).collect()) },
        custom_agents: if custom_agents.is_empty() { None } else { Some(custom_agents.iter().map(|(_, v)| v.clone()).collect()) },
        workspaces: if workspaces.is_empty() { None } else { Some(workspaces.iter().map(|(_, v)| v.clone()).collect()) },
    };

    match client.push(req).await {
        Ok(resp) => {
            let db_guard = db.lock().await;
            for (table, ids) in &resp.accepted {
                for id in ids {
                    // Find the pushed row's updated_at to protect against race.
                    let pushed_ts = match table.as_str() {
                        "profiles" => profiles.iter().find(|(k, _)| k == id).and_then(|(_, v)| v.get("updated_at").and_then(|s| s.as_str()).map(String::from)),
                        "custom_agents" => custom_agents.iter().find(|(k, _)| k == id).and_then(|(_, v)| v.get("updated_at").and_then(|s| s.as_str()).map(String::from)),
                        "workspaces" => workspaces.iter().find(|(k, _)| k == id).and_then(|(_, v)| v.get("updated_at").and_then(|s| s.as_str()).map(String::from)),
                        _ => None,
                    };
                    if let Some(ts) = pushed_ts {
                        let _ = db_guard.mark_row_synced_if_unchanged(table, id, &ts);
                    }
                }
            }
            let drained: Vec<(String, String)> = queue.iter().map(|r| (r.table_name.clone(), r.row_key.clone())).collect();
            let _ = db_guard.delete_sync_queue_entries(&drained);
            drop(db_guard);
            emit_status(app, db, SyncStatus::Idle, None).await;
        }
        Err(e) => {
            let msg = format!("{:?}", e);
            crate::error_reporter::report_bg("sync_push", msg.clone());
            emit_status(app, db, SyncStatus::Error, Some(msg)).await;
        }
    }
}

/// Fetch full row payloads for a queue snapshot. Filters out rows that no
/// longer exist (e.g. hard-deleted between enqueue and drain).
async fn collect_rows(
    db: &Arc<Mutex<Database>>,
    queue: &[crate::database::SyncQueueRow],
) -> (Vec<(String, serde_json::Value)>, Vec<(String, serde_json::Value)>, Vec<(String, serde_json::Value)>) {
    let db_guard = db.lock().await;
    let mut profiles = vec![];
    let mut custom_agents = vec![];
    let mut workspaces = vec![];
    for row in queue {
        // Read as JSON via table-specific helper. Callers must ensure the
        // Database has `read_syncable_row_json(table, row_key)` — added in Task 18.
        if let Ok(Some(v)) = db_guard.read_syncable_row_json(&row.table_name, &row.row_key) {
            match row.table_name.as_str() {
                "profiles" => profiles.push((row.row_key.clone(), v)),
                "custom_agents" => custom_agents.push((row.row_key.clone(), v)),
                "workspaces" => workspaces.push((row.row_key.clone(), v)),
                _ => {}
            }
        }
    }
    (profiles, custom_agents, workspaces)
}
```

- [ ] **Step 3: Commit (compilation will fail until Task 18 adds `read_syncable_row_json`; that's fine — group them)**

```bash
git add src-tauri/src/sync.rs
git commit -m "feat(sync): push loop with debounce + LWW race-safe mark_synced"
```

---

## Task 18: `read_syncable_row_json` on Database

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Add the helper**

Returns the row as a `serde_json::Value` shaped for the sync-push JSON schema (matches Task 12's zod).

```rust
pub fn read_syncable_row_json(&self, table: &str, row_key: &str) -> Result<Option<serde_json::Value>, String> {
    use serde_json::json;
    match table {
        "profiles" => {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, description, working_directory, claude_args, env_vars,
                        is_default, preview_json, agent, agent_args_json,
                        credential_bindings_json, updated_at, deleted_at, client_version
                 FROM profiles WHERE id = ?1",
            ).map_err(|e| e.to_string())?;
            let row = stmt.query_row(params![row_key], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, Option<String>>(2)?,
                    "workingDirectory": r.get::<_, Option<String>>(3)?,
                    "claudeArgs": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(4)?).unwrap_or(json!([])),
                    "envVars": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(5)?).unwrap_or(json!({})),
                    "isDefault": r.get::<_, i32>(6)? != 0,
                    "agent": r.get::<_, String>(8)?,
                    "agentArgsJson": r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()),
                    "updated_at": r.get::<_, String>(11)?,
                    "updatedAt": r.get::<_, String>(11)?,
                    "deletedAt": r.get::<_, Option<String>>(12)?,
                    "clientVersion": r.get::<_, i64>(13)?,
                }))
            });
            match row {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        "custom_agents" => {
            // Same pattern; extract fields per custom_agents schema.
            let mut stmt = self.conn.prepare(
                "SELECT id, name, binary, default_args, resume_flag, color, required_env,
                        bindings, install_url, install_hint, updated_at, deleted_at, client_version
                 FROM custom_agents WHERE id = ?1",
            ).map_err(|e| e.to_string())?;
            let row = stmt.query_row(params![row_key], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "binary": r.get::<_, String>(2)?,
                    "defaultArgs": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(3)?).unwrap_or(json!([])),
                    "resumeFlag": r.get::<_, Option<String>>(4)?,
                    "color": r.get::<_, String>(5)?,
                    "requiredEnv": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(6)?).unwrap_or(json!([])),
                    "bindings": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(7)?).unwrap_or(json!([])),
                    "installUrl": r.get::<_, Option<String>>(8)?,
                    "installHint": r.get::<_, Option<String>>(9)?,
                    "updatedAt": r.get::<_, String>(10)?,
                    "deletedAt": r.get::<_, Option<String>>(11)?,
                    "clientVersion": r.get::<_, i64>(12)?,
                }))
            });
            match row {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        "workspaces" => {
            let mut stmt = self.conn.prepare(
                "SELECT sync_id, name, terminals, created_at, updated_at, deleted_at, client_version
                 FROM workspaces WHERE sync_id = ?1",
            ).map_err(|e| e.to_string())?;
            let row = stmt.query_row(params![row_key], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "terminals": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(2)?).unwrap_or(json!([])),
                    "createdAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                    "deletedAt": r.get::<_, Option<String>>(5)?,
                    "clientVersion": r.get::<_, i64>(6)?,
                }))
            });
            match row {
                Ok(v) => Ok(Some(v)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        _ => Ok(None),
    }
}
```

- [ ] **Step 2: Verify build + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/database.rs
git commit -m "feat(sync): read_syncable_row_json for push payload assembly"
```

---

## Task 19: Sync engine pull loop implementation

**Files:**
- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Add `do_pull` alongside `do_push`**

```rust
async fn do_pull(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) {
    let since = db.lock().await.get_last_pull_cursor().unwrap_or(None);
    let req = sync_client::PullRequest { since, tables: None };
    emit_status(app, db, SyncStatus::Syncing, None).await;
    match client.pull(req).await {
        Ok(resp) => {
            let db_guard = db.lock().await;
            apply_pulled_rows(&db_guard, "profiles", &resp.profiles);
            apply_pulled_rows(&db_guard, "custom_agents", &resp.custom_agents);
            apply_pulled_rows(&db_guard, "workspaces", &resp.workspaces);
            let _ = db_guard.set_last_pull_cursor(&resp.server_time);
            drop(db_guard);
            emit_status(app, db, SyncStatus::Idle, None).await;
            if resp.truncated {
                // Immediately re-pull with the new cursor.
                Box::pin(do_pull(app, db, client)).await;
            }
        }
        Err(e) => {
            let msg = format!("{:?}", e);
            crate::error_reporter::report_bg("sync_pull", msg.clone());
            emit_status(app, db, SyncStatus::Error, Some(msg)).await;
        }
    }
}

fn apply_pulled_rows(db: &Database, table: &str, rows: &Option<Vec<serde_json::Value>>) {
    let Some(rows) = rows else { return };
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else { continue };
        let Some(incoming_updated_at) = row.get("updatedAt").and_then(|v| v.as_str()).or_else(|| row.get("updated_at").and_then(|v| v.as_str())) else { continue };
        let local_updated_at = db.get_local_updated_at(table, id).unwrap_or(None);
        let is_new = local_updated_at.is_none();
        let wins = is_new
            || match &local_updated_at {
                Some(local) => incoming_wins(local, incoming_updated_at),
                None => true,
            };
        if !wins {
            continue;
        }
        // Delegate the actual upsert to a Database helper — Task 20 adds it.
        if let Err(e) = db.upsert_pulled_row(table, row) {
            crate::error_reporter::report_bg("sync_pull_apply", format!("{table}/{id}: {e}"));
        }
    }
}
```

- [ ] **Step 2: Commit (still won't build until Task 20; group)**

```bash
git add src-tauri/src/sync.rs
git commit -m "feat(sync): pull loop with LWW apply + auto re-pull on truncation"
```

---

## Task 20: Database helpers for pull apply (`get_local_updated_at`, `upsert_pulled_row`)

**Files:**
- Modify: `src-tauri/src/database.rs`

- [ ] **Step 1: Add `get_local_updated_at`**

```rust
pub fn get_local_updated_at(&self, table: &str, row_key: &str) -> Result<Option<String>, String> {
    let where_col = if table == "workspaces" { "sync_id" } else { "id" };
    let sql = format!("SELECT updated_at FROM {table} WHERE {where_col} = ?1");
    self.conn
        .query_row(&sql, params![row_key], |r| r.get::<_, String>(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}
```

- [ ] **Step 2: Add `upsert_pulled_row`**

Table-specific upsert that decodes the JSON payload and INSERT-OR-REPLACE / UPDATE:

```rust
pub fn upsert_pulled_row(&self, table: &str, row: &serde_json::Value) -> Result<(), String> {
    let get_str = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let get_opt_str = |k: &str| row.get(k).and_then(|v| v.as_str()).map(String::from);
    let get_bool = |k: &str| row.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let get_i64 = |k: &str| row.get(k).and_then(|v| v.as_i64()).unwrap_or(1);
    let now_or = |k: &str| get_opt_str(k).unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let ua = row.get("updatedAt").and_then(|v| v.as_str())
        .or_else(|| row.get("updated_at").and_then(|v| v.as_str()))
        .unwrap_or("").to_string();
    match table {
        "profiles" => {
            let claude_args = row.get("claudeArgs").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
            let env_vars = row.get("envVars").map(|v| v.to_string()).unwrap_or_else(|| "{}".into());
            let agent_args_json = row.get("agentArgsJson").map(|v| v.to_string());
            self.conn.execute(
                "INSERT OR REPLACE INTO profiles
                   (id, name, description, working_directory, claude_args, env_vars,
                    is_default, agent, agent_args_json, updated_at, deleted_at,
                    client_version, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'synced')",
                params![
                    get_str("id"), get_str("name"), get_opt_str("description"),
                    get_opt_str("workingDirectory"), claude_args, env_vars,
                    get_bool("isDefault") as i32, get_str("agent"), agent_args_json,
                    ua, get_opt_str("deletedAt"), get_i64("clientVersion"),
                ],
            ).map_err(|e| e.to_string())?;
        }
        "custom_agents" => {
            let default_args = row.get("defaultArgs").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
            let required_env = row.get("requiredEnv").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
            let bindings = row.get("bindings").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
            self.conn.execute(
                "INSERT OR REPLACE INTO custom_agents
                   (id, name, binary, default_args, resume_flag, color, required_env,
                    bindings, install_url, install_hint, created_at, updated_at, deleted_at,
                    client_version, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                         COALESCE((SELECT created_at FROM custom_agents WHERE id = ?1), ?11),
                         ?11, ?12, ?13, 'synced')",
                params![
                    get_str("id"), get_str("name"), get_str("binary"),
                    default_args, get_opt_str("resumeFlag"), get_str("color"),
                    required_env, bindings, get_opt_str("installUrl"),
                    get_opt_str("installHint"), ua, get_opt_str("deletedAt"),
                    get_i64("clientVersion"),
                ],
            ).map_err(|e| e.to_string())?;
        }
        "workspaces" => {
            let terminals = row.get("terminals").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
            let created_at = now_or("createdAt");
            // First, does a local row with this sync_id exist? If yes, update. Else insert.
            let existing: Option<i64> = self.conn
                .query_row("SELECT id FROM workspaces WHERE sync_id = ?1", params![get_str("id")], |r| r.get(0))
                .ok();
            if let Some(_) = existing {
                self.conn.execute(
                    "UPDATE workspaces SET name = ?1, terminals = ?2, updated_at = ?3,
                            deleted_at = ?4, client_version = ?5, sync_state = 'synced'
                     WHERE sync_id = ?6",
                    params![get_str("name"), terminals, ua, get_opt_str("deletedAt"),
                            get_i64("clientVersion"), get_str("id")],
                ).map_err(|e| e.to_string())?;
            } else {
                self.conn.execute(
                    "INSERT INTO workspaces (sync_id, name, terminals, created_at, updated_at,
                                             deleted_at, client_version, sync_state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'synced')",
                    params![get_str("id"), get_str("name"), terminals, created_at, ua,
                            get_opt_str("deletedAt"), get_i64("clientVersion")],
                ).map_err(|e| e.to_string())?;
            }
        }
        _ => {}
    }
    Ok(())
}
```

- [ ] **Step 3: Verify build + run tests**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(sync): get_local_updated_at + upsert_pulled_row for pull-apply"
```

---

## Task 21: `emit_status` helper and Tauri event wiring

**Files:**
- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Add the emitter**

```rust
async fn emit_status(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<Database>>,
    status: SyncStatus,
    last_error: Option<String>,
) {
    let (queue_depth, last_pulled_at) = {
        let db_guard = db.lock().await;
        (
            db_guard.sync_queue_depth().unwrap_or(0),
            db_guard.get_last_pull_cursor().unwrap_or(None),
        )
    };
    let payload = SyncStatusPayload { status, queue_depth, last_pulled_at, last_error };
    let _ = app.emit("sync-status-changed", payload);
}
```

- [ ] **Step 2: Commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/sync.rs
git commit -m "feat(sync): emit sync-status-changed event with queue depth + cursor"
```

---

## Task 22: IPC commands `set_sync_enabled`, `get_sync_enabled`, `sync_now`

**Files:**
- Modify: `src-tauri/src/commands.rs` (or wherever IPC handlers live)
- Modify: `src-tauri/src/main.rs` (register commands in `.invoke_handler`)

- [ ] **Step 1: Add the commands (they need access to the SyncHandle)**

Assumes `SyncHandle` is stored on `AppState` — Task 23 adds it. Sketch:

```rust
use tauri::State;

#[tauri::command]
pub async fn get_sync_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap_or_else(|p| p.into_inner());
        db.get_sync_enabled()
    })
    .await
    .map_err(|e| format!("DB task failed: {e}"))?
}

#[tauri::command]
pub async fn set_sync_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    // Persist immediately so a next-boot reads the correct default even
    // before the engine picks up the SetEnabled message.
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap_or_else(|p| p.into_inner());
        db.set_sync_enabled(enabled)
    })
    .await
    .map_err(|e| format!("DB task failed: {e}"))??;
    if let Some(handle) = state.sync_handle.lock().await.as_ref() {
        handle.set_enabled(enabled);
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.sync_handle.lock().await.as_ref() {
        handle.sync_now();
    }
    Ok(())
}
```

- [ ] **Step 2: Register in main.rs**

Add to `.invoke_handler(tauri::generate_handler![...])` next to existing sync/auth handlers.

- [ ] **Step 3: Commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src
git commit -m "feat(sync): IPC commands get/set sync_enabled + sync_now"
```

---

## Task 23: `AppState` gains `sync_handle` + lifecycle wiring in `main.rs`

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Extend AppState**

```rust
pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub sync_handle: Arc<tokio::sync::Mutex<Option<crate::sync::SyncHandle>>>,
    // ... other existing fields
}
```

Initialize `sync_handle: Arc::new(tokio::sync::Mutex::new(None))` alongside `db`.

- [ ] **Step 2: Start engine after auth rehydration**

In the boot flow (post-`rehydrate_auth`), if the returned `access_token` is Some, start the engine:

```rust
// after rehydrate_auth returns Some(RehydrateResult { access_token }):
let handle = crate::sync::start_engine(app_handle.clone(), db.clone(), access_token.clone());
*state.sync_handle.lock().await = Some(handle);
```

- [ ] **Step 3: Stop engine on logout**

In `logout()` (in `auth.rs`), before clearing state, take the handle and call `.shutdown()`:

```rust
if let Some(handle) = state.sync_handle.lock().await.take() {
    handle.shutdown();
}
```

- [ ] **Step 4: Restart engine after fresh login**

In the `auth-tokens-received` deep-link handler, after storing tokens and emitting the event, start the engine (mirror step 2).

- [ ] **Step 5: Verify build + commit**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/main.rs src-tauri/src/auth.rs
git commit -m "feat(sync): lifecycle wire — start on login/rehydrate, stop on logout"
```

---

## Task 24: Guest → account migration hook

**Files:**
- Modify: `src-tauri/src/auth.rs`

- [ ] **Step 1: Add `run_guest_migration`**

Runs inside the `auth-tokens-received` handler, after tokens are stored but before returning:

```rust
/// Enqueues every locally-authored row (sync_state='local_only') for push and
/// flips it to 'synced'. Runs in one transaction. Fires the pusher immediately.
/// Returns the counts pushed per table for the toast.
pub fn run_guest_migration(db: &Database) -> Result<GuestMigrationCounts, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;

    let mut counts = GuestMigrationCounts::default();
    for (table, key_col) in [("profiles", "id"), ("custom_agents", "id"), ("workspaces", "sync_id")] {
        let sql_ids = format!("SELECT {key_col} FROM {table} WHERE sync_state = 'local_only'");
        let ids: Vec<String> = tx.prepare(&sql_ids).map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for id in &ids {
            let update = format!("UPDATE {table} SET updated_at = ?1, sync_state = 'synced' WHERE {key_col} = ?2");
            tx.execute(&update, rusqlite::params![now, id]).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
                 VALUES (?1, ?2, ?3, 0, NULL)",
                rusqlite::params![table, id, now],
            ).map_err(|e| e.to_string())?;
        }
        match table {
            "profiles" => counts.profiles = ids.len(),
            "custom_agents" => counts.custom_agents = ids.len(),
            "workspaces" => counts.workspaces = ids.len(),
            _ => {}
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(counts)
}

#[derive(Debug, Default, serde::Serialize, Clone)]
pub struct GuestMigrationCounts {
    pub profiles: usize,
    pub custom_agents: usize,
    pub workspaces: usize,
}

impl GuestMigrationCounts {
    pub fn total(&self) -> usize {
        self.profiles + self.custom_agents + self.workspaces
    }
}
```

- [ ] **Step 2: Call it from the deep-link handler**

Inside `handle_deep_link` (auth.rs), after storing refresh + emitting `auth-tokens-received`:

```rust
// Only run migration if the frontend previously reported 'guest' mode.
// Simplest signal: check the store on the frontend side and invoke a
// separate IPC command from App.tsx after auth-changed. To keep this
// on the Rust side, gate on `sync_state='local_only'` count > 0 —
// which is only true for a first-time guest.
match run_guest_migration(&db_guard) {
    Ok(counts) if counts.total() > 0 => {
        let _ = app.emit("guest-migration-completed", counts);
    }
    _ => {}
}
```

Actually — this needs the DB reference to be inside the async task, not the sync deep-link handler. Adjust as needed; the sketch shows the intent, the executing agent adapts to the exact call-site layout.

- [ ] **Step 3: Unit test**

```rust
#[test]
fn run_guest_migration_enqueues_local_only_rows_and_flips_state() {
    let db = Database::new_in_memory().unwrap();
    db.conn.execute(
        "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
         VALUES ('p1', 'a', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'local_only'),
                ('p2', 'b', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'synced')",
        [],
    ).unwrap();
    let counts = super::run_guest_migration(&db).unwrap();
    assert_eq!(counts.profiles, 1);
    assert_eq!(db.sync_queue_depth().unwrap(), 1);
    let synced: i64 = db.conn.query_row(
        "SELECT COUNT(*) FROM profiles WHERE sync_state = 'synced'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(synced, 2);
}
```

- [ ] **Step 4: Commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins auth::tests::run_guest_migration
git add src-tauri/src/auth.rs
git commit -m "feat(sync): guest→account migration on first login"
```

---

## Task 25: Frontend `syncStore` Zustand slice

**Files:**
- Create: `src/store/syncStore.ts`
- Create: `src/store/syncStore.test.ts`

- [ ] **Step 1: Write the store**

```typescript
import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  enabled: boolean;
  queueDepth: number;
  lastPulledAt: string | null;
  lastError: string | null;
  setStatus: (
    patch: Partial<Omit<SyncState, 'setStatus' | 'setEnabled'>>,
  ) => void;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Sync engine state, updated by the `sync-status-changed` Tauri event.
 * Not persisted — engine emits an event on every startup so the store
 * hydrates itself within the first second of app boot.
 */
export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  enabled: true,
  queueDepth: 0,
  lastPulledAt: null,
  lastError: null,
  setStatus: (patch) => set((s) => ({ ...s, ...patch })),
  setEnabled: (enabled) => set({ enabled }),
}));
```

- [ ] **Step 2: Tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncStore } from './syncStore';

beforeEach(() => {
  useSyncStore.setState({
    status: 'idle', enabled: true, queueDepth: 0, lastPulledAt: null, lastError: null,
  });
});

describe('syncStore', () => {
  it('patches status without wiping other fields', () => {
    useSyncStore.getState().setStatus({ queueDepth: 3 });
    useSyncStore.getState().setStatus({ status: 'syncing' });
    expect(useSyncStore.getState().queueDepth).toBe(3);
    expect(useSyncStore.getState().status).toBe('syncing');
  });

  it('setEnabled toggles independently of status', () => {
    useSyncStore.getState().setEnabled(false);
    expect(useSyncStore.getState().enabled).toBe(false);
    expect(useSyncStore.getState().status).toBe('idle');
  });
});
```

- [ ] **Step 3: Commit**

```bash
npx vitest run src/store/syncStore.test.ts
git add src/store/syncStore.ts src/store/syncStore.test.ts
git commit -m "feat(sync): syncStore Zustand slice + tests"
```

---

## Task 26: Frontend `lib/sync.ts` — IPC wrappers + event subscription

**Files:**
- Create: `src/lib/sync.ts`

- [ ] **Step 1: Write the wrappers**

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useSyncStore, type SyncStatus } from '../store/syncStore';
import { reportInvokeFailure } from './errorReporter';
import { toast } from '../store/toastStore';

interface SyncStatusPayload {
  status: SyncStatus;
  queue_depth: number;
  last_pulled_at: string | null;
  last_error: string | null;
}

export async function getSyncEnabled(): Promise<boolean> {
  return invoke<boolean>('get_sync_enabled');
}

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  useSyncStore.getState().setEnabled(enabled);
  try {
    await invoke('set_sync_enabled', { enabled });
  } catch (err) {
    // Revert optimistic UI on failure.
    useSyncStore.getState().setEnabled(!enabled);
    reportInvokeFailure('set_sync_enabled', err);
    throw err;
  }
}

export async function syncNow(): Promise<void> {
  try {
    await invoke('sync_now');
  } catch (err) {
    reportInvokeFailure('sync_now', err);
  }
}

/**
 * Subscribe to sync engine status events. Call once on app boot.
 * Returns an unlisten fn.
 *
 * Also subscribes to `guest-migration-completed` — a one-shot event fired
 * by the Rust auth deep-link handler when a guest's local rows got seeded
 * into the account. Shows a toast summarising counts.
 */
export async function subscribeToSyncEvents(): Promise<UnlistenFn> {
  const unlistenStatus = await listen<SyncStatusPayload>('sync-status-changed', (event) => {
    const { status, queue_depth, last_pulled_at, last_error } = event.payload;
    useSyncStore.getState().setStatus({
      status,
      queueDepth: queue_depth,
      lastPulledAt: last_pulled_at,
      lastError: last_error,
    });
  });

  const unlistenMigration = await listen<{ profiles: number; custom_agents: number; workspaces: number }>(
    'guest-migration-completed',
    (event) => {
      const { profiles, custom_agents, workspaces } = event.payload;
      const parts: string[] = [];
      if (profiles > 0) parts.push(`${profiles} profile${profiles === 1 ? '' : 's'}`);
      if (custom_agents > 0) parts.push(`${custom_agents} custom agent${custom_agents === 1 ? '' : 's'}`);
      if (workspaces > 0) parts.push(`${workspaces} workspace${workspaces === 1 ? '' : 's'}`);
      if (parts.length > 0) {
        toast.success('Signed in', `Imported ${parts.join(', ')} into your account.`);
      }
    },
  );

  return () => {
    unlistenStatus();
    unlistenMigration();
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(sync): FE wrappers + subscribeToSyncEvents"
```

---

## Task 27: Wire subscription in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the subscription in the existing boot effect**

Locate the effect that subscribes to `auth-tokens-received` (from M1) and add sync-events subscription next to it:

```tsx
useEffect(() => {
  let unlistenSync: (() => void) | undefined;
  (async () => {
    // Fetch initial sync-enabled state so the toggle isn't wrong for a frame.
    try {
      const enabled = await getSyncEnabled();
      useSyncStore.getState().setEnabled(enabled);
    } catch { /* pre-auth: no user_meta, defaults are fine */ }
    unlistenSync = await subscribeToSyncEvents();
  })();
  return () => { unlistenSync?.(); };
}, []);
```

Add the imports:
```tsx
import { getSyncEnabled, subscribeToSyncEvents } from './lib/sync';
import { useSyncStore } from './store/syncStore';
```

- [ ] **Step 2: Commit**

```bash
git add src/App.tsx
git commit -m "feat(sync): subscribe to sync events on boot"
```

---

## Task 28: `SyncStatusChip` component

**Files:**
- Create: `src/components/SyncStatusChip.tsx`
- Create: `src/components/SyncStatusChip.test.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { RefreshCw, CheckCircle2, CloudOff, AlertCircle, Pause } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { syncNow } from '../lib/sync';
import { Tooltip } from './ui/Tooltip';

/**
 * Titlebar chip showing current sync state. Hidden for guests and while
 * auth mode is 'unknown'. Clickable — triggers a `sync_now` IPC.
 *
 * Colors follow the app's semantic tokens:
 *   Idle   = neutral (text-tertiary)
 *   Syncing = accent (text-accent-primary) + animate-spin
 *   Paused = neutral (text-text-secondary)
 *   Offline = warning (text-warning)
 *   Error  = error (text-error)
 */
export function SyncStatusChip() {
  const mode = useAuthStore((s) => s.mode);
  const status = useSyncStore((s) => s.status);
  const enabled = useSyncStore((s) => s.enabled);
  const queueDepth = useSyncStore((s) => s.queueDepth);
  const lastPulledAt = useSyncStore((s) => s.lastPulledAt);
  const lastError = useSyncStore((s) => s.lastError);

  if (mode !== 'authed') return null;

  const effective = !enabled ? 'paused' : status;
  const { Icon, spin, tone, label } = viewFor(effective, queueDepth, lastError);
  const tooltip = tooltipFor(effective, queueDepth, lastPulledAt, lastError);

  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        onClick={() => syncNow()}
        disabled={!enabled}
        aria-label={`Sync: ${label}`}
        className={`no-drag h-7 px-2 flex items-center gap-1.5 rounded-md hover:bg-fill-hover transition-colors ${tone}`}
      >
        <Icon size={13} className={spin ? 'animate-spin' : ''} />
        {queueDepth > 0 && enabled && (
          <span className="text-[10px] font-mono">{queueDepth}</span>
        )}
      </button>
    </Tooltip>
  );
}

function viewFor(status: string, queueDepth: number, _err: string | null) {
  switch (status) {
    case 'syncing':
      return { Icon: RefreshCw, spin: true, tone: 'text-accent-primary', label: 'Syncing' };
    case 'paused':
      return { Icon: Pause, spin: false, tone: 'text-text-secondary', label: 'Paused' };
    case 'offline':
      return { Icon: CloudOff, spin: false, tone: 'text-warning', label: 'Offline' };
    case 'error':
      return { Icon: AlertCircle, spin: false, tone: 'text-error', label: 'Error' };
    case 'idle':
    default:
      return queueDepth > 0
        ? { Icon: RefreshCw, spin: false, tone: 'text-text-tertiary', label: 'Pending' }
        : { Icon: CheckCircle2, spin: false, tone: 'text-text-tertiary', label: 'Synced' };
  }
}

function tooltipFor(
  status: string,
  queueDepth: number,
  lastPulledAt: string | null,
  lastError: string | null,
): string {
  const pulled = lastPulledAt ? `Last pulled ${new Date(lastPulledAt).toLocaleTimeString()}` : 'Not yet pulled';
  switch (status) {
    case 'syncing': return 'Syncing…';
    case 'paused': return `Sync paused. ${queueDepth} change${queueDepth === 1 ? '' : 's'} pending.`;
    case 'offline': return `Offline. Changes will sync when the connection returns.`;
    case 'error': return lastError ? `Sync error: ${lastError}` : 'Sync error';
    default: return queueDepth > 0 ? `${queueDepth} change${queueDepth === 1 ? '' : 's'} pending. ${pulled}` : `Synced. ${pulled}`;
  }
}
```

- [ ] **Step 2: Component tests**

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/sync', () => ({ syncNow: vi.fn() }));
vi.mock('./ui/Tooltip', () => ({ Tooltip: ({ children }: any) => children }));

import { SyncStatusChip } from './SyncStatusChip';
import { useAuthStore } from '../store/authStore';
import { useSyncStore } from '../store/syncStore';
import { syncNow } from '../lib/sync';

beforeEach(() => {
  useAuthStore.setState({ mode: 'authed', user: { id: 'u', email: 'e', name: 'n', image: null } } as any);
  useSyncStore.setState({ status: 'idle', enabled: true, queueDepth: 0, lastPulledAt: null, lastError: null } as any);
  vi.clearAllMocks();
});

describe('SyncStatusChip', () => {
  it('renders nothing for guest users', () => {
    useAuthStore.setState({ mode: 'guest', user: null } as any);
    const { container } = render(<SyncStatusChip />);
    expect(container.firstChild).toBeNull();
  });

  it('renders Synced label when idle + queue empty', () => {
    render(<SyncStatusChip />);
    expect(screen.getByLabelText('Sync: Synced')).toBeInTheDocument();
  });

  it('shows queue depth badge when > 0', () => {
    useSyncStore.setState({ status: 'idle', enabled: true, queueDepth: 3 } as any);
    render(<SyncStatusChip />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows Paused when enabled=false regardless of status', () => {
    useSyncStore.setState({ status: 'syncing', enabled: false } as any);
    render(<SyncStatusChip />);
    expect(screen.getByLabelText('Sync: Paused')).toBeInTheDocument();
  });

  it('triggers sync_now on click', async () => {
    render(<SyncStatusChip />);
    await userEvent.click(screen.getByRole('button'));
    expect(syncNow).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests + commit**

```bash
npx vitest run src/components/SyncStatusChip.test.tsx
git add src/components/SyncStatusChip.tsx src/components/SyncStatusChip.test.tsx
git commit -m "feat(sync): SyncStatusChip with state-driven icon/tooltip + click-to-sync"
```

---

## Task 29: Insert `SyncStatusChip` into `TitleBar`

**Files:**
- Modify: `src/components/TitleBar.tsx`

- [ ] **Step 1: Import and insert before `<HeaderAuth />`**

```tsx
import { SyncStatusChip } from './SyncStatusChip';
```

In the right cluster (find the block containing `<ThemeToggle />` and `<HeaderAuth />`):

```tsx
<ThemeToggle />
<SyncStatusChip />
<HeaderAuth />
```

- [ ] **Step 2: Commit**

```bash
git add src/components/TitleBar.tsx
git commit -m "feat(sync): mount SyncStatusChip in TitleBar"
```

---

## Task 30: Add sync toggle to `HeaderAuth` dropdown

**Files:**
- Modify: `src/components/HeaderAuth.tsx`

- [ ] **Step 1: Add a toggle row above the Sign out button**

```tsx
import { useSyncStore } from '../store/syncStore';
import { setSyncEnabled } from '../lib/sync';

// ...inside the authed dropdown JSX, between user info and Sign out:
<div className="px-3 py-2 border-b border-seam flex items-center justify-between">
  <span className="text-[12px] text-text-secondary">Sync</span>
  <SyncToggle />
</div>
```

Add the toggle component at the bottom of the file:

```tsx
function SyncToggle() {
  const enabled = useSyncStore((s) => s.enabled);
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try {
      await setSyncEnabled(!enabled);
    } catch { /* setSyncEnabled already reverted the UI */ }
    setBusy(false);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`Sync ${enabled ? 'on' : 'off'}`}
      onClick={handleToggle}
      disabled={busy}
      className={`relative w-8 h-4 rounded-full transition-colors ${
        enabled ? 'bg-accent-primary' : 'bg-elevation-1 ring-1 ring-inset ring-seam'
      } disabled:opacity-50`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
```

Add `import { useState } from 'react'` if not already present (it is, per M1). Also import `useSyncStore` and `setSyncEnabled` at the top.

- [ ] **Step 2: Extend the auth interaction test**

Append to `src/components/TitleBar.auth.test.tsx`:

```tsx
it('toggling Sync off in the account dropdown calls set_sync_enabled(false)', async () => {
  useAuthStore.getState().setAuthed(
    { id: 'u1', email: 'test@example.com', name: 'Test User', image: null }, 'jwt',
  );
  // Sync starts enabled by default.
  useSyncStore.setState({ enabled: true } as any);

  const user = userEvent.setup();
  render(<TitleBar />);
  await user.click(screen.getByRole('button', { name: 'Account - Test User' }));
  await user.click(screen.getByRole('switch', { name: 'Sync on' }));
  expect(setSyncEnabled).toHaveBeenCalledWith(false);
});
```

Extend the vitest mock at the top of that test file:
```tsx
vi.mock('../lib/sync', () => ({
  setSyncEnabled: vi.fn().mockResolvedValue(undefined),
  syncNow: vi.fn(),
  subscribeToSyncEvents: vi.fn().mockResolvedValue(() => {}),
  getSyncEnabled: vi.fn().mockResolvedValue(true),
}));

import { setSyncEnabled } from '../lib/sync';
import { useSyncStore } from '../store/syncStore';
```

- [ ] **Step 3: Run tests + commit**

```bash
npx vitest run src/components/TitleBar.auth.test.tsx
git add src/components/HeaderAuth.tsx src/components/TitleBar.auth.test.tsx
git commit -m "feat(sync): pause/resume toggle in account dropdown"
```

---

## Task 31: Test guest→account migration end-to-end (Rust)

**Files:**
- Modify: `src-tauri/src/auth.rs`

Guest→account migration is a critical seam. Add a broader test that walks a whole guest→auth transition with mocked broker.

- [ ] **Step 1: Add integration-style test**

```rust
#[test]
fn guest_to_account_migration_full_flow() {
    let db = Database::new_in_memory().unwrap();

    // Simulate guest-authored data: 2 profiles + 1 workspace.
    db.conn.execute(
        "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
         VALUES ('p1', 'One', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'local_only'),
                ('p2', 'Two', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'local_only')",
        [],
    ).unwrap();
    db.conn.execute(
        "INSERT INTO workspaces (sync_id, name, terminals, created_at, updated_at, sync_state)
         VALUES ('w1', 'main', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'local_only')",
        [],
    ).unwrap();

    // Run migration (as if user just signed in).
    let counts = super::run_guest_migration(&db).unwrap();
    assert_eq!(counts.profiles, 2);
    assert_eq!(counts.workspaces, 1);
    assert_eq!(counts.custom_agents, 0);
    assert_eq!(counts.total(), 3);

    // All rows now sync_state='synced' and enqueued.
    assert_eq!(db.sync_queue_depth().unwrap(), 3);

    let synced_profiles: i64 = db.conn.query_row(
        "SELECT COUNT(*) FROM profiles WHERE sync_state = 'synced'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(synced_profiles, 2);

    // Running again is a no-op (idempotent) — no local_only left.
    let counts2 = super::run_guest_migration(&db).unwrap();
    assert_eq!(counts2.total(), 0);
}
```

- [ ] **Step 2: Commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --bins auth::tests::guest_to_account
git add src-tauri/src/auth.rs
git commit -m "test(sync): full guest→account migration path incl. idempotence"
```

---

## Task 32: Broker push contract test — LWW skip + accept

**Files:**
- Modify: `agentrium-api/src/app/api/sync/push/route.test.ts`

- [ ] **Step 1: Add LWW test**

Mock `db.transaction` to expose the tx object, verify:
- Row with newer server `updatedAt` is skipped, id in `skipped.profiles`.
- Row with older server `updatedAt` is upserted, id in `accepted.profiles`.
- Row with no existing server row is upserted, id in `accepted.profiles`.
- Body > 500 rows returns 400 `too_many_rows`.

Follow the same mocking pattern as `pull/route.test.ts` from Task 13.

- [ ] **Step 2: Commit**

```bash
cd agentrium-api && npx vitest run src/app/api/sync/push
git add src/app/api/sync/push/route.test.ts
git commit -m "test(sync): LWW skip/accept + row cap"
```

---

## Task 33: Manual E2E verification

No code change. This walks the whole loop, on a real Vercel deploy + real desktop app.

- [ ] **Step 1: Reset a clean profile on machine A**

- Delete `%APPDATA%\com.claudeterminal.ClaudeTerminal\claudeterminal.db` (Windows) or platform equivalent.
- Delete Windows Credential Manager entry `agentrium.auth`.
- Launch Agentrium dev build with QA config (see `src-tauri/tauri.conf.qa.json`).

- [ ] **Step 2: Sign in on machine A + verify sync UI**

- LoginModal appears → Sign in with Google.
- After auth, `SyncStatusChip` should appear in the titlebar showing "Synced" (green check).
- Open account dropdown → Sync toggle shows On.

- [ ] **Step 3: Create a profile and verify push**

- Add a new profile via existing UI.
- Chip momentarily flips to `Syncing…` then back to `Synced`.
- Query Neon (via Vercel dashboard → integrations → Neon → SQL editor):
  ```sql
  SELECT id, name, updated_at FROM profiles WHERE user_id = '<your user id>';
  ```
- Expected: your new profile row present.

- [ ] **Step 4: Toggle sync off + mutate + verify queue grows**

- Toggle Sync off in the dropdown.
- Chip flips to `Paused`.
- Edit a profile locally.
- Chip badge shows `1` (queue depth).
- Toggle Sync on.
- Chip flips to `Syncing…` then `Synced`; badge disappears.
- Neon SQL confirms the edit landed.

- [ ] **Step 5: Second-device pull**

- On machine B (or a fresh QA install on the same machine — different `identifier`).
- Sign in with the same Google account.
- Expected: the profiles/workspaces you created on machine A appear immediately after boot pull.

- [ ] **Step 6: Guest → account migration**

- Sign out on machine A. Delete the DB again to force guest.
- Boot in guest mode. Create 2 profiles + 1 workspace locally.
- Click "Sign in" pill → sign in with Google.
- Expected: toast "Imported 2 profiles, 1 workspace into your account.". Chip flips to Syncing then Synced.
- Neon SQL confirms all 3 rows have your user_id.

- [ ] **Step 7: Report results**

Report to the plan owner: which steps passed, any failures with screenshots + `[sync]` log lines from the dev console.

---

## Task 34: Push branch + broker after all tasks land

**Files:**
- No code change; git only.

- [ ] **Step 1: Push agentrium-api**

```bash
cd agentrium-api && git push origin master
```

Vercel auto-deploys. Wait ~30s for the deploy to complete.

- [ ] **Step 2: Push feat/m1-auth-signin**

```bash
cd agentrium && git push origin feat/m1-auth-signin
```

- [ ] **Step 3: Confirm branch is intact + tests green on CI (if configured)**

---

## Self-review checklist (fill in before executing)

Before executing this plan, walk through the spec sections that fall in M2a scope and confirm coverage:

- [ ] **Spec §5.2 (Syncable resources)** — Tasks 1-3 (local schema), Task 9 (server schema)
- [ ] **Spec §5.5 (Local SQLite additions: sync_queue)** — Task 4 (table), Task 5 (helpers)
- [ ] **Spec §6.4 (Guest → account migration)** — Task 24 (algorithm), Task 31 (test)
- [ ] **Spec §7.1 (LWW model)** — Task 16 (client), Task 12 (server)
- [ ] **Spec §7.2 (Endpoints /api/sync/pull, /api/sync/push)** — Tasks 11, 12
- [ ] **Spec §7.3 (Cadence: startup, 5-min interval, debounced push, sync-now)** — Task 17 (push+debounce), Task 19 (pull), Task 22 (sync_now IPC)
- [ ] **Spec §7.4 (Pusher behavior: 500 rows / 512 KB cap, 401 refresh, poison-row drop, backoff)** — Task 12 (cap), Task 14 (401 refresh), TODO: poison-row drop + backoff **left as follow-up in M2a-2 if not implemented in Task 17**
- [ ] **Spec §7.5 (SQLite migration idempotence)** — Tasks 1-4 all use ADD COLUMN pattern; run twice test in Task 5 confirms
- [ ] **User request: sync on/off toggle** — Task 30 (UI), Task 22 (IPC), Task 25 (store)
- [ ] **User request: SyncStatusChip Paused state** — Task 28

**Explicitly not covered (see "OUT" list):**
- `hints` sync (no user-editable hints table today)
- `app_settings` sync (localStorage-persisted; needs Zustand→SQLite migration first)
- `snippets` sync (no user-creation UI today)
- Sharing (M3)
- Telemetry attribution `user_id` (M3)

**Follow-up gaps flagged during self-review:**

- **Poison-row drop on 4xx (spec §7.4):** Task 17's push loop treats all errors as "report + Error status" and re-queues. Add a follow-up task or extend Task 17 to `delete_sync_queue_entries` + `report_bg('sync_push_4xx', ...)` when server returns 4xx (except 401). Not blocking M2a functionality — worst case is a poison row loops forever until fixed manually.
- **Exponential backoff (spec §7.4):** Task 17 pushes every debounce tick if the queue is non-empty; there is no `min(30 * 2^attempts, 3600)` scheduling. Add follow-up. Impact: on server outage, we hammer at 5-second cadence instead of backing off. Acceptable for M2a preview — fix before v1.34.0-preview ships.
- **Explicit "Sync now" in header dropdown (spec §7.3):** SyncStatusChip click already triggers `sync_now` (Task 28); menu-item version not implemented. If needed for accessibility, add a "Sync now" row above Sync toggle in Task 30.

---

## Definition of done for M2a

When all tasks are complete:

1. Signed-in user's `profiles`, `custom_agents`, `workspaces` push to broker on mutation within 5 seconds.
2. Boot-time pull hydrates any changes made from other devices.
3. Guest user's local data seeds into their account on first login (no confirmation prompt, toast confirms counts).
4. Titlebar chip reflects current sync state (Idle/Syncing/Paused/Offline/Error) with queue-depth badge.
5. Account dropdown Sync toggle pauses/resumes; local mutations still enqueue while paused, drain on resume.
6. All Rust unit tests pass (`cargo test --bins`).
7. All frontend tests pass (`npm run test:run`).
8. All backend tests pass (`cd agentrium-api && npx vitest run`).
9. Manual E2E steps 1-6 (Task 33) all pass on a real dev build.
