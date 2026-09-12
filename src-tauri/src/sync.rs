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

#[cfg(test)]
mod tests {}
