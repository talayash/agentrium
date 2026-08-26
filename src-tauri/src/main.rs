#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod commands;
mod terminal;
mod config;
mod database;
mod telemetry;
mod error_reporter;
mod claude_path;
mod claude_session;
mod pastes;
mod changelists;
mod otel_receiver;
mod lsp;

use tauri::Manager;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct AppState {
    pub terminals: Arc<Mutex<terminal::TerminalManager>>,
    /// Database uses `std::sync::Mutex`, NOT `tokio::sync::Mutex`, so callers
    /// don't hold the guard across `.await`. Every DB call runs inside a
    /// `spawn_blocking` closure (see `commands::db_op`) — the mutex is held
    /// only for the duration of the sync rusqlite call, on the blocking
    /// pool, off the tokio runtime workers.
    pub db: Arc<std::sync::Mutex<database::Database>>,
    /// Localhost port of the embedded OTLP metrics receiver (0 if disabled/failed).
    pub otel_port: u16,
    /// Shared aggregator so close_terminal can forget a terminal's metrics.
    pub otel_agg: std::sync::Arc<std::sync::Mutex<crate::otel_receiver::MetricsAggregator>>,
    pub lsp: Arc<Mutex<lsp::LspManager>>,
}

fn main() {
    // Arm the reporter before anything can fail: version + persisted consent
    // flag are available immediately; the installation id is attached later in
    // setup() once the database is open. This makes startup crashes (including
    // a broken database) reportable instead of silent.
    error_reporter::init_early();

    // report_blocking flushes synchronously on a dedicated thread, so the
    // report survives `panic = "abort"` in release builds - the abort happens
    // only after the hook returns.
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let kind = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        error_reporter::report_blocking(
            error_reporter::ErrorSource::RustPanic,
            kind,
            msg,
            Some(backtrace),
        );
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let db = database::Database::new()?;
            let installation_id = match db.get_or_create_installation_id() {
                Ok(id) => id,
                Err(e) => {
                    // An empty id corrupts per-install grouping server-side,
                    // so make the cause visible instead of silently degrading.
                    error_reporter::report_bg(
                        "installation_id",
                        format!("get_or_create_installation_id failed: {}", e),
                    );
                    String::new()
                }
            };
            error_reporter::set_installation_id(installation_id);

            let terminal_manager = terminal::TerminalManager::new();
            let lsp_manager = lsp::LspManager::new(app.handle().clone());

            let (otel_port, otel_agg) = match otel_receiver::start(app.handle().clone()) {
                Ok((port, agg)) => {
                    eprintln!("[otel] metrics receiver listening on 127.0.0.1:{}", port);
                    (port, agg)
                }
                Err(e) => {
                    eprintln!("[otel] failed to start metrics receiver: {} (cost tracking disabled)", e);
                    error_reporter::report_bg(
                        "otel_receiver_start",
                        format!("metrics receiver failed to start (cost tracking disabled): {}", e),
                    );
                    (0, std::sync::Arc::new(std::sync::Mutex::new(otel_receiver::MetricsAggregator::new())))
                }
            };

            app.manage(AppState {
                terminals: Arc::new(Mutex::new(terminal_manager)),
                db: Arc::new(std::sync::Mutex::new(db)),
                otel_port,
                otel_agg,
                lsp: Arc::new(Mutex::new(lsp_manager)),
            });

            // WebView2 ships a default browser context menu with "Refresh" that
            // reloads the top-level document — clicking it inside the preview
            // iframe closes every open terminal. Parent-window JS can't cancel
            // that click (iframes are separate documents), and WebView2 also
            // auto-confirms `beforeunload` in Tauri, so the ONLY reliable
            // block is turning the default context menu off at the shell
            // level. Applies to every webview created by this process.
            #[cfg(target_os = "windows")]
            {
                for (_, w) in app.webview_windows() {
                    let _ = w.with_webview(|webview| unsafe {
                        if let Ok(core) = webview.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                let _ = settings
                                    .SetAreDefaultContextMenusEnabled(false.into());
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::write_to_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::get_terminals,
            commands::get_cursor_position,
            commands::update_terminal_label,
            commands::update_terminal_nickname,
            commands::save_profile,
            commands::get_profiles,
            commands::delete_profile,
            commands::get_claude_version,
            commands::get_agent_version,
            commands::check_claude_update,
            commands::update_claude_code,
            commands::get_hints,
            commands::get_workspaces,
            commands::delete_workspace,
            commands::save_workspace,
            commands::load_workspace,
            commands::save_session_for_restore,
            commands::get_last_session,
            commands::clear_last_session,
            commands::check_system_requirements,
            commands::install_claude_code,
            commands::open_external_url,
            commands::reveal_in_file_manager,
            commands::list_claude_sessions,
            commands::rename_path,
            commands::trash_path,
            commands::move_into_dir,
            commands::copy_into_dir,
            commands::send_notification,
            commands::get_terminal_changes,
            commands::get_path_changes,
            commands::get_file_diff,
            commands::get_path_file_diff,
            commands::git_create_branch,
            commands::get_repo_remote_refs,
            commands::get_upstream_branch,
            commands::git_pull_branch,
            commands::get_worktree_info,
            commands::list_worktrees,
            commands::get_repo_branches,
            commands::checkout_branch,
            commands::git_commit,
            commands::get_last_commit_info,
            commands::get_push_preview,
            commands::git_push,
            commands::git_stage_files,
            commands::git_unstage_files,
            commands::git_stash_push,
            commands::git_list_stashes,
            commands::git_stash_apply,
            commands::git_stash_pop,
            commands::git_stash_drop,
            commands::create_worktree,
            commands::remove_worktree,
            commands::get_session_history,
            commands::get_session_log,
            commands::read_log_file,
            commands::delete_session_history,
            commands::save_snippet,
            commands::get_snippets,
            commands::delete_snippet,
            commands::get_active_teams,
            commands::read_claude_settings,
            commands::write_claude_settings,
            commands::list_claude_agents,
            commands::read_claude_agent,
            commands::write_claude_agent,
            commands::delete_claude_agent,
            commands::list_claude_commands,
            commands::read_claude_command,
            commands::write_claude_command,
            commands::delete_claude_command,
            commands::get_installation_id,
            commands::send_telemetry_heartbeat,
            commands::get_team_tasks,
            commands::summarize_session,
            commands::save_session_summary,
            commands::get_session_summary,
            commands::list_memory_files,
            commands::read_memory_file,
            commands::write_memory_file,
            commands::list_claude_md_files,
            commands::scan_git_repos,
            commands::list_directory,
            commands::read_text_file,
            commands::write_text_file,
            commands::git_discard_file,
            commands::get_git_head_content,
            commands::list_package_scripts,
            commands::create_script_terminal,
            commands::create_shell_terminal,
            commands::search_in_files,
            commands::report_error,
            commands::set_error_reporting_enabled,
            commands::write_paste,
            commands::list_pastes,
            commands::read_paste,
            commands::delete_paste,
            commands::purge_pastes,
            commands::list_changelists,
            commands::create_changelist,
            commands::rename_changelist,
            commands::delete_changelist,
            commands::assign_files_to_changelist,
            commands::get_changelist_assignments,
            commands::lsp_did_open,
            commands::lsp_did_change,
            commands::lsp_did_close,
            commands::lsp_request,
            commands::lsp_status,
            commands::lsp_install_server,
            commands::lsp_restart_server,
            commands::lsp_server_log,
        ])
        .on_window_event(|window, event| {
            // Only the main window owns the app lifecycle. Detached (tear-off)
            // windows are labelled `detached-*`; closing one must NOT save the
            // session or tear down every PTY — that close is handled in JS
            // (the "return to main / close terminals" dialog).
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_state = window.state::<AppState>();
                let terminals = app_state.terminals.clone();
                let db = app_state.db.clone();
                tauri::async_runtime::block_on(async {
                    // Read configs and save session (short lock)
                    let configs = {
                        let manager = terminals.lock().await;
                        manager.get_all_configs()
                    };
                    {
                        // Sync lock — we're already inside block_on and the
                        // process is about to exit; no need to yield the runtime.
                        let db = db.lock().unwrap_or_else(|p| p.into_inner());
                        if let Err(e) = db.save_last_session(&configs) {
                            eprintln!("Failed to save last session on exit: {}", e);
                            // This is the user's whole workspace-restore state
                            // and the process exits right after - flush
                            // synchronously or the report never leaves.
                            error_reporter::report_blocking(
                                error_reporter::ErrorSource::RustCommand,
                                Some("save_last_session_on_exit".to_string()),
                                format!("Failed to save last session on exit: {}", e),
                                None,
                            );
                        }
                    }
                    // Close all terminals (drops PTY resources, reader threads clean up async)
                    {
                        let mut manager = terminals.lock().await;
                        manager.close_all();
                    }
                });
                // The main window is the app. Closing it quits everything
                // (including any torn-off windows) — matching the original
                // single-window behavior. Torn-off windows persist their layout
                // during the session, so the next launch restores them. This
                // exit force-closes detached windows without firing their JS
                // close dialog.
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod panic_hook_tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Smoke test: a panic inside `std::thread::spawn` is visible to the
    /// default panic hook (and therefore to our `set_hook` in `main`). We
    /// don't install the real hook here - that would race with other tests
    /// and need ErrorReporter init. Instead we set our own hook for the
    /// duration of the test, panic on a worker thread, and assert the hook
    /// fired.
    #[test]
    fn thread_spawn_panic_invokes_global_hook() {
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();

        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |_info| {
            fired_clone.store(true, Ordering::SeqCst);
        }));

        let handle = std::thread::spawn(|| {
            panic!("intentional thread-panic for hook coverage");
        });
        // The join returns Err on a panicked thread; that's expected.
        let _ = handle.join();

        // Restore so other tests aren't affected.
        std::panic::set_hook(prev);

        assert!(
            fired.load(Ordering::SeqCst),
            "global panic hook did not fire from a std::thread::spawn panic"
        );
    }
}
