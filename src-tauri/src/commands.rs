use crate::config::{ConfigProfile, HintCategory};
use crate::database::{SessionHistoryEntry, Snippet};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::mpsc;
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
            if error_reporter::should_report(&e) {
                tokio::spawn(error_reporter::report(
                    ErrorSource::RustCommand,
                    Some(name.to_string()),
                    e.clone(),
                    None,
                ));
                Err(e)
            } else {
                // User-input error: strip the marker prefix so the frontend
                // sees a plain message, and skip telemetry.
                Err(error_reporter::strip_user_prefix(&e).to_string())
            }
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
    // Persisted so the next process start honors the choice before the
    // frontend has mounted (startup crashes are reported - or not - per the
    // user's last known consent).
    error_reporter::set_enabled_persist(enabled);
    Ok(())
}

/// Run a sync rusqlite call off the tokio runtime.
///
/// Previously every DB access looked like `let db = state.db.lock().await;
/// db.method()`, which used a `tokio::sync::Mutex`. That has two problems:
/// (1) holding the guard across any subsequent `.await` in the handler
/// serializes global DB access, and (2) the sync `rusqlite` call inside
/// the guard blocks a tokio worker until it returns. Under load both
/// stall unrelated IPC (including `terminal-output` event delivery).
///
/// This helper takes an `Arc<std::sync::Mutex<Database>>` (the sync flavor
/// so it can't be held across `.await`) and runs `f` on the blocking pool
/// — the lock is held only for the duration of the sync work, and the
/// runtime workers stay free.
async fn db_op<T, F>(
    db_arc: &std::sync::Arc<std::sync::Mutex<crate::database::Database>>,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&crate::database::Database) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let db_arc = db_arc.clone();
    tokio::task::spawn_blocking(move || {
        // `unwrap_or_else(into_inner)` recovers from Mutex poisoning: SQLite
        // is transactional, so a panic in a prior DB call left the connection
        // in a well-defined state and the mutex is still safe to use.
        let db = db_arc.lock().unwrap_or_else(|p| p.into_inner());
        f(&db)
    })
    .await
    .map_err(|e| format!("DB task failed: {}", e))?
}

async fn terminal_cwd(
    state: &State<'_, AppState>,
    terminal_id: &str,
) -> Result<std::path::PathBuf, String> {
    let manager = state.terminals.lock().await;
    let term = manager
        .terminals
        .get(terminal_id)
        .ok_or_else(|| format!("Unknown terminal id: {}", terminal_id))?;
    Ok(std::path::PathBuf::from(term.config.working_directory.clone()))
}

#[command]
pub async fn write_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    content: String,
    suggested_name: Option<String>,
    extension: String,
) -> Result<crate::pastes::PasteEntry, String> {
    wrap_cmd("write_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        let base = suggested_name.unwrap_or_else(|| {
            chrono::Local::now().format("paste-%Y-%m-%d-%H%M").to_string()
        });
        crate::pastes::write_paste(&cwd, &content, &base, &extension)
    })
    .await
}

#[command]
pub async fn list_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Vec<crate::pastes::PasteEntry>, String> {
    wrap_cmd("list_pastes", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::list_pastes(&cwd)
    })
    .await
}

#[command]
pub async fn read_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<String, String> {
    wrap_cmd("read_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::read_paste(&cwd, &file_name)
    })
    .await
}

#[command]
pub async fn delete_paste(
    state: State<'_, AppState>,
    terminal_id: String,
    file_name: String,
) -> Result<(), String> {
    wrap_cmd("delete_paste", async move {
        let cwd = terminal_cwd(&state, &terminal_id).await?;
        crate::pastes::delete_paste(&cwd, &file_name)
    })
    .await
}

#[command]
pub async fn purge_pastes(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), String> {
    wrap_cmd("purge_pastes", async move {
        let cwd = match terminal_cwd(&state, &terminal_id).await {
            Ok(p) => p,
            Err(_) => return Ok(()),
        };
        crate::pastes::purge_pastes(&cwd)
    })
    .await
}

// --- Changelists (v1.22.0) ----------------------------------------------------

#[command]
pub async fn list_changelists(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<crate::changelists::ChangelistInfo>, String> {
    wrap_cmd("list_changelists", async move {
        db_op(&state.db, move |db| {
            crate::changelists::list_changelists(db.conn(), &repo_path)
        })
        .await
    })
    .await
}

#[command]
pub async fn create_changelist(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> Result<i64, String> {
    wrap_cmd("create_changelist", async move {
        db_op(&state.db, move |db| {
            crate::changelists::create_changelist(db.conn(), &repo_path, &name)
        })
        .await
    })
    .await
}

#[command]
pub async fn rename_changelist(
    state: State<'_, AppState>,
    id: i64,
    new_name: String,
) -> Result<(), String> {
    wrap_cmd("rename_changelist", async move {
        db_op(&state.db, move |db| {
            crate::changelists::rename_changelist(db.conn(), id, &new_name)
        })
        .await
    })
    .await
}

#[command]
pub async fn delete_changelist(
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    wrap_cmd("delete_changelist", async move {
        db_op(&state.db, move |db| {
            crate::changelists::delete_changelist(db.conn(), id)
        })
        .await
    })
    .await
}

#[command]
pub async fn assign_files_to_changelist(
    state: State<'_, AppState>,
    repo_path: String,
    file_paths: Vec<String>,
    changelist_id: Option<i64>,
) -> Result<(), String> {
    wrap_cmd("assign_files_to_changelist", async move {
        db_op(&state.db, move |db| {
            crate::changelists::assign_files_to_changelist(
                db.conn(), &repo_path, &file_paths, changelist_id,
            )
        })
        .await
    })
    .await
}

#[command]
pub async fn get_changelist_assignments(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<(String, i64)>, String> {
    wrap_cmd("get_changelist_assignments", async move {
        db_op(&state.db, move |db| {
            crate::changelists::get_changelist_assignments(db.conn(), &repo_path)
        })
        .await
    })
    .await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTerminalRequest {
    pub label: String,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub color_tag: Option<String>,
    pub nickname: Option<String>,
    /// When set, the spawned `claude` is launched with `--resume <id>` to
    /// re-attach the conversation exactly. The frontend supplies this from
    /// the saved session-restore row when we previously captured an id.
    #[serde(default)]
    pub resume_session_id: Option<String>,
    /// When true (and `resume_session_id` is unset), spawn with `--continue`
    /// so Claude attaches to the most recent session in this cwd. Used as
    /// the restore fallback for saves predating session-id capture.
    #[serde(default)]
    pub continue_recent: bool,
    /// Whether to enable per-session OTel cost/token tracking for this terminal.
    #[serde(default)]
    pub cost_tracking: bool,
    /// Which coding agent to spawn (Claude or Codex).
    /// Defaults to Claude for compatibility with older frontends that don't
    /// send this field.
    #[serde(default)]
    pub agent: crate::config::AgentKind,
}

#[command]
pub async fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CreateTerminalRequest,
) -> Result<crate::terminal::TerminalConfig, String> {
    wrap_cmd("create_terminal", async move {
        // Channel sized for burst output - Claude Code streaming can easily push
        // hundreds of chunks/sec per terminal. 100 caused backpressure into the
        // PTY reader thread under load.
        let (tx, mut rx) = mpsc::channel::<(String, Vec<u8>)>(1000);

        // Compute log file path
        let log_path = {
            let data_dir = directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
                .ok_or("Failed to get project directories")?
                .data_dir()
                .to_path_buf();
            let logs_dir = data_dir.join("logs");
            tokio::fs::create_dir_all(&logs_dir).await.map_err(|e| e.to_string())?;
            let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
            let filename = format!("{}_{}.log", uuid::Uuid::new_v4(), timestamp);
            logs_dir.join(filename).to_string_lossy().to_string()
        };

        // Snapshot Claude's project dir *before* spawning so we can later
        // diff for the new session file. Cheap (a few dozen file paths) and
        // synchronous - must happen before the PTY starts the claude process.
        let session_snapshot = crate::claude_session::snapshot_session_files();
        let resume_id = request.resume_session_id.clone();
        let continue_recent = request.continue_recent && resume_id.is_none();
        let working_directory = request.working_directory.clone();

        // Build the OTLP endpoint only when the user enabled tracking AND the
        // receiver actually started (port != 0).
        let otel_endpoint = if request.cost_tracking && state.otel_port != 0 {
            Some(format!("http://127.0.0.1:{}", state.otel_port))
        } else {
            None
        };

        let config = {
            let mut terminals = state.terminals.lock().await;
            terminals.create_terminal(
                request.label.clone(),
                request.agent,
                request.working_directory,
                request.claude_args,
                request.env_vars,
                request.color_tag,
                request.nickname,
                tx,
                Some(log_path.clone()),
                request.resume_session_id,
                continue_recent,
                otel_endpoint,
            )?
        };

        // Detect the session id Claude assigned to this terminal. We don't
        // know when the user will send their first message (Claude only
        // writes the .jsonl after a user turn), so the watcher runs for the
        // full lifetime of the terminal and keeps overwriting the captured
        // id whenever a newer .jsonl appears in the same cwd dir. That way
        // `/clear` (which rotates the session id) is handled transparently.
        if let Some(id) = resume_id.as_deref() {
            eprintln!("[session-resume] spawning '{}' with --resume {}", config.label, id);
        } else if continue_recent {
            eprintln!("[session-resume] spawning '{}' with --continue", config.label);
            // `--continue` attaches to the newest existing session in this
            // cwd. Record that id immediately so the NEXT restore can
            // `--resume` it precisely instead of falling back to `--continue`
            // again (a second `--continue` in the same cwd would attach to
            // whatever session happens to be newest by then - possibly a
            // different terminal's conversation).
            let sessions = crate::claude_session::list_sessions_for_cwd(&working_directory);
            if let Some(newest) = sessions.first() {
                eprintln!(
                    "[session-resume] '{}' recorded --continue target session {}",
                    config.label, newest.id
                );
                {
                    let mut m = state.terminals.lock().await;
                    m.update_claude_session_id(&config.id, newest.id.clone());
                }
                // Persist to history so the Session Timeline can `--resume` it.
                {
                    let cfg_id = config.id.clone();
                    let newest_id = newest.id.clone();
                    let _ = db_op(&state.db, move |db| {
                        db.update_session_claude_id(&cfg_id, &newest_id)
                    })
                    .await;
                }
            }
        } else {
            let manager = state.terminals.clone();
            let db_for_detect = state.db.clone();
            let detect_id = config.id.clone();
            let detect_label = config.label.clone();
            let cwd_for_log = working_directory.clone();
            tokio::spawn(async move {
                let mut last_recorded: Option<String> = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    // Stop watching once the terminal is gone - both saves
                    // CPU and avoids racing close_terminal. While we hold the
                    // lock, also gather what the OTHER live terminals have
                    // claimed, and whether THIS terminal was recently typed
                    // in. A Claude session file is created on a user turn, so
                    // a new .jsonl can only belong to a terminal with recent
                    // input - without these two guards, every terminal in the
                    // same cwd converges on the same (newest) session id and
                    // the next restore attaches them all to ONE conversation.
                    let claimed_by_others = {
                        let m = manager.lock().await;
                        let Some(me) = m.terminals.get(&detect_id) else {
                            return;
                        };
                        let recently_typed = me
                            .last_input_at
                            .map(|t| t.elapsed() < std::time::Duration::from_secs(120))
                            .unwrap_or(false);
                        if !recently_typed {
                            continue;
                        }
                        m.terminals
                            .iter()
                            .filter(|(tid, _)| tid.as_str() != detect_id)
                            .filter_map(|(_, t)| t.config.claude_session_id.clone())
                            .collect::<std::collections::HashSet<String>>()
                    };
                    if let Some(session_id) = crate::claude_session::find_new_session_for_cwd(
                        &session_snapshot,
                        &cwd_for_log,
                        &claimed_by_others,
                    ) {
                        if last_recorded.as_deref() != Some(&session_id) {
                            eprintln!(
                                "[session-detect] '{}' bound to session {} (cwd={})",
                                detect_label, session_id, cwd_for_log
                            );
                            {
                                let mut m = manager.lock().await;
                                m.update_claude_session_id(&detect_id, session_id.clone());
                            }
                            // Mirror onto the history row for later `--resume`.
                            {
                                let detect_id_c = detect_id.clone();
                                let session_id_c = session_id.clone();
                                let _ = db_op(&db_for_detect, move |db| {
                                    db.update_session_claude_id(&detect_id_c, &session_id_c)
                                })
                                .await;
                            }
                            last_recorded = Some(session_id);
                        }
                    }
                }
            });
        }

        // Insert session history entry
        {
            let cfg_id = config.id.clone();
            let cfg_label = config.label.clone();
            let cfg_created = config.created_at.to_rfc3339();
            let cfg_cwd = config.working_directory.clone();
            let log_path_c = log_path.clone();
            let res = db_op(&state.db, move |db| {
                db.insert_session_history(
                    &cfg_id,
                    &cfg_label,
                    &cfg_created,
                    Some(&log_path_c),
                    Some(&cfg_cwd),
                )
            })
            .await;
            if let Err(e) = res {
                eprintln!("Failed to insert session history: {}", e);
                error_reporter::report_bg(
                    "insert_session_history",
                    format!("Failed to insert session history: {}", e),
                );
            }
        }

        let terminal_id = config.id.clone();
        let db_arc = state.db.clone();
        let terminals_arc = state.terminals.clone();
        let otel_agg = state.otel_agg.clone();

        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some((id, data)) = rx.recv().await {
                if let Err(e) = app_clone.emit("terminal-output", serde_json::json!({
                    "id": id,
                    "data": data,
                })) {
                    // Breaking here permanently freezes this terminal's output,
                    // so it must be visible in telemetry, not just stderr.
                    eprintln!("Failed to emit terminal-output: {}", e);
                    error_reporter::report_bg(
                        "emit_terminal_output",
                        format!("Failed to emit terminal-output: {}", e),
                    );
                    break;
                }
            }

            // Terminal process exited - update status, session history, and notify frontend
            // Note: the terminal may have already been removed by close_terminal(), so ignore errors.
            // Await the lock unbounded: no caller in this codebase holds the manager guard across
            // an .await, so this can only queue behind bounded sync work (matching every other
            // .terminals.lock().await site).
            {
                let mut manager = terminals_arc.lock().await;
                let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
            }
            // Drop accumulated telemetry on the natural process-exit path too -
            // close_terminal() handles the user-close path, but a terminal that
            // exits on its own would otherwise leak its aggregator entry until
            // the tab is closed or the app restarts.
            if let Ok(mut agg) = otel_agg.lock() {
                agg.forget(&terminal_id);
            }
            {
                let tid_c = terminal_id.clone();
                let now = chrono::Utc::now().to_rfc3339();
                let res = db_op(&db_arc, move |db| {
                    db.update_session_ended(&tid_c, &now)
                })
                .await;
                if let Err(e) = res {
                    eprintln!("Failed to update session ended for {}: {}", terminal_id, e);
                    error_reporter::report_bg(
                        "update_session_ended",
                        format!("Failed to update session ended: {}", e),
                    );
                }
            }

            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({
                "id": terminal_id,
            })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
                error_reporter::report_bg(
                    "emit_terminal_finished",
                    format!("Failed to emit terminal-finished: {}", e),
                );
            }
        });

        Ok(config)
    })
    .await
}

/// Maximum size for a single write to terminal (64 KB)
const MAX_TERMINAL_WRITE_SIZE: usize = 65_536;

#[command]
pub async fn write_to_terminal(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    wrap_cmd("write_to_terminal", async move {
        if data.len() > MAX_TERMINAL_WRITE_SIZE {
            return Err(format!(
                "Write payload too large ({} bytes). Maximum is {} bytes.",
                data.len(),
                MAX_TERMINAL_WRITE_SIZE
            ));
        }
        let mut terminals = state.terminals.lock().await;
        terminals.write(&id, &data)
    })
    .await
}

#[command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    wrap_cmd("resize_terminal", async move {
        let mut terminals = state.terminals.lock().await;
        terminals.resize(&id, cols, rows)
    })
    .await
}

#[command]
pub async fn close_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("close_terminal", async move {
        let mut terminals = state.terminals.lock().await;
        terminals.close(&id)?;
        // Drop accumulated telemetry so a reused id can't inherit stale totals.
        if let Ok(mut agg) = state.otel_agg.lock() {
            agg.forget(&id);
        }
        Ok(())
    })
    .await
}

#[command]
pub async fn get_terminals(
    state: State<'_, AppState>,
) -> Result<Vec<crate::terminal::TerminalConfig>, String> {
    wrap_cmd("get_terminals", async move {
        let terminals = state.terminals.lock().await;
        Ok(terminals.get_all_configs())
    })
    .await
}

/// Global cursor position in physical (device) pixels, relative to the
/// top-left of the desktop. Used by the tab tear-off / cross-window transfer
/// logic to hit-test the drop point against each window's outer bounds
/// (which `outerPosition()`/`outerSize()` also report in physical pixels).
#[command]
pub async fn get_cursor_position(app: AppHandle) -> Result<(f64, f64), String> {
    wrap_cmd("get_cursor_position", async move {
        let pos = app.cursor_position().map_err(|e| e.to_string())?;
        Ok((pos.x, pos.y))
    })
    .await
}

