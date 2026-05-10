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

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTerminalRequest {
    pub label: String,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub color_tag: Option<String>,
    pub nickname: Option<String>,
}

#[command]
pub async fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CreateTerminalRequest,
) -> Result<crate::terminal::TerminalConfig, String> {
    wrap_cmd("create_terminal", async move {
        // Channel sized for burst output — Claude Code streaming can easily push
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
            std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
            let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
            let filename = format!("{}_{}.log", uuid::Uuid::new_v4(), timestamp);
            logs_dir.join(filename).to_string_lossy().to_string()
        };

        let config = {
            let mut terminals = state.terminals.lock().await;
            terminals.create_terminal(
                request.label.clone(),
                request.working_directory,
                request.claude_args,
                request.env_vars,
                request.color_tag,
                request.nickname,
                tx,
                Some(log_path.clone()),
            )?
        };

        // Insert session history entry
        {
            let db = state.db.lock().await;
            if let Err(e) = db.insert_session_history(
                &config.id,
                &config.label,
                &config.created_at.to_rfc3339(),
                Some(&log_path),
            ) {
                eprintln!("Failed to insert session history: {}", e);
            }
        }

        let terminal_id = config.id.clone();
        let db_arc = state.db.clone();
        let terminals_arc = state.terminals.clone();

        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some((id, data)) = rx.recv().await {
                if let Err(e) = app_clone.emit("terminal-output", serde_json::json!({
                    "id": id,
                    "data": data,
                })) {
                    eprintln!("Failed to emit terminal-output: {}", e);
                    break;
                }
            }

            // Terminal process exited — update status, session history, and notify frontend
            // Note: the terminal may have already been removed by close_terminal(), so ignore errors
            {
                if let Ok(mut manager) = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    terminals_arc.lock(),
                ).await {
                    let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
                }
            }
            {
                let db = db_arc.lock().await;
                if let Err(e) = db.update_session_ended(&terminal_id, &chrono::Utc::now().to_rfc3339()) {
                    eprintln!("Failed to update session ended for {}: {}", terminal_id, e);
                }
            }

            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({
                "id": terminal_id,
            })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
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
        terminals.close(&id)
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
        let db = state.db.lock().await;
        db.save_profile(&profile)
    })
    .await
}

#[command]
pub async fn get_profiles(state: State<'_, AppState>) -> Result<Vec<ConfigProfile>, String> {
    wrap_cmd("get_profiles", async move {
        let db = state.db.lock().await;
        db.get_profiles()
    })
    .await
}

#[command]
pub async fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_profile", async move {
        let db = state.db.lock().await;
        db.delete_profile(&id)
    })
    .await
}

