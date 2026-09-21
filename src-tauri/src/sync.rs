//! Sync engine: background task that drains sync_queue via /api/sync/push
//! and pulls remote changes via /api/sync/pull. Life cycle is controlled
//! by `SyncHandle` which supports start/stop/pause/resume/sync-now and
//! survives access-token rotation.
//!
//! Emits `sync-status-changed` Tauri events so the frontend chip stays live.

use crate::{database::Database, sync_client};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::mpsc;

const PUSH_BATCH_ROW_CAP: usize = 500;
const DEBOUNCE_MS: u64 = 5_000;
const PULL_INTERVAL_MS: u64 = 5 * 60 * 1_000;
/// Spec §7.4: after a transient push failure wait `min(30 * 2^attempts, 3600)`
/// seconds (±20% jitter) before the next automatic push. `attempts` is the
/// count *before* the failed one, so the first retry lands ~30s later.
const BACKOFF_BASE_SECS: u64 = 30;
const BACKOFF_MAX_SECS: u64 = 3_600;
const BACKOFF_JITTER: f64 = 0.20;

pub fn backoff_secs(attempts: i64) -> u64 {
    // 2^7 already saturates the cap; clamping keeps the shift well-defined.
    let exp = attempts.clamp(0, 16) as u32;
    BACKOFF_BASE_SECS.saturating_mul(1u64 << exp).min(BACKOFF_MAX_SECS)
}