#[command]
pub async fn update_terminal_label(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> Result<(), String> {
    wrap_cmd("update_terminal_label", async move {
        let mut terminals = state.terminals.lock().await;
        terminals.update_label(&id, label)
    })
    .await
}

#[command]
pub async fn update_terminal_nickname(
    state: State<'_, AppState>,
    id: String,
    nickname: String,
) -> Result<(), String> {
    wrap_cmd("update_terminal_nickname", async move {
        let mut terminals = state.terminals.lock().await;
        terminals.update_nickname(&id, nickname)
    })
    .await
}

#[command]
pub async fn save_profile(
    state: State<'_, AppState>,
    profile: ConfigProfile,
) -> Result<(), String> {
    wrap_cmd("save_profile", async move {
        db_op(&state.db, move |db| db.save_profile(&profile)).await
    })
    .await
}

#[command]
pub async fn get_profiles(state: State<'_, AppState>) -> Result<Vec<ConfigProfile>, String> {
    wrap_cmd("get_profiles", async move {
        db_op(&state.db, |db| db.get_profiles()).await
    })
    .await
}

#[command]
pub async fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_profile", async move {
        db_op(&state.db, move |db| db.delete_profile(&id)).await
    })
    .await
}

#[command]
pub async fn get_claude_version() -> Result<String, String> {
    wrap_cmd("get_claude_version", async move {
        let output = run_claude(&["--version"])
            .await
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let stdout = String::from_utf8(output.stdout)
            .map_err(|e| e.to_string())?;
        Ok(extract_version_line(&stdout))
    })
    .await
}

/// Generic per-agent `<binary> --version` runner. Claude routes through
/// the cached-path helper (`run_claude`) so users with PATH only in
/// `.zshrc` still resolve it; other agents fall through the shell lookup.
/// Returns a cleaned single-line version string or an error message.
#[command]
pub async fn get_agent_version(agent: crate::config::AgentKind) -> Result<String, String> {
    wrap_cmd("get_agent_version", async move {
        let output = if agent == crate::config::AgentKind::Claude {
            run_claude(&["--version"])
                .await
                .map_err(|e| e.to_string())?
        } else {
            let binary = crate::agents::spec_for(agent).binary;
            let mut cmd: tokio::process::Command = shell_command(binary, &["--version"]).into();
            cmd.output().await.map_err(|e| e.to_string())?
        };

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        Ok(extract_version_line(&stdout))
    })
    .await
}

/// Run `claude` with the given args. Prefers the cached absolute path resolved
/// via an interactive login shell (so users with PATH set in `.zshrc` work);
/// falls back to the shell-PATH lookup if resolution failed.
async fn run_claude(args: &[&str]) -> std::io::Result<std::process::Output> {
    if let Some(path) = crate::claude_path::cached() {
        let mut cmd = tokio::process::Command::new(&path);
        for a in args { cmd.arg(a); }
        cmd.output().await
    } else {
        let mut cmd: tokio::process::Command = shell_command("claude", args).into();
        cmd.output().await
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
}

#[command]
pub async fn check_claude_update() -> Result<UpdateCheckResult, String> {
    wrap_cmd("check_claude_update", async move {
        // Get current version
        let current_output = run_claude(&["--version"])
            .await
            .map_err(|e| format!("Failed to get current version: {}", e))?;

        let current_stdout = String::from_utf8_lossy(&current_output.stdout);
        let current_version = extract_version_line(&current_stdout);

        if current_version.is_empty() {
            return Err("Claude Code is not installed".to_string());
        }

        let latest_version = fetch_latest_claude_version().await?;

        // Extract version number from current version string (e.g., "1.0.17 (Claude Code)" -> "1.0.17")
        let current_ver_clean = current_version
            .split_whitespace()
            .next()
            .unwrap_or(&current_version)
            .to_string();

        let update_available = current_ver_clean != latest_version;

        Ok(UpdateCheckResult {
            current_version,
            latest_version,
            update_available,
        })
    })
    .await
}

/// Fetch `@anthropic-ai/claude-code` latest version directly from the npm
/// registry. Avoids the npm CLI (slow Node startup, PATH issues on macOS).
/// Two attempts with a short backoff to ride out transient network blips.
async fn fetch_latest_claude_version() -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct LatestResponse { version: String }

    const REGISTRY_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP client build failed: {}", e))?;

    let mut last_err: Option<String> = None;
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        }
        match client.get(REGISTRY_URL).header("accept", "application/json").send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<LatestResponse>().await {
                    Ok(parsed) if !parsed.version.is_empty() => return Ok(parsed.version),
                    Ok(_) => last_err = Some("npm registry returned empty version".to_string()),
                    Err(e) => last_err = Some(format!("Parse error from npm registry: {}", e)),
                }
            }
            Ok(resp) => last_err = Some(format!("npm registry returned HTTP {}", resp.status())),
            Err(e) => last_err = Some(format!("Network error: {}", e)),
        }
    }
    Err(last_err.unwrap_or_else(|| "Failed to fetch latest version from npm".to_string()))
}

#[command]
pub async fn update_claude_code() -> Result<String, String> {
    wrap_cmd("update_claude_code", async move {
        let mut cmd: tokio::process::Command =
            shell_command("npm", &["install", "-g", "@anthropic-ai/claude-code@latest"]).into();
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run npm: {}", e))?;

        if output.status.success() {
            // npm may have moved the binary or the user may have switched
            // node versions - drop the cache so the next call re-resolves.
            crate::claude_path::invalidate();
            Ok("Claude Code updated successfully!".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            Err(format!("{}{}", stderr, stdout))
        }
    })
    .await
}

#[command]
pub async fn get_hints() -> Result<Vec<HintCategory>, String> {
    // Wrapped for consistency: every command flows through wrap_cmd so a
    // future failure path (e.g. lazy-loaded hints from disk) reports to
    // telemetry the same way as the rest. Currently infallible.
    wrap_cmd("get_hints", async move { Ok(crate::config::get_default_hints()) }).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemStatus {
    pub node_installed: bool,
    pub node_version: Option<String>,
    pub npm_installed: bool,
    pub npm_version: Option<String>,
    pub claude_installed: bool,
    pub claude_version: Option<String>,
}

/// Shells that are allowed when reading `$SHELL` on non-Windows platforms.
const VALID_SHELLS: &[&str] = &[
    "/bin/bash",
    "/bin/sh",
    "/bin/zsh",
    "/bin/fish",
    "/bin/dash",
    "/usr/bin/bash",
    "/usr/bin/sh",
    "/usr/bin/zsh",
    "/usr/bin/fish",
    "/usr/bin/dash",
    "/usr/local/bin/bash",
    "/usr/local/bin/zsh",
    "/usr/local/bin/fish",
    "/opt/homebrew/bin/bash",
    "/opt/homebrew/bin/zsh",
    "/opt/homebrew/bin/fish",
];

/// Shell-escape a single argument by wrapping it in single quotes.
/// Any embedded single quotes are escaped as `'\''`.
fn shell_escape_arg(arg: &str) -> String {
    let mut escaped = String::with_capacity(arg.len() + 2);
    escaped.push('\'');
    for ch in arg.chars() {
        if ch == '\'' {
            escaped.push_str("'\\''");
        } else {
            escaped.push(ch);
        }
    }
    escaped.push('\'');
    escaped
}

/// Creates a Command that works cross-platform.
/// On Windows, wraps the command with `cmd /C` so that `.cmd`/`.bat` scripts
/// (like `npm.cmd`, `claude.cmd`) are resolved correctly.
pub(crate) fn shell_command(program: &str, args: &[&str]) -> std::process::Command {
    if cfg!(target_os = "windows") {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(program);
        for arg in args {
            cmd.arg(arg);
        }
        // Prevent a console window from flashing on Windows
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        // Validate $SHELL against allowlist to prevent arbitrary binary execution
        let shell = if VALID_SHELLS.contains(&shell.as_str()) {
            shell
        } else {
            "/bin/bash".to_string()
        };
        let mut full_cmd = shell_escape_arg(program);
        for arg in args {
            full_cmd.push(' ');
            full_cmd.push_str(&shell_escape_arg(arg));
        }
        let mut cmd = std::process::Command::new(shell);
        // -lic (login + interactive + command). The `-i` is what gets
        // ~/.zshrc / ~/.bashrc sourced. Without it (plain -lc) only
        // ~/.zshenv and ~/.zprofile run, which means PATH additions for
        // tools installed via nvm / fnm / volta / `npm config prefix` /
        // `~/.local/bin` are invisible - `claude --version`, `node`, `npm`
        // all return "command not found" for users who only export those
        // dirs from their interactive rc file.
        cmd.arg("-lic").arg(&full_cmd);
        cmd
    }
}

/// Build a Command that runs `git` with the given args.
///
/// SECURITY: On Windows we must NOT route git through `cmd /C` the way the
/// generic `shell_command` helper does for `.cmd`/`.bat` shims (npm/claude).
/// `git` is a real `.exe`, so we invoke it directly. Going through cmd.exe
/// lets cmd metacharacters (`& | ( ) ^ !`) in user-controlled args — branch
/// names, file paths, remotes coming from a hostile repository — break out
/// into command execution, because Rust's std only quotes args containing
/// whitespace and its cmd.exe caret-escaping (the CVE-2024-24576 fix) only
/// triggers when the spawned program itself is a `.bat`/`.cmd`, not `cmd.exe`.
/// Spawning `git.exe` directly means args are passed as literal argv elements
/// (no shell interprets them), which closes the whole injection family.
///
/// On Unix we keep using the login shell (`shell_command`) because git's PATH
/// resolution can depend on the interactive shell environment there, and the
/// single-quote escaping in `shell_command` already makes injection impossible.
pub(crate) fn git_command(args: &[&str]) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("git");
        for arg in args {
            cmd.arg(arg);
        }
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        shell_command("git", args)
    }
}

/// Pick a sensible "version" string from a command's stdout.
///
/// With the shell helper now using `-lic`, an interactive shell's init may
/// print banners / prompts / conda init blurbs to stdout *before* the actual
/// version line. We scan from the bottom for a line that contains a
/// dotted-numeric version. Falls back to the trimmed full output if nothing
/// matches (e.g. unusual `--version` formats we don't want to silently drop).
pub(crate) fn extract_version_line(stdout: &str) -> String {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        // Cheap manual scan instead of pulling regex into the hot path:
        // require <digits>.<digits>.<digits> somewhere in the line.
        if has_semver_like(trimmed) {
            return trimmed.to_string();
        }
    }
    stdout.trim().to_string()
}

fn has_semver_like(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            let mut dots = 0;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                if bytes[j] == b'.' { dots += 1; }
                j += 1;
            }
            // `1.2.3` style - at least two dots between numeric runs.
            if dots >= 2 && j > i + 4 { return true; }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    false
}

#[command]
pub async fn check_system_requirements() -> Result<SystemStatus, String> {
    wrap_cmd("check_system_requirements", async move {
        // Check Node.js
        let node_result = {
            let mut cmd: tokio::process::Command = shell_command("node", &["--version"]).into();
            cmd.output().await
        };

        let (node_installed, node_version) = match node_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                (true, Some(extract_version_line(&stdout)))
            }
            _ => (false, None),
        };

        // Check npm
        let npm_result = {
            let mut cmd: tokio::process::Command = shell_command("npm", &["--version"]).into();
            cmd.output().await
        };

        let (npm_installed, npm_version) = match npm_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                (true, Some(extract_version_line(&stdout)))
            }
            _ => (false, None),
        };

        // Check Claude Code via the resolved absolute path when available
        // (avoids any shell-PATH guessing). Falls back to the shell helper.
        let claude_result = run_claude(&["--version"]).await;

        let (claude_installed, claude_version) = match claude_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                (true, Some(extract_version_line(&stdout)))
            }
            _ => (false, None),
        };

        Ok(SystemStatus {
            node_installed,
            node_version,
            npm_installed,
            npm_version,
            claude_installed,
            claude_version,
        })
    })
    .await
}

#[command]
pub async fn install_claude_code() -> Result<String, String> {
    wrap_cmd("install_claude_code", async move {
        let mut cmd: tokio::process::Command =
            shell_command("npm", &["install", "-g", "@anthropic-ai/claude-code"]).into();
        let output = cmd
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            // Drop any cached "claude not found" so the next system check
            // re-resolves the freshly-installed binary.
            crate::claude_path::invalidate();
            Ok("Claude Code installed successfully!".to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    })
    .await
}

#[command]
pub async fn send_notification(title: String, body: String) -> Result<(), String> {
    wrap_cmd("send_notification", async move {
        tokio::task::spawn_blocking(move || {
            notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .show()
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    })
    .await
}

#[command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    wrap_cmd("open_external_url", async move {
        // Reject null bytes that could confuse shell execution
        if url.contains('\0') {
            return Err("Invalid URL".to_string());
        }
        // Parse with a proper URL parser to prevent scheme confusion
        let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err("Only HTTP and HTTPS URLs are allowed".to_string());
        }
        open::that(parsed.as_str()).map_err(|e| e.to_string())
    })
    .await
}

/// List Claude session `.jsonl` files for a given cwd. Returns newest-first;
/// each entry has the session id (UUID stem), file mtime, and a short
/// excerpt of the first user message for previewing in the sidebar.
#[command]
pub async fn list_claude_sessions(
    cwd: String,
) -> Result<Vec<crate::claude_session::ClaudeSessionInfo>, String> {
    wrap_cmd("list_claude_sessions", async move {
        if cwd.is_empty() || cwd.contains('\0') {
            return Err("Invalid cwd".to_string());
        }
        Ok(crate::claude_session::list_sessions_for_cwd(&cwd))
    })
    .await
}

/// Reject paths with null bytes or that resolve to a parent of themselves
/// (basic sanity gate shared by the file-tree mutation commands).
fn validate_path(s: &str) -> Result<(), String> {
    if s.is_empty() || s.contains('\0') {
        return Err("Invalid path".to_string());
    }
    Ok(())
}

/// Recursive copy for a directory tree. `dst` must not already exist.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let child_src = entry.path();
        let child_dst = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&child_src, &child_dst)?;
        } else if ty.is_symlink() {
            // Preserve symlinks rather than copying through them.
            #[cfg(unix)]
            {
                let target = std::fs::read_link(&child_src)?;
                std::os::unix::fs::symlink(target, &child_dst)?;
            }
            #[cfg(windows)]
            {
                // On Windows, symlinks need elevation. Fall back to copying
                // the file the link points to - best-effort but safe.
                std::fs::copy(&child_src, &child_dst)?;
            }
        } else {
            std::fs::copy(&child_src, &child_dst)?;
        }
    }
    Ok(())
}

/// Rename a file or folder in place (parent stays the same). Refuses to
/// overwrite an existing entry at the destination - UI should ask the user
/// first if they really want to replace it.
#[command]
pub async fn rename_path(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    wrap_cmd("rename_path", async move {
        validate_path(&from)?;
        validate_path(&to)?;
        let from_p = std::path::PathBuf::from(&from);
        let to_p = std::path::PathBuf::from(&to);
        if !from_p.exists() {
            return Err(error_reporter::user_err("Source path does not exist"));
        }
        // Confine to an active terminal's working directory. `to` shares
        // `from`'s parent (enforced below), so trusting the source is enough.
        validate_path_is_trusted(&state, &from).await?;
        if to_p.exists() {
            return Err(error_reporter::user_err("A file with that name already exists"));
        }
        // Restrict rename to the same parent - moves use move_path instead.
        if from_p.parent() != to_p.parent() {
            return Err(error_reporter::user_err("Rename target must be in the same folder"));
        }
        tokio::fs::rename(&from_p, &to_p).await.map_err(|e| e.to_string())
    })
    .await
}

/// Send a file or folder to the OS trash/recycle bin. The `trash` crate
/// handles Windows (SHFileOperation), macOS (NSFileManager trashItem), and
/// Linux (XDG trash spec) - entries can be restored manually by the user.
#[command]
pub async fn trash_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    wrap_cmd("trash_path", async move {
        validate_path(&path)?;
        let p = std::path::PathBuf::from(&path);
        if !p.exists() {
            // Race with the filesystem (external delete, stale FileTree row) — user-visible, not a bug.
            return Err(error_reporter::user_err("Path does not exist"));
        }
        // Only allow trashing paths under an active terminal's working directory.
        validate_path_is_trusted(&state, &path).await?;
        // trash::delete failures are environmental: file held by another process,
        // Windows Recycle Bin confirmation cancelled, or OS aborted mid-op. Not defects.
        trash::delete(&p).map_err(|e| error_reporter::user_err(e.to_string()))
    })
    .await
}

