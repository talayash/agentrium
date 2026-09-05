use portable_pty::{native_pty_system, Child, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::thread::JoinHandle;
use tokio::sync::mpsc;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use crate::error_reporter;

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
    /// Which agent CLI this terminal launched. `#[serde(default)]` so
    /// restored rows from before this field existed migrate to Claude.
    #[serde(default)]
    pub agent: crate::config::AgentKind,
    /// Credentials this terminal was launched with, by id only. Session
    /// restore re-resolves them from the OS store; values are never stored.
    #[serde(default)]
    pub credential_bindings: Vec<crate::config::CredentialBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TerminalStatus {
    Running,
    Idle,
    Error,
    Stopped,
}

/// True when a PTY read error is just the normal teardown of a closing terminal
/// rather than a genuine mid-session failure. On Windows, killing the child (see
/// `close`) or the user exiting tears the pipe down and surfaces as a broken-pipe
/// / invalid-handle error on the reader's next read instead of a clean EOF. We
/// treat those as EOF: break quietly, without an error banner or telemetry.
fn is_benign_close_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    if matches!(e.kind(), ErrorKind::BrokenPipe | ErrorKind::UnexpectedEof) {
        return true;
    }
    // Windows: ERROR_INVALID_HANDLE (6), ERROR_BROKEN_PIPE (109),
    // ERROR_NO_DATA / "pipe is being closed" (232).
    matches!(e.raw_os_error(), Some(6) | Some(109) | Some(232))
}

/// Resolve the binary + arg list for a resolved agent spec. Args are cloned
/// so callers keep ownership of the original vec.
pub fn build_agent_command(spec: &crate::agents::AgentSpec, args: &[String]) -> (String, Vec<String>) {
    (spec.binary.clone(), args.to_vec())
}

/// The bits `create_terminal` injects to open a prior conversation for a
/// given agent. `subcommand` is prepended as the first positional (Codex
/// uses `codex resume <id> ...`). `leading` goes after the subcommand
/// (if any) and before the user's persisted args.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResumeInjection {
    pub subcommand: Option<String>,
    pub leading: Vec<String>,
}

/// Compute the resume/continue argv injection for `agent`. Returns an
/// empty injection when neither a session id nor `continue_recent` is set.
pub(crate) fn resume_flags_for(
    spec: &crate::agents::AgentSpec,
    resume_id: Option<&str>,
    continue_recent: bool,
) -> ResumeInjection {
    use crate::config::AgentKind;
    match (&spec.kind, resume_id) {
        // Claude: `--resume=<id>` is the only safe binding form because
        // Commander.js parses `--resume <id>` as "open picker" plus a
        // stray positional (see the existing comment we inherited).
        (AgentKind::Claude, Some(id)) => ResumeInjection {
            subcommand: None,
            leading: vec![format!("--resume={}", id)],
        },
        (AgentKind::Claude, None) if continue_recent => ResumeInjection {
            subcommand: None,
            leading: vec!["--continue".to_string()],
        },
        // Codex: subcommand form `codex resume <id>` / `codex resume --last`.
        (AgentKind::Codex, Some(id)) => ResumeInjection {
            subcommand: Some("resume".to_string()),
            leading: vec![id.to_string()],
        },
        (AgentKind::Codex, None) if continue_recent => ResumeInjection {
            subcommand: Some("resume".to_string()),
            leading: vec!["--last".to_string()],
        },
        // Cursor: standard `--resume <id>` / `--continue` (space separator).
        (AgentKind::Cursor, Some(id)) => ResumeInjection {
            subcommand: None,
            leading: vec!["--resume".to_string(), id.to_string()],
        },
        (AgentKind::Cursor, None) if continue_recent => ResumeInjection {
            subcommand: None,
            leading: vec!["--continue".to_string()],
        },
        // Antigravity: `--conversation <id>` / `--continue`.
        (AgentKind::Antigravity, Some(id)) => ResumeInjection {
            subcommand: None,
            leading: vec!["--conversation".to_string(), id.to_string()],
        },
        (AgentKind::Antigravity, None) if continue_recent => ResumeInjection {
            subcommand: None,
            leading: vec!["--continue".to_string()],
        },
        // Custom agents: render the user's template. `{id}` templates need an
        // id; templates without `{id}` are the "continue recent" form and only
        // fire on `continue_recent`. A leading token that is not a flag is a
        // subcommand (Codex-style `resume <id>`).
        (AgentKind::Custom(_), _) => {
            let Some(tpl) = spec.resume_flag.as_deref() else {
                return ResumeInjection::default();
            };
            let has_id = tpl.contains("{id}");
            let rendered = match (has_id, resume_id) {
                (true, Some(id)) => tpl.replace("{id}", id),
                (false, None) if continue_recent => tpl.to_string(),
                _ => return ResumeInjection::default(),
            };
            let mut tokens: Vec<String> = rendered.split_whitespace().map(String::from).collect();
            let subcommand = match tokens.first() {
                Some(first) if !first.starts_with('-') => Some(tokens.remove(0)),
                _ => None,
            };
            ResumeInjection { subcommand, leading: tokens }
        }
        _ => ResumeInjection::default(),
    }
}