/// Apply ±`BACKOFF_JITTER` to `secs`. `unit` is a uniform sample in [0, 1]
/// supplied by the caller so the math stays deterministic under test.
pub fn jittered(secs: u64, unit: f64) -> std::time::Duration {
    let factor = 1.0 + BACKOFF_JITTER * (2.0 * unit.clamp(0.0, 1.0) - 1.0);
    std::time::Duration::from_secs((secs as f64 * factor).round() as u64)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushFailure {
    /// Non-recoverable validation 4xx: the server rejected the payload itself. Retrying
    /// the same rows can never succeed, so they are dropped (spec §7.4).
    Poison,
    /// 5xx, network, refresh, decode, or a 401 that survived the one-shot
    /// refresh: worth retrying later with backoff.
    Transient,
}

pub fn classify_push_failure(err: &sync_client::SyncError) -> PushFailure {
    match err {
        sync_client::SyncError::Server(code, _) if (400..500).contains(code) && !matches!(*code, 401 | 403 | 408 | 409 | 429) => {
            PushFailure::Poison
        }
        _ => PushFailure::Transient,
    }
}

/// Chip state for a failed request. "Could not reach the broker" (no
/// internet, Vercel or Neon down, a gateway error) is Offline so the user sees
/// the calm "will sync when the connection returns" copy; a real answer from
/// the server, or a broken response, is Error.
pub fn status_for_failure(err: &sync_client::SyncError) -> SyncStatus {
    match err {
        sync_client::SyncError::Network(_) => SyncStatus::Offline,
        sync_client::SyncError::Server(502 | 503 | 504, _) => SyncStatus::Offline,
        sync_client::SyncError::Refresh(msg) if msg.starts_with(crate::auth::NETWORK_ERROR_PREFIX) => SyncStatus::Offline,
        _ => SyncStatus::Error,
    }
}

/// Telemetry gate for a failed sync request, and the counterpart to
/// `status_for_failure`. A failure the user already sees as the calm Offline
/// chip is a normal fact of laptop life (sleep/resume, hotel wifi, DNS), not a
/// defect: reporting it buries real errors in the admin dashboard. It also
/// never stops, because `DEDUP_WINDOW` (60s) is shorter than
/// `PULL_INTERVAL_MS` (5min), so dedup can never collapse the repeats.
pub fn should_report_failure(err: &sync_client::SyncError) -> bool {
    status_for_failure(err) != SyncStatus::Offline
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushFailureAction {
    /// Poison rows removed from the queue; count of dropped entries.
    Dropped(usize),
    /// Attempt recorded on every batched row; hold automatic pushes this long.
    RetryAfter(std::time::Duration),
}

/// Book-keep a failed push against the snapshotted `queue` rows.
/// `jitter_unit` is a uniform sample in [0, 1] (see `jittered`).
fn handle_push_failure(
    db: &Database,
    queue: &[crate::database::SyncQueueRow],
    err: &sync_client::SyncError,
    jitter_unit: f64,
) -> Result<PushFailureAction, String> {
    match classify_push_failure(err) {
        PushFailure::Poison => {
            // Match on enqueued_at so a row the user edited after the
            // snapshot keeps its fresh entry and gets its own attempt.
            for entry in queue {
                db.acknowledge_sync_entry(entry)?;
            }
            crate::error_reporter::report_bg(
                "sync_push_4xx",
                format!("dropped {} queued row(s): {err}", queue.len()),
            );
            Ok(PushFailureAction::Dropped(queue.len()))
        }
        PushFailure::Transient => {
            let msg = err.to_string();
            let mut most_attempts: i64 = 0;
            for entry in queue {
                most_attempts = most_attempts.max(entry.attempts);
                db.record_sync_attempt(&entry.table_name, &entry.row_key, Some(&msg))?;
            }
            let server_delay = match err {
                sync_client::SyncError::Server(_, text) => text.strip_prefix("retry_after_seconds=")
                    .and_then(|s| s.split(';').next()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
                _ => 0,
            };
            Ok(PushFailureAction::RetryAfter(jittered(backoff_secs(most_attempts), jitter_unit).max(std::time::Duration::from_secs(server_delay))))
        }
    }
}

/// Compare two ISO-8601 timestamps and return whether `incoming` should win.
/// LWW: incoming wins iff strictly newer than local. Tie goes to local.
/// This is the client-side counterpart to the server's `>=` skip check —
/// the server treats equal timestamps as "older loses"; the client is
/// permissive and keeps its local copy on ties.
pub fn incoming_wins(local_updated_at: &str, incoming_updated_at: &str) -> bool {
    incoming_updated_at > local_updated_at
}

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
    task: tauri::async_runtime::JoinHandle<()>,
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
    pub async fn shutdown(self) {
        let _ = self.tx.send(SyncCommand::Shutdown).await;
        let _ = self.task.await;
    }
}

pub fn start_engine(
    app: tauri::AppHandle,
    db: Arc<std::sync::Mutex<Database>>,
    access_token: String,
) -> SyncHandle {
    spawn_engine(move |rx| run_engine(app, db, access_token, rx))
}

fn spawn_engine<F, Fut>(run: F) -> SyncHandle
where
    F: FnOnce(mpsc::Receiver<SyncCommand>) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<SyncCommand>(16);
    // OAuth callbacks run on the native event thread, outside Tokio's context.
    // Tauri's runtime also supports callers that have no current runtime.
    let task = tauri::async_runtime::spawn(run(rx));
    SyncHandle { tx, task }
}

async fn run_engine(
    app: tauri::AppHandle,
    db: Arc<std::sync::Mutex<Database>>,
    access_token: String,
    mut rx: mpsc::Receiver<SyncCommand>,
) {
    let mut enabled = {
        let db_arc = db.clone();
        tokio::task::spawn_blocking(move || {
            db_arc
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get_sync_enabled()
                .unwrap_or(true)
        })
        .await
        .unwrap_or(true)
    };
    let mut client = sync_client::SyncClient::new(access_token);
    let mut debounce_tick = tokio::time::interval(std::time::Duration::from_millis(1_000));
    let mut pull_tick = tokio::time::interval(std::time::Duration::from_millis(PULL_INTERVAL_MS));
    let mut dirty_since: Option<tokio::time::Instant> = None;
    // Set after a transient push failure; automatic pushes wait it out.
    // User-initiated actions (Sync now, re-enable) clear it.
    let mut backoff_until: Option<tokio::time::Instant> = None;

    if enabled {
        emit_status(&app, &db, SyncStatus::Idle, None).await;
        do_pull(&app, &db, &mut client).await;
    } else {
        emit_status(&app, &db, SyncStatus::Paused, None).await;
    }

    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(SyncCommand::SyncNow) => {
                    if enabled {
                        backoff_until = do_push(&app, &db, &mut client).await.next_backoff();
                        do_pull(&app, &db, &mut client).await;
                    }
                }
                Some(SyncCommand::SetEnabled(e)) => {
                    enabled = e;
                    let db_arc = db.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        db_arc
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .set_sync_enabled(e)
                    })
                    .await;
                    if e {
                        emit_status(&app, &db, SyncStatus::Idle, None).await;
                        backoff_until = do_push(&app, &db, &mut client).await.next_backoff();
                        do_pull(&app, &db, &mut client).await;
                    } else {
                        emit_status(&app, &db, SyncStatus::Paused, None).await;
                    }
                }
                Some(SyncCommand::UpdateToken(t)) => {
                    client.set_access_token(t);
                }
                Some(SyncCommand::Shutdown) | None => break,
            },
            _ = debounce_tick.tick() => {
                if !enabled { continue; }
                let db_arc = db.clone();
                let depth = tokio::task::spawn_blocking(move || {
                    db_arc
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .sync_queue_depth()
                        .unwrap_or(0)
                })
                .await
                .unwrap_or(0);
                if depth > 0 && dirty_since.is_none() {
                    dirty_since = Some(tokio::time::Instant::now());
                }
                let backing_off = backoff_until.is_some_and(|t| tokio::time::Instant::now() < t);
                if let Some(since) = dirty_since {
                    if !backing_off && since.elapsed() >= std::time::Duration::from_millis(DEBOUNCE_MS) {
                        backoff_until = do_push(&app, &db, &mut client).await.next_backoff();
                        dirty_since = None;
                    }
                }
            },
            _ = pull_tick.tick() => {
                if enabled {
                    do_pull(&app, &db, &mut client).await;
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushOutcome {
    /// Nothing to do, or the batch was acknowledged (fully or partially).
    Done,
    /// Transient failure: hold automatic pushes until this instant.
    BackOffUntil(tokio::time::Instant),
}

impl PushOutcome {
    fn next_backoff(self) -> Option<tokio::time::Instant> {
        match self {
            PushOutcome::Done => None,
            PushOutcome::BackOffUntil(t) => Some(t),
        }
    }
}

async fn do_push(
    app: &tauri::AppHandle,
    db: &Arc<std::sync::Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) -> PushOutcome {
    emit_status(app, db, SyncStatus::Syncing, None).await;

    // Snapshot queue + resolve row JSON, all under one blocking-lock pass.
    let db_arc = db.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
        let queue = db_guard.peek_sync_queue(PUSH_BATCH_ROW_CAP).unwrap_or_default();
        let mut profiles = Vec::new();
        let mut custom_agents = Vec::new();
        let mut workspaces = Vec::new();
        for row in &queue {
            match db_guard.read_syncable_row_json(&row.table_name, &row.row_key) {
                Ok(Some(v)) => match row.table_name.as_str() {
                    "profiles" => profiles.push((row.row_key.clone(), v)),
                    "custom_agents" => custom_agents.push((row.row_key.clone(), v)),
                    "workspaces" => workspaces.push((row.row_key.clone(), v)),
                    _ => {}
                },
                Ok(None) => {
                    // Row was deleted before we got to push it. Drop the queue entry.
                }
                Err(e) => {
                    crate::error_reporter::report_bg(
                        "sync_push_read",
                        format!("{}/{}: {e}", row.table_name, row.row_key),
                    );
                }
            }
        }
        (queue, profiles, custom_agents, workspaces)
    })
    .await;

    let (queue, profiles, custom_agents, workspaces) = match snapshot {
        Ok(v) => v,
        Err(e) => {
            emit_status(app, db, SyncStatus::Error, Some(format!("snapshot: {e}"))).await;
            return PushOutcome::Done;
        }
    };

    if queue.is_empty() {
        emit_status(app, db, SyncStatus::Idle, None).await;
        return PushOutcome::Done;
    }

    let req = sync_client::PushRequest {
        profiles: if profiles.is_empty() {
            None
        } else {
            Some(profiles.iter().map(|(_, v)| v.clone()).collect())
        },
        custom_agents: if custom_agents.is_empty() {
            None
        } else {
            Some(custom_agents.iter().map(|(_, v)| v.clone()).collect())
        },
        workspaces: if workspaces.is_empty() {
            None
        } else {
            Some(workspaces.iter().map(|(_, v)| v.clone()).collect())
        },
    };

    match client.push(req).await {
        Ok(resp) => {
            let accepted = resp.accepted.clone();
            let skipped = resp.skipped;
            let db_arc = db.clone();
            let profiles_c = profiles.clone();
            let custom_agents_c = custom_agents.clone();
            let workspaces_c = workspaces.clone();
            let queue_c = queue.clone();
            let acknowledged = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
                let tx = db_guard.conn().unchecked_transaction().map_err(|e| e.to_string())?;
                for (table, ids) in &accepted {
                    let source: &[(String, serde_json::Value)] = match table.as_str() {
                        "profiles" => &profiles_c,
                        "custom_agents" => &custom_agents_c,
                        "workspaces" => &workspaces_c,
                        _ => &[],
                    };
                    for id in ids {
                        if let Some((_, v)) = source.iter().find(|(k, _)| k == id) {
                            if let Some(ts) = v.get("updatedAt").and_then(|s| s.as_str()) {
                                db_guard.mark_row_synced_if_unchanged(table, id, ts)?;
                            }
                        }
                    }
                }
                for entry in &queue_c {
                    let confirmed = [&accepted, &skipped].iter().any(|rows| {
                        rows.get(&entry.table_name).is_some_and(|ids| ids.contains(&entry.row_key))
                    });
                    if confirmed { db_guard.acknowledge_sync_entry(entry)?; }
                }
                tx.commit().map_err(|e| e.to_string())
            })
            .await;
            if let Err(error) = acknowledged.map_err(|e| e.to_string()).and_then(|r| r) {
                emit_status(app, db, SyncStatus::Error, Some(error)).await;
                return PushOutcome::Done;
            }
            emit_status(app, db, SyncStatus::Idle, None).await;
            PushOutcome::Done
        }
        Err(e) => {
            let jitter_unit: f64 = rand::Rng::gen(&mut rand::thread_rng());
            let db_arc = db.clone();
            let queue_c = queue.clone();
            let failure_status = status_for_failure(&e);
            // Computed before `e` moves into the blocking task below.
            let report_transient = should_report_failure(&e);
            let handled = tokio::task::spawn_blocking(move || {
                let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
                handle_push_failure(&db_guard, &queue_c, &e, jitter_unit).map(|a| (a, e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);

            match handled {
                Ok((PushFailureAction::Dropped(n), msg)) => {
                    // Already reported as sync_push_4xx inside handle_push_failure.
                    let plural = if n == 1 { "" } else { "s" };
                    let detail = format!("{n} change{plural} rejected by server and dropped: {msg}");
                    emit_status(app, db, SyncStatus::Error, Some(detail)).await;
                    PushOutcome::Done
                }
                Ok((PushFailureAction::RetryAfter(delay), msg)) => {
                    if report_transient {
                        crate::error_reporter::report_bg("sync_push", msg.clone());
                    }
                    let detail = format!("{msg} (retrying in {}s)", delay.as_secs());
                    emit_status(app, db, failure_status, Some(detail)).await;
                    PushOutcome::BackOffUntil(tokio::time::Instant::now() + delay)
                }
                Err(book_keeping) => {
                    crate::error_reporter::report_bg("sync_push", book_keeping.clone());
                    emit_status(app, db, SyncStatus::Error, Some(book_keeping)).await;
                    // Don't hammer the server while local book-keeping is broken.
                    PushOutcome::BackOffUntil(
                        tokio::time::Instant::now() + std::time::Duration::from_secs(BACKOFF_BASE_SECS),
                    )
                }
            }
        }
    }
}

async fn do_pull(
    app: &tauri::AppHandle,
    db: &Arc<std::sync::Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) {
    let db_arc = db.clone();
    let (since, since_id) = tokio::task::spawn_blocking(move || {
        let db = db_arc.lock().unwrap_or_else(|p| p.into_inner());
        (db.get_last_pull_cursor().unwrap_or(None), db.get_user_meta("last_pull_cursor_id").unwrap_or(None))
    }).await.unwrap_or((None, None));

    let req = sync_client::PullRequest { since, since_id, tables: None };
    emit_status(app, db, SyncStatus::Syncing, None).await;

    match client.pull(req).await {
        Ok(resp) => {
            let truncated = resp.truncated;
            let db_arc = db.clone();
            let applied = tokio::task::spawn_blocking(move || {
                let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
                apply_pull_page(&db_guard, &resp)
            })
            .await;
            if let Err(error) = applied.map_err(|e| e.to_string()).and_then(|r| r) {
                emit_status(app, db, SyncStatus::Error, Some(error)).await;
                return;
            }
            emit_status(app, db, SyncStatus::Idle, None).await;
            if truncated {
                Box::pin(do_pull(app, db, client)).await;
            }
        }
        Err(e) => {
            let msg = format!("{e}");
            if should_report_failure(&e) {
                crate::error_reporter::report_bg("sync_pull", msg.clone());
            }
            emit_status(app, db, status_for_failure(&e), Some(msg)).await;
        }
    }
}

fn apply_pull_page(db: &Database, resp: &sync_client::PullResponse) -> Result<(), String> {
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;
    apply_pulled_rows(db, "profiles", &resp.profiles)?;
    apply_pulled_rows(db, "custom_agents", &resp.custom_agents)?;
    apply_pulled_rows(db, "workspaces", &resp.workspaces)?;
    if resp.truncated && resp.next_since.is_none() { return Err("Server omitted pagination cursor".into()); }
    db.set_last_pull_cursor(resp.next_since.as_deref().unwrap_or(&resp.server_time))?;
    db.set_user_meta("last_pull_cursor_id", resp.next_since_id.as_deref())?;
    tx.commit().map_err(|e| e.to_string())
}

fn apply_pulled_rows(db: &Database, table: &str, rows: &Option<Vec<serde_json::Value>>) -> Result<(), String> {
    let Some(rows) = rows else { return Ok(()) };
    for row in rows {
        let id = row.get("id").and_then(|v| v.as_str()).ok_or("Missing sync row id")?;
        let incoming_updated_at = row
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("updated_at").and_then(|v| v.as_str()))
            .ok_or("Missing sync row timestamp")?;
        let local_updated_at = db.get_local_updated_at(table, id)?;
        let wins = match &local_updated_at {
            Some(local) => incoming_wins(local, incoming_updated_at),
            None => true,
        };
        if !wins {
            continue;
        }
        db.upsert_pulled_row(table, row).map_err(|e| format!("{table}/{id}: {e}"))?;
    }
    Ok(())
}