/// Move a file or folder into `dest_dir` (keeps the original basename).
/// Refuses to overwrite an existing entry; refuses to move a folder into
/// itself or any of its descendants (which would leave the source orphaned).
#[command]
pub async fn move_into_dir(
    state: State<'_, AppState>,
    source: String,
    dest_dir: String,
) -> Result<(), String> {
    wrap_cmd("move_into_dir", async move {
        validate_path(&source)?;
        validate_path(&dest_dir)?;
        let src = std::path::PathBuf::from(&source);
        let dst_dir = std::path::PathBuf::from(&dest_dir);
        if !src.exists() {
            return Err(error_reporter::user_err("Source does not exist"));
        }
        if !dst_dir.is_dir() {
            return Err(error_reporter::user_err("Destination is not a folder"));
        }
        // Both endpoints must live under an active terminal's working directory.
        validate_path_is_trusted(&state, &source).await?;
        validate_path_is_trusted(&state, &dest_dir).await?;
        let name = src
            .file_name()
            .ok_or_else(|| error_reporter::user_err("Source has no file name"))?;
        let dst = dst_dir.join(name);
        if dst.exists() {
            return Err(error_reporter::user_err(
                "A file with that name already exists in the destination",
            ));
        }
        // Everything below is sync fs work — canonicalize, rename, and the
        // cross-volume fallback copy+delete (which may recurse for a dir).
        // Run it on the blocking pool so the tokio runtime keeps serving
        // other IPC while a large tree copies.
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            // Block moving a folder into itself or its own subtree.
            let src_canon = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
            let dst_dir_canon = std::fs::canonicalize(&dst_dir).map_err(|e| e.to_string())?;
            if dst_dir_canon == src_canon || dst_dir_canon.starts_with(&src_canon) {
                return Err(error_reporter::user_err("Cannot move a folder into itself"));
            }
            // Fall back to copy+delete when fs::rename can't cross volumes.
            if let Err(rename_err) = std::fs::rename(&src, &dst) {
                let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
                if meta.is_dir() {
                    copy_dir_recursive(&src, &dst).map_err(|e| {
                        format!("Move failed ({}); cross-volume copy also failed: {}", rename_err, e)
                    })?;
                    std::fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
                } else {
                    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
                    std::fs::remove_file(&src).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Move task failed: {}", e))?
    })
    .await
}

/// Copy a file or folder into `dest_dir` (keeps the original basename).
#[command]
pub async fn copy_into_dir(
    state: State<'_, AppState>,
    source: String,
    dest_dir: String,
) -> Result<(), String> {
    wrap_cmd("copy_into_dir", async move {
        validate_path(&source)?;
        validate_path(&dest_dir)?;
        let src = std::path::PathBuf::from(&source);
        let dst_dir = std::path::PathBuf::from(&dest_dir);
        if !src.exists() {
            return Err(error_reporter::user_err("Source does not exist"));
        }
        if !dst_dir.is_dir() {
            return Err(error_reporter::user_err("Destination is not a folder"));
        }
        // Both endpoints must live under an active terminal's working directory.
        validate_path_is_trusted(&state, &source).await?;
        validate_path_is_trusted(&state, &dest_dir).await?;
        let name = src
            .file_name()
            .ok_or_else(|| error_reporter::user_err("Source has no file name"))?;
        let dst = dst_dir.join(name);
        if dst.exists() {
            return Err(error_reporter::user_err(
                "A file with that name already exists in the destination",
            ));
        }
        // Sync fs work (canonicalize + copy, possibly recursive) — off-runtime.
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let src_canon = std::fs::canonicalize(&src).map_err(|e| e.to_string())?;
            let dst_dir_canon = std::fs::canonicalize(&dst_dir).map_err(|e| e.to_string())?;
            if dst_dir_canon.starts_with(&src_canon) {
                return Err(error_reporter::user_err("Cannot copy a folder into itself"));
            }
            let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                copy_dir_recursive(&src, &dst).map_err(|e| e.to_string())?;
            } else {
                std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("Copy task failed: {}", e))?
    })
    .await
}

/// Reveal a path in the OS file manager. Directories are opened; files are
/// shown selected inside their parent folder (Windows `explorer /select,`,
/// macOS `open -R`). Args are passed individually so there is no shell
/// interpolation; the path is canonicalized so symlinks/relative inputs are
/// resolved before we hand them to the native command.
#[command]
pub async fn reveal_in_file_manager(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    wrap_cmd("reveal_in_file_manager", async move {
        if path.is_empty() || path.contains('\0') {
            return Err(error_reporter::user_err("Invalid path"));
        }
        // Confine to an active terminal's working directory so a rogue renderer
        // extension can't invoke this to enumerate the filesystem via Explorer.
        validate_path_is_trusted(&state, &path).await?;
        let canonical = tokio::fs::canonicalize(&path).await.map_err(|e| e.to_string())?;
        let meta = tokio::fs::metadata(&canonical).await.map_err(|e| e.to_string())?;

        if meta.is_dir() {
            open::that(&canonical).map_err(|e| e.to_string())?;
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            // `explorer /select,<path>` needs the path joined to the flag with a
            // comma. Strip the verbatim `\\?\` prefix that `canonicalize` adds -
            // explorer.exe doesn't understand it. spawn() (vs status()) avoids
            // blocking on explorer's own exit code, which is famously nonzero
            // even on success.
            let s = canonical.to_string_lossy();
            let display = s.strip_prefix(r"\\?\").unwrap_or(&s);
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", display))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(canonical.as_os_str())
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            // Linux fallback: no portable "reveal" - open the parent folder.
            if let Some(parent) = canonical.parent() {
                open::that(parent).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
}

#[command]
pub async fn get_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<crate::database::WorkspaceInfo>, String> {
    wrap_cmd("get_workspaces", async move {
        db_op(&state.db, |db| db.get_workspaces()).await
    })
    .await
}

#[command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    wrap_cmd("delete_workspace", async move {
        db_op(&state.db, move |db| db.delete_workspace(&name)).await
    })
    .await
}

#[command]
pub async fn save_workspace(
    state: State<'_, AppState>,
    name: String,
    terminals: Vec<crate::terminal::TerminalConfig>,
) -> Result<(), String> {
    wrap_cmd("save_workspace", async move {
        db_op(&state.db, move |db| db.save_workspace(&name, &terminals)).await
    })
    .await
}

#[command]
pub async fn load_workspace(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<crate::terminal::TerminalConfig>, String> {
    wrap_cmd("load_workspace", async move {
        db_op(&state.db, move |db| db.load_workspace(&name)).await
    })
    .await
}

#[command]
pub async fn save_session_for_restore(state: State<'_, AppState>) -> Result<(), String> {
    wrap_cmd("save_session_for_restore", async move {
        let configs = {
            let terminals = state.terminals.lock().await;
            terminals.get_all_configs()
        };
        db_op(&state.db, move |db| db.save_last_session(&configs)).await
    })
    .await
}

#[command]
pub async fn get_last_session(
    state: State<'_, AppState>,
) -> Result<Option<Vec<crate::terminal::TerminalConfig>>, String> {
    wrap_cmd("get_last_session", async move {
        let configs = db_op(&state.db, |db| db.load_last_session()).await?;
        if let Some(ref cs) = configs {
            for c in cs {
                eprintln!(
                    "[session-restore] '{}' has claude_session_id = {:?}",
                    c.label, c.claude_session_id
                );
            }
        }
        Ok(configs)
    })
    .await
}

#[command]
pub async fn clear_last_session(state: State<'_, AppState>) -> Result<(), String> {
    wrap_cmd("clear_last_session", async move {
        db_op(&state.db, |db| db.clear_last_session()).await
    })
    .await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileChangesResult {
    pub terminal_id: String,
    pub working_directory: String,
    /// Absolute repo top-level. Porcelain paths in `changes` are relative to
    /// this, NOT to `working_directory` (which may be a subdirectory).
    pub repo_root: Option<String>,
    pub changes: Vec<FileChange>,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub error: Option<String>,
}

#[command]
pub async fn get_terminal_changes(
    state: State<'_, AppState>,
    id: String,
) -> Result<FileChangesResult, String> {
    wrap_cmd("get_terminal_changes", async move {
        // The FileChangesPanel polls on a debounced effect; if the active
        // terminal closes between the schedule and the call we'd otherwise
        // error with "Terminal not found" and pollute telemetry. An empty
        // not-a-repo result is the closest benign analog for "nothing to show".
        let working_directory = {
            let terminals = state.terminals.lock().await;
            let configs = terminals.get_all_configs();
            match configs.into_iter().find(|c| c.id == id) {
                Some(c) => c.working_directory.clone(),
                None => {
                    return Ok(FileChangesResult {
                        terminal_id: id,
                        working_directory: String::new(),
                        repo_root: None,
                        changes: vec![],
                        is_git_repo: false,
                        branch: None,
                        error: None,
                    });
                }
            }
        };

        // Check if it's a git repo and get branch name
        let branch_output = git_cmd_async(&["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&working_directory)
            .output()
            .await;

        let (is_git_repo, branch) = match branch_output {
            Ok(output) if output.status.success() => {
                let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
                (true, Some(branch))
            }
            _ => (false, None),
        };

        if !is_git_repo {
            return Ok(FileChangesResult {
                terminal_id: id,
                working_directory,
                repo_root: None,
                changes: vec![],
                is_git_repo: false,
                branch: None,
                error: None,
            });
        }

        let repo_root = resolve_repo_root(&working_directory).await.ok();

        // Get changed files
        let status_output = git_cmd_async(&["status", "--porcelain"])
            .current_dir(&working_directory)
            .output()
            .await
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        if !status_output.status.success() {
            return Ok(FileChangesResult {
                terminal_id: id,
                working_directory,
                repo_root,
                changes: vec![],
                is_git_repo: true,
                branch,
                error: Some(String::from_utf8_lossy(&status_output.stderr).trim().to_string()),
            });
        }

        let stdout = String::from_utf8_lossy(&status_output.stdout);
        let mut changes: Vec<FileChange> = Vec::new();
        for line in stdout.lines() {
            if line.len() < 3 { continue; }
            let x = line.as_bytes().get(0).copied().unwrap_or(b' ') as char;
            let y = line.as_bytes().get(1).copied().unwrap_or(b' ') as char;
            // Rename line: "R  old -> new"
            let raw_path = &line[3..];
            let path = if raw_path.contains(" -> ") {
                raw_path.split(" -> ").nth(1).unwrap_or(raw_path).to_string()
            } else {
                raw_path.to_string()
            };

            if x == '?' && y == '?' {
                // Untracked - always unstaged
                changes.push(FileChange { path, status: "untracked".into(), staged: false });
                continue;
            }

            let map_code = |c: char| match c {
                'A' => "new",
                'M' => "modified",
                'D' => "deleted",
                'R' => "renamed",
                'C' => "new",
                'U' => "modified", // conflicted - treat as modified
                'T' => "modified", // type change
                _ => "",
            };

            // Staged side (X)
            if x != ' ' && x != '?' {
                let status = map_code(x);
                if !status.is_empty() {
                    changes.push(FileChange { path: path.clone(), status: status.into(), staged: true });
                }
            }
            // Unstaged side (Y)
            if y != ' ' && y != '?' {
                let status = map_code(y);
                if !status.is_empty() {
                    changes.push(FileChange { path, status: status.into(), staged: false });
                }
            }
        }

        Ok(FileChangesResult {
            terminal_id: id,
            working_directory,
            repo_root,
            changes,
            is_git_repo: true,
            branch,
            error: None,
        })
    })
    .await
}

// ─── File Diff Command ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct FileDiffResult {
    pub file_path: String,
    pub diff_text: String,
    pub is_new_file: bool,
    pub is_deleted_file: bool,
    pub is_binary: bool,
}

/// Reject a single git pathspec that isn't a plain repo-relative path.
/// Mirrors `validate_file_list`'s per-entry checks. The diff/show commands pass
/// a frontend-supplied file path straight into git args, so this is both a
/// traversal guard and defense-in-depth for the arg-handling seams.
fn validate_git_pathspec(file: &str) -> Result<(), String> {
    if file.is_empty() || file.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    if file.starts_with('/') || file.starts_with('\\') || file.contains("..") {
        return Err(format!("Invalid file path: {}", file));
    }
    Ok(())
}

/// Build the `+`-prefixed pseudo-diff for a new/untracked file, capping size and
/// sniffing for binary the same way `read_text_file` does. Returns a short
/// human-readable marker (not an error) when the file can't be previewed, so the
/// diff pane degrades gracefully instead of reading an unbounded file into RAM.
async fn build_new_file_diff(full_path: &std::path::Path, file_path: &str) -> String {
    const MAX_DIFF_FILE_BYTES: u64 = 5 * 1024 * 1024; // 5 MB, matches read_text_file
    match tokio::fs::metadata(full_path).await {
        Ok(m) if m.len() > MAX_DIFF_FILE_BYTES => {
            return format!("File is too large to preview ({} bytes).", m.len());
        }
        Ok(_) => {}
        Err(_) => return String::from("Unable to read file contents"),
    }
    let bytes = match tokio::fs::read(full_path).await {
        Ok(b) => b,
        Err(_) => return String::from("Unable to read file contents"),
    };
    let sniff = bytes.len().min(8192);
    if bytes[..sniff].contains(&0u8) {
        return String::from("Binary file - preview not available");
    }
    let content = match String::from_utf8(bytes) {
        Ok(c) => c,
        Err(_) => return String::from("File is not valid UTF-8"),
    };
    let lines: Vec<String> = content.lines().map(|l| format!("+{}", l)).collect();
    format!(
        "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
        file_path,
        lines.len(),
        lines.join("\n")
    )
}

#[command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    id: String,
    file_path: String,
    staged: bool,
) -> Result<FileDiffResult, String> {
    wrap_cmd("get_file_diff", async move {
        validate_git_pathspec(&file_path)?;
        let working_directory = {
            let terminals = state.terminals.lock().await;
            let configs = terminals.get_all_configs();
            let config = configs
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| error_reporter::user_err("Terminal not found"))?;
            config.working_directory.clone()
        };

        // `file_path` is repo-root-relative (porcelain output) - all git ops and
        // file reads must resolve against the root, not the terminal's cwd.
        let working_directory = resolve_repo_root(&working_directory).await?;

        // Run git status for this specific file to determine its status
        let status_output = git_cmd_async(&["status", "--porcelain", "--", &file_path])
            .current_dir(&working_directory)
            .output()
            .await
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        let status_str = String::from_utf8_lossy(&status_output.stdout).trim().to_string();
        let file_status = if status_str.len() >= 2 {
            status_str[..2].trim().to_string()
        } else {
            String::new()
        };

        let is_new_file = file_status == "??" || file_status == "A";
        let is_deleted_file = file_status == "D";

        let diff_text = if is_new_file {
            // For untracked/new files, read the file and format as all-added
            // (size-capped + binary-sniffed - see build_new_file_diff).
            let full_path = std::path::Path::new(&working_directory).join(&file_path);
            build_new_file_diff(&full_path, &file_path).await
        } else if is_deleted_file {
            // For deleted files, show content from HEAD
            let show_output = git_cmd_async(&["show", &format!("HEAD:{}", file_path)])
                .current_dir(&working_directory)
                .output()
                .await;
            match show_output {
                Ok(output) if output.status.success() => {
                    let content = String::from_utf8_lossy(&output.stdout);
                    let lines: Vec<String> = content.lines().enumerate().map(|(_, line)| {
                        format!("-{}", line)
                    }).collect();
                    format!(
                        "--- a/{}\n+++ /dev/null\n@@ -1,{} +0,0 @@\n{}",
                        file_path,
                        lines.len(),
                        lines.join("\n")
                    )
                }
                _ => String::from("Unable to read deleted file contents")
            }
        } else {
            // For modified/renamed files, run git diff
            let mut args = vec!["diff"];
            if staged {
                args.push("--cached");
            }
            args.push("--");
            args.push(&file_path);

            let diff_output = git_cmd_async(&args)
                .current_dir(&working_directory)
                .output()
                .await
                .map_err(|e| format!("Failed to run git diff: {}", e))?;

            let text = String::from_utf8_lossy(&diff_output.stdout).to_string();

            // If unstaged diff is empty, try staged diff (file might be fully staged)
            if text.trim().is_empty() && !staged {
                let staged_output = git_cmd_async(&["diff", "--cached", "--", &file_path])
                    .current_dir(&working_directory)
                    .output()
                    .await
                    .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;
                String::from_utf8_lossy(&staged_output.stdout).to_string()
            } else {
                text
            }
        };

        let is_binary = diff_text.contains("Binary files") && diff_text.contains("differ");

        Ok(FileDiffResult {
            file_path,
            diff_text,
            is_new_file,
            is_deleted_file,
            is_binary,
        })
    })
    .await
}

// ─── Git Worktree Commands ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head_sha: String,
    pub is_main: bool,
    pub is_bare: bool,
    pub is_detached: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeDetectResult {
    pub is_git_repo: bool,
    pub is_worktree: bool,
    pub main_repo_path: Option<String>,
    pub current_branch: Option<String>,
    pub worktree_root: Option<String>,
    /// Count of files with modifications (staged or unstaged, incl. untracked
    /// via `--porcelain`). 0 = clean tree. None = not populated / not a repo.
    pub dirty_count: Option<u32>,
    /// Commits ahead of upstream. None = no upstream tracked or not populated.
    pub ahead: Option<u32>,
    /// Commits behind upstream. None = no upstream tracked or not populated.
    pub behind: Option<u32>,
}

/// Validate that a path belongs to (or is under) an active terminal's working directory.
/// Prevents arbitrary filesystem access via git commands.
async fn validate_path_is_trusted(state: &State<'_, AppState>, path: &str) -> Result<(), String> {
    let canonical_path = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| error_reporter::user_err(format!("Invalid path '{}': {}", path, e)))?;

    let terminals = state.terminals.lock().await;
    let known_dirs = terminals.get_all_configs();

    let is_trusted = known_dirs.iter().any(|config| {
        if config.working_directory.is_empty() {
            return false;
        }
        std::path::Path::new(&config.working_directory)
            .canonicalize()
            .ok()
            .map(|known| canonical_path.starts_with(&known))
            .unwrap_or(false)
    });

    if !is_trusted {
        return Err(error_reporter::user_err(format!(
            "Path '{}' is not under any active terminal's working directory",
            canonical_path.display()
        )));
    }
    Ok(())
}

#[command]
pub async fn get_worktree_info(
    state: State<'_, AppState>,
    path: String,
) -> Result<WorktreeDetectResult, String> {
    wrap_cmd("get_worktree_info", async move {
        // This is a "tell me about this path" lookup. If the path isn't a
        // tracked workspace (e.g. user navigated outside the file tree),
        // return the same empty shape we use for "not a git repo" instead of
        // erroring - this isn't a bug worth reporting to telemetry.
        if validate_path_is_trusted(&state, &path).await.is_err() {
            return Ok(WorktreeDetectResult {
                is_git_repo: false,
                is_worktree: false,
                main_repo_path: None,
                current_branch: None,
                worktree_root: None,
                dirty_count: None,
                ahead: None,
                behind: None,
            });
        }

        // Check if inside a git work tree
        let inside_wt = git_cmd_async(&["rev-parse", "--is-inside-work-tree"])
            .current_dir(&path)
            .output()
            .await;

        let is_git_repo = matches!(inside_wt, Ok(ref o) if o.status.success()
            && String::from_utf8_lossy(&o.stdout).trim() == "true");

        if !is_git_repo {
            return Ok(WorktreeDetectResult {
                is_git_repo: false,
                is_worktree: false,
                main_repo_path: None,
                current_branch: None,
                worktree_root: None,
                dirty_count: None,
                ahead: None,
                behind: None,
            });
        }

        // Get worktree root (--show-toplevel)
        let toplevel = git_cmd_async(&["rev-parse", "--show-toplevel"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        // Get git-dir and git-common-dir to detect if this is a linked worktree
        let git_dir = git_cmd_async(&["rev-parse", "--git-dir"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        let git_common_dir = git_cmd_async(&["rev-parse", "--git-common-dir"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        // If git-dir != git-common-dir, this is a linked worktree
        let is_worktree = match (&git_dir, &git_common_dir) {
            (Some(dir), Some(common)) => {
                let dir_canon = std::path::PathBuf::from(dir).canonicalize().ok();
                let common_canon = std::path::PathBuf::from(common).canonicalize().ok();
                match (dir_canon, common_canon) {
                    (Some(d), Some(c)) => d != c,
                    _ => dir != common,
                }
            }
            _ => false,
        };

        // Derive main repo path from git-common-dir (strip trailing .git)
        let main_repo_path = git_common_dir.and_then(|common| {
            let p = std::path::PathBuf::from(&common);
            let canonical = p.canonicalize().ok()?;
            // git-common-dir points to the .git directory; parent is the repo root
            if canonical.file_name().map(|f| f == ".git").unwrap_or(false) {
                canonical.parent().map(|p| p.to_string_lossy().to_string())
            } else {
                Some(canonical.to_string_lossy().to_string())
            }
        });

        // Get current branch
        let current_branch = git_cmd_async(&["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if b == "HEAD" { None } else { Some(b) }
            })
            .flatten();

        // Working-tree cleanliness — count of modified/staged/untracked files
        // via `--porcelain=v1` (stable, machine-readable). Empty output = clean.
        let dirty_count = git_cmd_async(&["status", "--porcelain=v1"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter(|l| !l.is_empty())
                    .count() as u32
            });

        // Ahead/behind vs upstream — `rev-list --left-right --count HEAD...@{u}`
        // emits "<ahead>\t<behind>". Fails silently when no upstream is tracked.
        let (ahead, behind) = git_cmd_async(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
            .current_dir(&path)
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let mut parts = s.split_whitespace();
                let a = parts.next()?.parse::<u32>().ok()?;
                let b = parts.next()?.parse::<u32>().ok()?;
                Some((Some(a), Some(b)))
            })
            .unwrap_or((None, None));

        Ok(WorktreeDetectResult {
            is_git_repo: true,
            is_worktree,
            main_repo_path,
            current_branch,
            worktree_root: toplevel,
            dirty_count,
            ahead,
            behind,
        })
    })
    .await
}

/// Internal helper to list worktrees for a given path (no authorization check).
async fn list_worktrees_internal(path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let output = git_cmd_async(&["worktree", "list", "--porcelain"])
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut is_first = true;

    // Parse porcelain output: blocks separated by blank lines
    for block in stdout.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        let mut wt_path = String::new();
        let mut head_sha = String::new();
        let mut branch: Option<String> = None;
        let mut is_bare = false;
        let mut is_detached = false;

        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                wt_path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head_sha = h[..7.min(h.len())].to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                // Strip refs/heads/ prefix
                branch = Some(
                    b.strip_prefix("refs/heads/")
                        .unwrap_or(b)
                        .to_string(),
                );
            } else if line == "bare" {
                is_bare = true;
            } else if line == "detached" {
                is_detached = true;
            }
        }

        if !wt_path.is_empty() {
            worktrees.push(WorktreeInfo {
                path: wt_path,
                branch,
                head_sha,
                is_main: is_first,
                is_bare,
                is_detached,
            });
        }
        is_first = false;
    }

    Ok(worktrees)
}

#[command]
pub async fn list_worktrees(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<WorktreeInfo>, String> {
    wrap_cmd("list_worktrees", async move {
        validate_path_is_trusted(&state, &path).await?;
        list_worktrees_internal(&path).await
    })
    .await
}

#[command]
pub async fn get_repo_branches(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    wrap_cmd("get_repo_branches", async move {
        validate_path_is_trusted(&state, &path).await?;

        let output = git_cmd_async(&["branch", "--format=%(refname:short)"])
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to list branches: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let branches: Vec<String> = stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();

        Ok(branches)
    })
    .await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StashEntry {
    pub reference: String, // e.g. "stash@{0}"
    pub message: String,
    pub branch: Option<String>,
}

/// Build a tokio::process::Command for git so async callers can .output().await
/// without stalling a runtime worker. Same argv semantics as `git_command`.
pub(crate) fn git_cmd_async(args: &[&str]) -> tokio::process::Command {
    git_command(args).into()
}

async fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    // tokio::process::Command runs the child on the async reactor so the
    // handler doesn't stall a runtime worker while git is thinking. On big
    // repos or slow disks a sync .output() would block every other IPC
    // command sharing the worker; here git yields on the child pipes.
    let out = git_cmd_async(args)
        .current_dir(path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolve the repository top-level for any path inside a repo. Git's
/// porcelain status reports root-relative paths while command-line pathspecs
/// resolve against the cwd, so commands that take file lists must run from
/// the root or they fail with "pathspec did not match" in subdirectories.
async fn resolve_repo_root(path: &str) -> Result<String, String> {
    let out = run_git(path, &["rev-parse", "--show-toplevel"]).await?;
    let root = out.trim().to_string();
    if root.is_empty() {
        return Err(error_reporter::user_err("Not a git repository"));
    }
    Ok(root)
}

fn validate_stash_ref(r: &str) -> Result<(), String> {
    // Must be "stash@{N}" to prevent argument injection
    if !r.starts_with("stash@{") || !r.ends_with('}') {
        return Err("Invalid stash reference".to_string());
    }
    let inner = &r[7..r.len() - 1];
    if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid stash reference".to_string());
    }
    Ok(())
}

fn validate_file_list(files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Err("No files selected".to_string());
    }
    for f in files {
        if f.is_empty() || f.contains('\0') {
            return Err("Invalid file path".to_string());
        }
        // Reject absolute paths and parent-dir traversal. Git always reports
        // repo-relative paths, so legitimate inputs never need these.
        if f.starts_with('/') || f.starts_with('\\') || f.contains("..") {
            return Err(format!("Invalid file path: {}", f));
        }
    }
    Ok(())
}

#[command]
pub async fn git_stage_files(
    state: State<'_, AppState>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    wrap_cmd("git_stage_files", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_file_list(&files)?;
        // File paths are root-relative (porcelain output) - run from the root.
        let root = resolve_repo_root(&path).await?;
        // Files named after Windows device names (nul, con, ...) cannot be read
        // by git ("short read while indexing nul") and would abort the whole
        // add. Stage everything else and report them clearly instead.
        let (reserved, addable): (Vec<&String>, Vec<&String>) =
            files.iter().partition(|f| is_windows_reserved_name(f));
        if !addable.is_empty() {
            // `--ignore-errors` keeps indexing the rest if one file fails;
            // `--` terminates options.
            let mut args: Vec<&str> = vec!["add", "--ignore-errors", "--"];
            for f in &addable { args.push(f); }
            run_git(&root, &args).await?;
        }
        if !reserved.is_empty() {
            let names: Vec<&str> = reserved.iter().map(|s| s.as_str()).collect();
            return Err(format!(
                "Skipped {}: Windows reserved device name - git cannot index it. Delete the file or add it to .gitignore.",
                names.join(", ")
            ));
        }
        Ok(())
    })
    .await
}

/// True when the path's final component is a Windows reserved device name
/// (nul, con, prn, aux, com1-9, lpt1-9), with or without an extension. Git on
/// Windows cannot index these - reads hit the device instead of the file.
#[cfg(windows)]
fn is_windows_reserved_name(path: &str) -> bool {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = base.split('.').next().unwrap_or(base).to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul"
            | "com1" | "com2" | "com3" | "com4" | "com5" | "com6" | "com7" | "com8" | "com9"
            | "lpt1" | "lpt2" | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9"
    )
}

#[cfg(not(windows))]
fn is_windows_reserved_name(_path: &str) -> bool {
    false
}

#[command]
pub async fn git_unstage_files(
    state: State<'_, AppState>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    wrap_cmd("git_unstage_files", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_file_list(&files)?;
        // File paths are root-relative (porcelain output) - run from the root.
        let root = resolve_repo_root(&path).await?;
        // Use `git reset HEAD -- <file>` for broad git-version compatibility.
        // `git restore --staged` (2.23+) is the modern equivalent.
        let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
        for f in &files { args.push(f); }
        // `git reset` returns non-zero on no-op or initial-commit edge cases, but
        // the files do end up unstaged - we tolerate non-fatal stderr.
        match run_git(&root, &args).await {
            Ok(_) => Ok(()),
            Err(e) => {
                // On a repo with no HEAD yet, use `git rm --cached` as fallback.
                if e.contains("ambiguous argument 'HEAD'") || e.contains("unknown revision") {
                    let mut fb: Vec<&str> = vec!["rm", "--cached", "--"];
                    for f in &files { fb.push(f); }
                    run_git(&root, &fb).await.map(|_| ())
                } else {
                    Err(e)
                }
            }
        }
    })
    .await
}

#[command]
pub async fn git_commit(
    state: State<'_, AppState>,
    path: String,
    message: String,
    auto_stage: AutoStageMode,
    amend: Option<bool>,
) -> Result<(), String> {
    let amend = amend.unwrap_or(false);
    wrap_cmd("git_commit", async move {
        validate_path_is_trusted(&state, &path).await?;
        if message.trim().is_empty() {
            return Err(error_reporter::user_err("Commit message cannot be empty"));
        }
        // Run from the repo root so auto-stage covers the whole repo even when
        // `path` is a subdirectory (add -u/-A are cwd-scoped).
        let root = resolve_repo_root(&path).await?;
        // If the caller asks us to auto-stage, do so. Otherwise commit what's
        // already staged - and if nothing is staged, return a clear error.
        // An amend with nothing staged is still valid (message-only rewrite).
        match auto_stage {
            AutoStageMode::None => {
                let status = run_git(&root, &["diff", "--cached", "--name-only"]).await?;
                if status.trim().is_empty() && !amend {
                    return Err(error_reporter::user_err(
                        "Nothing is staged - stage files first or choose 'stage all'",
                    ));
                }
            }
            AutoStageMode::Tracked => { run_git(&root, &["add", "-u"]).await?; }
            AutoStageMode::All => { run_git(&root, &["add", "-A"]).await?; }
        }

        // Pass message via a temp file to avoid any shell-quoting concerns for
        // multi-line or special-character messages. Uuid-based filename so a
        // local attacker can't pre-create the path as a symlink pointing
        // elsewhere (the old millis-based name was predictable-enough to race
        // on shared /tmp).
        let tmp = std::env::temp_dir().join(format!(
            "ct-commit-msg-{}.txt",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::write(&tmp, message.as_bytes()).await.map_err(|e| format!("Failed to write commit message: {}", e))?;
        let tmp_str = tmp.to_string_lossy().to_string();
        let mut args: Vec<&str> = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        args.push("-F");
        args.push(&tmp_str);
        let res = run_git(&root, &args).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        res.map(|_| ())
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct LastCommitInfo {
    pub subject: String,
    pub message: String,
}

#[command]
pub async fn get_last_commit_info(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<LastCommitInfo>, String> {
    wrap_cmd("get_last_commit_info", async move {
        validate_path_is_trusted(&state, &path).await?;
        // %s = subject, %B = raw body; separated by a unit separator so
        // multi-line messages parse unambiguously.
        match run_git(&path, &["log", "-1", "--format=%s%x1f%B"]).await {
            Ok(out) => {
                let trimmed = out.trim_end();
                if trimmed.is_empty() {
                    return Ok(None);
                }
                let (subject, message) = match trimmed.split_once('\x1f') {
                    Some((s, m)) => (s.to_string(), m.trim_end().to_string()),
                    None => (trimmed.to_string(), trimmed.to_string()),
                };
                Ok(Some(LastCommitInfo { subject, message }))
            }
            // A repo with no commits yet has no HEAD, and a directory that
            // isn't a git repo at all, both have no last commit - not errors.
            Err(e)
                if e.contains("does not have any commits")
                    || e.contains("unknown revision")
                    || e.contains("ambiguous argument")
                    || e.contains("not a git repository") => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum AutoStageMode {
    None,
    Tracked,
    All,
}

#[derive(Debug, Serialize)]
pub struct PushCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub time_iso: String,
}

#[derive(Debug, Serialize)]
pub struct PushPreview {
    pub local_branch: String,
    pub remotes: Vec<String>,
    pub default_remote: String,
    pub default_remote_branch: String,
    pub has_upstream: bool,
    pub commits: Vec<PushCommit>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum PushMode {
    Normal,
    ForceWithLease,
}

/// Reject inputs that could break the refspec or shell out - used for `remote`
/// and `remote_branch` arguments coming from the frontend.
fn validate_ref_token(value: &str, label: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if v.starts_with('-') {
        return Err(format!("{} cannot start with '-'", label));
    }
    for c in v.chars() {
        if c.is_control() || c.is_whitespace() {
            return Err(format!("{} contains an invalid character", label));
        }
        if matches!(c, ':' | '?' | '*' | '[' | '^' | '~' | '\\' | '\0') {
            return Err(format!("{} contains an invalid character", label));
        }
    }
    Ok(())
}

#[command]
pub async fn get_push_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<PushPreview, String> {
    wrap_cmd("get_push_preview", async move {
        validate_path_is_trusted(&state, &path).await?;

        // Local HEAD branch - refuse detached HEAD.
        let local_branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?
            .trim()
            .to_string();
        if local_branch.is_empty() || local_branch == "HEAD" {
            return Err(error_reporter::user_err("Cannot push from a detached HEAD"));
        }

        // Configured remotes.
        let remotes_raw = run_git(&path, &["remote"]).await?;
        let remotes: Vec<String> = remotes_raw
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if remotes.is_empty() {
            return Err(error_reporter::user_err("Repository has no remotes configured"));
        }

        // Upstream lookup - non-fatal if missing.
        let upstream = run_git(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

        let (default_remote, default_remote_branch, has_upstream) = match upstream {
            Some(s) => match s.split_once('/') {
                Some((r, b)) => (r.to_string(), b.to_string(), true),
                None => {
                    let r = if remotes.iter().any(|x| x == "origin") {
                        "origin".to_string()
                    } else {
                        remotes[0].clone()
                    };
                    (r, local_branch.clone(), false)
                }
            },
            None => {
                let r = if remotes.iter().any(|x| x == "origin") {
                    "origin".to_string()
                } else {
                    remotes[0].clone()
                };
                (r, local_branch.clone(), false)
            }
        };

        // Commit list - separator \x1f is safe against subjects with colons.
        let log_format = "--format=%H\x1f%h\x1f%s\x1f%an\x1f%aI";
        let commits_raw = if has_upstream {
            let range = format!("{}/{}..HEAD", default_remote, default_remote_branch);
            run_git(&path, &["log", &range, log_format]).await.unwrap_or_default()
        } else {
            // Commits on this branch not present on any remote.
            run_git(&path, &["log", "HEAD", "--not", "--remotes", log_format])
                .await
                .unwrap_or_default()
        };

        let commits: Vec<PushCommit> = commits_raw
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(5, '\x1f');
                let sha = parts.next()?.to_string();
                let short_sha = parts.next()?.to_string();
                let subject = parts.next()?.to_string();
                let author = parts.next()?.to_string();
                let time_iso = parts.next()?.to_string();
                if sha.is_empty() {
                    return None;
                }
                Some(PushCommit {
                    sha,
                    short_sha,
                    subject,
                    author,
                    time_iso,
                })
            })
            .collect();

        let ahead = commits.len();
        let behind = if has_upstream {
            let range = format!("HEAD..{}/{}", default_remote, default_remote_branch);
            run_git(&path, &["rev-list", "--count", &range])
                .await
                .ok()
                .and_then(|s| s.trim().parse::<usize>().ok())
                .unwrap_or(0)
        } else {
            0
        };

        Ok(PushPreview {
            local_branch,
            remotes,
            default_remote,
            default_remote_branch,
            has_upstream,
            commits,
            ahead,
            behind,
        })
    })
    .await
}

#[command]
pub async fn git_push(
    state: State<'_, AppState>,
    path: String,
    remote: String,
    remote_branch: String,
    mode: PushMode,
    push_tags: bool,
    set_upstream: bool,
) -> Result<(), String> {
    wrap_cmd("git_push", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_ref_token(&remote, "Remote")?;
        validate_ref_token(&remote_branch, "Remote branch")?;

        // Re-validate the remote against `git remote` - don't trust the frontend.
        let remotes_raw = run_git(&path, &["remote"]).await?;
        let known: Vec<&str> = remotes_raw.lines().map(|l| l.trim()).collect();
        if !known.iter().any(|r| *r == remote.as_str()) {
            return Err(error_reporter::user_err(format!("Unknown remote: {}", remote)));
        }

        let mut args: Vec<String> = vec!["push".into()];
        if set_upstream {
            args.push("-u".into());
        }
        if matches!(mode, PushMode::ForceWithLease) {
            args.push("--force-with-lease".into());
        }
        if push_tags {
            args.push("--tags".into());
        }
        args.push(remote.clone());
        args.push(format!("HEAD:{}", remote_branch));

        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        // Push failures are overwhelmingly environment/user conditions (auth,
        // non-fast-forward, no network) - surface to the UI, skip telemetry.
        run_git(&path, &str_args)
            .await
            .map(|_| ())
            .map_err(error_reporter::user_err)
    })
    .await
}

#[command]
pub async fn git_stash_push(
    state: State<'_, AppState>,
    path: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    wrap_cmd("git_stash_push", async move {
        validate_path_is_trusted(&state, &path).await?;
        let mut args: Vec<String> = vec!["stash".into(), "push".into()];
        if include_untracked { args.push("-u".into()); }
        if let Some(m) = message.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            // Use a temp file via `-F`? `git stash push` doesn't support -F; use -m.
            // Reject control chars to keep cmd.exe happy on Windows.
            if m.chars().any(|c| c.is_control()) {
                return Err(error_reporter::user_err("Stash message cannot contain control characters"));
            }
            args.push("-m".into());
            args.push(m.to_string());
        }
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_git(&path, &str_args).await.map(|_| ())
    })
    .await
}

#[command]
pub async fn git_list_stashes(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<StashEntry>, String> {
    wrap_cmd("git_list_stashes", async move {
        validate_path_is_trusted(&state, &path).await?;
        // Format: "<ref>\x1f<subject>" - \x1f (unit separator) is safe against
        // colons/spaces in the subject.
        // A non-git terminal cwd is a valid state for the stash panel to query -
        // treat git's "not a git repository" as an empty list, same shape as
        // get_worktree_info uses for non-repo paths.
        let out = match run_git(&path, &["stash", "list", "--format=%gd\x1f%s"]).await {
            Ok(out) => out,
            Err(e) if e.contains("not a git repository") => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut entries = Vec::new();
        for line in out.lines() {
            let mut parts = line.splitn(2, '\x1f');
            let reference = parts.next().unwrap_or("").trim().to_string();
            let subject = parts.next().unwrap_or("").trim().to_string();
            if reference.is_empty() { continue; }
            // Branch name is often encoded as "WIP on <branch>: ..." or "On <branch>: ..."
            let branch = subject
                .strip_prefix("WIP on ")
                .or_else(|| subject.strip_prefix("On "))
                .and_then(|s| s.split_once(':'))
                .map(|(b, _)| b.trim().to_string());
            entries.push(StashEntry { reference, message: subject, branch });
        }
        Ok(entries)
    })
    .await
}

#[command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    path: String,
    reference: String,
) -> Result<(), String> {
    wrap_cmd("git_stash_apply", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_stash_ref(&reference)?;
        run_git(&path, &["stash", "apply", &reference]).await.map(|_| ())
    })
    .await
}

#[command]
pub async fn git_stash_pop(
    state: State<'_, AppState>,
    path: String,
    reference: String,
) -> Result<(), String> {
    wrap_cmd("git_stash_pop", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_stash_ref(&reference)?;
        run_git(&path, &["stash", "pop", &reference]).await.map(|_| ())
    })
    .await
}

#[command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    path: String,
    reference: String,
) -> Result<(), String> {
    wrap_cmd("git_stash_drop", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_stash_ref(&reference)?;
        run_git(&path, &["stash", "drop", &reference]).await.map(|_| ())
    })
    .await
}

#[command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    path: String,
    branch: String,
) -> Result<(), String> {
    wrap_cmd("checkout_branch", async move {
        validate_path_is_trusted(&state, &path).await?;
        // Defense against arg injection - branch names cannot start with '-' and
        // cannot contain characters git disallows for refs anyway, but we're extra
        // strict with a conservative allowlist.
        if branch.is_empty() || branch.starts_with('-') {
            return Err("Invalid branch name".to_string());
        }
        if branch.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^' || c == ':' || c == '?' || c == '*' || c == '[') {
            return Err("Invalid branch name".to_string());
        }
        let output = git_cmd_async(&["checkout", &branch])
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // git checkout failure is a user/environment condition (dirty tree,
            // unknown branch, etc.) — surface to UI but skip telemetry.
            return Err(error_reporter::user_err(
                if !stderr.is_empty() { stderr } else { stdout },
            ));
        }
        Ok(())
    })
    .await
}

#[command]
pub async fn create_worktree(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
    branch: String,
    create_branch: bool,
) -> Result<WorktreeInfo, String> {
    wrap_cmd("create_worktree", async move {
        validate_path_is_trusted(&state, &repo_path).await?;

        // Validate worktree_path doesn't contain null bytes or traversal
        if worktree_path.contains('\0') || worktree_path.contains("..") {
            return Err("Invalid worktree path".to_string());
        }
        // Validate branch name
        let branch_regex = regex::Regex::new(r"^[a-zA-Z0-9_./-]+$")
            .map_err(|e| e.to_string())?;
        if !branch_regex.is_match(&branch) {
            return Err("Invalid branch name. Use only letters, numbers, dots, hyphens, underscores, and slashes.".to_string());
        }

        let output = if create_branch {
            git_cmd_async(&["worktree", "add", "-b", &branch, &worktree_path])
                .current_dir(&repo_path)
                .output()
                .await
        } else {
            git_cmd_async(&["worktree", "add", &worktree_path, &branch])
                .current_dir(&repo_path)
                .output()
                .await
        };

        let output = output.map_err(|e| format!("Failed to create worktree: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            // Branch already exists / worktree path taken / dirty index — user-caused.
            return Err(error_reporter::user_err(stderr));
        }

        // Return the new worktree info by listing and finding the new one
        let worktrees = list_worktrees_internal(&repo_path).await?;
        let normalized_path = std::path::PathBuf::from(&worktree_path);
        let canonical = normalized_path.canonicalize().ok();

        worktrees
            .into_iter()
            .find(|wt| {
                let wt_canon = std::path::PathBuf::from(&wt.path).canonicalize().ok();
                match (&canonical, &wt_canon) {
                    (Some(a), Some(b)) => a == b,
                    _ => wt.path == worktree_path,
                }
            })
            .ok_or_else(|| "Worktree created but not found in list".to_string())
    })
    .await
}

#[command]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    wrap_cmd("remove_worktree", async move {
        validate_path_is_trusted(&state, &repo_path).await?;

        // Validate worktree_path doesn't contain null bytes or traversal
        if worktree_path.contains('\0') || worktree_path.contains("..") {
            return Err("Invalid worktree path".to_string());
        }
        let args = if force {
            vec!["worktree", "remove", "--force", &worktree_path]
        } else {
            vec!["worktree", "remove", &worktree_path]
        };

        let output = git_cmd_async(&args)
            .current_dir(&repo_path)
            .output()
            .await
            .map_err(|e| format!("Failed to remove worktree: {}", e))?;

        if !output.status.success() {
            // Worktree still has uncommitted changes / already gone — user-caused.
            return Err(error_reporter::user_err(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        Ok(())
    })
    .await
}

// Session history commands

#[command]
pub async fn get_session_history(
    state: State<'_, AppState>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    wrap_cmd("get_session_history", async move {
        db_op(&state.db, |db| db.get_session_history()).await
    })
    .await
}

#[command]
pub async fn read_log_file(path: String) -> Result<String, String> {
    wrap_cmd("read_log_file", async move {
        // Validate path is under the logs directory
        let data_dir = directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
            .ok_or("Failed to get project directories")?
            .data_dir()
            .to_path_buf();
        let logs_dir = data_dir.join("logs");
        let canonical_path = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| format!("Invalid path: {}", e))?;
        tokio::fs::create_dir_all(&logs_dir).await.map_err(|e| format!("Failed to create logs directory: {}", e))?;
        let canonical_logs = tokio::fs::canonicalize(&logs_dir)
            .await
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Err(error_reporter::user_err("Access denied: path is not under logs directory"));
        }
        // Cap at 2 MB - prevents DoS via huge/symlinked logs and matches
        // what the UI can reasonably render in a single read.
        const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
        let bytes = tokio::fs::read(&canonical_path).await.map_err(|e| format!("Failed to read log file: {}", e))?;
        let slice = if bytes.len() > MAX_LOG_BYTES {
            &bytes[bytes.len() - MAX_LOG_BYTES..]
        } else {
            &bytes[..]
        };
        Ok(String::from_utf8_lossy(slice).into_owned())
    })
    .await
}