pub struct Terminal {
    pub config: TerminalConfig,
    /// Kept alive to maintain the PTY connection
    pub pty_pair: PtyPair,
    pub writer: Box<dyn Write + Send>,
    /// The spawned child process. Kept so `close()` can `kill()` it: on Windows
    /// a ConPTY read can block indefinitely after the writer/PTY is dropped, so
    /// relying on EOF alone leaks the reader thread and orphans the process.
    /// Killing the child forces EOF and lets the reader thread exit.
    pub child: Box<dyn Child + Send + Sync>,
    /// Handle to the reader thread for cleanup on close
    pub reader_handle: Option<JoinHandle<()>>,
    /// When this terminal last received user input (any `write()`). The
    /// session-detection watcher only binds a newly-appeared session file to a
    /// terminal that was recently typed in - a Claude session file is created
    /// on a user turn, so an idle terminal can't own a brand-new file.
    pub last_input_at: Option<std::time::Instant>,
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
    pub(crate) const SHELL_METACHARACTERS: &'static [char] = &[
        '&', '|', ';', '`', '$', '(', ')', '{', '}', '<', '>', '^', '\n', '\r',
        '\'', '"', '\\', '~', '*', '?', '[', ']', '!', '\t', '#',
    ];

    /// Known Claude Code model aliases. Only these values may contain `[`/`]`
    /// (the 1M-context variants use that form: `opus[1m]`, `sonnet[1m]`).
    /// Kept in sync with src/lib/claudeModels.ts - update both together.
    const KNOWN_CLAUDE_MODEL_ALIASES: &'static [&'static str] = &[
        "default", "fable", "opus", "opus[1m]", "opusplan",
        "sonnet", "sonnet[1m]", "haiku",
    ];

    /// Environment variable names that must not be overridden by user profiles
    pub(crate) const BLOCKED_ENV_VARS: &'static [&'static str] = &[
        "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR",
        "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
        "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
        "ELECTRON_RUN_AS_NODE",
        "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    ];

    // The PTY spawn path genuinely needs all of these to avoid an intermediate
    // struct that would just push the complexity elsewhere.
    #[allow(clippy::too_many_arguments)]
    pub fn create_terminal(
        &mut self,
        label: String,
        spec: crate::agents::AgentSpec,
        working_directory: String,
        claude_args: Vec<String>,
        env_vars: HashMap<String, String>,
        secret_env_vars: HashMap<String, String>,
        credential_bindings: Vec<crate::config::CredentialBinding>,
        color_tag: Option<String>,
        nickname: Option<String>,
        tx: mpsc::Sender<(String, Vec<u8>)>,
        log_file_path: Option<String>,
        resume_session_id: Option<String>,
        continue_recent: bool,
        // `http://127.0.0.1:<port>` base of the embedded OTLP receiver, or
        // None when cost tracking is disabled / the receiver failed to start.
        otel_endpoint: Option<String>,
    ) -> Result<TerminalConfig, String> {
        // Validate claude_args: reject any argument containing shell
        // metacharacters. Narrow exception: bracketed known-model aliases
        // (`sonnet[1m]`, `opus[1m]`) are legitimate Claude CLI inputs and
        // are the only way to reach 1M-context variants. `[` / `]` are
        // still blocked in every other position.
        for (i, arg) in claude_args.iter().enumerate() {
            let prev = if i > 0 { claude_args.get(i - 1).map(|s| s.as_str()) } else { None };
            let bare_known_model = prev == Some("--model")
                && Self::KNOWN_CLAUDE_MODEL_ALIASES.contains(&arg.as_str());
            let eq_known_model = arg.strip_prefix("--model=")
                .map(|v| Self::KNOWN_CLAUDE_MODEL_ALIASES.contains(&v))
                .unwrap_or(false);
            if bare_known_model || eq_known_model {
                continue;
            }
            if arg.contains(Self::SHELL_METACHARACTERS) {
                return Err(error_reporter::user_err(format!(
                    "Invalid character in argument: \"{}\". Shell metacharacters are not allowed.",
                    arg
                )));
            }
        }

        // Inject resume flags per-agent. Any injection is spawn-only: the
        // persisted `claude_args` on the config stay untouched so the next
        // restore is free to re-decide which mode to use.
        // Defense-in-depth: any session id must be free of shell metachars.
        if let Some(id) = resume_session_id.as_deref() {
            if id.contains(Self::SHELL_METACHARACTERS) {
                return Err(error_reporter::user_err("Invalid session id"));
            }
        }
        let injection = resume_flags_for(&spec, resume_session_id.as_deref(), continue_recent);
        let injected_len = injection.subcommand.as_ref().map_or(0, |_| 1) + injection.leading.len();
        let claude_args: Vec<String> = if injected_len > 0 {
            let mut v = Vec::with_capacity(claude_args.len() + injected_len);
            if let Some(sub) = injection.subcommand.clone() { v.push(sub); }
            v.extend(injection.leading.iter().cloned());
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

        let safe_secret_env: HashMap<String, String> = secret_env_vars
            .into_iter()
            .filter(|(key, _)| {
                let upper = key.to_uppercase();
                !Self::BLOCKED_ENV_VARS.iter().any(|blocked| blocked.eq_ignore_ascii_case(&upper))
            })
            .collect();

        // Generate the id early so it can be injected as an OTel resource
        // attribute (terminal.id) - the receiver routes metrics back by it.
        let id = Uuid::new_v4().to_string();

        let pty_system = native_pty_system();

        let pty_pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open pty: {}", e))?;

        // DIAG(pty-size): trace initial PTY size vs. subsequent xterm resizes to
        // catch the "burn" bug (ghost characters after /clear). Remove after fix.
        eprintln!(
            "[pty-size] {} create id={} cols=120 rows=30 (initial spawn)",
            Utc::now().format("%H:%M:%S%.3f"),
            id
        );

        // Resolve which agent binary to launch. `build_agent_command` returns
        // the binary name and echoes the args back so we can hand them to
        // CommandBuilder platform-appropriately.
        let (agent_binary, spawn_args) = build_agent_command(&spec, &claude_args);

        // Spawn the agent binary directly so the process exits when it
        // finishes, allowing the terminal-finished event to fire for
        // notifications.
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg(&agent_binary);
            for arg in &spawn_args {
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
            let mut full_cmd = agent_binary.clone();
            for arg in &spawn_args {
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

        // Bindings win over profile env vars with the same name.
        for (key, value) in &safe_secret_env {
            cmd.env(key, value);
        }

        // Claude Code is the only agent that speaks the OTel env-var protocol
        // we ship with. Codex ignores these, but injecting them is harmless -
        // still, we skip to keep the process env clean and to make the intent
        // obvious to future readers.
        if spec.kind == crate::config::AgentKind::Claude {
            if let Some(endpoint) = otel_endpoint.as_deref() {
                cmd.env("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
                cmd.env("OTEL_METRICS_EXPORTER", "otlp");
                cmd.env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
                cmd.env("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/json");
                cmd.env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
                cmd.env("OTEL_EXPORTER_OTLP_COMPRESSION", "none");
                // 3s export interval ≈ near-real-time without hammering (default 60s).
                cmd.env("OTEL_METRIC_EXPORT_INTERVAL", "3000");
                cmd.env("OTEL_METRICS_INCLUDE_SESSION_ID", "true");
                cmd.env("OTEL_RESOURCE_ATTRIBUTES", format!("terminal.id={}", id));
            }
        }

        // Spawn the command
        let child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command: {}", e))?;

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
            agent: spec.kind.clone(),
            credential_bindings,
        };

        let mut reader = pty_pair.master.try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pty_pair.master.take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Spawn reader thread
        let terminal_id = id.clone();
        let reader_handle = std::thread::spawn(move || {
            // 32 KB buffer - amortizes syscall overhead for high-throughput output
            // and reduces the number of IPC messages emitted to the frontend.
            let mut buf = [0u8; 32 * 1024];
            // Wrap the log file in a BufWriter so fs writes batch instead of
            // issuing one syscall per PTY chunk.
            let mut log_file = log_file_path.and_then(|path| {
                std::fs::File::create(&path)
                    .map_err(|e| {
                        // Without this file the whole session transcript is
                        // silently unrecorded (history/summarize come up empty).
                        eprintln!("Failed to create log file: {}", e);
                        error_reporter::report_bg(
                            "session_log_create",
                            format!("Failed to create session log file: {}", e),
                        );
                    })
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
                        // Normal close/teardown (esp. Windows ConPTY after the
                        // child is killed) surfaces as a read error rather than
                        // EOF - exit quietly, no banner, no telemetry.
                        if is_benign_close_error(&e) {
                            break;
                        }
                        eprintln!("Error reading from pty: {}", e);
                        // Capture so we hear about broken-mid-session terminals.
                        // report_bg (not report_blocking) so the user-visible
                        // error line below isn't delayed behind a network send.
                        // The 60s dedup window in the reporter collapses
                        // repeated identical errors.
                        error_reporter::report_bg("pty_reader_error", e.to_string());
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
                child,
                reader_handle: Some(reader_handle),
                last_input_at: None,
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
            return Err(error_reporter::user_err(format!(
                "Invalid script name: '{}'",
                script_name
            )));
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

        let child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn npm run {}: {}", script_name, e))?;

        let id = Uuid::new_v4().to_string();
        let config = TerminalConfig {
            id: id.clone(),
            label,
            nickname: Some(format!("npm run {}", script_name)),
            profile_id: None,
            working_directory,
            // Reuse claude_args to carry the script command - simplest fit for
            // restore / session history without adding another schema field.
            claude_args: vec!["__script__".into(), script_name.clone()],
            env_vars: HashMap::new(),
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
            agent: crate::config::AgentKind::Claude,
            credential_bindings: Vec::new(),
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
                        // Quiet exit on normal close teardown (see the claude
                        // reader above); only surface genuine mid-session errors.
                        if is_benign_close_error(&e) {
                            break;
                        }
                        error_reporter::report_bg(
                            "pty_reader_error",
                            format!("script terminal: {}", e),
                        );
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
                child,
                reader_handle: Some(reader_handle),
                last_input_at: None,
            },
        );

        Ok(config)
    }

    /// Spawn an interactive shell at `working_directory`. No `claude`, no
    /// `npm run` - just a plain shell the user can drive (run scripts, hit
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
            // ComSpec is whatever the user has set as their shell - typically
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

        let child = pty_pair.slave.spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let id = Uuid::new_v4().to_string();
        let config = TerminalConfig {
            id: id.clone(),
            label,
            nickname: None,
            profile_id: None,
            working_directory,
            // Tag this terminal so persistence/restore can recognise it as a
            // plain shell - same trick create_script_terminal uses.
            claude_args: vec!["__shell__".into()],
            env_vars: HashMap::new(),
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
            agent: crate::config::AgentKind::Claude,
            credential_bindings: Vec::new(),
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
                        // Quiet exit on normal close teardown (see the claude
                        // reader above); only surface genuine mid-session errors.
                        if is_benign_close_error(&e) {
                            break;
                        }
                        error_reporter::report_bg(
                            "pty_reader_error",
                            format!("shell terminal: {}", e),
                        );
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
                child,
                reader_handle: Some(reader_handle),
                last_input_at: None,
            },
        );

        Ok(config)
    }

    /// Silent no-op when the id is no longer in the map. xterm.js can dispatch
    /// a final keystroke after `close_terminal` removes the entry, and surfacing
    /// that as `Err("Terminal not found")` produced a flood of telemetry events
    /// plus a frontend UnhandledRejection from the resize observer's callback -
    /// see error fingerprints 599c11f8 / 808a0ce1.
    ///
    /// Also a no-op once the terminal is Stopped: the tab stays open for
    /// scrollback after the child exits, so keystrokes keep arriving while the
    /// ConPTY pipe is dead - writing there fails with os error 232 ("the pipe
    /// is being closed", fingerprint 6c5825d1). A BrokenPipe error while still
    /// Running is the same exit, one tick before the reader thread flips the
    /// status - mark it Stopped and swallow it.
    pub fn write(&mut self, id: &str, data: &[u8]) -> Result<(), String> {
        let Some(terminal) = self.terminals.get_mut(id) else {
            return Ok(());
        };
        if terminal.config.status == TerminalStatus::Stopped {
            return Ok(());
        }
        terminal.last_input_at = Some(std::time::Instant::now());
        let result = terminal
            .writer
            .write_all(data)
            .map_err(|e| (e.kind(), format!("Failed to write: {}", e)))
            .and_then(|_| {
                terminal
                    .writer
                    .flush()
                    .map_err(|e| (e.kind(), format!("Failed to flush: {}", e)))
            });
        match result {
            Ok(()) => Ok(()),
            Err((std::io::ErrorKind::BrokenPipe, _)) => {
                terminal.config.status = TerminalStatus::Stopped;
                Ok(())
            }
            Err((_, msg)) => Err(msg),
        }
    }

    /// Silent no-op when the id is no longer in the map. The ResizeObserver in
    /// TerminalView fires once more after the close_terminal call removes the
    /// entry; we don't want that race to produce an error report.
    ///
    /// Also a no-op once the terminal is Stopped: resizing a dead ConPTY fails
    /// with HRESULT 0x800700E8 ("the pipe is being closed") when the window is
    /// resized while a finished tab is showing scrollback - fingerprints
    /// 3a3f899b / 590a2e40.
    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let Some(terminal) = self.terminals.get_mut(id) else {
            return Ok(());
        };
        if terminal.config.status == TerminalStatus::Stopped {
            return Ok(());
        }
        // DIAG(pty-size): remove after burn-in bug is resolved.
        eprintln!(
            "[pty-size] {} resize id={} cols={} rows={}",
            Utc::now().format("%H:%M:%S%.3f"),
            id,
            cols,
            rows
        );
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
    }

    pub fn close(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut terminal) = self.terminals.remove(id) {
            // Kill the child process first. On Windows a ConPTY read can block
            // indefinitely even after the writer/PTY is dropped, so EOF alone
            // is not guaranteed - the reader thread (and the process itself)
            // would leak. Killing the child forces the read to unblock so the
            // thread exits.
            let _ = terminal.child.kill();
            // Move the child + reader handle onto a detached reaper thread so
            // wait() actually runs (avoids Unix zombies) and the reader thread
            // completes before app exit (avoids leaked JoinHandles). Bounded
            // so a stuck reader can't keep the reaper alive forever.
            reap_terminal(terminal.child, terminal.reader_handle.take());
        }
        Ok(())
    }

    pub fn close_all(&mut self) {
        // Kill every child so their reader threads unblock, move each to a
        // reaper, and clear. On app shutdown the reapers race the process
        // exit - bounded joins mean we don't hang the shutdown.
        let drained: Vec<Terminal> = self.terminals.drain().map(|(_, t)| t).collect();
        for mut terminal in drained {
            let _ = terminal.child.kill();
            reap_terminal(terminal.child, terminal.reader_handle.take());
        }
    }

    pub fn get_all_configs(&self) -> Vec<TerminalConfig> {
        self.terminals.values().map(|t| t.config.clone()).collect()
    }

    pub fn update_label(&mut self, id: &str, label: String) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.label = label;
            Ok(())
        } else {
            // Close-race condition, not a defect: keep surfacing to the UI
            // but skip telemetry.
            Err(error_reporter::user_err("Terminal not found"))
        }
    }

    // (See `reap_terminal` free function below.)

    pub fn update_status(&mut self, id: &str, status: TerminalStatus) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.status = status;
            Ok(())
        } else {
            Err(error_reporter::user_err("Terminal not found"))
        }
    }

    pub fn update_nickname(&mut self, id: &str, nickname: String) -> Result<(), String> {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.nickname = Some(nickname);
            Ok(())
        } else {
            Err(error_reporter::user_err("Terminal not found"))
        }
    }

    /// Attach the detected Claude session id to a live terminal. Silent
    /// no-op when the terminal has already been closed - detection races
    /// the user, and a stale write here shouldn't surface as an error.
    pub fn update_claude_session_id(&mut self, id: &str, session_id: String) {
        if let Some(terminal) = self.terminals.get_mut(id) {
            terminal.config.claude_session_id = Some(session_id);
        }
    }
}

