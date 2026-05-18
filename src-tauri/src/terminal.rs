use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::thread::JoinHandle;
use tokio::sync::mpsc;
use uuid::Uuid;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    pub id: String,
    pub label: String,
    pub nickname: Option<String>,
    pub profile_id: Option<String>,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub created_at: DateTime<Utc>,
    pub status: TerminalStatus,
    pub color_tag: Option<String>,
    /// UUID of the Claude Code session this terminal is bound to, if we were
    /// able to detect it after spawn. Persisted with the session-restore row
    /// so the next launch can re-attach the conversation via `--resume <id>`.
    /// `serde(default)` keeps existing rows from older builds deserializable.
    #[serde(default)]
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TerminalStatus {
    Running,
    Idle,
    Error,
    Stopped,
}

pub struct Terminal {
    pub config: TerminalConfig,
    /// Kept alive to maintain the PTY connection
    pub pty_pair: PtyPair,
    pub writer: Box<dyn Write + Send>,
    /// Handle to the reader thread for cleanup on close
    pub reader_handle: Option<JoinHandle<()>>,
}

pub struct TerminalManager {
    pub terminals: HashMap<String, Terminal>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
        }
    }

    /// Characters that could enable shell injection when passed through `cmd /C` or `sh -c`
    const SHELL_METACHARACTERS: &'static [char] = &[
        '&', '|', ';', '`', '$', '(', ')', '{', '}', '<', '>', '^', '\n', '\r',
        '\'', '"', '\\', '~', '*', '?', '[', ']', '!', '\t', '#',
    ];

    /// Environment variable names that must not be overridden by user profiles
    const BLOCKED_ENV_VARS: &'static [&'static str] = &[
        "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR",
        "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
        "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
        "ELECTRON_RUN_AS_NODE",
        "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    ];

    pub fn create_terminal(
        &mut self,
        label: String,
        working_directory: String,
        claude_args: Vec<String>,
        env_vars: HashMap<String, String>,
        color_tag: Option<String>,
        nickname: Option<String>,
        tx: mpsc::Sender<(String, Vec<u8>)>,
        log_file_path: Option<String>,
        resume_session_id: Option<String>,
        continue_recent: bool,
    ) -> Result<TerminalConfig, String> {
        // Validate claude_args: reject any argument containing shell metacharacters
        for arg in &claude_args {
            if arg.contains(Self::SHELL_METACHARACTERS) {
                return Err(format!(
                    "Invalid character in argument: \"{}\". Shell metacharacters are not allowed.",
                    arg
                ));
            }
        }

        // Inject a resume flag for spawn-only — `claude_args` persisted on
        // the config stays untouched so the next restore can re-decide which
        // flag to inject.
        // `--resume <id>` wins over `--continue` when we have an exact id;
        // both are exclusive of plain (no-flag) spawn.
        // The session id is a UUID Claude generates, but we still run it
        // through the metacharacter check as defense-in-depth.
        let injected: Vec<String> = if let Some(id) = resume_session_id.as_deref() {
            if id.contains(Self::SHELL_METACHARACTERS) {
                return Err("Invalid session id".to_string());
            }
            vec!["--resume".to_string(), id.to_string()]
        } else if continue_recent {
            vec!["--continue".to_string()]
        } else {
            vec![]
        };
        let injected_len = injected.len();
        let claude_args: Vec<String> = if injected_len > 0 {
            let mut v = Vec::with_capacity(claude_args.len() + injected_len);
            v.extend(injected);
            v.extend(claude_args);
            v
        } else {
            claude_args
        };

        // Filter out blocked environment variables
        let safe_env_vars: HashMap<String, String> = env_vars
            .into_iter()
            .filter(|(key, _)| {
                let upper = key.to_uppercase();
                !Self::BLOCKED_ENV_VARS.iter().any(|blocked| blocked.eq_ignore_ascii_case(&upper))
            })
            .collect();

        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        // Spawn claude directly so the process exits when claude finishes,
        // allowing the terminal-finished event to fire for notifications
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("claude");
            for arg in &claude_args {
                c.arg(arg);
            }
            c
        };

        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            /// Shells allowed for PTY spawning on non-Windows platforms.
            const VALID_SHELLS: &[&str] = &[
                "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/fish", "/bin/dash",
                "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/dash",
                "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
                "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
            ];

            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            // Validate $SHELL against allowlist
            let shell = if VALID_SHELLS.contains(&shell.as_str()) {
                shell
            } else {
                "/bin/bash".to_string()
            };
            let mut c = CommandBuilder::new(&shell);
            // Build command string with shell-escaped args as defense-in-depth
            // (args are already validated against metacharacters above)
            let mut full_cmd = "claude".to_string();
            for arg in &claude_args {
                full_cmd.push(' ');
                // Single-quote wrap each arg; escape embedded single quotes
                full_cmd.push('\'');
                for ch in arg.chars() {
                    if ch == '\'' {
                        full_cmd.push_str("'\\''");
                    } else {
                        full_cmd.push(ch);
                    }
                }
                full_cmd.push('\'');
            }
            c.arg("-lc");
            c.arg(&full_cmd);
            c
        };

        // Set working directory
        if !working_directory.is_empty() {
            cmd.cwd(&working_directory);
        }

        // Set environment variables (blocked keys already filtered out)
        for (key, value) in &safe_env_vars {
            cmd.env(key, value);
        }

        // Spawn the command
        let _child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

        let id = Uuid::new_v4().to_string();
        let config = TerminalConfig {
            id: id.clone(),
            label,
            nickname,
            profile_id: None,
            working_directory,
            // Persist the *user-facing* args (without our injected resume
            // flags) so the next restore is free to re-decide.
            claude_args: if injected_len > 0 {
                claude_args.iter().skip(injected_len).cloned().collect()
            } else {
                claude_args.clone()
            },
            env_vars: safe_env_vars,
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag,
            claude_session_id: resume_session_id,
        };

        let mut reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pty_pair.master.take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Spawn reader thread
        let terminal_id = id.clone();
        let reader_handle = std::thread::spawn(move || {
            // 32 KB buffer — amortizes syscall overhead for high-throughput output
            // and reduces the number of IPC messages emitted to the frontend.
            let mut buf = [0u8; 32 * 1024];
            // Wrap the log file in a BufWriter so fs writes batch instead of
            // issuing one syscall per PTY chunk.
            let mut log_file = log_file_path.and_then(|path| {
                std::fs::File::create(&path)
                    .map_err(|e| eprintln!("Failed to create log file: {}", e))
                    .ok()
                    .map(|f| BufWriter::with_capacity(64 * 1024, f))
            });
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        // Write ANSI-stripped output to log file
                        if let Some(ref mut file) = log_file {
                            let stripped = strip_ansi_escapes::strip(&data);
                            let _ = file.write_all(&stripped);
                        }
                        if tx.blocking_send((terminal_id.clone(), data)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from pty: {}", e);
                        let _ = tx.blocking_send((
                            terminal_id.clone(),
                            format!("\r\n[Error reading from terminal: {}]\r\n", e).into_bytes(),
                        ));
                        break;
                    }
                }
            }
            // Flush any pending buffered log writes before the thread exits.
            if let Some(ref mut file) = log_file {
                let _ = file.flush();
            }
        });

        self.terminals.insert(
            id.clone(),
            Terminal {
                config: config.clone(),
                pty_pair,
                writer,
                reader_handle: Some(reader_handle),
            },
        );

        Ok(config)
    }

    /// Spawn a PTY running `npm run <script>` in the given working directory.
    /// Used by the package.json scripts runner. Reuses the same reader thread
    /// plumbing as `create_terminal` so frontend handling is unchanged.
    pub fn create_script_terminal(
        &mut self,
        label: String,
        working_directory: String,
        script_name: String,
        tx: mpsc::Sender<(String, Vec<u8>)>,
    ) -> Result<TerminalConfig, String> {
        // npm script names come from package.json keys but the user picks them
        // via UI, so reject any shell metacharacter as defense-in-depth.
        if script_name.is_empty() || script_name.contains(Self::SHELL_METACHARACTERS) {
            return Err(format!("Invalid script name: '{}'", script_name));
        }

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        #[cfg(target_os = "windows")]
        let cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("npm");
            c.arg("run");
            c.arg(&script_name);
            c
        };

        #[cfg(not(target_os = "windows"))]
        let cmd = {
            const VALID_SHELLS: &[&str] = &[
                "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/fish", "/bin/dash",
                "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/dash",
                "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
                "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
            ];
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell = if VALID_SHELLS.contains(&shell.as_str()) { shell } else { "/bin/bash".to_string() };
            let mut c = CommandBuilder::new(&shell);
            // Single-quote the script name as defense-in-depth (already validated above).
            let mut full = String::from("npm run '");
            for ch in script_name.chars() {
                if ch == '\'' { full.push_str("'\\''"); } else { full.push(ch); }
            }
            full.push('\'');
            c.arg("-lc");
            c.arg(&full);
            c
        };

        let mut cmd = cmd;
        if !working_directory.is_empty() {
            cmd.cwd(&working_directory);
        }

        let _child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn npm run {}: {}", script_name, e))?;

        let id = Uuid::new_v4().to_string();
        let config = TerminalConfig {
            id: id.clone(),
            label,
            nickname: Some(format!("npm run {}", script_name)),
            profile_id: None,
            working_directory,
            // Reuse claude_args to carry the script command — simplest fit for
            // restore / session history without adding another schema field.
            claude_args: vec!["__script__".into(), script_name.clone()],
            env_vars: HashMap::new(),
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
        };

        let mut reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pty_pair.master.take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let terminal_id = id.clone();
        let reader_handle = std::thread::spawn(move || {
            let mut buf = [0u8; 32 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if tx.blocking_send((terminal_id.clone(), data)).is_err() { break; }
                    }
                    Err(e) => {
                        let _ = tx.blocking_send((
                            terminal_id.clone(),
                            format!("\r\n[Error: {}]\r\n", e).into_bytes(),
                        ));
                        break;
                    }
                }
            }
        });

        self.terminals.insert(
            id.clone(),
            Terminal {
                config: config.clone(),
                pty_pair,
                writer,
                reader_handle: Some(reader_handle),
            },
        );

        Ok(config)
    }

    /// Spawn an interactive shell at `working_directory`. No `claude`, no
    /// `npm run` — just a plain shell the user can drive (run scripts, hit
    /// Ctrl+C to stop them, etc.). Reuses the same PTY/reader plumbing so
    /// `write_to_terminal` and `terminal-output` events Just Work.
    pub fn create_shell_terminal(
        &mut self,
        label: String,
        working_directory: String,
        tx: mpsc::Sender<(String, Vec<u8>)>,
    ) -> Result<TerminalConfig, String> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        #[cfg(target_os = "windows")]
        let cmd = {
            // ComSpec is whatever the user has set as their shell — typically
            // cmd.exe but could be PowerShell. Without /C the shell stays
            // interactive.
            let exe = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            CommandBuilder::new(exe)
        };

        #[cfg(not(target_os = "windows"))]
        let cmd = {
            const VALID_SHELLS: &[&str] = &[
                "/bin/bash", "/bin/sh", "/bin/zsh", "/bin/fish", "/bin/dash",
                "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/fish", "/usr/bin/dash",
                "/usr/local/bin/bash", "/usr/local/bin/zsh", "/usr/local/bin/fish",
                "/opt/homebrew/bin/bash", "/opt/homebrew/bin/zsh", "/opt/homebrew/bin/fish",
            ];
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let shell = if VALID_SHELLS.contains(&shell.as_str()) { shell } else { "/bin/bash".to_string() };
            let mut c = CommandBuilder::new(&shell);
            // Login + interactive so the user gets their normal prompt.
            c.arg("-li");
            c
        };

        let mut cmd = cmd;
        if !working_directory.is_empty() {
            cmd.cwd(&working_directory);
        }

        let _child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let id = Uuid::new_v4().to_string();
        let config = TerminalConfig {
            id: id.clone(),
            label,
            nickname: None,
            profile_id: None,
            working_directory,
            // Tag this terminal so persistence/restore can recognise it as a
            // plain shell — same trick create_script_terminal uses.
            claude_args: vec!["__shell__".into()],
            env_vars: HashMap::new(),
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
        };

        let mut reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pty_pair.master.take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let terminal_id = id.clone();
        let reader_handle = std::thread::spawn(move || {
            let mut buf = [0u8; 32 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if tx.blocking_send((terminal_id.clone(), data)).is_err() { break; }
                    }
                    Err(e) => {
                        let _ = tx.blocking_send((
                            terminal_id.clone(),
                            format!("\r\n[Error: {}]\r\n", e).into_bytes(),
                        ));
                        break;
                    }
                }
            }
        });

        self.terminals.insert(
            id.clone(),
            Terminal {
                config: config.clone(),
                pty_pair,
                writer,
                reader_handle: Some(reader_handle),
            },
        );

        Ok(config)
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal
                .writer
                .write_all(data)
                .map_err(|e| format!("Failed to write: {}", e))?;
            terminal.writer.flush().map_err(|e| format!("Failed to flush: {}", e))?;
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal
                .pty_pair
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Failed to resize: {}", e))?;
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn close(&mut self, id: &str) -> Result<(), String> {
        if let Some(terminal) = self.terminals.remove(id) {
            // Dropping the terminal drops the writer and PTY pair, which signals EOF
            // to the reader thread. The reader thread will exit on its next read attempt
            // and clean up asynchronously. We do NOT join the reader thread here because
            // on Windows, PTY reads can block indefinitely even after the writer is dropped,
            // which would deadlock the mutex and freeze the entire application.
            drop(terminal);
        }
        Ok(())
    }

    pub fn close_all(&mut self) {
        // Clear all terminals at once — reader threads clean up asynchronously
        self.terminals.clear();
    }

    pub fn get_all_configs(&self) -> Vec<TerminalConfig> {
        self.terminals.values().map(|t| t.config.clone()).collect()
    }

    pub fn update_label(&mut self, id: &str, label: String) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.label = label;
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn update_status(&mut self, id: &str, status: TerminalStatus) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.status = status;
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    pub fn update_nickname(&mut self, id: &str, nickname: String) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.nickname = Some(nickname);
            Ok(())
        } else {
            Err("Terminal not found".to_string())
        }
    }

    /// Attach the detected Claude session id to a live terminal. Silent
    /// no-op when the terminal has already been closed — detection races
    /// the user, and a stale write here shouldn't surface as an error.
    pub fn update_claude_session_id(&mut self, id: &str, session_id: String) {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.claude_session_id = Some(session_id);
        }
    }
}