#[command]
pub async fn delete_session_history(
    state: State<'_, AppState>,
    id: i64,
    log_path: Option<String>,
) -> Result<(), String> {
    wrap_cmd("delete_session_history", async move {
        // Delete log file if it exists, but only if it's under the logs directory
        if let Some(ref path) = log_path {
            let data_dir = directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
                .ok_or("Failed to get project directories")?
                .data_dir()
                .to_path_buf();
            let logs_dir = data_dir.join("logs");
            let _ = tokio::fs::create_dir_all(&logs_dir).await;
            if let Ok(canonical_path) = tokio::fs::canonicalize(path).await {
                if let Ok(canonical_logs) = tokio::fs::canonicalize(&logs_dir).await {
                    if canonical_path.starts_with(&canonical_logs) {
                        let _ = tokio::fs::remove_file(&canonical_path).await;
                    }
                }
            }
        }
        db_op(&state.db, move |db| db.delete_session_history_entry(id)).await
    })
    .await
}

/// Retrieve the log content for a terminal from a previous session.
/// Looks up the most recent session_history entry for the given terminal_id,
/// reads the log file, and returns its content (capped at 512 KB).
#[command]
pub async fn get_session_log(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_session_log", async move {
        let tid_c = terminal_id.clone();
        let log_path = db_op(&state.db, move |db| db.get_log_path_for_terminal(&tid_c)).await?;

        let path = match log_path {
            Some(p) => p,
            None => return Ok(None),
        };

        // Validate path is under the logs directory
        let data_dir = directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
            .ok_or("Failed to get project directories")?
            .data_dir()
            .to_path_buf();
        let logs_dir = data_dir.join("logs");
        tokio::fs::create_dir_all(&logs_dir)
            .await
            .map_err(|e| format!("Failed to create logs directory: {}", e))?;

        let canonical_path = match tokio::fs::canonicalize(&path).await {
            Ok(p) => p,
            Err(_) => return Ok(None), // Log file may have been deleted
        };
        let canonical_logs = tokio::fs::canonicalize(&logs_dir)
            .await
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Ok(None);
        }

        // Read the last 512 KB via seek. The old code loaded the whole file
        // then sliced the tail, which allocated the entire log — 500 MB logs
        // would pin 500 MB per call. Now we seek to len - 512 KB and read
        // only the tail.
        const MAX_BYTES: u64 = 512 * 1024;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = match tokio::fs::File::open(&canonical_path).await {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };
        let len = match file.metadata().await {
            Ok(m) => m.len(),
            Err(_) => return Ok(None),
        };
        if len > MAX_BYTES
            && file
                .seek(std::io::SeekFrom::Start(len - MAX_BYTES))
                .await
                .is_err()
        {
            return Ok(None);
        }
        let mut bytes = Vec::with_capacity(len.min(MAX_BYTES) as usize);
        if file.read_to_end(&mut bytes).await.is_err() {
            return Ok(None);
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    })
    .await
}

