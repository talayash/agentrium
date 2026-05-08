use crate::config::ConfigProfile;
use crate::terminal::TerminalConfig;
use rusqlite::{params, Connection};
use directories::ProjectDirs;
use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionHistoryEntry {
    pub id: i64,
    pub terminal_id: String,
    pub label: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub log_path: Option<String>,
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

        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                working_directory TEXT NOT NULL,
                claude_args TEXT NOT NULL,
                env_vars TEXT NOT NULL,
                is_default INTEGER DEFAULT 0
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
                log_path TEXT
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
            "
        ).map_err(|e| e.to_string())?;

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
        self.conn.execute(
            "INSERT OR REPLACE INTO profiles (id, name, description, working_directory, claude_args, env_vars, is_default)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                profile.id,
                profile.name,
                profile.description,
                profile.working_directory,
                claude_args_json,
                env_vars_json,
                profile.is_default as i32,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_profiles(&self) -> Result<Vec<ConfigProfile>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, name, description, working_directory, claude_args, env_vars, is_default FROM profiles")
            .map_err(|e| e.to_string())?;

        let profiles = stmt.query_map([], |row| {
            Ok(ConfigProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                working_directory: row.get(3)?,
                claude_args: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                env_vars: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                is_default: row.get::<_, i32>(6)? != 0,
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

    pub fn insert_session_history(&self, terminal_id: &str, label: &str, started_at: &str, log_path: Option<&str>) -> Result<i64, String> {
        self.conn.execute(
            "INSERT INTO session_history (terminal_id, label, started_at, log_path) VALUES (?1, ?2, ?3, ?4)",
            params![terminal_id, label, started_at, log_path],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
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
            .prepare("SELECT id, terminal_id, label, started_at, ended_at, log_path FROM session_history ORDER BY started_at DESC LIMIT 100")
            .map_err(|e| e.to_string())?;

        let entries = stmt.query_map([], |row| {
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                terminal_id: row.get(1)?,
                label: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                log_path: row.get(5)?,
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
}