#[command]
pub async fn get_claude_version() -> Result<String, String> {
    wrap_cmd("get_claude_version", async move {
        let output = run_claude(&["--version"])
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

/// Run `claude` with the given args. Prefers the cached absolute path resolved
/// via an interactive login shell (so users with PATH set in `.zshrc` work);
/// falls back to the shell-PATH lookup if resolution failed.
fn run_claude(args: &[&str]) -> std::io::Result<std::process::Output> {
    if let Some(path) = crate::claude_path::cached() {
        let mut cmd = std::process::Command::new(&path);
        for a in args { cmd.arg(a); }
        cmd.output()
    } else {
        shell_command("claude", args).output()
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
            .map_err(|e| format!("Failed to get current version: {}", e))?;

        let current_stdout = String::from_utf8_lossy(&current_output.stdout);
        let current_version = extract_version_line(&current_stdout);

        if current_version.is_empty() {
            return Err("Claude Code is not installed".to_string());
        }

        // Get latest version from npm
        let npm_output = shell_command("npm", &["view", "@anthropic-ai/claude-code", "version"])
            .output()
            .map_err(|e| format!("Failed to check latest version: {}", e))?;

        let npm_stdout = String::from_utf8_lossy(&npm_output.stdout);
        let latest_version = extract_version_line(&npm_stdout);

        if latest_version.is_empty() {
            return Err("Failed to fetch latest version from npm".to_string());
        }

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

#[command]
pub async fn update_claude_code() -> Result<String, String> {
    wrap_cmd("update_claude_code", async move {
        let output = shell_command("npm", &["install", "-g", "@anthropic-ai/claude-code@latest"])
            .output()
            .map_err(|e| format!("Failed to run npm: {}", e))?;

        if output.status.success() {
            // npm may have moved the binary or the user may have switched
            // node versions — drop the cache so the next call re-resolves.
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
pub fn get_hints() -> Vec<HintCategory> {
    crate::config::get_default_hints()
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
fn shell_command(program: &str, args: &[&str]) -> std::process::Command {
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
        // `~/.local/bin` are invisible — `claude --version`, `node`, `npm`
        // all return "command not found" for users who only export those
        // dirs from their interactive rc file.
        cmd.arg("-lic").arg(&full_cmd);
        cmd
    }
}

/// Pick a sensible "version" string from a command's stdout.
///
/// With the shell helper now using `-lic`, an interactive shell's init may
/// print banners / prompts / conda init blurbs to stdout *before* the actual
/// version line. We scan from the bottom for a line that contains a
/// dotted-numeric version. Falls back to the trimmed full output if nothing
/// matches (e.g. unusual `--version` formats we don't want to silently drop).
fn extract_version_line(stdout: &str) -> String {
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
            // `1.2.3` style — at least two dots between numeric runs.
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
        let node_result = shell_command("node", &["--version"]).output();

        let (node_installed, node_version) = match node_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                (true, Some(extract_version_line(&stdout)))
            }
            _ => (false, None),
        };

        // Check npm
        let npm_result = shell_command("npm", &["--version"]).output();

        let (npm_installed, npm_version) = match npm_result {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                (true, Some(extract_version_line(&stdout)))
            }
            _ => (false, None),
        };

        // Check Claude Code via the resolved absolute path when available
        // (avoids any shell-PATH guessing). Falls back to the shell helper.
        let claude_result = run_claude(&["--version"]);

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
        let output = shell_command("npm", &["install", "-g", "@anthropic-ai/claude-code"])
            .output()
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

#[command]
pub async fn get_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<crate::database::WorkspaceInfo>, String> {
    wrap_cmd("get_workspaces", async move {
        let db = state.db.lock().await;
        db.get_workspaces()
    })
    .await
}

#[command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    wrap_cmd("delete_workspace", async move {
        let db = state.db.lock().await;
        db.delete_workspace(&name)
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
        let db = state.db.lock().await;
        db.save_workspace(&name, &terminals)
    })
    .await
}

#[command]
pub async fn load_workspace(
    state: State<'_, AppState>,
    name: String,
) -> Result<Vec<crate::terminal::TerminalConfig>, String> {
    wrap_cmd("load_workspace", async move {
        let db = state.db.lock().await;
        db.load_workspace(&name)
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
        let db = state.db.lock().await;
        db.save_last_session(&configs)
    })
    .await
}

#[command]
pub async fn get_last_session(
    state: State<'_, AppState>,
) -> Result<Option<Vec<crate::terminal::TerminalConfig>>, String> {
    wrap_cmd("get_last_session", async move {
        let db = state.db.lock().await;
        db.load_last_session()
    })
    .await
}

#[command]
pub async fn clear_last_session(state: State<'_, AppState>) -> Result<(), String> {
    wrap_cmd("clear_last_session", async move {
        let db = state.db.lock().await;
        db.clear_last_session()
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
        let working_directory = {
            let terminals = state.terminals.lock().await;
            let configs = terminals.get_all_configs();
            configs
                .into_iter()
                .find(|c| c.id == id)
                .map(|c| c.working_directory.clone())
                .ok_or_else(|| "Terminal not found".to_string())?
        };

        // Check if it's a git repo and get branch name
        let branch_output = shell_command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&working_directory)
            .output();

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
                changes: vec![],
                is_git_repo: false,
                branch: None,
                error: None,
            });
        }

        // Get changed files
        let status_output = shell_command("git", &["status", "--porcelain"])
            .current_dir(&working_directory)
            .output()
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        if !status_output.status.success() {
            return Ok(FileChangesResult {
                terminal_id: id,
                working_directory,
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
                // Untracked — always unstaged
                changes.push(FileChange { path, status: "untracked".into(), staged: false });
                continue;
            }

            let map_code = |c: char| match c {
                'A' => "new",
                'M' => "modified",
                'D' => "deleted",
                'R' => "renamed",
                'C' => "new",
                'U' => "modified", // conflicted — treat as modified
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

#[command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    id: String,
    file_path: String,
    staged: bool,
) -> Result<FileDiffResult, String> {
    wrap_cmd("get_file_diff", async move {
        let (working_directory, file_status) = {
            let terminals = state.terminals.lock().await;
            let configs = terminals.get_all_configs();
            let config = configs
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| "Terminal not found".to_string())?;

            // Run git status for this specific file to determine its status
            let status_output = shell_command("git", &["status", "--porcelain", "--", &file_path])
                .current_dir(&config.working_directory)
                .output()
                .map_err(|e| format!("Failed to run git status: {}", e))?;

            let status_str = String::from_utf8_lossy(&status_output.stdout).trim().to_string();
            let file_status = if status_str.len() >= 2 {
                status_str[..2].trim().to_string()
            } else {
                String::new()
            };

            (config.working_directory.clone(), file_status)
        };

        let is_new_file = file_status == "??" || file_status == "A";
        let is_deleted_file = file_status == "D";

        let diff_text = if is_new_file {
            // For untracked/new files, read the file and format as all-added
            let full_path = std::path::Path::new(&working_directory).join(&file_path);
            match std::fs::read_to_string(&full_path) {
                Ok(content) => {
                    let lines: Vec<String> = content.lines().enumerate().map(|(_, line)| {
                        format!("+{}", line)
                    }).collect();
                    format!(
                        "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
                        file_path,
                        lines.len(),
                        lines.join("\n")
                    )
                }
                Err(_) => String::from("Unable to read file contents")
            }
        } else if is_deleted_file {
            // For deleted files, show content from HEAD
            let show_output = shell_command("git", &["show", &format!("HEAD:{}", file_path)])
                .current_dir(&working_directory)
                .output();
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

            let diff_output = shell_command("git", &args)
                .current_dir(&working_directory)
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;

            let text = String::from_utf8_lossy(&diff_output.stdout).to_string();

            // If unstaged diff is empty, try staged diff (file might be fully staged)
            if text.trim().is_empty() && !staged {
                let staged_output = shell_command("git", &["diff", "--cached", "--", &file_path])
                    .current_dir(&working_directory)
                    .output()
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
}

/// Validate that a path belongs to (or is under) an active terminal's working directory.
/// Prevents arbitrary filesystem access via git commands.
async fn validate_path_is_trusted(state: &State<'_, AppState>, path: &str) -> Result<(), String> {
    let canonical_path = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;

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
        return Err(format!(
            "Path '{}' is not under any active terminal's working directory",
            canonical_path.display()
        ));
    }
    Ok(())
}

#[command]
pub async fn get_worktree_info(
    state: State<'_, AppState>,
    path: String,
) -> Result<WorktreeDetectResult, String> {
    wrap_cmd("get_worktree_info", async move {
        validate_path_is_trusted(&state, &path).await?;

        // Check if inside a git work tree
        let inside_wt = shell_command("git", &["rev-parse", "--is-inside-work-tree"])
            .current_dir(&path)
            .output();

        let is_git_repo = matches!(inside_wt, Ok(ref o) if o.status.success()
            && String::from_utf8_lossy(&o.stdout).trim() == "true");

        if !is_git_repo {
            return Ok(WorktreeDetectResult {
                is_git_repo: false,
                is_worktree: false,
                main_repo_path: None,
                current_branch: None,
                worktree_root: None,
            });
        }

        // Get worktree root (--show-toplevel)
        let toplevel = shell_command("git", &["rev-parse", "--show-toplevel"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        // Get git-dir and git-common-dir to detect if this is a linked worktree
        let git_dir = shell_command("git", &["rev-parse", "--git-dir"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

        let git_common_dir = shell_command("git", &["rev-parse", "--git-common-dir"])
            .current_dir(&path)
            .output()
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
        let current_branch = shell_command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let b = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if b == "HEAD" { None } else { Some(b) }
            })
            .flatten();

        Ok(WorktreeDetectResult {
            is_git_repo: true,
            is_worktree,
            main_repo_path,
            current_branch,
            worktree_root: toplevel,
        })
    })
    .await
}

/// Internal helper to list worktrees for a given path (no authorization check).
fn list_worktrees_internal(path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let output = shell_command("git", &["worktree", "list", "--porcelain"])
        .current_dir(path)
        .output()
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
        list_worktrees_internal(&path)
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

        let output = shell_command("git", &["branch", "--format=%(refname:short)"])
            .current_dir(&path)
            .output()
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

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let out = shell_command("git", args)
        .current_dir(path)
        .output()
        .map_err(|e| format!("Failed to run git {}: {}", args.join(" "), e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
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
        // `git add -- <file>...` with `--` to terminate options
        let mut args: Vec<&str> = vec!["add", "--"];
        for f in &files { args.push(f); }
        run_git(&path, &args).map(|_| ())
    })
    .await
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
        // Use `git reset HEAD -- <file>` for broad git-version compatibility.
        // `git restore --staged` (2.23+) is the modern equivalent.
        let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
        for f in &files { args.push(f); }
        // `git reset` returns non-zero on no-op or initial-commit edge cases, but
        // the files do end up unstaged — we tolerate non-fatal stderr.
        match run_git(&path, &args) {
            Ok(_) => Ok(()),
            Err(e) => {
                // On a repo with no HEAD yet, use `git rm --cached` as fallback.
                if e.contains("ambiguous argument 'HEAD'") || e.contains("unknown revision") {
                    let mut fb: Vec<&str> = vec!["rm", "--cached", "--"];
                    for f in &files { fb.push(f); }
                    run_git(&path, &fb).map(|_| ())
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
) -> Result<(), String> {
    wrap_cmd("git_commit", async move {
        validate_path_is_trusted(&state, &path).await?;
        if message.trim().is_empty() {
            return Err("Commit message cannot be empty".to_string());
        }
        // If the caller asks us to auto-stage, do so. Otherwise commit what's
        // already staged — and if nothing is staged, return a clear error.
        match auto_stage {
            AutoStageMode::None => {
                let status = run_git(&path, &["diff", "--cached", "--name-only"])?;
                if status.trim().is_empty() {
                    return Err("Nothing is staged — stage files first or choose 'stage all'".to_string());
                }
            }
            AutoStageMode::Tracked => { run_git(&path, &["add", "-u"])?; }
            AutoStageMode::All => { run_git(&path, &["add", "-A"])?; }
        }

        // Pass message via a temp file to avoid any shell-quoting concerns for
        // multi-line or special-character messages.
        let tmp = std::env::temp_dir().join(format!(
            "ct-commit-msg-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::write(&tmp, message.as_bytes()).map_err(|e| format!("Failed to write commit message: {}", e))?;
        let tmp_str = tmp.to_string_lossy().to_string();
        let res = run_git(&path, &["commit", "-F", &tmp_str]);
        let _ = std::fs::remove_file(&tmp);
        res.map(|_| ())
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

#[command]
pub async fn git_push(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    wrap_cmd("git_push", async move {
        validate_path_is_trusted(&state, &path).await?;
        run_git(&path, &["push"]).map(|_| ())
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
                return Err("Stash message cannot contain control characters".to_string());
            }
            args.push("-m".into());
            args.push(m.to_string());
        }
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_git(&path, &str_args).map(|_| ())
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
        // Format: "<ref>\x1f<subject>" — \x1f (unit separator) is safe against
        // colons/spaces in the subject.
        let out = run_git(&path, &["stash", "list", "--format=%gd\x1f%s"])?;
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
        run_git(&path, &["stash", "apply", &reference]).map(|_| ())
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
        run_git(&path, &["stash", "pop", &reference]).map(|_| ())
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
        run_git(&path, &["stash", "drop", &reference]).map(|_| ())
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
        // Defense against arg injection — branch names cannot start with '-' and
        // cannot contain characters git disallows for refs anyway, but we're extra
        // strict with a conservative allowlist.
        if branch.is_empty() || branch.starts_with('-') {
            return Err("Invalid branch name".to_string());
        }
        if branch.chars().any(|c| c.is_control() || c == ' ' || c == '~' || c == '^' || c == ':' || c == '?' || c == '*' || c == '[') {
            return Err("Invalid branch name".to_string());
        }
        let output = shell_command("git", &["checkout", &branch])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if !stderr.is_empty() { stderr } else { stdout });
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
            shell_command("git", &["worktree", "add", "-b", &branch, &worktree_path])
                .current_dir(&repo_path)
                .output()
        } else {
            shell_command("git", &["worktree", "add", &worktree_path, &branch])
                .current_dir(&repo_path)
                .output()
        };

        let output = output.map_err(|e| format!("Failed to create worktree: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(stderr);
        }

        // Return the new worktree info by listing and finding the new one
        let worktrees = list_worktrees_internal(&repo_path)?;
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

        let output = shell_command("git", &args)
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to remove worktree: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
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
        let db = state.db.lock().await;
        db.get_session_history()
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
        let canonical_path = std::path::Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("Invalid path: {}", e))?;
        std::fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs directory: {}", e))?;
        let canonical_logs = logs_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Err("Access denied: path is not under logs directory".to_string());
        }
        // Cap at 2 MB — prevents DoS via huge/symlinked logs and matches
        // what the UI can reasonably render in a single read.
        const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
        let bytes = std::fs::read(&canonical_path).map_err(|e| format!("Failed to read log file: {}", e))?;
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
            let _ = std::fs::create_dir_all(&logs_dir);
            if let Ok(canonical_path) = std::path::Path::new(path).canonicalize() {
                if let Ok(canonical_logs) = logs_dir.canonicalize() {
                    if canonical_path.starts_with(&canonical_logs) {
                        let _ = std::fs::remove_file(&canonical_path);
                    }
                }
            }
        }
        let db = state.db.lock().await;
        db.delete_session_history_entry(id)
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
        let log_path = {
            let db = state.db.lock().await;
            db.get_log_path_for_terminal(&terminal_id)?
        };

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
        std::fs::create_dir_all(&logs_dir)
            .map_err(|e| format!("Failed to create logs directory: {}", e))?;

        let canonical_path = match std::path::Path::new(&path).canonicalize() {
            Ok(p) => p,
            Err(_) => return Ok(None), // Log file may have been deleted
        };
        let canonical_logs = logs_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Ok(None);
        }

        // Read up to 512 KB
        match std::fs::read(&canonical_path) {
            Ok(bytes) => {
                let max_bytes = 512 * 1024;
                let truncated = if bytes.len() > max_bytes {
                    &bytes[bytes.len() - max_bytes..]
                } else {
                    &bytes
                };
                Ok(Some(String::from_utf8_lossy(truncated).into_owned()))
            }
            Err(_) => Ok(None),
        }
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
        let db = state.db.lock().await;
        db.save_snippet(&snippet)
    })
    .await
}

#[command]
pub async fn get_snippets(state: State<'_, AppState>) -> Result<Vec<Snippet>, String> {
    wrap_cmd("get_snippets", async move {
        let db = state.db.lock().await;
        db.get_snippets()
    })
    .await
}

#[command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_snippet", async move {
        let db = state.db.lock().await;
        db.delete_snippet(&id)
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

/// Maximum size for ~/.claude/settings.json — 1 MB is generous for a JSON config
/// and prevents a compromised renderer (or malformed file) from exhausting memory.
const MAX_CLAUDE_SETTINGS_BYTES: u64 = 1024 * 1024;

#[command]
pub async fn read_claude_settings() -> Result<String, String> {
    wrap_cmd("read_claude_settings", async move {
        let settings_path = get_claude_dir()?.join("settings.json");
        if !settings_path.exists() {
            return Ok("{}".to_string());
        }
        let meta = std::fs::metadata(&settings_path)
            .map_err(|e| format!("Failed to stat settings.json: {}", e))?;
        if meta.len() > MAX_CLAUDE_SETTINGS_BYTES {
            return Err(format!(
                "settings.json is larger than allowed maximum ({} bytes)",
                MAX_CLAUDE_SETTINGS_BYTES
            ));
        }
        std::fs::read_to_string(&settings_path)
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
        std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
        std::fs::write(claude_dir.join("settings.json"), &content)
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
        let entries = std::fs::read_dir(&agents_dir).map_err(|e| e.to_string())?;
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .collect();
        names.sort();
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
            return Err(format!("Agent file not found: {}", name));
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn write_claude_agent(name: String, content: String) -> Result<(), String> {
    wrap_cmd("write_claude_agent", async move {
        validate_filename(&name)?;
        let agents_dir = get_claude_dir()?.join("agents");
        std::fs::create_dir_all(&agents_dir).map_err(|e| e.to_string())?;
        std::fs::write(agents_dir.join(&name), &content).map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn delete_claude_agent(name: String) -> Result<(), String> {
    wrap_cmd("delete_claude_agent", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("agents").join(&name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
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
        let entries = std::fs::read_dir(&commands_dir).map_err(|e| e.to_string())?;
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .collect();
        names.sort();
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
            return Err(format!("Command file not found: {}", name));
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn write_claude_command(name: String, content: String) -> Result<(), String> {
    wrap_cmd("write_claude_command", async move {
        validate_filename(&name)?;
        let commands_dir = get_claude_dir()?.join("commands");
        std::fs::create_dir_all(&commands_dir).map_err(|e| e.to_string())?;
        std::fs::write(commands_dir.join(&name), &content).map_err(|e| e.to_string())
    })
    .await
}

#[command]
pub async fn delete_claude_command(name: String) -> Result<(), String> {
    wrap_cmd("delete_claude_command", async move {
        validate_filename(&name)?;
        let path = get_claude_dir()?.join("commands").join(&name);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

// Telemetry commands

#[command]
pub async fn get_installation_id(state: State<'_, AppState>) -> Result<String, String> {
    wrap_cmd("get_installation_id", async move {
        let db = state.db.lock().await;
        db.get_or_create_installation_id()
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
        let installation_id = {
            let db = state.db.lock().await;
            db.get_or_create_installation_id()?
        };
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
        std::fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed to create logs directory: {}", e))?;

        let canonical_path = match std::path::Path::new(&log_path).canonicalize() {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };
        let canonical_logs = logs_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve logs directory: {}", e))?;
        if !canonical_path.starts_with(&canonical_logs) {
            return Err("Access denied: path is not under logs directory".to_string());
        }

        // Read log file content (capped at 100KB)
        let bytes = match std::fs::read(&canonical_path) {
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

        // Strip ANSI escape sequences
        let ansi_re = regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[A-Za-z]")
            .unwrap();
        let clean_content = ansi_re.replace_all(&log_content, "").to_string();

        if clean_content.trim().is_empty() {
            return Ok(None);
        }

        // Run claude -p to summarize
        let mut cmd = shell_command("claude", &["-p", "--model", "haiku", "Summarize what was accomplished in this terminal session in 2-3 bullet points. Be concise."]);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => return Ok(None), // Claude Code not available
        };

        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(clean_content.as_bytes());
        }

        let output = match child.wait_with_output() {
            Ok(o) => o,
            Err(_) => return Ok(None),
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
        let db = state.db.lock().await;
        db.save_session_summary(&terminal_id, &summary)
    })
    .await
}

#[command]
pub async fn get_session_summary(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_session_summary", async move {
        let db = state.db.lock().await;
        db.get_session_summary(&terminal_id)
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

    // If the target exists, canonicalize resolves symlinks — strongest check.
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
            // Scan only the specific project
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

        Ok(files)
    })
    .await
}

#[command]
pub async fn read_memory_file(path: String) -> Result<String, String> {
    wrap_cmd("read_memory_file", async move {
        validate_claude_path(&path)?;
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read memory file: {}", e))
    })
    .await
}

#[command]
pub async fn write_memory_file(path: String, content: String) -> Result<(), String> {
    wrap_cmd("write_memory_file", async move {
        validate_claude_path(&path)?;
        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, &content).map_err(|e| format!("Failed to write memory file: {}", e))
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

        // Project-level CLAUDE.md files in ~/.claude/projects/*/
        let projects_dir = claude_dir.join("projects");
        if projects_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&projects_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let md_path = path.join("CLAUDE.md");
                        if md_path.exists() {
                            let project_name = entry.file_name().to_string_lossy().to_string();
                            files.push(ClaudeMdInfo {
                                path: md_path.to_string_lossy().to_string(),
                                scope: "project".to_string(),
                                project_name: Some(project_name),
                            });
                        }
                    }
                }
            }
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
            let tasks_dir = std::path::Path::new(&home)
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
    let out = shell_command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(path)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if b == "HEAD" || b.is_empty() { None } else { Some(b) }
}

fn git_is_worktree(path: &std::path::Path) -> bool {
    let git_dir = shell_command("git", &["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let common = shell_command("git", &["rev-parse", "--git-common-dir"])
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
    shell_command("git", &["status", "--porcelain"])
        .current_dir(path)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

fn git_ahead_behind(path: &std::path::Path) -> (u32, u32) {
    // rev-list --count --left-right HEAD...@{u}   → "ahead\tbehind"
    let out = shell_command("git", &["rev-list", "--count", "--left-right", "HEAD...@{u}"])
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
        // repos — a nested repo is one whose parent is not itself a repo root.
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
        let mut results = Vec::new();
        // max_depth 4 handles common monorepo layouts (apps/x, packages/y/z)
        // limit 40 guards against runaway scans
        scan_for_repos(&root, &root, 0, 4, &mut results, 40);
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

        let branch_output = shell_command("git", &["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&path)
            .output();

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
                changes: vec![],
                is_git_repo: false,
                branch: None,
                error: None,
            });
        }

        let status_output = shell_command("git", &["status", "--porcelain"])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        if !status_output.status.success() {
            return Ok(FileChangesResult {
                terminal_id: String::new(),
                working_directory: path,
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

        let status_output = shell_command("git", &["status", "--porcelain", "--", &file_path])
            .current_dir(&path)
            .output()
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
            match std::fs::read_to_string(&full_path) {
                Ok(content) => {
                    let lines: Vec<String> = content.lines().map(|line| format!("+{}", line)).collect();
                    format!(
                        "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
                        file_path,
                        lines.len(),
                        lines.join("\n")
                    )
                }
                Err(_) => String::from("Unable to read file contents"),
            }
        } else if is_deleted_file {
            let show_output = shell_command("git", &["show", &format!("HEAD:{}", file_path)])
                .current_dir(&path)
                .output();
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

            let diff_output = shell_command("git", &args)
                .current_dir(&path)
                .output()
                .map_err(|e| format!("Failed to run git diff: {}", e))?;

            let text = String::from_utf8_lossy(&diff_output.stdout).to_string();
            if text.trim().is_empty() && !staged {
                let staged_output = shell_command("git", &["diff", "--cached", "--", &file_path])
                    .current_dir(&path)
                    .output()
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

        let output = shell_command("git", &args)
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if !stderr.is_empty() { stderr } else { stdout });
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
        ])?;
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
        let output = shell_command("git", &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git rev-parse: {}", e))?;
        if !output.status.success() {
            // No upstream configured — not an error, just absent
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

        // Refuse to pull when the working tree is dirty — merges on top of uncommitted
        // changes leave the user in a messy state. Better to fail fast with advice.
        let dirty = run_git(&path, &["status", "--porcelain"])?;
        if !dirty.trim().is_empty() {
            return Err(
                "Working tree has uncommitted changes — commit or stash first, then pull.".into(),
            );
        }

        let mut args: Vec<&str> = vec!["pull"];
        match strategy {
            PullStrategy::Merge => {}
            PullStrategy::Rebase => args.push("--rebase"),
            PullStrategy::FfOnly => args.push("--ff-only"),
        }
        args.push("--");
        args.push(&remote);
        args.push(&branch);

        let output = shell_command("git", &args)
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git pull: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() {
            return Err(if !stderr.is_empty() { stderr } else { stdout });
        }
        // Surface the combined output so the UI can show "Already up to date." or merge summary.
        let combined = if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Ok(combined)
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
        let bytes = match std::fs::read(&pkg_path) {
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
                    break;
                }
            }
            if let Ok(mut manager) = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                terminals_arc.lock(),
            ).await {
                let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
            }
            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({ "id": terminal_id })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
            }
        });

        Ok(config)
    })
    .await
}

/// Spawn an interactive shell terminal at `cwd`. No claude. The terminal
/// behaves like create_terminal otherwise — emits `terminal-output` /
/// `terminal-finished` events and accepts input via `write_to_terminal`.
#[command]
pub async fn create_shell_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    cwd: String,
) -> Result<crate::terminal::TerminalConfig, String> {
    wrap_cmd("create_shell_terminal", async move {
        validate_path_is_trusted(&state, &cwd).await?;

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
                    break;
                }
            }
            if let Ok(mut manager) = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                terminals_arc.lock(),
            ).await {
                let _ = manager.update_status(&terminal_id, crate::terminal::TerminalStatus::Stopped);
            }
            if let Err(e) = app_clone.emit("terminal-finished", serde_json::json!({ "id": terminal_id })) {
                eprintln!("Failed to emit terminal-finished: {}", e);
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
        if file.is_empty() || file.starts_with('-') {
            return Err("Invalid file path".to_string());
        }
        // git uses forward slashes in ref specs, even on Windows.
        let normalized = file.replace('\\', "/");
        let spec = format!("HEAD:{}", normalized);
        let output = shell_command("git", &["show", &spec])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git show: {}", e))?;
        if !output.status.success() {
            // File has no HEAD version — treat as empty (new/untracked file).
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
            return Err("Invalid file path".to_string());
        }

        if untracked {
            // Untracked files/directories aren't tracked by git — just remove from disk.
            // `file` is relative to `path`. Resolve and sanity-check it ends up inside
            // the repo to avoid `..` escapes.
            let joined = std::path::Path::new(&path).join(&file);
            let canonical_target = joined.canonicalize().map_err(|e| {
                format!("Cannot resolve '{}': {}", joined.display(), e)
            })?;
            let canonical_root = std::path::Path::new(&path)
                .canonicalize()
                .map_err(|e| format!("Cannot resolve repo '{}': {}", path, e))?;
            if !canonical_target.starts_with(&canonical_root) {
                return Err(format!(
                    "Refusing to delete path outside repo: {}",
                    canonical_target.display()
                ));
            }
            let meta = std::fs::metadata(&canonical_target)
                .map_err(|e| format!("Failed to stat '{}': {}", canonical_target.display(), e))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&canonical_target)
                    .map_err(|e| format!("Failed to delete directory: {}", e))?;
            } else {
                std::fs::remove_file(&canonical_target)
                    .map_err(|e| format!("Failed to delete file: {}", e))?;
            }
            return Ok(());
        }

        // Tracked file — reset index + worktree for just this file to HEAD.
        let output = shell_command("git", &["checkout", "HEAD", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Err(if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "git checkout failed".into() });
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

/// List the immediate children of a directory. Does NOT recurse — the UI
/// requests children lazily when the user expands a folder.
#[command]
pub async fn list_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<DirEntryInfo>, String> {
    wrap_cmd("list_directory", async move {
        validate_path_is_trusted(&state, &path).await?;

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

        let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat file: {}", e))?;
        if meta.is_dir() {
            return Err("Path is a directory".to_string());
        }
        const MAX_BYTES: u64 = 5 * 1024 * 1024; // 5 MB
        if meta.len() > MAX_BYTES {
            return Err(format!(
                "File is too large to edit in-app ({} bytes, max {}).",
                meta.len(),
                MAX_BYTES
            ));
        }

        let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
        // Quick binary sniff: any NUL byte in the first 8 KB → binary.
        let sniff_len = bytes.len().min(8192);
        if bytes[..sniff_len].contains(&0u8) {
            return Err("File appears to be binary and cannot be edited as text.".to_string());
        }
        String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8.".to_string())
    })
    .await
}

/// Write UTF-8 text back to a file. Refuses to create new paths — the file must
/// already exist in a trusted location.
#[command]
pub async fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    wrap_cmd("write_text_file", async move {
        validate_path_is_trusted(&state, &path).await?;

        let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat file: {}", e))?;
        if meta.is_dir() {
            return Err("Path is a directory".to_string());
        }
        std::fs::write(&path, content.as_bytes()).map_err(|e| format!("Failed to write file: {}", e))?;
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

        let root = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| format!("Invalid root: {}", e))?;
        if !root.is_dir() {
            return Err("Search root is not a directory".to_string());
        }

        let query_lower = query.to_lowercase();
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

        Ok(SearchSummary {
            total_files: results.len() as u32,
            total_matches,
            truncated: !completed,
            results,
        })
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
        // tag without dotted numerics) — return what we got.
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