// Snippet commands

#[command]
pub async fn save_snippet(
    state: State<'_, AppState>,
    snippet: Snippet,
) -> Result<(), String> {
    wrap_cmd("save_snippet", async move {
        db_op(&state.db, move |db| db.save_snippet(&snippet)).await
    })
    .await
}

#[command]
pub async fn get_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    wrap_cmd("get_snippets", async move {
        db_op(&state.db, |db| db.get_snippets()).await
    })
    .await
}

#[command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_snippet", async move {
        db_op(&state.db, move |db| db.delete_snippet(&id)).await
    })
    .await
}

// Claude Global Configuration (~/.claude/)

/// Returns the path to the user's ~/.claude directory
fn get_claude_dir() -> Result<std::path::PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?
    } else {
        std::env::var("HOME").map_err(|_| "HOME not set".to_string())?
    };
    Ok(std::path::Path::new(&home).join(".claude"))
}

/// Validates that a filename is safe (no path traversal)
fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err("Invalid filename".to_string());
    }
    Ok(())
}

/// Maximum size for ~/.claude/settings.json - 1 MB is generous for a JSON config
/// and prevents a compromised renderer (or malformed file) from exhausting memory.
const MAX_CLAUDE_SETTINGS_BYTES: u64 = 1024 * 1024;

#[command]
pub async fn read_claude_settings() -> Result<String, String> {
    wrap_cmd("read_claude_settings", async move {
        let settings_path = get_claude_dir()?.join("settings.json");
        if !settings_path.exists() {
            return Ok("{}".to_string());
        }
        let meta = tokio::fs::metadata(&settings_path)
            .await
            .map_err(|e| format!("Failed to stat settings.json: {}", e))?;
        if meta.len() > MAX_CLAUDE_SETTINGS_BYTES {
            return Err(error_reporter::user_err(format!(
                "settings.json is larger than allowed maximum ({} bytes)",
                MAX_CLAUDE_SETTINGS_BYTES
            )));
        }
        tokio::fs::read_to_string(&settings_path)
            .await
            .map_err(|e| format!("Failed to read settings.json: {}", e))
    })
    .await
}

#[command]
pub async fn write_claude_settings(content: String) -> Result<(), String> {
    wrap_cmd("write_claude_settings", async move {
        if content.len() as u64 > MAX_CLAUDE_SETTINGS_BYTES {
            return Err(format!(
                "settings content exceeds maximum size ({} bytes)",
                MAX_CLAUDE_SETTINGS_BYTES
            ));
        }
        // Validate it's valid JSON
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
        let claude_dir = get_claude_dir()?;
        tokio::fs::create_dir_all(&claude_dir).await.map_err(|e| e.to_string())?;
        tokio::fs::write(claude_dir.join("settings.json"), &content)
            .await
            .map_err(|e| format!("Failed to write settings.json: {}", e))
    })
    .await
}

#[command]
pub async fn list_claude_agents() -> Result<Vec<String>, String> {
    wrap_cmd("list_claude_agents", async move {
        let agents_dir = get_claude_dir()?.join("agents");
        if !agents_dir.exists() {
            return Ok(vec![]);
        }
        // read_dir + is_file() + file_name() is cheap sync work; wrap the
        // whole listing in spawn_blocking rather than pulling in tokio_stream.
        let agents_dir_cloned = agents_dir.clone();
        let names = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
            let entries = std::fs::read_dir(&agents_dir_cloned).map_err(|e| e.to_string())?;
            let mut names: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().to_str().map(String::from))
                .collect();
            names.sort();
            Ok(names)
        })
        .await
        .map_err(|e| format!("List agents task failed: {}", e))??;
        Ok(names)
    })
    .await
}

