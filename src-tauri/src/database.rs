use crate::config::ConfigProfile;
use crate::terminal::TerminalConfig;
use rusqlite::{params, Connection};
use directories::ProjectDirs;
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppWorktreeRow {
    pub terminal_id: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub branch_name: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionHistoryEntry {
    pub id: i64,
    pub terminal_id: String,
    pub label: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub log_path: Option<String>,
    /// Working directory the session ran in - needed to resume it in the right
    /// place. Added in a later release, so NULL for pre-migration rows.
    pub working_directory: Option<String>,
    /// The Claude session UUID, captured once detected, so a resume can use
    /// `--resume <id>` exactly instead of `--continue`. NULL until detected or
    /// for pre-migration rows.
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub content: String,
    pub category: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub terminal_count: usize,
    pub created_at: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new() -> Result<Self, String> {
        let data_dir = ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
            .ok_or("Failed to get project directories")?
            .data_dir()
            .to_path_buf();

        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

        let db_path = data_dir.join("claudeterminal.db");
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        Self::init_schema(&conn)?;
        Ok(Self { conn })
    }

    fn init_schema(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                working_directory TEXT NOT NULL,
                claude_args TEXT NOT NULL,
                env_vars TEXT NOT NULL,
                is_default INTEGER DEFAULT 0,
                preview_json TEXT
            );

            CREATE TABLE IF NOT EXISTS workspaces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                terminals TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                terminal_id TEXT NOT NULL,
                label TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                log_path TEXT,
                working_directory TEXT,
                claude_session_id TEXT
            );

            CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_summaries (
                terminal_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
            CREATE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name);
            CREATE INDEX IF NOT EXISTS idx_session_history_terminal_id ON session_history(terminal_id);
            CREATE INDEX IF NOT EXISTS idx_snippets_category ON snippets(category);

            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS changelists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                repo_path TEXT NOT NULL,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(repo_path, name)
            );

            CREATE TABLE IF NOT EXISTS changelist_files (
                repo_path TEXT NOT NULL,
                file_path TEXT NOT NULL,
                changelist_id INTEGER NOT NULL REFERENCES changelists(id) ON DELETE CASCADE,
                PRIMARY KEY (repo_path, file_path)
            );

            CREATE TABLE IF NOT EXISTS app_worktrees (
                terminal_id   TEXT PRIMARY KEY,
                worktree_path TEXT NOT NULL,
                base_branch   TEXT NOT NULL,
                branch_name   TEXT NOT NULL,
                created_at    INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_changelist_files_repo ON changelist_files(repo_path);
            CREATE INDEX IF NOT EXISTS idx_changelist_files_list ON changelist_files(changelist_id);
            ",
        )
        .map_err(|e| e.to_string())?;

        // Migrations for databases created before these columns existed.
        // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so add
        // the columns here. ADD COLUMN errors with "duplicate column name" when
        // already present (fresh installs, or a second launch) - treat that as
        // success and propagate anything else.
        for column in ["working_directory TEXT", "claude_session_id TEXT"] {
            let sql = format!("ALTER TABLE session_history ADD COLUMN {}", column);
            if let Err(e) = conn.execute(&sql, []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        // Same pattern for the profiles table: `preview_json` is nullable JSON
        // storing the profile's PreviewProfile (see config.rs). NULL means the
        // profile has no preview config, matching the Option<PreviewProfile>
        // shape in Rust. `worktree_close_default` is the profile's default
        // action for the worktree close modal, stored as the snake_case string
        // form of the enum ("merge" | "squash" | "keep" | "discard") or NULL.
        for column in ["preview_json TEXT", "worktree_close_default TEXT"] {
            let sql = format!("ALTER TABLE profiles ADD COLUMN {}", column);
            if let Err(e) = conn.execute(&sql, []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        Ok(())
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    #[cfg(test)]
    pub(crate) fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init_schema(&conn)?;
        Ok(Self { conn })
    }

    pub fn save_profile(&self, profile: &ConfigProfile) -> Result<(), String> {
        if profile.name.is_empty() || profile.name.len() > 255 {
            return Err("Profile name must be 1-255 characters".to_string());
        }
        let claude_args_json = serde_json::to_string(&profile.claude_args)
            .map_err(|e| format!("Failed to serialize claude_args: {}", e))?;
        let env_vars_json = serde_json::to_string(&profile.env_vars)
            .map_err(|e| format!("Failed to serialize env_vars: {}", e))?;
        // preview_json mirrors env_vars: JSON in a TEXT column, but nullable -
        // Option<PreviewProfile>::None persists as SQL NULL so old rows and
        // opted-out profiles are indistinguishable on read.
        let preview_json: Option<String> = match &profile.preview {
            Some(preview) => Some(
                serde_json::to_string(preview)
                    .map_err(|e| format!("Failed to serialize preview: {}", e))?,
            ),
            None => None,
        };
        // Enum -> snake_case string via serde. Strip the JSON quotes so the
        // column stores the bare word ("merge" not "\"merge\"").
        let worktree_close_default: Option<String> = match &profile.worktree_close_default {
            Some(action) => {
                let quoted = serde_json::to_string(action)
                    .map_err(|e| format!("Failed to serialize worktree_close_default: {}", e))?;
                Some(quoted.trim_matches('"').to_string())
            }
            None => None,
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO profiles (id, name, description, working_directory, claude_args, env_vars, is_default, preview_json, worktree_close_default)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                profile.id,
                profile.name,
                profile.description,
                profile.working_directory,
                claude_args_json,
                env_vars_json,
                profile.is_default as i32,
                preview_json,
                worktree_close_default,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_profiles(&self) -> Result<Vec<ConfigProfile>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, name, description, working_directory, claude_args, env_vars, is_default, preview_json, worktree_close_default FROM profiles")
            .map_err(|e| e.to_string())?;

        let profiles = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let args_raw: String = row.get(4)?;
            let env_raw: String = row.get(5)?;
            // Malformed JSON here means a profile launches with no args / no env
            // vars - a silent behaviour change that's hard to diagnose. Log it
            // (with the profile identity) before falling back, rather than
            // swallowing it, so it shows up in stderr/telemetry.
            let claude_args = serde_json::from_str(&args_raw).unwrap_or_else(|e| {
                eprintln!("[profiles] corrupt claude_args for '{}' ({}): {}", name, id, e);
                Default::default()
            });
            let env_vars = serde_json::from_str(&env_raw).unwrap_or_else(|e| {
                eprintln!("[profiles] corrupt env_vars for '{}' ({}): {}", name, id, e);
                Default::default()
            });
            // preview_json is nullable; a NULL column and a JSON `null` both
            // yield `None`. Corrupt JSON falls back to `None` with a log line,
            // matching the defensive treatment of claude_args / env_vars above.
            let preview_raw: Option<String> = row.get(7)?;
            let preview: Option<crate::config::PreviewProfile> = match preview_raw {
                Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                    eprintln!("[profiles] corrupt preview for '{}' ({}): {}", name, id, e);
                    None
                }),
                None => None,
            };
            // worktree_close_default is a nullable snake_case string. Parse
            // it back into the enum; unknown values fall back to None with
            // an eprintln so misconfigured rows don't crash startup.
            let close_raw: Option<String> = row.get(8)?;
            let worktree_close_default: Option<crate::config::WorktreeCloseAction> = match close_raw {
                Some(raw) => {
                    let quoted = format!("\"{}\"", raw);
                    match serde_json::from_str::<crate::config::WorktreeCloseAction>(&quoted) {
                        Ok(action) => Some(action),
                        Err(e) => {
                            eprintln!(
                                "[profiles] unknown worktree_close_default '{}' for '{}' ({}): {}",
                                raw, name, id, e
                            );
                            None
                        }
                    }
                }
                None => None,
            };
            Ok(ConfigProfile {
                id,
                name,
                description: row.get(2)?,
                working_directory: row.get(3)?,
                claude_args,
                env_vars,
                is_default: row.get::<_, i32>(6)? != 0,
                preview,
                worktree_close_default,
            })
        }).map_err(|e| e.to_string())?;

        profiles.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_workspace(&self, name: &str, terminals: &[TerminalConfig]) -> Result<(), String> {
        // Allow internal keys like "__last_session__" but validate user-facing names
        if !name.starts_with("__") && (name.is_empty() || name.len() > 255) {
            return Err("Workspace name must be 1-255 characters".to_string());
        }
        let terminals_json = serde_json::to_string(terminals).map_err(|e| e.to_string())?;
        self.conn.execute(
            "INSERT OR REPLACE INTO workspaces (name, terminals, created_at) VALUES (?1, ?2, ?3)",
            params![name, terminals_json, chrono::Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_workspaces(&self) -> Result<Vec<WorkspaceInfo>, String> {
        let mut stmt = self.conn
            .prepare("SELECT name, terminals, created_at FROM workspaces WHERE name != '__last_session__' ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;

        let workspaces = stmt.query_map([], |row| {
            let name: String = row.get(0)?;
            let terminals_json: String = row.get(1)?;
            let created_at: String = row.get(2)?;
            let terminal_count = serde_json::from_str::<Vec<serde_json::Value>>(&terminals_json)
                .map(|v| v.len())
                .unwrap_or(0);
            Ok(WorkspaceInfo { name, terminal_count, created_at })
        }).map_err(|e| e.to_string())?;

        workspaces.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_workspace(&self, name: &str) -> Result<(), String> {
        if name.starts_with("__") {
            return Err("Cannot delete internal workspaces".to_string());
        }
        self.conn.execute("DELETE FROM workspaces WHERE name = ?1", params![name])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_workspace(&self, name: &str) -> Result<Vec<TerminalConfig>, String> {
        let terminals_json: String = self.conn
            .query_row("SELECT terminals FROM workspaces WHERE name = ?1", params![name], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        serde_json::from_str(&terminals_json).map_err(|e| e.to_string())
    }

    // Session persistence methods

    const LAST_SESSION_KEY: &'static str = "__last_session__";

    pub fn save_last_session(&self, terminals: &[TerminalConfig]) -> Result<(), String> {
        if terminals.is_empty() {
            return self.clear_last_session();
        }
        let mut sorted = terminals.to_vec();
        sorted.sort_by_key(|t| t.created_at);
        self.save_workspace(Self::LAST_SESSION_KEY, &sorted)
    }

    pub fn load_last_session(&self) -> Result<Option<Vec<TerminalConfig>>, String> {
        // Use OptionalExtension so an empty table is `Ok(None)` rather than a
        // stringified `QueryReturnedNoRows`. The previous match-on-substring
        // tested for the variant name (`"QueryReturnedNoRows"`) but rusqlite's
        // Display impl produces `"Query returned no rows"`, so first-run users
        // were getting a real error reported to telemetry.
        use rusqlite::OptionalExtension;
        let row: Option<String> = self
            .conn
            .query_row(
                "SELECT terminals FROM workspaces WHERE name = ?1",
                params![Self::LAST_SESSION_KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match row {
            Some(json) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }

    pub fn clear_last_session(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM workspaces WHERE name = ?1", params![Self::LAST_SESSION_KEY])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Session history methods

    pub fn insert_session_history(
        &self,
        terminal_id: &str,
        label: &str,
        started_at: &str,
        log_path: Option<&str>,
        working_directory: Option<&str>,
    ) -> Result<i64, String> {
        self.conn.execute(
            "INSERT INTO session_history (terminal_id, label, started_at, log_path, working_directory) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![terminal_id, label, started_at, log_path, working_directory],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Persist the detected Claude session id onto the terminal's currently-open
    /// history row (the one without an ended_at) so a later resume can use
    /// `--resume <id>` precisely. Idempotent - overwrites on redetection (e.g.
    /// after `/clear` rotates the id).
    pub fn update_session_claude_id(&self, terminal_id: &str, claude_session_id: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE session_history SET claude_session_id = ?1 WHERE terminal_id = ?2 AND ended_at IS NULL",
            params![claude_session_id, terminal_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_session_ended(&self, terminal_id: &str, ended_at: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE session_history SET ended_at = ?1 WHERE terminal_id = ?2 AND ended_at IS NULL",
            params![ended_at, terminal_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session_history(&self) -> Result<Vec<SessionHistoryEntry>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, terminal_id, label, started_at, ended_at, log_path, working_directory, claude_session_id FROM session_history ORDER BY started_at DESC LIMIT 100")
            .map_err(|e| e.to_string())?;

        let entries = stmt.query_map([], |row| {
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                terminal_id: row.get(1)?,
                label: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                log_path: row.get(5)?,
                working_directory: row.get(6)?,
                claude_session_id: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;

        entries.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_log_path_for_terminal(&self, terminal_id: &str) -> Result<Option<String>, String> {
        let result: Result<String, _> = self.conn.query_row(
            "SELECT log_path FROM session_history WHERE terminal_id = ?1 AND log_path IS NOT NULL ORDER BY started_at DESC LIMIT 1",
            params![terminal_id],
            |row| row.get(0),
        );
        match result {
            Ok(path) => Ok(Some(path)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete_session_history_entry(&self, id: i64) -> Result<(), String> {
        self.conn.execute("DELETE FROM session_history WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Snippet methods

    pub fn save_snippet(&self, snippet: &Snippet) -> Result<(), String> {
        if snippet.title.is_empty() || snippet.title.len() > 255 {
            return Err("Snippet title must be 1-255 characters".to_string());
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO snippets (id, title, content, category, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![snippet.id, snippet.title, snippet.content, snippet.category, snippet.created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_snippets(&self) -> Result<Vec<Snippet>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, title, content, category, created_at FROM snippets ORDER BY created_at DESC")
            .map_err(|e| e.to_string())?;

        let snippets = stmt.query_map([], |row| {
            Ok(Snippet {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                category: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        snippets.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Session summary methods

    pub fn save_session_summary(&self, terminal_id: &str, summary: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO session_summaries (terminal_id, summary, created_at) VALUES (?1, ?2, ?3)",
            params![terminal_id, summary, chrono::Utc::now().to_rfc3339()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session_summary(&self, terminal_id: &str) -> Result<Option<String>, String> {
        let result: Result<String, _> = self.conn.query_row(
            "SELECT summary FROM session_summaries WHERE terminal_id = ?1",
            params![terminal_id],
            |row| row.get(0),
        );
        match result {
            Ok(summary) => Ok(Some(summary)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    // App meta methods

    pub fn get_or_create_installation_id(&self) -> Result<String, String> {
        let result: Result<String, _> = self.conn.query_row(
            "SELECT value FROM app_meta WHERE key = 'installation_id'",
            [],
            |row| row.get(0),
        );
        match result {
            Ok(id) => Ok(id),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                let id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO app_meta (key, value) VALUES ('installation_id', ?1)",
                    params![id],
                ).map_err(|e| e.to_string())?;
                Ok(id)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    // App worktree methods

    pub fn insert_app_worktree(&self, row: &AppWorktreeRow) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO app_worktrees
             (terminal_id, worktree_path, base_branch, branch_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                row.terminal_id,
                row.worktree_path,
                row.base_branch,
                row.branch_name,
                row.created_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_app_worktree(&self, terminal_id: &str) -> Result<Option<AppWorktreeRow>, String> {
        let mut stmt = self.conn
            .prepare(
                "SELECT terminal_id, worktree_path, base_branch, branch_name, created_at
                 FROM app_worktrees WHERE terminal_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([terminal_id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(AppWorktreeRow {
                terminal_id: r.get(0).map_err(|e| e.to_string())?,
                worktree_path: r.get(1).map_err(|e| e.to_string())?,
                base_branch: r.get(2).map_err(|e| e.to_string())?,
                branch_name: r.get(3).map_err(|e| e.to_string())?,
                created_at: r.get(4).map_err(|e| e.to_string())?,
            })),
            None => Ok(None),
        }
    }

    pub fn delete_app_worktree(&self, terminal_id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM app_worktrees WHERE terminal_id = ?1", [terminal_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_app_worktrees(&self) -> Result<Vec<AppWorktreeRow>, String> {
        let mut stmt = self.conn
            .prepare(
                "SELECT terminal_id, worktree_path, base_branch, branch_name, created_at
                 FROM app_worktrees",
            )
            .map_err(|e| e.to_string())?;
        let iter = stmt
            .query_map([], |r| {
                Ok(AppWorktreeRow {
                    terminal_id: r.get(0)?,
                    worktree_path: r.get(1)?,
                    base_branch: r.get(2)?,
                    branch_name: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        iter.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Startup cleanup: drop rows whose worktree_path no longer exists on disk.
    /// Returns the number of rows removed.
    pub fn cleanup_orphan_app_worktrees(&self) -> Result<usize, String> {
        let all = self.list_app_worktrees()?;
        let mut removed = 0usize;
        for r in all {
            if !std::path::Path::new(&r.worktree_path).exists() {
                self.delete_app_worktree(&r.terminal_id)?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PreviewProfile;
    use crate::terminal::{TerminalConfig, TerminalStatus};
    use chrono::{Duration, Utc};
    use std::collections::HashMap;

    fn make_profile(id: &str, name: &str) -> ConfigProfile {
        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());
        ConfigProfile {
            id: id.to_string(),
            name: name.to_string(),
            description: Some("desc".to_string()),
            working_directory: "C:/work".to_string(),
            claude_args: vec!["--model".to_string(), "opus".to_string()],
            env_vars: env,
            is_default: false,
            preview: None,
            worktree_close_default: None,
        }
    }

    fn make_terminal(id: &str, offset_secs: i64) -> TerminalConfig {
        TerminalConfig {
            id: id.to_string(),
            label: format!("term-{}", id),
            nickname: None,
            profile_id: None,
            working_directory: "C:/work".to_string(),
            claude_args: vec![],
            env_vars: HashMap::new(),
            created_at: Utc::now() + Duration::seconds(offset_secs),
            status: TerminalStatus::Running,
            color_tag: None,
            claude_session_id: None,
        }
    }

    #[test]
    fn init_schema_is_idempotent() {
        let db = Database::new_in_memory().unwrap();
        // Re-running the migration on the same connection must not error.
        Database::init_schema(&db.conn).unwrap();
    }

    #[test]
    fn profile_round_trips_complex_args_and_env() {
        let db = Database::new_in_memory().unwrap();
        let p = make_profile("p1", "default");
        db.save_profile(&p).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "p1");
        assert_eq!(loaded[0].claude_args, vec!["--model", "opus"]);
        assert_eq!(loaded[0].env_vars.get("FOO"), Some(&"bar".to_string()));
    }

    #[test]
    fn profile_round_trips_preview_when_present_and_absent() {
        let db = Database::new_in_memory().unwrap();

        // With preview -> round-trips exact field values.
        let mut with_preview = make_profile("p-with", "with");
        with_preview.preview = Some(PreviewProfile {
            enabled: true,
            url_override: Some("http://localhost:3000".to_string()),
            framework_hint: Some("vite".to_string()),
        });
        db.save_profile(&with_preview).unwrap();

        // Without preview -> persists as SQL NULL and reads back as None.
        let without_preview = make_profile("p-none", "none");
        db.save_profile(&without_preview).unwrap();

        let loaded = db.get_profiles().unwrap();
        let with_loaded = loaded.iter().find(|p| p.id == "p-with").unwrap();
        let without_loaded = loaded.iter().find(|p| p.id == "p-none").unwrap();

        let preview = with_loaded.preview.as_ref().expect("preview persisted");
        assert_eq!(preview.enabled, true);
        assert_eq!(preview.url_override.as_deref(), Some("http://localhost:3000"));
        assert_eq!(preview.framework_hint.as_deref(), Some("vite"));

        assert!(without_loaded.preview.is_none(), "None preview must stay None across a round-trip");
    }

    #[test]
    fn save_profile_treats_repeat_id_as_upsert() {
        let db = Database::new_in_memory().unwrap();
        let mut p = make_profile("p1", "first");
        db.save_profile(&p).unwrap();
        p.name = "second".to_string();
        db.save_profile(&p).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded.len(), 1, "save_profile must upsert by id");
        assert_eq!(loaded[0].name, "second");
    }

    #[test]
    fn save_profile_rejects_empty_or_too_long_name() {
        let db = Database::new_in_memory().unwrap();
        let mut p = make_profile("p1", "");
        assert!(db.save_profile(&p).is_err());

        p.name = "x".repeat(256);
        assert!(db.save_profile(&p).is_err());
    }

    #[test]
    fn delete_profile_removes_only_the_target() {
        let db = Database::new_in_memory().unwrap();
        db.save_profile(&make_profile("p1", "a")).unwrap();
        db.save_profile(&make_profile("p2", "b")).unwrap();
        db.delete_profile("p1").unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "p2");
    }

    #[test]
    fn workspace_round_trip() {
        let db = Database::new_in_memory().unwrap();
        let terminals = vec![make_terminal("t1", 0), make_terminal("t2", 1)];
        db.save_workspace("my-ws", &terminals).unwrap();

        let loaded = db.load_workspace("my-ws").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "t1");
        assert_eq!(loaded[1].id, "t2");
    }

    #[test]
    fn save_workspace_validates_user_facing_names_but_allows_internal_keys() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.save_workspace("", &[]).is_err());
        assert!(db.save_workspace(&"x".repeat(256), &[]).is_err());

        // __-prefixed keys bypass the length check (used for __last_session__).
        assert!(db.save_workspace("__internal__", &[make_terminal("t", 0)]).is_ok());
    }

    #[test]
    fn delete_workspace_refuses_internal_keys() {
        let db = Database::new_in_memory().unwrap();
        db.save_workspace("__last_session__", &[make_terminal("t", 0)])
            .unwrap();
        assert!(db.delete_workspace("__last_session__").is_err());
    }

    #[test]
    fn get_workspaces_hides_internal_last_session_entry() {
        let db = Database::new_in_memory().unwrap();
        db.save_workspace("real", &[make_terminal("t", 0)]).unwrap();
        db.save_workspace("__last_session__", &[make_terminal("t", 0)])
            .unwrap();

        let listed = db.get_workspaces().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "real");
    }

    #[test]
    fn load_last_session_returns_ok_none_on_empty_db() {
        // Regression: a stringly-typed match against "QueryReturnedNoRows" used
        // to surface a real error to telemetry on first run. The fix routes the
        // empty-row case through OptionalExtension; this test pins that.
        let db = Database::new_in_memory().unwrap();
        assert!(matches!(db.load_last_session(), Ok(None)));
    }

    #[test]
    fn last_session_round_trips_and_sorts_by_created_at() {
        let db = Database::new_in_memory().unwrap();
        // Insert out of order; save_last_session must sort ascending.
        let unordered = vec![make_terminal("late", 10), make_terminal("early", 0)];
        db.save_last_session(&unordered).unwrap();

        let loaded = db.load_last_session().unwrap().expect("session present");
        assert_eq!(loaded.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["early", "late"]);
    }

    #[test]
    fn save_last_session_with_empty_list_clears_the_row() {
        let db = Database::new_in_memory().unwrap();
        db.save_last_session(&[make_terminal("t", 0)]).unwrap();
        assert!(db.load_last_session().unwrap().is_some());

        db.save_last_session(&[]).unwrap();
        assert!(db.load_last_session().unwrap().is_none());
    }

    #[test]
    fn session_history_insert_then_close_sets_ended_at() {
        let db = Database::new_in_memory().unwrap();
        let id = db
            .insert_session_history("t1", "label", "2026-01-01T00:00:00Z", Some("/log/path"), Some("/work/dir"))
            .unwrap();
        assert!(id > 0);
        // Claude session id is detected after spawn and stamped onto the open row.
        db.update_session_claude_id("t1", "sess-abc").unwrap();
        db.update_session_ended("t1", "2026-01-01T01:00:00Z").unwrap();

        let entries = db.get_session_history().unwrap();
        let found = entries.iter().find(|e| e.id == id).expect("entry present");
        assert_eq!(found.ended_at.as_deref(), Some("2026-01-01T01:00:00Z"));
        assert_eq!(found.log_path.as_deref(), Some("/log/path"));
        assert_eq!(found.working_directory.as_deref(), Some("/work/dir"));
        assert_eq!(found.claude_session_id.as_deref(), Some("sess-abc"));
    }

    #[test]
    fn get_log_path_for_terminal_returns_the_most_recent_non_null_path() {
        let db = Database::new_in_memory().unwrap();
        db.insert_session_history("t1", "old", "2026-01-01T00:00:00Z", Some("/old"), None)
            .unwrap();
        db.insert_session_history("t1", "new", "2026-01-02T00:00:00Z", Some("/new"), None)
            .unwrap();

        assert_eq!(
            db.get_log_path_for_terminal("t1").unwrap().as_deref(),
            Some("/new")
        );
        assert_eq!(db.get_log_path_for_terminal("missing").unwrap(), None);
    }

    #[test]
    fn snippet_validation_and_round_trip() {
        let db = Database::new_in_memory().unwrap();
        let valid = Snippet {
            id: "s1".to_string(),
            title: "title".to_string(),
            content: "body".to_string(),
            category: "General".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        };
        db.save_snippet(&valid).unwrap();

        let invalid_empty = Snippet { title: String::new(), ..valid.clone() };
        assert!(db.save_snippet(&invalid_empty).is_err());

        let invalid_long = Snippet { title: "x".repeat(256), ..valid };
        assert!(db.save_snippet(&invalid_long).is_err());

        let listed = db.get_snippets().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "s1");
    }

    #[test]
    fn session_summary_save_get_overwrites_per_terminal() {
        let db = Database::new_in_memory().unwrap();
        db.save_session_summary("t1", "first").unwrap();
        db.save_session_summary("t1", "second").unwrap();

        assert_eq!(db.get_session_summary("t1").unwrap().as_deref(), Some("second"));
        assert_eq!(db.get_session_summary("missing").unwrap(), None);
    }

    #[test]
    fn installation_id_is_stable_across_calls() {
        let db = Database::new_in_memory().unwrap();
        let a = db.get_or_create_installation_id().unwrap();
        let b = db.get_or_create_installation_id().unwrap();
        assert_eq!(a, b);
        assert!(!a.is_empty());
    }
}

#[cfg(test)]
mod app_worktrees_tests {
    use super::*;

    #[test]
    fn insert_and_get() {
        let db = Database::new_in_memory().unwrap();
        let row = AppWorktreeRow {
            terminal_id: "t1".into(),
            worktree_path: "/tmp/wt-x".into(),
            base_branch: "main".into(),
            branch_name: "feat/x".into(),
            created_at: 1234567890,
        };
        db.insert_app_worktree(&row).unwrap();

        let got = db.get_app_worktree("t1").unwrap().unwrap();
        assert_eq!(got.terminal_id, "t1");
        assert_eq!(got.worktree_path, "/tmp/wt-x");
        assert_eq!(got.base_branch, "main");
        assert_eq!(got.branch_name, "feat/x");
        assert_eq!(got.created_at, 1234567890);
    }

    #[test]
    fn get_missing_returns_none() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.get_app_worktree("nope").unwrap().is_none());
    }

    #[test]
    fn delete_removes_row() {
        let db = Database::new_in_memory().unwrap();
        let row = AppWorktreeRow {
            terminal_id: "t1".into(),
            worktree_path: "/tmp/x".into(),
            base_branch: "main".into(),
            branch_name: "b".into(),
            created_at: 0,
        };
        db.insert_app_worktree(&row).unwrap();
        db.delete_app_worktree("t1").unwrap();
        assert!(db.get_app_worktree("t1").unwrap().is_none());
    }

    #[test]
    fn cleanup_removes_orphans_only() {
        let db = Database::new_in_memory().unwrap();
        let existing = tempfile::TempDir::new().unwrap();
        db.insert_app_worktree(&AppWorktreeRow {
            terminal_id: "t-alive".into(),
            worktree_path: existing.path().to_string_lossy().into(),
            base_branch: "main".into(),
            branch_name: "a".into(),
            created_at: 0,
        }).unwrap();
        db.insert_app_worktree(&AppWorktreeRow {
            terminal_id: "t-dead".into(),
            worktree_path: "/definitely/does/not/exist/xyzzy".into(),
            base_branch: "main".into(),
            branch_name: "b".into(),
            created_at: 0,
        }).unwrap();

        let removed = db.cleanup_orphan_app_worktrees().unwrap();
        assert_eq!(removed, 1);
        assert!(db.get_app_worktree("t-alive").unwrap().is_some());
        assert!(db.get_app_worktree("t-dead").unwrap().is_none());
    }
}