pub(crate) async fn emit_status(
    app: &tauri::AppHandle,
    db: &Arc<std::sync::Mutex<Database>>,
    status: SyncStatus,
    last_error: Option<String>,
) {
    use tauri::Emitter;
    let db_arc = db.clone();
    let (queue_depth, last_pulled_at) = tokio::task::spawn_blocking(move || {
        let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
        (
            db_guard.sync_queue_depth().unwrap_or(0),
            db_guard.get_last_pull_cursor().unwrap_or(None),
        )
    })
    .await
    .unwrap_or((0, None));
    let payload = SyncStatusPayload {
        status,
        queue_depth,
        last_pulled_at,
        last_error,
    };
    let _ = app.emit("sync-status-changed", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A genuine `reqwest` transport error, provoked by an unparseable URL.
    /// `SyncError::Network` wraps a real `reqwest::Error`, which has no public
    /// constructor, so this is the way to build one in a test.
    fn network_error() -> sync_client::SyncError {
        sync_client::SyncError::Network(reqwest::Client::new().get("http://[").build().unwrap_err())
    }

    #[test]
    fn failed_pull_rolls_back_rows_and_keeps_cursor_for_retry() {
        let db = Database::new_in_memory().unwrap();
        db.set_last_pull_cursor("before").unwrap();
        let mut page = sync_client::PullResponse {
            profiles: None, custom_agents: None,
            workspaces: Some(vec![serde_json::json!({
                "id": "remote", "name": "Remote", "terminals": [],
                "updatedAt": "2026-09-12T00:00:00Z", "createdAt": "2026-09-12T00:00:00Z"
            }), serde_json::json!({"id": "invalid"})]),
            next_since: None,
            next_since_id: None,
            server_time: "after".into(), truncated: false,
        };
        assert!(apply_pull_page(&db, &page).is_err());
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("before"));
        assert!(db.get_workspaces().unwrap().is_empty());
        page.workspaces.as_mut().unwrap().pop();
        apply_pull_page(&db, &page).unwrap();
        assert_eq!(db.get_workspaces().unwrap().len(), 1);
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("after"));
    }

    #[test]
    fn same_name_remote_workspace_is_preserved_under_distinct_name() {
        let db = Database::new_in_memory().unwrap();
        let local = db.save_workspace("Shared", &[]).unwrap();
        let page = sync_client::PullResponse {
            profiles: None, custom_agents: None,
            workspaces: Some(vec![serde_json::json!({
                "id": "remote", "name": "Shared", "terminals": [],
                "updatedAt": "2026-09-12T00:00:00Z", "createdAt": "2026-09-12T00:00:00Z"
            })]), next_since: None, next_since_id: None, server_time: "after".into(), truncated: false,
        };
        apply_pull_page(&db, &page).unwrap();
        assert_eq!(db.get_workspaces().unwrap().len(), 2);
        assert_eq!(db.read_syncable_row_json("workspaces", &local).unwrap().unwrap()["name"], "Shared");
        assert_eq!(db.read_syncable_row_json("workspaces", "remote").unwrap().unwrap()["name"], "Shared (synced 1)");
        apply_pull_page(&db, &page).unwrap();
        assert_eq!(db.get_workspaces().unwrap().len(), 2);
    }

    #[test]
    fn engine_starts_and_stops_outside_tokio_runtime() {
        std::thread::spawn(|| {
            assert!(tokio::runtime::Handle::try_current().is_err());
            let (completed_tx, completed_rx) = std::sync::mpsc::channel();
            let handle = spawn_engine(move |mut rx| async move {
                // Exercise runtime services as well as command delivery.
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                assert!(matches!(rx.recv().await, Some(SyncCommand::Shutdown)));
                completed_tx.send(()).unwrap();
            });
            tauri::async_runtime::block_on(handle.shutdown());
            completed_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("engine should run and receive shutdown from a native callback thread");
        })
        .join()
        .unwrap();
    }

    // ---- Spec §7.4: exponential backoff on 5xx / network failures ----

    #[test]
    fn rate_limit_preserves_queue_and_honors_retry_after() {
        let db = Database::new_in_memory().unwrap();
        let id = db.save_workspace("pending", &[]).unwrap();
        db.touch_sync_row("workspaces", &id).unwrap();
        let queue = db.peek_sync_queue(10).unwrap();
        let err = sync_client::SyncError::Server(429, "retry_after_seconds=90;rate_limited".into());
        let action = handle_push_failure(&db, &queue, &err, 0.5).unwrap();
        assert!(matches!(action, PushFailureAction::RetryAfter(d) if d.as_secs() >= 90));
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
    }

    #[test]
    fn pagination_stores_boundary_and_tie_breaker_not_wall_clock() {
        let db = Database::new_in_memory().unwrap();
        let page = sync_client::PullResponse {
            profiles: None, custom_agents: None, workspaces: None,
            server_time: "2026-09-20T12:00:00Z".into(),
            next_since: Some("2026-09-20T11:00:00Z".into()),
            next_since_id: Some("row-id".into()), truncated: true,
        };
        apply_pull_page(&db, &page).unwrap();
        assert_eq!(db.get_last_pull_cursor().unwrap(), page.next_since);
        assert_eq!(db.get_user_meta("last_pull_cursor_id").unwrap(), page.next_since_id);
    }

    #[test]
    fn backoff_doubles_from_30s_and_caps_at_one_hour() {
        assert_eq!(backoff_secs(0), 30);
        assert_eq!(backoff_secs(1), 60);
        assert_eq!(backoff_secs(2), 120);
        assert_eq!(backoff_secs(6), 1_920);
        assert_eq!(backoff_secs(7), 3_600);
        assert_eq!(backoff_secs(100), 3_600, "huge attempt counts must not overflow");
    }

    #[test]
    fn jitter_spreads_delay_by_plus_minus_twenty_percent() {
        assert_eq!(jittered(30, 0.5), std::time::Duration::from_secs(30));
        assert_eq!(jittered(30, 0.0), std::time::Duration::from_secs(24));
        assert_eq!(jittered(30, 1.0), std::time::Duration::from_secs(36));
    }

    #[test]
    fn four_xx_other_than_401_is_poison_everything_else_is_transient() {
        use sync_client::SyncError;
        assert!(matches!(classify_push_failure(&SyncError::Server(400, String::new())), PushFailure::Poison));
        assert!(matches!(classify_push_failure(&SyncError::Server(422, String::new())), PushFailure::Poison));
        assert!(matches!(classify_push_failure(&SyncError::Server(401, String::new())), PushFailure::Transient));
        assert!(matches!(classify_push_failure(&SyncError::Server(500, String::new())), PushFailure::Transient));
        assert!(matches!(classify_push_failure(&SyncError::Server(503, String::new())), PushFailure::Transient));
        assert!(matches!(classify_push_failure(&SyncError::Refresh("x".into())), PushFailure::Transient));
    }

    /// An unreachable broker (no internet, Vercel/Neon down) is shown as
    /// Offline with its friendly copy; anything the server actually answered
    /// with (other than a gateway error) stays a red Error.
    #[test]
    fn unreachable_broker_reads_as_offline_not_error() {
        use sync_client::SyncError;
        assert_eq!(status_for_failure(&network_error()), SyncStatus::Offline);
        for code in [502, 503, 504] {
            assert_eq!(status_for_failure(&SyncError::Server(code, String::new())), SyncStatus::Offline, "{code}");
        }
        assert_eq!(status_for_failure(&SyncError::Refresh(format!("{} timed out", crate::auth::NETWORK_ERROR_PREFIX))), SyncStatus::Offline);

        assert_eq!(status_for_failure(&SyncError::Server(500, String::new())), SyncStatus::Error);
        assert_eq!(status_for_failure(&SyncError::Server(401, String::new())), SyncStatus::Error);
        assert_eq!(status_for_failure(&SyncError::Refresh("decode: bad json".into())), SyncStatus::Error);
    }

    /// Telemetry must mirror the chip. A failure the user already sees as the
    /// calm Offline state is a normal fact of laptop life (sleep/resume, hotel
    /// wifi, DNS) and is not a defect worth an error report. Without this gate
    /// a permanently-offline install reports forever: `DEDUP_WINDOW` is 60s
    /// but `PULL_INTERVAL_MS` is 5min, so dedup can never suppress the repeat.
    #[test]
    fn offline_class_failures_are_not_reported() {
        use sync_client::SyncError;
        assert!(!should_report_failure(&network_error()));
        for code in [502, 503, 504] {
            assert!(!should_report_failure(&SyncError::Server(code, String::new())), "{code}");
        }
        assert!(!should_report_failure(&SyncError::Refresh(format!("{} timed out", crate::auth::NETWORK_ERROR_PREFIX))));
    }

    /// The gate must stay narrow: anything the server actually answered with,
    /// and any broken response, is still a real defect and still reported.
    #[test]
    fn server_answered_and_malformed_failures_are_still_reported() {
        use sync_client::SyncError;
        assert!(should_report_failure(&SyncError::Server(500, String::new())));
        assert!(should_report_failure(&SyncError::Server(401, String::new())));
        assert!(should_report_failure(&SyncError::Server(422, String::new())));
        assert!(should_report_failure(&SyncError::Refresh("decode: bad json".into())));
    }

    #[test]
    fn poison_response_drops_the_snapshotted_queue_rows() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "p1").unwrap();
        db.enqueue_sync("workspaces", "w1").unwrap();
        let queue = db.peek_sync_queue(10).unwrap();

        let action = handle_push_failure(&db, &queue, &sync_client::SyncError::Server(422, "bad row".into()), 0.5).unwrap();

        assert!(matches!(action, PushFailureAction::Dropped(2)));
        assert_eq!(db.sync_queue_depth().unwrap(), 0);
    }

    #[test]
    fn poison_drop_spares_a_row_re_enqueued_after_the_snapshot() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "p1").unwrap();
        let queue = db.peek_sync_queue(10).unwrap();
        // User edits the row again while the push is in flight: fresh enqueued_at.
        std::thread::sleep(std::time::Duration::from_millis(2));
        db.enqueue_sync("profiles", "p1").unwrap();

        handle_push_failure(&db, &queue, &sync_client::SyncError::Server(422, String::new()), 0.5).unwrap();

        assert_eq!(db.sync_queue_depth().unwrap(), 1, "the newer edit must get its own push attempt");
    }

    #[test]
    fn transient_failure_records_attempt_and_backs_off_exponentially() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "p1").unwrap();
        let err = sync_client::SyncError::Server(503, "unavailable".into());

        let queue = db.peek_sync_queue(10).unwrap();
        let first = handle_push_failure(&db, &queue, &err, 0.5).unwrap();
        assert!(matches!(first, PushFailureAction::RetryAfter(d) if d == std::time::Duration::from_secs(30)));

        let row = &db.peek_sync_queue(10).unwrap()[0];
        assert_eq!(row.attempts, 1);
        assert_eq!(row.last_error.as_deref(), Some("server 503: unavailable"));
        assert_eq!(db.sync_queue_depth().unwrap(), 1, "transient failures keep the row queued");

        let queue = db.peek_sync_queue(10).unwrap();
        let second = handle_push_failure(&db, &queue, &err, 0.5).unwrap();
        assert!(matches!(second, PushFailureAction::RetryAfter(d) if d == std::time::Duration::from_secs(60)));
    }

    #[test]
    fn transient_backoff_uses_the_most_retried_row_in_the_batch() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "stale").unwrap();
        db.record_sync_attempt("profiles", "stale", Some("x")).unwrap();
        db.record_sync_attempt("profiles", "stale", Some("x")).unwrap();
        db.record_sync_attempt("profiles", "stale", Some("x")).unwrap();
        db.enqueue_sync("profiles", "fresh").unwrap();
        let queue = db.peek_sync_queue(10).unwrap();

        let action = handle_push_failure(&db, &queue, &sync_client::SyncError::Server(500, String::new()), 0.5).unwrap();

        // "stale" had 3 attempts before this one -> 30 * 2^3 = 240s.
        assert!(matches!(action, PushFailureAction::RetryAfter(d) if d == std::time::Duration::from_secs(240)));
    }

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
}