#[command]
pub async fn read_claude_agent(name: String) -> Result<String, String> {
    wrap_cmd("read_claude_agent", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("agents").join(&name);
        if !path.exists() {
            return Err(error_reporter::user_err(format!("Agent file not found: {}", name)));
        }
        tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn write_claude_agent(name: String, content: String) -> Result<(), String> {
    wrap_cmd("write_claude_agent", async move {
        validate_filename(&name)?;
        let agents_dir = get_claude_dir()?.join("agents");
        tokio::fs::create_dir_all(&agents_dir).await.map_err(|e| e.to_string())?;
        tokio::fs::write(agents_dir.join(&name), &content).await.map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn delete_claude_agent(name: String) -> Result<(), String> {
    wrap_cmd("delete_claude_agent", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("agents").join(&name);
        if path.exists() {
            tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[command]
pub async fn list_claude_commands() -> Result<Vec<String>, String> {
    wrap_cmd("list_claude_commands", async move {
        let commands_dir = get_claude_dir()?.join("commands");
        if !commands_dir.exists() {
            return Ok(vec![]);
        }
        let commands_dir_cloned = commands_dir.clone();
        let names = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
            let entries = std::fs::read_dir(&commands_dir_cloned).map_err(|e| e.to_string())?;
            let mut names: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().to_str().map(String::from))
                .collect();
            names.sort();
            Ok(names)
        })
        .await
        .map_err(|e| format!("List commands task failed: {}", e))??;
        Ok(names)
    })
    .await
}

#[command]
pub async fn read_claude_command(name: String) -> Result<String, String> {
    wrap_cmd("read_claude_command", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("commands").join(&name);
        if !path.exists() {
            return Err(error_reporter::user_err(format!("Command file not found: {}", name)));
        }
        tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn write_claude_command(name: String, content: String) -> Result<(), String> {
    wrap_cmd("write_claude_command", async move {
        validate_filename(&name)?;
        let commands_dir = get_claude_dir()?.join("commands");
        tokio::fs::create_dir_all(&commands_dir).await.map_err(|e| e.to_string())?;
        tokio::fs::write(commands_dir.join(&name), &content).await.map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn delete_claude_command(name: String) -> Result<(), String> {
    wrap_cmd("delete_claude_command", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("commands").join(&name);
        if path.exists() {
            tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

// Telemetry commands

#[command]
pub async fn get_installation_id(state: State<'_, AppState>) -> Result<String, String> {
    wrap_cmd("get_installation_id", async move {
        db_op(&state.db, |db| db.get_or_create_installation_id()).await
    })
    .await
}

#[command]
pub async fn send_telemetry_heartbeat(
    state: State<'_, AppState>,
    enabled: bool,
    app_version: String,
) -> Result<(), String> {
    wrap_cmd("send_telemetry_heartbeat", async move {
        if !enabled {
            return Ok(());
        }
        let installation_id = db_op(&state.db, |db| db.get_or_create_installation_id()).await?;
        tokio::spawn(crate::telemetry::send_heartbeat(installation_id, app_version));
        Ok(())
    })
    .await
}

// Session summary commands

#[command]
pub async fn summarize_session(log_path: String) -> Result<Option<String>, String> {
    wrap_cmd("summarize_session", async move {
        // Validate path is under the logs directory
        let data_dir = directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
            .ok_or("Failed to get project directories")?
            .data_dir()
            .to_path_buf();
        let logs_dir = data_dir.join("logs");
        tokio::fs::create_dir_all(&logs_dir).await.map_err(|e| format!("Failed to create logs directory: {}", e))?;

        let canonical_path = match tokio::fs::canonicalize(&log_path).await {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };
        let canonical_logs = tokio::fs::canonicalize(&logs_dir)
            .await
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Err(error_reporter::user_err("Access denied: path is not under logs directory"));
        }

        // Read log file content (capped at 100KB)
        let bytes = match tokio::fs::read(&canonical_path).await {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let max_bytes = 100 * 1024;
        let truncated = if bytes.len() > max_bytes {
            &bytes[bytes.len() - max_bytes..]
        } else {
            &bytes
        };
        let log_content = String::from_utf8_lossy(truncated);

        // Strip ANSI escape sequences. Compile the pattern once — this handler
        // is called on every terminal-finished event, and recompiling a 3-alt
        // regex per call was a real per-call cost.
        static ANSI_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let ansi_re = ANSI_RE.get_or_init(|| {
            regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[A-Za-z]").unwrap()
        });
        let clean_content = ansi_re.replace_all(&log_content, "").to_string();

        if clean_content.trim().is_empty() {
            return Ok(None);
        }

        // Run claude -p to summarize. Use tokio::process so we can bound the
        // wait: a hung `claude -p` (network stall, model timeout) would
        // otherwise block a tokio worker forever. `kill_on_drop(true)` means
        // dropping the child on timeout also terminates the process.
        use std::time::Duration;
        use tokio::io::AsyncWriteExt;
        let mut cmd: tokio::process::Command = shell_command(
            "claude",
            &["-p", "--model", "haiku", "Summarize what was accomplished in this terminal session in 2-3 bullet points. Be concise."],
        ).into();
        cmd.kill_on_drop(true);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Ok(None), // Claude Code not available
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(clean_content.as_bytes()).await;
            // Closing the pipe signals EOF so claude can finish reading.
            drop(stdin);
        }

        // 60s cap: haiku on a 100 KB log typically completes in <20s; longer
        // means it's stuck. Timeout returns Ok(None) — the UI treats "no
        // summary" as a silent skip, which is the right behaviour on hang.
        let output = match tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await {
            Ok(Ok(o)) => o,
            Ok(Err(_)) | Err(_) => return Ok(None),
        };

        if !output.status.success() {
            return Ok(None);
        }

        let summary = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if summary.is_empty() {
            return Ok(None);
        }

        Ok(Some(summary))
    })
    .await
}

#[command]
pub async fn save_session_summary(
    state: State<'_, AppState>,
    terminal_id: String,
    summary: String,
) -> Result<(), String> {
    wrap_cmd("save_session_summary", async move {
        db_op(&state.db, move |db| db.save_session_summary(&terminal_id, &summary)).await
    })
    .await
}

#[command]
pub async fn get_session_summary(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_session_summary", async move {
        db_op(&state.db, move |db| db.get_session_summary(&terminal_id)).await
    })
    .await
}

// Team tasks command

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub subject: String,
    pub status: String,
    pub owner: Option<String>,
    pub blocked_by: Vec<String>,
    pub active_form: Option<String>,
}

#[command]
pub async fn get_team_tasks(team_name: String) -> Result<Vec<TaskInfo>, String> {
    wrap_cmd("get_team_tasks", async move {
        // Validate team_name doesn't contain path traversal
        if team_name.contains('/') || team_name.contains('\\') || team_name.contains("..") || team_name.contains('\0') {
            return Err("Invalid team name".to_string());
        }

        let home = if cfg!(target_os = "windows") {
            std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?
        } else {
            std::env::var("HOME").map_err(|_| "HOME not set".to_string())?
        };

        let tasks_dir = std::path::Path::new(&home)
            .join(".claude")
            .join("tasks")
            .join(&team_name);

        if !tasks_dir.exists() {
            return Ok(vec![]);
        }

        // read_dir + per-file read_to_string + JSON parse for every task file
        // — off-runtime so a directory with hundreds of tasks doesn't stall
        // other IPC.
        let tasks = tokio::task::spawn_blocking(move || -> Result<Vec<TaskInfo>, String> {
            let entries = std::fs::read_dir(&tasks_dir).map_err(|e| e.to_string())?;
            let mut tasks = Vec::new();

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }

                // Skip .highwatermark and non-JSON files
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || !name.ends_with(".json") {
                    continue;
                }

                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let val: serde_json::Value = match serde_json::from_str(&content) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let subject = val.get("subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let status = val.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string();
                let owner = val.get("owner").and_then(|v| v.as_str()).map(String::from);
                let active_form = val.get("activeForm").and_then(|v| v.as_str()).map(String::from);
                let blocked_by: Vec<String> = val.get("blockedBy")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();

                if !id.is_empty() {
                    tasks.push(TaskInfo {
                        id,
                        subject,
                        status,
                        owner,
                        blocked_by,
                        active_form,
                    });
                }
            }

            // Sort by id
            tasks.sort_by(|a, b| a.id.cmp(&b.id));
            Ok(tasks)
        })
        .await
        .map_err(|e| format!("get_team_tasks task failed: {}", e))??;

        Ok(tasks)
    })
    .await
}

// Memory & CLAUDE.md commands

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileInfo {
    pub path: String,
    pub name: String,
    pub project: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdInfo {
    pub path: String,
    pub scope: String,
    pub project_name: Option<String>,
}

/// Validates that a path is under ~/.claude/
/// Rejects traversal components (`..`, `\0`) and resolves against the canonical
/// parent directory so not-yet-existing files still get a real containment check.
fn validate_claude_path(path: &str) -> Result<(), String> {
    let target = std::path::Path::new(path);

    // Reject path traversal and null-byte components explicitly. canonicalize()
    // collapses `..` but only when the full path exists, so we also need a
    // structural check for write paths that don't exist yet.
    if path.contains('\0') {
        return Err("Invalid path: null byte".to_string());
    }
    for comp in target.components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("Invalid path: parent directory traversal not allowed".to_string());
        }
    }

    let claude_dir = get_claude_dir()?;
    let canonical_claude = claude_dir
        .canonicalize()
        .unwrap_or_else(|_| claude_dir.clone());

    // If the target exists, canonicalize resolves symlinks - strongest check.
    // Otherwise fall back to canonicalizing the nearest existing ancestor and
    // re-appending the remaining components (prevents bypass when the file
    // is about to be created).
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let mut ancestor = target.to_path_buf();
            let mut tail: Vec<std::ffi::OsString> = Vec::new();
            loop {
                if ancestor.exists() {
                    break;
                }
                match ancestor.file_name() {
                    Some(name) => tail.push(name.to_os_string()),
                    None => return Err("Invalid path: cannot resolve".to_string()),
                }
                if !ancestor.pop() {
                    return Err("Invalid path: cannot resolve".to_string());
                }
            }
            let mut resolved = ancestor
                .canonicalize()
                .map_err(|e| format!("Invalid path: {}", e))?;
            for name in tail.into_iter().rev() {
                resolved.push(name);
            }
            resolved
        }
    };

    if !canonical_target.starts_with(&canonical_claude) {
        return Err("Access denied: path is not under ~/.claude/".to_string());
    }
    Ok(())
}

#[command]
pub async fn list_memory_files(project_path: Option<String>) -> Result<Vec<MemoryFileInfo>, String> {
    wrap_cmd("list_memory_files", async move {
        let claude_dir = get_claude_dir()?;
        let projects_dir = claude_dir.join("projects");

        if !projects_dir.exists() {
            return Ok(vec![]);
        }

        // Validate the specific-project path before entering the blocking task
        // so the validation error (not-under-.claude) surfaces synchronously.
        if let Some(ref specific_project) = project_path {
            validate_claude_path(specific_project)?;
        }

        // Nested read_dir + per-file metadata for every project — off-runtime.
        let files = tokio::task::spawn_blocking(move || -> Vec<MemoryFileInfo> {
            let mut files = Vec::new();
            let scan_project = |project_dir: &std::path::Path, files: &mut Vec<MemoryFileInfo>| {
                let memory_dir = project_dir.join("memory");
                if !memory_dir.exists() || !memory_dir.is_dir() {
                    return;
                }
                let project_name = project_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                if let Ok(entries) = std::fs::read_dir(&memory_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                            files.push(MemoryFileInfo {
                                path: path.to_string_lossy().to_string(),
                                name,
                                project: project_name.clone(),
                                size,
                            });
                        }
                    }
                }
            };

            if let Some(ref specific_project) = project_path {
                let target = std::path::Path::new(specific_project);
                if target.exists() && target.is_dir() {
                    scan_project(target, &mut files);
                }
            } else {
                // Scan all projects
                if let Ok(entries) = std::fs::read_dir(&projects_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            scan_project(&path, &mut files);
                        }
                    }
                }
            }
            files
        })
        .await
        .map_err(|e| format!("list_memory_files task failed: {}", e))?;

        Ok(files)
    })
    .await
}

#[command]
pub async fn read_memory_file(path: String) -> Result<String, String> {
    wrap_cmd("read_memory_file", async move {
        validate_claude_path(&path)?;
        tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read memory file: {}", e))
    })
    .await
}

#[command]
pub async fn write_memory_file(path: String, content: String) -> Result<(), String> {
    wrap_cmd("write_memory_file", async move {
        validate_claude_path(&path)?;
        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(&path).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&path, &content)
            .await
            .map_err(|e| format!("Failed to write memory file: {}", e))
    })
    .await
}

#[command]
pub async fn list_claude_md_files() -> Result<Vec<ClaudeMdInfo>, String> {
    wrap_cmd("list_claude_md_files", async move {
        let mut files = Vec::new();
        let claude_dir = get_claude_dir()?;

        // Global ~/.claude/CLAUDE.md
        let global_md = claude_dir.join("CLAUDE.md");
        if global_md.exists() {
            files.push(ClaudeMdInfo {
                path: global_md.to_string_lossy().to_string(),
                scope: "global".to_string(),
                project_name: None,
            });
        }

        // Project-level CLAUDE.md files in ~/.claude/projects/*/ — off-runtime.
        let projects_dir = claude_dir.join("projects");
        if projects_dir.exists() {
            let more = tokio::task::spawn_blocking(move || -> Vec<ClaudeMdInfo> {
                let mut out = Vec::new();
                if let Ok(entries) = std::fs::read_dir(&projects_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let md_path = path.join("CLAUDE.md");
                            if md_path.exists() {
                                let project_name = entry.file_name().to_string_lossy().to_string();
                                out.push(ClaudeMdInfo {
                                    path: md_path.to_string_lossy().to_string(),
                                    scope: "project".to_string(),
                                    project_name: Some(project_name),
                                });
                            }
                        }
                    }
                }
                out
            })
            .await
            .map_err(|e| format!("list_claude_md_files task failed: {}", e))?;
            files.extend(more);
        }

        Ok(files)
    })
    .await
}

// Agent Teams (multi-agent orchestration)

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub agent_id: String,
    pub name: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub joined_at: Option<u64>,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub name: String,
    pub description: Option<String>,
    pub created_at: Option<u64>,
    pub lead_agent_id: Option<String>,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub dir_name: String,
    pub config: TeamConfig,
    pub task_count: Option<u32>,
}

#[command]
pub async fn get_active_teams() -> Result<Vec<TeamInfo>, String> {
    wrap_cmd("get_active_teams", async move {
        let home = if cfg!(target_os = "windows") {
            std::env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?
        } else {
            std::env::var("HOME").map_err(|_| "HOME not set".to_string())?
        };

        let teams_dir = std::path::Path::new(&home).join(".claude").join("teams");
        if !teams_dir.exists() {
            return Ok(vec![]);
        }

        // Teams walk: read_dir + read_to_string (config.json) + read_to_string
        // (.highwatermark) + JSON parse for every team. Off-runtime.
        let home_cloned = home.clone();
        let teams = tokio::task::spawn_blocking(move || -> Result<Vec<TeamInfo>, String> {
            let entries = std::fs::read_dir(&teams_dir).map_err(|e| e.to_string())?;
            let mut teams = Vec::new();

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                let config_path = path.join("config.json");
                if !config_path.exists() {
                    continue;
                }

                let config_str = match std::fs::read_to_string(&config_path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let config: TeamConfig = match serde_json::from_str(&config_str) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let dir_name = entry.file_name().to_string_lossy().to_string();

                // Read task count from .highwatermark
                let tasks_dir = std::path::Path::new(&home_cloned)
                    .join(".claude")
                    .join("tasks")
                    .join(&dir_name);
                let hwm_path = tasks_dir.join(".highwatermark");
                let task_count = std::fs::read_to_string(&hwm_path)
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());

                teams.push(TeamInfo {
                    dir_name,
                    config,
                    task_count,
                });
            }
            Ok(teams)
        })
        .await
        .map_err(|e| format!("get_active_teams task failed: {}", e))??;

        Ok(teams)
    })
    .await
}

// ─── Git repo scan (sidebar Git panel) ────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ScannedGitRepo {
    pub path: String,
    pub relative_path: String,
    pub branch: Option<String>,
    pub is_worktree: bool,
    pub is_main_repo: bool,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
}

