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
    tauri::async_runtime::spawn(run(rx));
    SyncHandle { tx }
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
                        do_push(&app, &db, &mut client).await;
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
                        do_push(&app, &db, &mut client).await;
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
                if let Some(since) = dirty_since {
                    if since.elapsed() >= std::time::Duration::from_millis(DEBOUNCE_MS) {
                        do_push(&app, &db, &mut client).await;
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

async fn do_push(
    app: &tauri::AppHandle,
    db: &Arc<std::sync::Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) {
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
            return;
        }
    };

    if queue.is_empty() {
        emit_status(app, db, SyncStatus::Idle, None).await;
        return;
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
            let db_arc = db.clone();
            let profiles_c = profiles.clone();
            let custom_agents_c = custom_agents.clone();
            let workspaces_c = workspaces.clone();
            let queue_c = queue.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
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
                                let _ = db_guard.mark_row_synced_if_unchanged(table, id, ts);
                            }
                        }
                    }
                }
                let drained: Vec<(String, String)> = queue_c
                    .iter()
                    .map(|r| (r.table_name.clone(), r.row_key.clone()))
                    .collect();
                let _ = db_guard.delete_sync_queue_entries(&drained);
            })
            .await;
            emit_status(app, db, SyncStatus::Idle, None).await;
        }
        Err(e) => {
            let msg = format!("{e}");
            crate::error_reporter::report_bg("sync_push", msg.clone());
            emit_status(app, db, SyncStatus::Error, Some(msg)).await;
        }
    }
}

async fn do_pull(
    app: &tauri::AppHandle,
    db: &Arc<std::sync::Mutex<Database>>,
    client: &mut sync_client::SyncClient,
) {
    let db_arc = db.clone();
    let since = tokio::task::spawn_blocking(move || {
        db_arc
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_last_pull_cursor()
            .unwrap_or(None)
    })
    .await
    .unwrap_or(None);

    let req = sync_client::PullRequest { since, tables: None };
    emit_status(app, db, SyncStatus::Syncing, None).await;

    match client.pull(req).await {
        Ok(resp) => {
            let server_time = resp.server_time.clone();
            let truncated = resp.truncated;
            let db_arc = db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
                apply_pulled_rows(&db_guard, "profiles", &resp.profiles);
                apply_pulled_rows(&db_guard, "custom_agents", &resp.custom_agents);
                apply_pulled_rows(&db_guard, "workspaces", &resp.workspaces);
                let _ = db_guard.set_last_pull_cursor(&server_time);
            })
            .await;
            emit_status(app, db, SyncStatus::Idle, None).await;
            if truncated {
                Box::pin(do_pull(app, db, client)).await;
            }
        }
        Err(e) => {
            let msg = format!("{e}");
            crate::error_reporter::report_bg("sync_pull", msg.clone());
            emit_status(app, db, SyncStatus::Error, Some(msg)).await;
        }
    }
}

fn apply_pulled_rows(db: &Database, table: &str, rows: &Option<Vec<serde_json::Value>>) {
    let Some(rows) = rows else { return };
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else { continue };
        let Some(incoming_updated_at) = row
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("updated_at").and_then(|v| v.as_str()))
        else {
            continue;
        };
        let local_updated_at = db.get_local_updated_at(table, id).unwrap_or(None);
        let wins = match &local_updated_at {
            Some(local) => incoming_wins(local, incoming_updated_at),
            None => true,
        };
        if !wins {
            continue;
        }
        if let Err(e) = db.upsert_pulled_row(table, row) {
            crate::error_reporter::report_bg(
                "sync_pull_apply",
                format!("{table}/{id}: {e}"),
            );
        }
    }
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
            handle.shutdown();
            completed_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("engine should run and receive shutdown from a native callback thread");
        })
        .join()
        .unwrap();
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