/// Detached cleanup for a closed terminal.
///
/// Historically `close()` killed the child but never `wait()`ed it and
/// dropped the reader `JoinHandle` without joining - on Unix this left
/// zombies; on Windows a stuck reader thread outlived the tab. Move the
/// remaining teardown onto its own thread so the caller (holding the
/// TerminalManager mutex) returns immediately, and cap the joins so a
/// pathological reader can't keep the process alive on shutdown.
fn reap_terminal(
    mut child: Box<dyn Child + Send + Sync>,
    reader_handle: Option<JoinHandle<()>>,
) {
    std::thread::spawn(move || {
        // wait() reaps the process on Unix and returns the exit status on
        // Windows. Errors are expected on already-dead children - just drop.
        let _ = child.wait();
        if let Some(h) = reader_handle {
            // Join with a short deadline so a wedged read (Windows ConPTY
            // pathological case) doesn't keep this thread alive forever.
            // We give the reader 2s to notice EOF/kill and then detach.
            let start = std::time::Instant::now();
            const JOIN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);
            while !h.is_finished() {
                if start.elapsed() > JOIN_DEADLINE {
                    // Detach: dropping JoinHandle leaks the OS thread, but the
                    // process is either single-terminal-closing (rare) or
                    // shutting down (thread dies with process). Both are fine.
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let _ = h.join();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writer that fails every write the way a dead ConPTY pipe does on
    /// Windows (os error 232 maps to ErrorKind::BrokenPipe).
    struct BrokenPipeWriter;

    impl Write for BrokenPipeWriter {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "The pipe is being closed. (os error 232)",
            ))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn insert_test_terminal(
        mgr: &mut TerminalManager,
        id: &str,
        status: TerminalStatus,
        writer: Box<dyn Write + Send>,
    ) {
        let pty_pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .expect("openpty failed in test");
        // The Terminal struct owns its child handle (close() kills it); spawn
        // a trivial short-lived process to fill the field.
        #[cfg(target_os = "windows")]
        let cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("exit");
            c
        };
        #[cfg(not(target_os = "windows"))]
        let cmd = CommandBuilder::new("true");
        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .expect("spawn test child failed");
        mgr.terminals.insert(
            id.to_string(),
            Terminal {
                config: TerminalConfig {
                    id: id.to_string(),
                    label: "test".to_string(),
                    nickname: None,
                    profile_id: None,
                    working_directory: String::new(),
                    claude_args: vec![],
                    env_vars: HashMap::new(),
                    created_at: Utc::now(),
                    status,
                    color_tag: None,
                    claude_session_id: None,
                    agent: crate::config::AgentKind::Claude,
                    credential_bindings: Vec::new(),
                },
                pty_pair,
                writer,
                child,
                reader_handle: None,
                last_input_at: None,
            },
        );
    }

    #[test]
    fn write_is_noop_when_terminal_stopped() {
        let mut mgr = TerminalManager::new();
        // BrokenPipeWriter errors on any write attempt, so Ok proves the
        // Stopped guard skipped the write entirely.
        insert_test_terminal(&mut mgr, "t", TerminalStatus::Stopped, Box::new(BrokenPipeWriter));
        assert_eq!(mgr.write("t", b"hello"), Ok(()));
    }

    #[test]
    fn write_broken_pipe_marks_stopped_and_returns_ok() {
        // The child died but the reader thread hasn't flipped status yet -
        // the write hits the dead pipe. That's the process-exit race, not a
        // bug worth a telemetry event (fingerprint 6c5825d1).
        let mut mgr = TerminalManager::new();
        insert_test_terminal(&mut mgr, "t", TerminalStatus::Running, Box::new(BrokenPipeWriter));
        assert_eq!(mgr.write("t", b"hello"), Ok(()));
        assert_eq!(mgr.terminals.get("t").unwrap().config.status, TerminalStatus::Stopped);
    }

    #[test]
    fn write_non_pipe_error_still_surfaces() {
        struct DeniedWriter;
        impl Write for DeniedWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut mgr = TerminalManager::new();
        insert_test_terminal(&mut mgr, "t", TerminalStatus::Running, Box::new(DeniedWriter));
        assert!(mgr.write("t", b"hello").is_err());
    }

    #[test]
    fn arg_validation_errors_are_tagged_as_user_errors() {
        // Validation failures are user input problems, not defects - they
        // must carry the user_err marker so wrap_cmd skips telemetry.
        let mut mgr = TerminalManager::new();
        let (tx, _rx) = mpsc::channel(1);
        let err = mgr
            .create_terminal(
                "l".into(),
                crate::agents::builtin_spec(&crate::config::AgentKind::Claude).unwrap(),
                String::new(),
                vec!["--flag&&evil".into()],
                HashMap::new(),
                HashMap::new(),
                Vec::new(),
                None,
                None,
                tx,
                None,
                None,
                false,
                None,
            )
            .unwrap_err();
        assert!(crate::error_reporter::is_user_error(&err));

        let (tx2, _rx2) = mpsc::channel(1);
        let err = mgr
            .create_script_terminal("l".into(), String::new(), "bad;name".into(), tx2)
            .unwrap_err();
        assert!(crate::error_reporter::is_user_error(&err));
    }

    #[test]
    fn resize_is_noop_when_terminal_stopped() {
        let mut mgr = TerminalManager::new();
        insert_test_terminal(&mut mgr, "t", TerminalStatus::Stopped, Box::new(BrokenPipeWriter));
        assert_eq!(mgr.resize("t", 172, 31), Ok(()));
    }

    #[test]
    fn write_returns_ok_when_terminal_missing() {
        let mut mgr = TerminalManager::new();
        assert_eq!(mgr.write("does-not-exist", b"hello"), Ok(()));
    }

    #[test]
    fn resize_returns_ok_when_terminal_missing() {
        let mut mgr = TerminalManager::new();
        assert_eq!(mgr.resize("does-not-exist", 120, 30), Ok(()));
    }

    #[test]
    fn label_and_nickname_updates_still_error_when_missing() {
        // These commands aren't on the close-race path; we want them to keep
        // surfacing real bugs.
        let mut mgr = TerminalManager::new();
        assert!(mgr.update_label("nope", "x".to_string()).is_err());
        assert!(mgr.update_nickname("nope", "x".to_string()).is_err());
    }

    #[test]
    fn build_agent_command_uses_claude_binary_for_claude() {
        let (bin, args) = build_agent_command(&crate::agents::builtin_spec(&crate::config::AgentKind::Claude).unwrap(), &["--model".into(), "opus".into()]);
        assert_eq!(bin, "claude");
        assert_eq!(args, vec!["--model", "opus"]);
    }

    #[test]
    fn build_agent_command_uses_codex_binary_for_codex() {
        let (bin, args) = build_agent_command(&crate::agents::builtin_spec(&crate::config::AgentKind::Codex).unwrap(), &["--json".into()]);
        assert_eq!(bin, "codex");
        assert_eq!(args, vec!["--json"]);
    }

    #[test]
    fn build_agent_command_passes_through_empty_args() {
        let (bin, args) = build_agent_command(&crate::agents::builtin_spec(&crate::config::AgentKind::Codex).unwrap(), &[]);
        assert_eq!(bin, "codex");
        assert!(args.is_empty());
    }

    use crate::config::AgentKind;

    #[test]
    fn resume_flags_for_claude_use_equals_form() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Claude).unwrap(), Some("abc-123"), false);
        assert_eq!(out.leading, vec!["--resume=abc-123".to_string()]);
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn continue_flag_for_claude() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Claude).unwrap(), None, true);
        assert_eq!(out.leading, vec!["--continue".to_string()]);
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn resume_for_codex_uses_subcommand() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Codex).unwrap(), Some("sess-9"), false);
        assert_eq!(out.subcommand.as_deref(), Some("resume"));
        assert_eq!(out.leading, vec!["sess-9".to_string()]);
    }

    #[test]
    fn continue_for_codex_uses_resume_last_subcommand() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Codex).unwrap(), None, true);
        assert_eq!(out.subcommand.as_deref(), Some("resume"));
        assert_eq!(out.leading, vec!["--last".to_string()]);
    }

    #[test]
    fn resume_for_cursor_uses_flag() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Cursor).unwrap(), Some("chat-77"), false);
        assert_eq!(out.leading, vec!["--resume".to_string(), "chat-77".to_string()]);
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn continue_for_cursor() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Cursor).unwrap(), None, true);
        assert_eq!(out.leading, vec!["--continue".to_string()]);
    }

    #[test]
    fn resume_for_antigravity_uses_conversation_flag() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Antigravity).unwrap(), Some("conv-1"), false);
        assert_eq!(out.leading, vec!["--conversation".to_string(), "conv-1".to_string()]);
    }

    #[test]
    fn continue_for_antigravity() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Antigravity).unwrap(), None, true);
        assert_eq!(out.leading, vec!["--continue".to_string()]);
    }

    #[test]
    fn no_flags_when_neither_resume_nor_continue_codex() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Codex).unwrap(), None, false);
        assert!(out.leading.is_empty());
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn no_flags_when_neither_resume_nor_continue_claude() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Claude).unwrap(), None, false);
        assert!(out.leading.is_empty());
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn no_flags_when_neither_resume_nor_continue_cursor() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Cursor).unwrap(), None, false);
        assert!(out.leading.is_empty());
        assert!(out.subcommand.is_none());
    }

    #[test]
    fn no_flags_when_neither_resume_nor_continue_antigravity() {
        let out = super::resume_flags_for(&crate::agents::builtin_spec(&AgentKind::Antigravity).unwrap(), None, false);
        assert!(out.leading.is_empty());
        assert!(out.subcommand.is_none());
    }

    fn custom_spec(tpl: Option<&str>) -> crate::agents::AgentSpec {
        crate::agents::AgentSpec {
            kind: AgentKind::Custom("c1".into()),
            display_name: "OpenCode".into(),
            binary: "opencode".into(),
            install_url: None,
            install_hint: None,
            resume_flag: tpl.map(|s| s.to_string()),
        }
    }

    #[test]
    fn custom_resume_substitutes_id_into_flag_template() {
        let spec = custom_spec(Some("--session {id}"));
        let out = super::resume_flags_for(&spec, Some("s-42"), false);
        assert_eq!(out.subcommand, None);
        assert_eq!(out.leading, vec!["--session".to_string(), "s-42".to_string()]);
    }

    #[test]
    fn custom_resume_leading_non_flag_token_becomes_subcommand() {
        let spec = custom_spec(Some("resume {id}"));
        let out = super::resume_flags_for(&spec, Some("s-42"), false);
        assert_eq!(out.subcommand, Some("resume".to_string()));
        assert_eq!(out.leading, vec!["s-42".to_string()]);
    }

    #[test]
    fn custom_continue_uses_template_without_id_verbatim() {
        let spec = custom_spec(Some("--continue"));
        let out = super::resume_flags_for(&spec, None, true);
        assert_eq!(out.leading, vec!["--continue".to_string()]);
    }

    #[test]
    fn custom_id_template_with_no_id_is_empty() {
        let spec = custom_spec(Some("--session {id}"));
        let out = super::resume_flags_for(&spec, None, true);
        assert!(out.subcommand.is_none() && out.leading.is_empty());
    }

    #[test]
    fn custom_continue_template_ignores_a_supplied_id() {
        // A `--continue`-style template has nowhere to put the id: spawn fresh
        // rather than pass an id the CLI would misread as a prompt.
        let spec = custom_spec(Some("--continue"));
        let out = super::resume_flags_for(&spec, Some("s-1"), false);
        assert!(out.leading.is_empty());
    }

    #[test]
    fn custom_without_template_never_injects() {
        let spec = custom_spec(None);
        assert!(super::resume_flags_for(&spec, Some("x"), true).leading.is_empty());
    }

    #[test]
    fn build_agent_command_uses_custom_binary() {
        let spec = custom_spec(None);
        let (bin, args) = build_agent_command(&spec, &["--agent".into(), "build".into()]);
        assert_eq!(bin, "opencode");
        assert_eq!(args, vec!["--agent".to_string(), "build".to_string()]);
    }

    #[test]
    fn terminal_config_carries_bindings_but_serializes_no_secret_values() {
        let cfg = TerminalConfig {
            id: "t1".into(),
            label: "L".into(),
            nickname: None,
            profile_id: None,
            working_directory: "C:\\w".into(),
            claude_args: vec![],
            env_vars: HashMap::from([("PLAIN".to_string(), "1".to_string())]),
            created_at: Utc::now(),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
            agent: crate::config::AgentKind::Claude,
            credential_bindings: vec![crate::config::CredentialBinding {
                env: "ANTHROPIC_API_KEY".into(),
                credential_id: "c1".into(),
            }],
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"credential_bindings\""));
        assert!(json.contains("\"c1\""));
        assert!(!json.contains("ANTHROPIC_API_KEY\":\"sk"));
        // Older rows without the field still load.
        let old = json.replace(",\"credential_bindings\":[{\"env\":\"ANTHROPIC_API_KEY\",\"credential_id\":\"c1\"}]", "");
        let back: TerminalConfig = serde_json::from_str(&old).unwrap();
        assert!(back.credential_bindings.is_empty());
    }
}