fn git_branch_for(path: &std::path::Path) -> Option<String> {
    let out = git_command(&["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b == "HEAD" || b.is_empty() { None } else { Some(b) }
}

fn git_is_worktree(path: &std::path::Path) -> bool {
    let git_dir = git_command(&["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let common = git_command(&["rev-parse", "--git-common-dir"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match (git_dir, common) {
        (Some(d), Some(c)) => {
            let dc = std::path::PathBuf::from(&d).canonicalize().ok();
            let cc = std::path::PathBuf::from(&c).canonicalize().ok();
            match (dc, cc) { (Some(a), Some(b)) => a != b, _ => d != c }
        }
        _ => false,
    }
}

fn git_dirty(path: &std::path::Path) -> bool {
    git_command(&["status", "--porcelain"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

fn git_ahead_behind(path: &std::path::Path) -> (u32, u32) {
    // rev-list --count --left-right HEAD...@{u}   → "ahead\tbehind"
    let out = git_command(&["rev-list", "--count", "--left-right", "HEAD...@{u}"])
        .current_dir(path)
        .output();
    let Ok(out) = out else { return (0, 0); };
    if !out.status.success() { return (0, 0); }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut parts = s.split_whitespace();
    let a: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let b: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (a, b)
}

const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules", "target", ".git", "dist", "build", "out",
    ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__",
    ".idea", ".vscode", "vendor",
];

fn scan_for_repos(
    root: &std::path::Path,
    current: &std::path::Path,
    depth: u32,
    max_depth: u32,
    results: &mut Vec<ScannedGitRepo>,
    limit: usize,
) {
    if results.len() >= limit { return; }
    if depth > max_depth { return; }

    // Is `current` itself a git repo?
    let dot_git = current.join(".git");
    if dot_git.exists() {
        let branch = git_branch_for(current);
        let is_wt = git_is_worktree(current);
        let dirty = git_dirty(current);
        let (ahead, behind) = git_ahead_behind(current);
        let rel = current.strip_prefix(root).unwrap_or(current).to_string_lossy().to_string();
        let relative_path = if rel.is_empty() { ".".to_string() } else { rel };
        let is_main = current == root;
        results.push(ScannedGitRepo {
            path: current.to_string_lossy().to_string(),
            relative_path,
            branch,
            is_worktree: is_wt,
            is_main_repo: is_main,
            dirty,
            ahead,
            behind,
        });
        // Don't descend into a repo's own directory when looking for *nested*
        // repos - a nested repo is one whose parent is not itself a repo root.
        // Allow descent only for the root itself so we can find sub-repos
        // embedded as submodules or siblings.
        if !is_main { return; }
    }

    let Ok(entries) = std::fs::read_dir(current) else { return; };
    for entry in entries.flatten() {
        if results.len() >= limit { return; }
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') && name != ".git" { continue; }
        if SCAN_SKIP_DIRS.iter().any(|s| *s == name) { continue; }
        scan_for_repos(root, &path, depth + 1, max_depth, results, limit);
    }
}

#[command]
pub async fn scan_git_repos(
    state: State<'_, AppState>,
    root_path: String,
) -> Result<Vec<ScannedGitRepo>, String> {
    wrap_cmd("scan_git_repos", async move {
        validate_path_is_trusted(&state, &root_path).await?;
        let root = std::path::Path::new(&root_path)
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;
        // The recursive walk fires ~4 sync git subprocesses per directory. Doing
        // that on a runtime worker starves other IPC (terminal-output delivery
        // stalls). spawn_blocking sends the whole walk to the blocking pool.
        // Making the recursive helpers async instead would require boxed
        // futures at every recursion — this is simpler and equivalent.
        let results = tokio::task::spawn_blocking(move || {
            let mut results = Vec::new();
            // max_depth 4 handles common monorepo layouts (apps/x, packages/y/z)
            // limit 40 guards against runaway scans
            scan_for_repos(&root, &root, 0, 4, &mut results, 40);
            results
        })
        .await
        .map_err(|e| format!("Scan task failed: {}", e))?;
        Ok(results)
    })
    .await
}

// ─── Path-based variants for operating on nested / selected repos ───────────

#[command]
pub async fn get_path_changes(
    state: State<'_, AppState>,
    path: String,
) -> Result<FileChangesResult, String> {
    wrap_cmd("get_path_changes", async move {
        validate_path_is_trusted(&state, &path).await?;

        let branch_output = git_cmd_async(&["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output()
            .await;

        let (is_git_repo, branch) = match branch_output {
            Ok(output) if output.status.success() => {
                let b = String::from_utf8_lossy(&output.stdout).trim().to_string();
                (true, Some(b))
            }
            _ => (false, None),
        };

        if !is_git_repo {
            return Ok(FileChangesResult {
                terminal_id: String::new(),
                working_directory: path,
                repo_root: None,
                changes: vec![],
                is_git_repo: false,
                branch: None,
                error: None,
            });
        }

        let repo_root = resolve_repo_root(&path).await.ok();

        let status_output = git_cmd_async(&["status", "--porcelain"])
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        if !status_output.status.success() {
            return Ok(FileChangesResult {
                terminal_id: String::new(),
                working_directory: path,
                repo_root,
                changes: vec![],
                is_git_repo: true,
                branch,
                error: Some(String::from_utf8_lossy(&status_output.stderr).trim().to_string()),
            });
        }

        let stdout = String::from_utf8_lossy(&status_output.stdout);
        let mut changes: Vec<FileChange> = Vec::new();
        for line in stdout.lines() {
            if line.len() < 3 { continue; }
            let x = line.as_bytes().get(0).copied().unwrap_or(b' ') as char;
            let y = line.as_bytes().get(1).copied().unwrap_or(b' ') as char;
            let raw_path = &line[3..];
            let fpath = if raw_path.contains(" -> ") {
                raw_path.split(" -> ").nth(1).unwrap_or(raw_path).to_string()
            } else {
                raw_path.to_string()
            };

            if x == '?' && y == '?' {
                changes.push(FileChange { path: fpath, status: "untracked".into(), staged: false });
                continue;
            }

            let map_code = |c: char| match c {
                'A' => "new",
                'M' => "modified",
                'D' => "deleted",
                'R' => "renamed",
                'C' => "new",
                'U' => "modified",
                'T' => "modified",
                _ => "",
            };

            if x != ' ' && x != '?' {
                let status = map_code(x);
                if !status.is_empty() {
                    changes.push(FileChange { path: fpath.clone(), status: status.into(), staged: true });
                }
            }
            if y != ' ' && y != '?' {
                let status = map_code(y);
                if !status.is_empty() {
                    changes.push(FileChange { path: fpath, status: status.into(), staged: false });
                }
            }
        }

        Ok(FileChangesResult {
            terminal_id: String::new(),
            working_directory: path,
            repo_root,
            changes,
            is_git_repo: true,
            branch,
            error: None,
        })
    })
    .await
}

#[command]
pub async fn get_path_file_diff(
    state: State<'_, AppState>,
    path: String,
    file_path: String,
    staged: bool,
) -> Result<FileDiffResult, String> {
    wrap_cmd("get_path_file_diff", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_git_pathspec(&file_path)?;
        // `file_path` is repo-root-relative (porcelain output) - resolve against
        // the root in case `path` is a subdirectory of the repo.
        let path = resolve_repo_root(&path).await?;

        let status_output = git_cmd_async(&["status", "--porcelain", "--", &file_path])
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        let status_str = String::from_utf8_lossy(&status_output.stdout).trim().to_string();
        let file_status = if status_str.len() >= 2 {
            status_str[..2].trim().to_string()
        } else {
            String::new()
        };

        let is_new_file = file_status == "??" || file_status == "A";
        let is_deleted_file = file_status == "D";

        let diff_text = if is_new_file {
            let full_path = std::path::Path::new(&path).join(&file_path);
            build_new_file_diff(&full_path, &file_path).await
        } else if is_deleted_file {
            let show_output = git_cmd_async(&["show", &format!("HEAD:{}", file_path)])
                .current_dir(&path)
                .output()
                .await;
            match show_output {
                Ok(output) if output.status.success() => {
                    let content = String::from_utf8_lossy(&output.stdout);
                    let lines: Vec<String> = content.lines().map(|line| format!("-{}", line)).collect();
                    format!(
                        "--- a/{}\n+++ /dev/null\n@@ -1,{} +0,0 @@\n{}",
                        file_path,
                        lines.len(),
                        lines.join("\n")
                    )
                }
                _ => String::from("Unable to read deleted file contents"),
            }
        } else {
            let mut args = vec!["diff"];
            if staged { args.push("--cached"); }
            args.push("--");
            args.push(&file_path);

            let diff_output = git_cmd_async(&args)
                .current_dir(&path)
                .output()
                .await
                .map_err(|e| format!("Failed to run git diff: {}", e))?;

            let text = String::from_utf8_lossy(&diff_output.stdout).to_string();
            if text.trim().is_empty() && !staged {
                let staged_output = git_cmd_async(&["diff", "--cached", "--", &file_path])
                    .current_dir(&path)
                    .output()
                    .await
                    .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;
                String::from_utf8_lossy(&staged_output.stdout).to_string()
            } else {
                text
            }
        };

        let is_binary = diff_text.contains("Binary files") && diff_text.contains("differ");

        Ok(FileDiffResult {
            file_path,
            diff_text,
            is_new_file,
            is_deleted_file,
            is_binary,
        })
    })
    .await
}

#[command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    path: String,
    name: String,
    base: Option<String>,
) -> Result<(), String> {
    wrap_cmd("git_create_branch", async move {
        validate_path_is_trusted(&state, &path).await?;

        let reject_bad_ref = |s: &str, label: &str| -> Result<(), String> {
            if s.is_empty() || s.starts_with('-') {
                return Err(format!("Invalid {}", label));
            }
            if s.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^' || c == ':' || c == '?' || c == '*' || c == '[' || c == '\\') {
                return Err(format!("Invalid {}", label));
            }
            Ok(())
        };
        reject_bad_ref(&name, "branch name")?;
        if let Some(b) = base.as_deref() {
            reject_bad_ref(b, "base ref")?;
        }

        let mut args: Vec<&str> = vec!["checkout", "-b", &name];
        if let Some(b) = base.as_deref() {
            args.push(b);
        }

        let output = git_cmd_async(&args)
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(error_reporter::user_err(
                if !stderr.is_empty() { stderr } else { stdout },
            ));
        }
        Ok(())
    })
    .await
}

#[command]
pub async fn get_repo_remote_refs(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    wrap_cmd("get_repo_remote_refs", async move {
        validate_path_is_trusted(&state, &path).await?;
        let out = run_git(&path, &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/",
        ])
        .await?;
        let mut refs: Vec<String> = out
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
            .collect();
        refs.sort();
        Ok(refs)
    })
    .await
}

#[command]
pub async fn get_upstream_branch(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_upstream_branch", async move {
        validate_path_is_trusted(&state, &path).await?;
        let output = git_cmd_async(&[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git rev-parse: {}", e))?;
        if !output.status.success() {
            // No upstream configured - not an error, just absent
            return Ok(None);
        }
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if s.is_empty() { Ok(None) } else { Ok(Some(s)) }
    })
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PullStrategy {
    Merge,
    Rebase,
    FfOnly,
}

#[command]
pub async fn git_pull_branch(
    state: State<'_, AppState>,
    path: String,
    remote: String,
    branch: String,
    strategy: PullStrategy,
    auto_stash: Option<bool>,
) -> Result<String, String> {
    wrap_cmd("git_pull_branch", async move {
        validate_path_is_trusted(&state, &path).await?;

        let reject_bad_ref = |s: &str, label: &str| -> Result<(), String> {
            if s.is_empty() || s.starts_with('-') {
                return Err(format!("Invalid {}", label));
            }
            if s.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^' || c == ':' || c == '?' || c == '*' || c == '[' || c == '\\') {
                return Err(format!("Invalid {}", label));
            }
            Ok(())
        };
        reject_bad_ref(&remote, "remote")?;
        reject_bad_ref(&branch, "branch")?;

        // When the tree is dirty, refuse by default. If the caller opts in to
        // auto_stash, stash (including untracked) → pull → pop. Frontend uses
        // this for the "Stash & Pull" confirm flow.
        let auto_stash = auto_stash.unwrap_or(false);
        let dirty = run_git(&path, &["status", "--porcelain"]).await?;
        let is_dirty = !dirty.trim().is_empty();
        if is_dirty && !auto_stash {
            return Err(error_reporter::user_err(
                "Working tree has uncommitted changes - commit or stash first, then pull.",
            ));
        }

        let stashed = if is_dirty {
            let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
            let msg = format!("claude-terminal: auto-stash before pull {}", ts);
            run_git(&path, &["stash", "push", "-u", "-m", &msg]).await?;
            true
        } else {
            false
        };

        let mut args: Vec<&str> = vec!["pull"];
        match strategy {
            PullStrategy::Merge => {}
            PullStrategy::Rebase => args.push("--rebase"),
            PullStrategy::FfOnly => args.push("--ff-only"),
        }
        args.push("--");
        args.push(&remote);
        args.push(&branch);

        let output = git_cmd_async(&args)
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git pull: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            let pull_err = if !stderr.is_empty() { stderr } else { stdout };
            if stashed {
                // Restore the auto-stash so the user isn't left with both a failed
                // pull and an orphan stash. Best-effort - if pop conflicts, the
                // stash stays in the list and the user can recover manually.
                let _ = run_git(&path, &["stash", "pop"]).await;
                // Pull failures (conflicts, no upstream, network) are user/
                // environment conditions - surface to the UI, skip telemetry.
                return Err(error_reporter::user_err(format!(
                    "Pull failed; your changes were restored from auto-stash.\n\n{}",
                    pull_err
                )));
            }
            return Err(error_reporter::user_err(pull_err));
        }

        // Surface the combined output so the UI can show "Already up to date." or merge summary.
        let pull_combined = if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{}\n{}", stdout, stderr)
        };

        if stashed {
            let pop = git_cmd_async(&["stash", "pop"])
                .current_dir(&path)
                .output()
                .await
                .map_err(|e| format!("Failed to run git stash pop: {}", e))?;
            if !pop.status.success() {
                let pop_err = String::from_utf8_lossy(&pop.stderr).trim().to_string();
                // Pop conflicted. The stash stays applied with conflict markers,
                // and the stash entry remains in the list for safety. The user
                // resolves conflicts in-tree and then `git stash drop` manually.
                return Ok(format!(
                    "{}\n\nPull succeeded, but restoring your stashed changes hit conflicts - resolve them in the working tree, then run `git stash drop` once you're done.\n\n{}",
                    pull_combined, pop_err
                ));
            }
        }

        Ok(pull_combined)
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct PackageScript {
    pub name: String,
    pub command: String,
}

/// Read `package.json` at the given directory and return its `scripts` map as
/// an ordered list. Empty vec if no package.json exists or no scripts key.
#[command]
pub async fn list_package_scripts(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<Vec<PackageScript>, String> {
    wrap_cmd("list_package_scripts", async move {
        validate_path_is_trusted(&state, &cwd).await?;

        let pkg_path = std::path::Path::new(&cwd).join("package.json");
        let bytes = match tokio::fs::read(&pkg_path).await {
            Ok(b) => b,
            Err(_) => return Ok(vec![]), // no package.json → no scripts, not an error
        };
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid package.json: {}", e))?;
        let scripts = match json.get("scripts").and_then(|v| v.as_object()) {
            Some(m) => m,
            None => return Ok(vec![]),
        };
        let result: Vec<PackageScript> = scripts
            .iter()
            .filter_map(|(name, val)| {
                val.as_str().map(|command| PackageScript {
                    name: name.clone(),
                    command: command.to_string(),
                })
            })
            .collect();
        Ok(result)
    })
    .await
}

/// Spawn a child terminal that runs `npm run <script>` in the given cwd.
/// The returned terminal config has the same shape as `create_terminal` so
/// the frontend can reuse the regular terminal rendering pipeline.
#[command]
pub async fn create_script_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    script_name: String,
) -> Result<crate::terminal::TerminalConfig, String> {
    wrap_cmd("create_script_terminal", async move {
        validate_path_is_trusted(&state, &cwd).await?;

        let (tx, mut rx) = mpsc::channel::<(String, Vec<u8>)>(1000);

        let config = {
            let mut terminals = state.terminals.lock().await;
            terminals.create_script_terminal(
                format!("npm run {}", script_name),
                cwd,
                script_name,
                tx,
            )?
        };

        let terminal_id = config.id.clone();
        let terminals_arc = state.terminals.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some((id, data)) = rx.recv().await {
                if let Err(e) = app_clone.emit("terminal-output", serde_json::json!({
                    "id": id,
                    "data": data,
                })) {
                    eprintln!("Failed to emit terminal-output: {}", e);
                    error_reporter::report_bg(
                        "emit_terminal_output",
                        format!("Failed to emit terminal-output: {}", e),
                    );
                    break;
                }
            }
            {
                let mut manager = terminals_arc.lock().await;
                let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
            }
            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({ "id": terminal_id })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
                error_reporter::report_bg(
                    "emit_terminal_finished",
                    format!("Failed to emit terminal-finished: {}", e),
                );
            }
        });

        Ok(config)
    })
    .await
}

/// Spawn an interactive shell terminal at `cwd`. No claude. The terminal
/// behaves like create_terminal otherwise - emits `terminal-output` /
/// `terminal-finished` events and accepts input via `write_to_terminal`.
#[command]
pub async fn create_shell_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    cwd: String,
) -> Result<crate::terminal::TerminalConfig, String> {
    wrap_cmd("create_shell_terminal", async move {
        // Mirror create_terminal: trust the user-supplied cwd. The trust check
        // exists to prevent the renderer from probing arbitrary paths via git
        // commands, but spawning a shell IS the user's explicit action and the
        // shell has full FS access once spawned anyway.
        let (tx, mut rx) = mpsc::channel::<(String, Vec<u8>)>(1000);

        let config = {
            let mut terminals = state.terminals.lock().await;
            terminals.create_shell_terminal(label, cwd, tx)?
        };

        let terminal_id = config.id.clone();
        let terminals_arc = state.terminals.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some((id, data)) = rx.recv().await {
                if let Err(e) = app_clone.emit("terminal-output", serde_json::json!({
                    "id": id,
                    "data": data,
                })) {
                    eprintln!("Failed to emit terminal-output: {}", e);
                    error_reporter::report_bg(
                        "emit_terminal_output",
                        format!("Failed to emit terminal-output: {}", e),
                    );
                    break;
                }
            }
            {
                let mut manager = terminals_arc.lock().await;
                let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
            }
            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({ "id": terminal_id })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
                error_reporter::report_bg(
                    "emit_terminal_finished",
                    format!("Failed to emit terminal-finished: {}", e),
                );
            }
        });

        Ok(config)
    })
    .await
}

/// Return the HEAD version of a file as a string. Used by the diff editor to
/// show original vs current working copy. Returns an empty string if the file
/// has no HEAD version (e.g., newly-added or untracked).
#[command]
pub async fn get_git_head_content(
    state: State<'_, AppState>,
    path: String,
    file: String,
) -> Result<String, String> {
    wrap_cmd("get_git_head_content", async move {
        validate_path_is_trusted(&state, &path).await?;
        validate_git_pathspec(&file)?;
        if file.starts_with('-') {
            return Err(error_reporter::user_err("Invalid file path"));
        }
        // git uses forward slashes in ref specs, even on Windows.
        let normalized = file.replace('\\', "/");
        let spec = format!("HEAD:{}", normalized);
        let output = git_cmd_async(&["show", &spec])
            .current_dir(&path)
            .output()
            .await
            .map_err(|e| format!("Failed to run git show: {}", e))?;
        if !output.status.success() {
            // File has no HEAD version - treat as empty (new/untracked file).
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    })
    .await
}

/// Discard all changes to a single file: restores index + worktree to HEAD for
/// tracked files, deletes from disk for untracked files/dirs. Destructive.
#[command]
pub async fn git_discard_file(
    state: State<'_, AppState>,
    path: String,
    file: String,
    untracked: bool,
) -> Result<(), String> {
    wrap_cmd("git_discard_file", async move {
        validate_path_is_trusted(&state, &path).await?;
        if file.is_empty() || file.starts_with('-') {
            return Err(error_reporter::user_err("Invalid file path"));
        }
        // `file` is repo-root-relative (porcelain output) - resolve against the
        // root, not `path`, which may be a subdirectory of the repo.
        let root = resolve_repo_root(&path).await?;

        if untracked {
            // Untracked files/directories aren't tracked by git - just remove from disk.
            // Resolve and sanity-check it ends up inside the repo to avoid `..` escapes.
            let joined = std::path::Path::new(&root).join(&file);
            let canonical_target = joined.canonicalize().map_err(|e| {
                format!("Cannot resolve '{}': {}", joined.display(), e)
            })?;
            let canonical_root = std::path::Path::new(&root)
                .canonicalize()
                .map_err(|e| format!("Cannot resolve repo '{}': {}", root, e))?;
            if !canonical_target.starts_with(&canonical_root) {
                return Err(format!(
                    "Refusing to delete path outside repo: {}",
                    canonical_target.display()
                ));
            }
            let meta = tokio::fs::metadata(&canonical_target)
                .await
                .map_err(|e| format!("Failed to stat '{}': {}", canonical_target.display(), e))?;
            if meta.is_dir() {
                tokio::fs::remove_dir_all(&canonical_target)
                    .await
                    .map_err(|e| format!("Failed to delete directory: {}", e))?;
            } else {
                tokio::fs::remove_file(&canonical_target)
                    .await
                    .map_err(|e| format!("Failed to delete file: {}", e))?;
            }
            return Ok(());
        }

        // Tracked file - reset index + worktree for just this file to HEAD.
        let output = git_cmd_async(&["checkout", "HEAD", "--", &file])
            .current_dir(&root)
            .output()
            .await
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // git checkout failure here is environmental (dirty index, lock held).
            return Err(error_reporter::user_err(
                if !stderr.is_empty() { stderr }
                else if !stdout.is_empty() { stdout }
                else { "git checkout failed".into() },
            ));
        }
        Ok(())
    })
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// File tree / editor commands
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

/// List the immediate children of a directory. Does NOT recurse - the UI
/// requests children lazily when the user expands a folder.
#[command]
pub async fn list_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    wrap_cmd("list_directory", async move {
        // Untrusted paths return an empty listing rather than an error: the
        // file tree shouldn't be able to show contents outside a workspace,
        // but a stray request isn't a bug worth telemetry-reporting.
        if validate_path_is_trusted(&state, &path).await.is_err() {
            return Ok(Vec::new());
        }

        // read_dir + per-entry metadata for the whole directory — off-runtime.
        let entries = tokio::task::spawn_blocking(move || -> Result<Vec<DirEntryInfo>, String> {
            let mut entries: Vec<DirEntryInfo> = Vec::new();
            let read_dir = std::fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;
            for entry in read_dir.flatten() {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let file_name = entry.file_name().to_string_lossy().to_string();
                let full_path = entry.path().to_string_lossy().to_string();
                entries.push(DirEntryInfo {
                    name: file_name,
                    path: full_path,
                    is_dir: meta.is_dir(),
                    is_symlink: meta.file_type().is_symlink(),
                    size: if meta.is_file() { meta.len() } else { 0 },
                });
            }

            // VS Code ordering: folders first, then files, each alphabetical (case-insensitive).
            entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            Ok(entries)
        })
        .await
        .map_err(|e| format!("list_directory task failed: {}", e))??;

        Ok(entries)
    })
    .await
}

