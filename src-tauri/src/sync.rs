//! Sync engine: background task that drains sync_queue via /api/sync/push
//! and pulls remote changes via /api/sync/pull. Life cycle is controlled
//! by `SyncHandle` which supports start/stop/pause/resume/sync-now and
//! survives access-token rotation.
//!
//! Emits `sync-status-changed` Tauri events so the frontend chip stays live.

use crate::database::Database;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

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
    // Fleshed out in tasks 17 (push) and 19 (pull). Placeholder loop keeps
    // the task alive so SyncHandle commands don't panic on send.
    let _ = (app, db, access_token);
    while let Some(cmd) = rx.recv().await {
        if matches!(cmd, SyncCommand::Shutdown) {
            break;
        }
    }
}

pub(crate) async fn emit_status(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<Database>>,
    status: SyncStatus,
    last_error: Option<String>,
) {
    use tauri::Emitter;
    let (queue_depth, last_pulled_at) = {
        let db_guard = db.lock().await;
        (
            db_guard.sync_queue_depth().unwrap_or(0),
            db_guard.get_last_pull_cursor().unwrap_or(None),
        )
    };
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