/// Read a file as UTF-8 text. Refuses binary files and very large files so the
/// editor can't be used to OOM the app.
#[command]
pub async fn read_text_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    wrap_cmd("read_text_file", async move {
        validate_path_is_trusted(&state, &path).await?;

        let meta = tokio::fs::metadata(&path).await.map_err(|e| format!("Failed to stat file: {}", e))?;
        // Directory / too-large / binary / non-UTF-8 are all expected outcomes
        // of the user clicking a file in the tree, not defects: user_err them
        // so they surface in the UI without hitting telemetry.
        if meta.is_dir() {
            return Err(error_reporter::user_err("Path is a directory"));
        }
        const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MB
        if meta.len() > MAX_BYTES {
            return Err(error_reporter::user_err(format!(
                "File is too large to edit in-app ({} bytes, max {}).",
                meta.len(),
                MAX_BYTES
            )));
        }

        let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Failed to read file: {}", e))?;
        // Quick binary sniff: any NUL byte in the first 8 KB → binary.
        let sniff_len = bytes.len().min(8192);
        if bytes[..sniff_len].contains(&0u8) {
            return Err(error_reporter::user_err(
                "File appears to be binary and cannot be edited as text.",
            ));
        }
        String::from_utf8(bytes).map_err(|_| error_reporter::user_err("File is not valid UTF-8."))
    })
    .await
}

/// Write UTF-8 text back to a file. Refuses to create new paths - the file must
/// already exist in a trusted location.
#[command]
pub async fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    wrap_cmd("write_text_file", async move {
        validate_path_is_trusted(&state, &path).await?;

        // Resolve the path once and write via the canonical form. Between
        // validation (which canonicalises) and the actual write, the input
        // `path` string could be swapped for a symlink pointing outside the
        // trusted tree — following the untrusted string would land the write
        // on the swap target. Canonicalising here means we write to the
        // already-resolved absolute path, closing that TOCTOU window.
        let canonical = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| format!("Failed to resolve path: {}", e))?;
        let meta = tokio::fs::metadata(&canonical)
            .await
            .map_err(|e| format!("Failed to stat file: {}", e))?;
        if meta.is_dir() {
            return Err(error_reporter::user_err("Path is a directory"));
        }
        tokio::fs::write(&canonical, content.as_bytes())
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;
        Ok(())
    })
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatch {
    pub line: u32,
    pub column: u32,
    pub line_text: String,
    pub match_length: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileSearchResult {
    pub file_path: String,
    pub relative_path: String,
    pub matches: Vec<SearchMatch>,
    pub name_match: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchSummary {
    pub results: Vec<FileSearchResult>,
    pub total_matches: u32,
    pub total_files: u32,
    pub truncated: bool,
}

const SEARCH_IGNORE_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".vscode",
    ".idea",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
    "vendor",
    "coverage",
    ".vite",
];

const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB per file
const SEARCH_MAX_FILES: u32 = 5000;
const SEARCH_MAX_TOTAL_MATCHES: u32 = 5000;
const SEARCH_MAX_PER_FILE: usize = 200;

fn search_should_skip_dir(name: &str) -> bool {
    if SEARCH_IGNORE_DIRS.iter().any(|d| *d == name) {
        return true;
    }
    name.starts_with('.') && name.len() > 1
}

fn search_walk(
    root: &std::path::Path,
    dir: &std::path::Path,
    query_lower: &str,
    query_raw: &str,
    case_sensitive: bool,
    include_files: bool,
    results: &mut Vec<FileSearchResult>,
    total_matches: &mut u32,
    files_seen: &mut u32,
) -> bool {
    // Returns false to signal "stop walking" when a hard cap is hit.
    let read_dir = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return true,
    };
    for entry in read_dir.flatten() {
        if *total_matches >= SEARCH_MAX_TOTAL_MATCHES || *files_seen >= SEARCH_MAX_FILES {
            return false;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if search_should_skip_dir(&name) {
                continue;
            }
            if !search_walk(
                root,
                &path,
                query_lower,
                query_raw,
                case_sensitive,
                include_files,
                results,
                total_matches,
                files_seen,
            ) {
                return false;
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        *files_seen += 1;
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        // Filename match (always cheap, ignores file size).
        let name_lower = name.to_lowercase();
        let name_matches = if case_sensitive {
            name.contains(query_raw)
        } else {
            name_lower.contains(query_lower)
        };

        // Skip content scan for huge files, but still let filename matches through.
        let scan_content = include_files && meta.len() <= SEARCH_MAX_FILE_BYTES;

        let mut matches: Vec<SearchMatch> = Vec::new();
        if scan_content {
            if let Ok(bytes) = std::fs::read(&path) {
                let sniff_len = bytes.len().min(8192);
                if !bytes[..sniff_len].contains(&0u8) {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        let mut line_no: u32 = 0;
                        for line in text.lines() {
                            line_no += 1;
                            if matches.len() >= SEARCH_MAX_PER_FILE {
                                break;
                            }
                            let haystack_lower;
                            let haystack: &str = if case_sensitive {
                                line
                            } else {
                                haystack_lower = line.to_lowercase();
                                &haystack_lower
                            };
                            let needle: &str = if case_sensitive { query_raw } else { query_lower };
                            let mut start = 0;
                            while let Some(idx) = haystack[start..].find(needle) {
                                let abs_idx = start + idx;
                                // Trim very long lines for transport.
                                let truncated_line = if line.len() > 400 {
                                    let cut = line.char_indices().nth(400).map(|(i, _)| i).unwrap_or(line.len());
                                    format!("{}…", &line[..cut])
                                } else {
                                    line.to_string()
                                };
                                matches.push(SearchMatch {
                                    line: line_no,
                                    column: (abs_idx as u32) + 1,
                                    line_text: truncated_line,
                                    match_length: needle.chars().count() as u32,
                                });
                                *total_matches += 1;
                                if *total_matches >= SEARCH_MAX_TOTAL_MATCHES
                                    || matches.len() >= SEARCH_MAX_PER_FILE
                                {
                                    break;
                                }
                                start = abs_idx + needle.len().max(1);
                                if start >= haystack.len() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if !matches.is_empty() || name_matches {
            results.push(FileSearchResult {
                file_path: path.to_string_lossy().replace('\\', "/"),
                relative_path: relative,
                matches,
                name_match: name_matches,
            });
        }
    }
    true
}

/// Search for `query` across all files under `path`. Walks the tree, skipping
/// common ignore directories (.git, node_modules, target, …) and files that
/// look binary. Returns matches grouped by file with line/column metadata.
#[command]
pub async fn search_in_files(
    state: State<'_, AppState>,
    path: String,
    query: String,
    case_sensitive: bool,
    include_file_contents: bool,
) -> Result<SearchSummary, String> {
    wrap_cmd("search_in_files", async move {
        validate_path_is_trusted(&state, &path).await?;

        if query.trim().is_empty() {
            return Ok(SearchSummary {
                results: Vec::new(),
                total_matches: 0,
                total_files: 0,
                truncated: false,
            });
        }

        let root = tokio::fs::canonicalize(&path)
            .await
            .map_err(|e| format!("Invalid root: {}", e))?;
        if !root.is_dir() {
            return Err(error_reporter::user_err("Search root is not a directory"));
        }

        // Recursive tree walk with per-file read + substring scan — inherently
        // sync-blocking and CPU-heavy. Run on the blocking pool so the tokio
        // runtime keeps serving terminal-output events while a big repo scans.
        let query_lower = query.to_lowercase();
        let summary = tokio::task::spawn_blocking(move || -> SearchSummary {
            let mut results: Vec<FileSearchResult> = Vec::new();
            let mut total_matches: u32 = 0;
            let mut files_seen: u32 = 0;

            let completed = search_walk(
                &root,
                &root,
                &query_lower,
                &query,
                case_sensitive,
                include_file_contents,
                &mut results,
                &mut total_matches,
                &mut files_seen,
            );

            // Show files with content matches first, then filename-only matches.
            results.sort_by(|a, b| {
                let a_only_name = a.matches.is_empty();
                let b_only_name = b.matches.is_empty();
                match (a_only_name, b_only_name) {
                    (false, true) => std::cmp::Ordering::Less,
                    (true, false) => std::cmp::Ordering::Greater,
                    _ => a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()),
                }
            });

            SearchSummary {
                total_files: results.len() as u32,
                total_matches,
                truncated: !completed,
                results,
            }
        })
        .await
        .map_err(|e| format!("Search task failed: {}", e))?;

        Ok(summary)
    })
    .await
}

// ─── LSP ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LspLanguageStatus {
    pub language: String,
    pub resolution: crate::lsp::acquire::Resolution,
    pub running_roots: Vec<String>,
}

#[command]
pub async fn lsp_did_open(
    state: State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
    language_id: String,
    text: String,
    version: i64,
) -> Result<(), String> {
    wrap_cmd("lsp_did_open", async move {
        // rust-analyzer wants the crate root (Cargo.toml dir), not the git root.
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_open(&root, &language, &path, &language_id, &text, version).await
    })
    .await
}

#[command]
pub async fn lsp_did_change(
    state: State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
    text: String,
    version: i64,
) -> Result<(), String> {
    wrap_cmd("lsp_did_change", async move {
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_change(&root, &language, &path, &text, version).await
    })
    .await
}

#[command]
pub async fn lsp_did_close(
    state: State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
) -> Result<(), String> {
    wrap_cmd("lsp_did_close", async move {
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_close(&root, &language, &path).await
    })
    .await
}

/// Generic LSP request passthrough (hover, definition, ...).
///
/// Contract: `root` must match the *effective* root used for document sync.
/// did_open/did_change/did_close rewrite the root for rust via
/// `rust_project_root` (crate root, not git root), so rust callers must pass
/// `path` (the file the request targets) so the same rewrite is applied here —
/// otherwise the request would spawn a second rust-analyzer with no open docs.
#[command]
pub async fn lsp_request(
    state: State<'_, crate::AppState>,
    root: String,
    language: String,
    method: String,
    params: serde_json::Value,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    wrap_cmd("lsp_request", async move {
        let root = match (language.as_str(), &path) {
            ("rust", Some(p)) => crate::lsp::acquire::rust_project_root(p, &root),
            _ => root,
        };
        // Two-phase locking: hold the manager lock only long enough to
        // get/spawn the client, then release it for the request round-trip.
        // The client request timeout is 120s — holding the manager lock that
        // long would block every other LSP command on one wedged server.
        let client = {
            let mut mgr = state.lsp.lock().await;
            mgr.ensure(&root, &language).await?
        };
        let c = client.lock().await;
        c.request(&method, params).await
    })
    .await
}

#[command]
pub async fn lsp_status(
    state: State<'_, crate::AppState>,
) -> Result<Vec<LspLanguageStatus>, String> {
    wrap_cmd("lsp_status", async move {
        let mut out = Vec::new();
        for language in ["typescript", "python", "rust"] {
            let lang = language.to_string();
            let (_, resolution) =
                tokio::task::spawn_blocking(move || crate::lsp::acquire::resolve(&lang))
                    .await
                    .map_err(|e| e.to_string())??;
            let running_roots = {
                let mgr = state.lsp.lock().await;
                mgr.running_roots(language).await
            };
            out.push(LspLanguageStatus {
                language: language.to_string(),
                resolution,
                running_roots,
            });
        }
        Ok(out)
    })
    .await
}

#[command]
pub async fn lsp_install_server(
    state: State<'_, crate::AppState>,
    language: String,
) -> Result<String, String> {
    wrap_cmd("lsp_install_server", async move {
        crate::lsp::acquire::install(&language).await?;
        // Drop any cached resolution so the next ensure() picks up the
        // fresh install instead of a stale Missing/Path result.
        state.lsp.lock().await.invalidate_resolution(&language);
        Ok(format!("{language} language server installed"))
    })
    .await
}

#[command]
pub async fn lsp_restart_server(
    state: State<'_, crate::AppState>,
    language: String,
) -> Result<(), String> {
    wrap_cmd("lsp_restart_server", async move {
        let mut mgr = state.lsp.lock().await;
        mgr.restart_language(&language).await;
        Ok(())
    })
    .await
}

#[command]
pub async fn lsp_server_log(
    state: State<'_, crate::AppState>,
    language: String,
) -> Result<Vec<String>, String> {
    wrap_cmd("lsp_server_log", async move {
        let mgr = state.lsp.lock().await;
        Ok(mgr.stderr_log(&language).await)
    })
    .await
}

#[cfg(test)]
mod version_extraction_tests {
    use super::{extract_version_line, has_semver_like};

    #[test]
    fn extracts_simple_version() {
        assert_eq!(extract_version_line("1.0.17\n"), "1.0.17");
        assert_eq!(extract_version_line("v20.18.0\n"), "v20.18.0");
    }

    #[test]
    fn extracts_version_with_suffix() {
        assert_eq!(
            extract_version_line("1.0.17 (Claude Code)\n"),
            "1.0.17 (Claude Code)"
        );
    }

    #[test]
    fn skips_init_noise_picks_version_line() {
        // p10k / conda init / banner stuff before the actual version output.
        let stdout = "p10k: warning: instant prompt configured\n\
                      (base) Welcome back!\n\
                      1.0.17\n";
        assert_eq!(extract_version_line(stdout), "1.0.17");
    }

    #[test]
    fn falls_back_to_full_output_when_no_semver() {
        // Don't silently lose unusual `--version` output (e.g. a prerelease
        // tag without dotted numerics) - return what we got.
        assert_eq!(extract_version_line("nightly-build\n"), "nightly-build");
    }

    #[test]
    fn semver_detector_rejects_two_part_version() {
        // `npm view`-like single-number / two-part outputs are uncommon for
        // the tools we care about, but we want to be sure we require the
        // full X.Y.Z shape.
        assert!(!has_semver_like("1.0"));
        assert!(!has_semver_like("v20"));
        assert!(has_semver_like("0.1.2"));
        assert!(has_semver_like("20.18.0"));
    }
}

#[cfg(test)]
mod wrap_cmd_tests {
    use super::*;

    #[tokio::test]
    async fn wrap_cmd_strips_prefix_from_user_error() {
        let result: Result<(), String> = wrap_cmd("dummy", async {
            Err(error_reporter::user_err("input was bad"))
        }).await;
        assert_eq!(result, Err("input was bad".to_string()));
    }

    #[tokio::test]
    async fn wrap_cmd_passes_through_internal_error_unchanged() {
        let result: Result<(), String> = wrap_cmd("dummy", async {
            Err("io failure".to_string())
        }).await;
        assert_eq!(result, Err("io failure".to_string()));
    }

    #[tokio::test]
    async fn wrap_cmd_passes_through_ok_unchanged() {
        let result: Result<i32, String> = wrap_cmd("dummy", async { Ok(42) }).await;
        assert_eq!(result, Ok(42));
    }

    #[tokio::test]
    async fn wrap_cmd_passes_through_validate_path_is_trusted_error_clean() {
        // Document that callers see the same string they would have before
        // migration. The prefix is stripped invisibly.
        let inner_msg = "Invalid path 'agentic-dev': not found";
        let result: Result<(), String> = wrap_cmd("scan_git_repos", async {
            Err(error_reporter::user_err(inner_msg))
        }).await;
        assert_eq!(result, Err(inner_msg.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_terminal_request_deserializes_without_agent_field() {
        // Older frontend versions that don't send `agent` must still
        // deserialize and default to Claude.
        let json = r#"{
            "label": "test",
            "working_directory": "/tmp",
            "claude_args": [],
            "env_vars": {}
        }"#;
        let req: CreateTerminalRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.agent, crate::config::AgentKind::Claude);
    }

    #[test]
    fn create_terminal_request_deserializes_codex_agent() {
        let json = r#"{
            "label": "test",
            "working_directory": "/tmp",
            "claude_args": [],
            "env_vars": {},
            "agent": "codex"
        }"#;
        let req: CreateTerminalRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.agent, crate::config::AgentKind::Codex);
    }
}
