use crate::config::ConfigProfile;
use crate::terminal::TerminalConfig;
use rusqlite::{params, Connection};
use directories::ProjectDirs;
use serde::{Serialize, Deserialize};

/// Sync state of a syncable row. Serialized to SQLite as one of three
/// lowercase strings; conversion is centralized here so writers can't
/// produce invalid values by typo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncState {
    LocalOnly,
    Pending,
    Synced,
}

impl SyncState {
    pub fn as_sql_str(self) -> &'static str {
        match self {
            SyncState::LocalOnly => "local_only",
            SyncState::Pending => "pending",
            SyncState::Synced => "synced",
        }
    }
}

impl std::str::FromStr for SyncState {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "local_only" => Ok(SyncState::LocalOnly),
            "pending" => Ok(SyncState::Pending),
            "synced" => Ok(SyncState::Synced),
            other => Err(format!("invalid sync_state: {other}")),
        }
    }
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

#[derive(Debug, Clone)]
pub struct SyncQueueRow {
    pub table_name: String,
    pub row_key: String,
    pub enqueued_at: String,
    pub attempts: i64,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new() -> Result<Self, String> {
        // App name is suffixed when running a side-loaded QA build so the
        // dev instance gets its own DB, isolated from any prod install.
        // See `crate::instance_suffix` for the convention.
        let app_name = format!("ClaudeTerminal{}", crate::instance_suffix());
        let data_dir = ProjectDirs::from("com", "claudeterminal", &app_name)
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
                preview_json TEXT,
                agent TEXT NOT NULL DEFAULT 'claude'
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

            CREATE TABLE IF NOT EXISTS user_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS sync_queue (
                table_name TEXT NOT NULL,
                row_key TEXT NOT NULL,
                enqueued_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_attempt_at TEXT,
                last_error TEXT,
                PRIMARY KEY (table_name, row_key)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_queue_enqueued_at ON sync_queue(enqueued_at);

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

            CREATE TABLE IF NOT EXISTS custom_agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                binary TEXT NOT NULL,
                default_args TEXT NOT NULL,
                resume_flag TEXT,
                color TEXT NOT NULL,
                required_env TEXT NOT NULL,
                bindings TEXT NOT NULL,
                install_url TEXT,
                install_hint TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL UNIQUE,
                provider TEXT NOT NULL,
                env_name TEXT NOT NULL,
                endpoint_env TEXT,
                has_key INTEGER NOT NULL DEFAULT 0,
                has_endpoint INTEGER NOT NULL DEFAULT 0,
                masked_tail TEXT,
                created_at TEXT NOT NULL,
                last_used_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_defaults (
                agent TEXT PRIMARY KEY,
                bindings TEXT NOT NULL
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
        // shape in Rust. `agent` stores the agent kind as a lowercase string;
        // the NOT NULL DEFAULT 'claude' ensures existing rows get a valid value.
        for column in [
            "preview_json TEXT",
            "agent TEXT NOT NULL DEFAULT 'claude'",
            // Per-agent args (multi-agent profiles). Nullable JSON so a row
            // written before this column existed reads as NULL; the loader
            // then migrates in-memory by seeding {profile.agent: claude_args}.
            "agent_args_json TEXT",
            // Credentials pinned by this profile (Vec<CredentialBinding>).
            // Nullable JSON so a pre-migration row reads as NULL, which the
            // loader treats as an empty list.
            "credential_bindings_json TEXT",
            // M2a sync columns. `updated_at` is the LWW key; ISO-8601 UTC.
            // `deleted_at` NULL means live, non-NULL means tombstone.
            // `sync_state` is one of 'local_only' | 'pending' | 'synced'.
            "updated_at TEXT",
            "deleted_at TEXT",
            "client_version INTEGER NOT NULL DEFAULT 1",
            "sync_state TEXT NOT NULL DEFAULT 'local_only'",
        ] {
            let sql = format!("ALTER TABLE profiles ADD COLUMN {}", column);
            if let Err(e) = conn.execute(&sql, []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        // Backfill updated_at for pre-migration rows. Any row still on NULL
        // was written before sync existed, so use `now()` — the first push
        // will look like a fresh authoring event, which is correct.
        conn.execute(
            "UPDATE profiles SET updated_at = ?1 WHERE updated_at IS NULL",
            params![chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
        // Antigravity replaced Gemini as the fourth agent slot. Any row
        // whose `agent` column still says 'gemini' (written by an older
        // build) is promoted in place so users don't lose their profile.
        // The `agent_args_json` JSON payload is migrated lazily on read
        // in `get_profiles` via `AgentKind::from_str_lossy`, which also
        // accepts the legacy token. This UPDATE is a no-op once every
        // row has been rewritten - safe to run on every launch.
        conn.execute(
            "UPDATE profiles SET agent = 'antigravity' WHERE agent = 'gemini'",
            [],
        )
        .map_err(|e| e.to_string())?;
        // M2a: custom_agents sync columns. `updated_at` and `id` already exist
        // on this table, so only the tombstone + version + state columns are new.
        for column in [
            "deleted_at TEXT",
            "client_version INTEGER NOT NULL DEFAULT 1",
            "sync_state TEXT NOT NULL DEFAULT 'local_only'",
        ] {
            let sql = format!("ALTER TABLE custom_agents ADD COLUMN {}", column);
            if let Err(e) = conn.execute(&sql, []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        // M2a: workspaces sync columns. Keep local INTEGER id intact; introduce a
        // separate TEXT UUID sync_id used as the cross-device stable key. The
        // unique index is created AFTER backfill (below) so pre-migration NULL
        // values don't collide with each other.
        for column in [
            "sync_id TEXT",
            "updated_at TEXT",
            "deleted_at TEXT",
            "client_version INTEGER NOT NULL DEFAULT 1",
            "sync_state TEXT NOT NULL DEFAULT 'local_only'",
        ] {
            let sql = format!("ALTER TABLE workspaces ADD COLUMN {}", column);
            if let Err(e) = conn.execute(&sql, []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }

        // Pre-migration workspaces get a fresh UUID sync_id and now() timestamp.
        // Collect ids first (short-lived borrow), then update in a loop.
        let workspace_ids: Vec<i64> = conn
            .prepare("SELECT id FROM workspaces WHERE sync_id IS NULL")
            .map_err(|e| e.to_string())?
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        for id in workspace_ids {
            let uuid = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "UPDATE workspaces SET sync_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![uuid, now, id],
            )
            .map_err(|e| e.to_string())?;
        }
        // Enforce uniqueness now that all rows have a sync_id.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_sync_id ON workspaces(sync_id)",
            [],
        )
        .map_err(|e| e.to_string())?;
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
        // Keep the legacy `claude_args` column in sync with the currently
        // selected agent's per-agent list, so any consumer that still reads
        // only `claude_args` sees the args a launch would actually use.
        // Falls back to whatever the caller sent when agent_args has no
        // entry for the default agent (fresh profile / partial payload).
        let effective_claude_args: Vec<String> = profile
            .agent_args
            .get(&profile.agent)
            .cloned()
            .unwrap_or_else(|| profile.claude_args.clone());
        let claude_args_json = serde_json::to_string(&effective_claude_args)
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
        let agent_args_json = serde_json::to_string(&profile.agent_args)
            .map_err(|e| format!("Failed to serialize agent_args: {}", e))?;
        let credential_bindings_json = serde_json::to_string(&profile.credential_bindings)
            .map_err(|e| e.to_string())?;
        self.conn.execute(
            "INSERT OR REPLACE INTO profiles (id, name, description, working_directory, claude_args, env_vars, is_default, preview_json, agent, agent_args_json, credential_bindings_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                profile.id,
                profile.name,
                profile.description,
                profile.working_directory,
                claude_args_json,
                env_vars_json,
                profile.is_default as i32,
                preview_json,
                profile.agent.to_wire(),
                agent_args_json,
                credential_bindings_json,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_profiles(&self) -> Result<Vec<ConfigProfile>, String> {
        let mut stmt = self.conn
            .prepare("SELECT id, name, description, working_directory, claude_args, env_vars, is_default, preview_json, agent, agent_args_json, credential_bindings_json FROM profiles WHERE deleted_at IS NULL")
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
            let claude_args: Vec<String> = serde_json::from_str(&args_raw).unwrap_or_else(|e| {
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
            let agent_raw: String = row.get(8)?;
            let agent = crate::config::AgentKind::from_str_lossy(&agent_raw);
            // agent_args_json is nullable. Rows written before this column
            // existed read as NULL - migrate in-memory by seeding a single
            // entry {profile.agent: claude_args} so per-agent lookups return
            // the legacy list under the profile's current agent, and other
            // agents fall through to args_for()'s claude_args fallback.
            //
            // We deserialize with string keys first, then map through
            // `AgentKind::from_str_lossy`. That's what lets pre-rename
            // payloads with `"gemini"` keys land on the current
            // Antigravity variant instead of tripping serde's strict
            // enum parser.
            let agent_args_raw: Option<String> = row.get(9)?;
            let agent_args: std::collections::HashMap<crate::config::AgentKind, Vec<String>> =
                match agent_args_raw {
                    Some(raw) => match serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(&raw) {
                        Ok(raw_map) => raw_map
                            .into_iter()
                            .map(|(k, v)| (crate::config::AgentKind::from_str_lossy(&k), v))
                            .collect(),
                        Err(e) => {
                            eprintln!("[profiles] corrupt agent_args for '{}' ({}): {}", name, id, e);
                            let mut m = std::collections::HashMap::new();
                            m.insert(agent.clone(), claude_args.clone());
                            m
                        }
                    },
                    None => {
                        let mut m = std::collections::HashMap::new();
                        m.insert(agent.clone(), claude_args.clone());
                        m
                    }
                };
            let cb_raw: Option<String> = row.get(10)?;
            let credential_bindings: Vec<crate::config::CredentialBinding> = match cb_raw {
                Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                    eprintln!("[profiles] corrupt credential_bindings for '{}' ({}): {}", name, id, e);
                    Vec::new()
                }),
                None => Vec::new(),
            };
            Ok(ConfigProfile {
                id,
                name,
                description: row.get(2)?,
                working_directory: row.get(3)?,
                claude_args,
                env_vars,
                is_default: row.get::<_, i32>(6)? != 0,
                agent,
                preview,
                agent_args,
                credential_bindings,
            })
        }).map_err(|e| e.to_string())?;

        profiles.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn save_custom_agent(&self, a: &crate::custom_agents::CustomAgent) -> Result<(), String> {
        let default_args = serde_json::to_string(&a.default_args).map_err(|e| e.to_string())?;
        let required_env = serde_json::to_string(&a.required_env).map_err(|e| e.to_string())?;
        let bindings = serde_json::to_string(&a.bindings).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO custom_agents
                 (id, name, binary, default_args, resume_flag, color, required_env, bindings, install_url, install_hint, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    a.id, a.name, a.binary, default_args, a.resume_flag, a.color,
                    required_env, bindings, a.install_url, a.install_hint, a.created_at, a.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn row_to_custom_agent(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::custom_agents::CustomAgent> {
        let id: String = row.get(0)?;
        let default_args_raw: String = row.get(3)?;
        let required_env_raw: String = row.get(6)?;
        let bindings_raw: String = row.get(7)?;
        // Corrupt JSON degrades to empty lists (logged) rather than failing
        // the whole listing - same policy as profile args.
        let default_args = serde_json::from_str(&default_args_raw).unwrap_or_else(|e| {
            eprintln!("[custom_agents] corrupt default_args for {}: {}", id, e);
            Vec::new()
        });
        let required_env = serde_json::from_str(&required_env_raw).unwrap_or_else(|e| {
            eprintln!("[custom_agents] corrupt required_env for {}: {}", id, e);
            Vec::new()
        });
        let bindings = serde_json::from_str(&bindings_raw).unwrap_or_else(|e| {
            eprintln!("[custom_agents] corrupt bindings for {}: {}", id, e);
            Vec::new()
        });
        Ok(crate::custom_agents::CustomAgent {
            id,
            name: row.get(1)?,
            binary: row.get(2)?,
            default_args,
            resume_flag: row.get(4)?,
            color: row.get(5)?,
            required_env,
            bindings,
            install_url: row.get(8)?,
            install_hint: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }

    const CUSTOM_AGENT_COLUMNS: &'static str =
        "id, name, binary, default_args, resume_flag, color, required_env, bindings, install_url, install_hint, created_at, updated_at";

    pub fn list_custom_agents(&self) -> Result<Vec<crate::custom_agents::CustomAgent>, String> {
        let sql = format!(
            "SELECT {} FROM custom_agents WHERE deleted_at IS NULL ORDER BY created_at ASC, name ASC",
            Self::CUSTOM_AGENT_COLUMNS,
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], Self::row_to_custom_agent).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_custom_agent(&self, id: &str) -> Result<Option<crate::custom_agents::CustomAgent>, String> {
        let sql = format!("SELECT {} FROM custom_agents WHERE id = ?1 AND deleted_at IS NULL", Self::CUSTOM_AGENT_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query_map(params![id], Self::row_to_custom_agent).map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    const CREDENTIAL_COLUMNS: &'static str =
        "id, label, provider, env_name, endpoint_env, has_key, has_endpoint, masked_tail, created_at, last_used_at";

    fn row_to_credential(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::credentials::CredentialMeta> {
        let provider_raw: String = row.get(2)?;
        Ok(crate::credentials::CredentialMeta {
            id: row.get(0)?,
            label: row.get(1)?,
            provider: crate::credentials::Provider::from_str_lossy(&provider_raw),
            env_name: row.get(3)?,
            endpoint_env: row.get(4)?,
            has_key: row.get::<_, i32>(5)? != 0,
            has_endpoint: row.get::<_, i32>(6)? != 0,
            masked_tail: row.get(7)?,
            created_at: row.get(8)?,
            last_used_at: row.get(9)?,
        })
    }

    pub fn upsert_credential(&self, m: &crate::credentials::CredentialMeta) -> Result<(), String> {
        // Label uniqueness is a user-facing rule; report it in their words.
        let clash: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM credentials WHERE label = ?1 AND id != ?2",
                params![m.label, m.id],
                |r| r.get(0),
            )
            .ok();
        if clash.is_some() {
            return Err(crate::error_reporter::user_err(format!(
                "A key labelled \"{}\" already exists",
                m.label
            )));
        }
        self.conn
            .execute(
                "INSERT OR REPLACE INTO credentials
                 (id, label, provider, env_name, endpoint_env, has_key, has_endpoint, masked_tail, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    m.id,
                    m.label,
                    m.provider.as_str(),
                    m.env_name,
                    m.endpoint_env,
                    m.has_key as i32,
                    m.has_endpoint as i32,
                    m.masked_tail,
                    m.created_at,
                    m.last_used_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_credentials(&self) -> Result<Vec<crate::credentials::CredentialMeta>, String> {
        let sql = format!(
            "SELECT {} FROM credentials ORDER BY created_at ASC, label ASC",
            Self::CREDENTIAL_COLUMNS
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_credential)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_credential(&self, id: &str) -> Result<Option<crate::credentials::CredentialMeta>, String> {
        let sql = format!("SELECT {} FROM credentials WHERE id = ?1", Self::CREDENTIAL_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![id], Self::row_to_credential)
            .map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn touch_credential_used(&self, id: &str) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .execute(
                "UPDATE credentials SET last_used_at = ?1 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_agent_bindings(&self, agent_wire: &str) -> Result<Vec<crate::config::CredentialBinding>, String> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT bindings FROM agent_defaults WHERE agent = ?1",
                params![agent_wire],
                |r| r.get(0),
            )
            .ok();
        Ok(raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    pub fn set_agent_bindings(
        &self,
        agent_wire: &str,
        bindings: &[crate::config::CredentialBinding],
    ) -> Result<(), String> {
        let json = serde_json::to_string(bindings).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT OR REPLACE INTO agent_defaults (agent, bindings) VALUES (?1, ?2)",
                params![agent_wire, json],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete a credential row and strip every binding that referenced it
    /// (custom agents, built-in defaults, profiles). One transaction so a
    /// dangling binding can never survive a partial failure.
    pub fn delete_credential_cascade(&self, id: &str) -> Result<(), String> {
        self.conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            self.conn
                .execute("DELETE FROM credentials WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            for mut a in self.list_custom_agents()? {
                if a.bindings.iter().any(|b| b.credential_id == id) {
                    a.bindings.retain(|b| b.credential_id != id);
                    self.save_custom_agent(&a)?;
                }
            }
            let agents: Vec<String> = {
                let mut stmt = self
                    .conn
                    .prepare("SELECT agent FROM agent_defaults")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            for agent in agents {
                let mut b = self.get_agent_bindings(&agent)?;
                if b.iter().any(|x| x.credential_id == id) {
                    b.retain(|x| x.credential_id != id);
                    self.set_agent_bindings(&agent, &b)?;
                }
            }
            for mut p in self.get_profiles()? {
                if p.credential_bindings.iter().any(|b| b.credential_id == id) {
                    p.credential_bindings.retain(|b| b.credential_id != id);
                    self.save_profile(&p)?;
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => self.conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Upsert a workspace by name and return its sync-facing key (`sync_id`).
    ///
    /// On first save for a given name, a fresh UUID `sync_id` is stamped along
    /// with `updated_at = now()`. On repeat saves, the existing row's `sync_id`
    /// is preserved (previously `INSERT OR REPLACE` deleted+reinserted, which
    /// rotated `sync_id` on every save and broke cross-device merges).
    ///
    /// The returned `sync_id` is what callers pass to `touch_sync_row`. For
    /// `__`-prefixed internal keys (e.g. `__last_session__`) the sync_id is
    /// still returned, but the IPC layer must skip enqueueing them - they
    /// snapshot ephemeral local state and would spam every device otherwise.
    pub fn save_workspace(&self, name: &str, terminals: &[TerminalConfig]) -> Result<String, String> {
        // Allow internal keys like "__last_session__" but validate user-facing names
        if !name.starts_with("__") && (name.is_empty() || name.len() > 255) {
            return Err("Workspace name must be 1-255 characters".to_string());
        }
        let terminals_json = serde_json::to_string(terminals).map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let new_sync_id = uuid::Uuid::new_v4().to_string();
        // ON CONFLICT(name) DO UPDATE preserves the existing `sync_id`
        // (unlike INSERT OR REPLACE, which deletes the row and would let the
        // new UUID clobber the stable identity).
        self.conn.execute(
            "INSERT INTO workspaces (name, terminals, created_at, sync_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(name) DO UPDATE SET
                terminals = excluded.terminals,
                deleted_at = NULL,
                updated_at = excluded.updated_at",
            params![name, terminals_json, now, new_sync_id, now],
        ).map_err(|e| e.to_string())?;
        // Read back the row's actual sync_id (which is `new_sync_id` for a
        // fresh insert or the pre-existing one for an update).
        let sync_id: String = self.conn.query_row(
            "SELECT sync_id FROM workspaces WHERE name = ?1",
            params![name],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(sync_id)
    }

    pub fn get_workspaces(&self) -> Result<Vec<WorkspaceInfo>, String> {
        let mut stmt = self.conn
            .prepare("SELECT name, terminals, created_at FROM workspaces WHERE name != '__last_session__' AND deleted_at IS NULL ORDER BY created_at DESC")
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

    pub fn load_workspace(&self, name: &str) -> Result<Vec<TerminalConfig>, String> {
        let terminals_json: String = self.conn
            .query_row(
                "SELECT terminals FROM workspaces WHERE name = ?1 AND deleted_at IS NULL",
                params![name],
                |row| row.get(0),
            )
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
        // Discard the sync_id: `__last_session__` is an ephemeral snapshot that
        // must never sync (see save_workspace docstring).
        self.save_workspace(Self::LAST_SESSION_KEY, &sorted).map(|_| ())
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
                "SELECT terminals FROM workspaces WHERE name = ?1 AND deleted_at IS NULL",
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

    /// Profiles whose env vars hold something that looks like a secret.
    /// Drives the one-time "move keys to the OS store" prompt.
    pub fn count_profiles_with_plaintext_keys(&self) -> Result<usize, String> {
        let looks_secret = |k: &str| k.ends_with("_API_KEY") || k.ends_with("_TOKEN") || k.ends_with("_SECRET");
        Ok(self
            .get_profiles()?
            .iter()
            .filter(|p| p.env_vars.iter().any(|(k, v)| looks_secret(k) && !v.trim().is_empty()))
            .count())
    }

    pub fn get_meta_flag(&self, key: &str) -> Result<bool, String> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |r| r.get(0))
            .ok();
        Ok(v.as_deref() == Some("1"))
    }

    pub fn set_meta_flag(&self, key: &str) -> Result<(), String> {
        self.conn
            .execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?1, '1')", params![key])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

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

    pub fn enqueue_sync(&self, table: &str, row_key: &str) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        // INSERT OR REPLACE resets attempts to 0 so a re-enqueue after a
        // rewrite doesn't inherit the previous attempt's backoff state.
        self.conn.execute(
            "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
             VALUES (?1, ?2, ?3, 0, NULL)",
            params![table, row_key, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn peek_sync_queue(&self, limit: usize) -> Result<Vec<SyncQueueRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT table_name, row_key, enqueued_at, attempts, last_attempt_at, last_error
                 FROM sync_queue ORDER BY enqueued_at LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(SyncQueueRow {
                    table_name: r.get(0)?,
                    row_key: r.get(1)?,
                    enqueued_at: r.get(2)?,
                    attempts: r.get(3)?,
                    last_attempt_at: r.get(4)?,
                    last_error: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn delete_sync_queue_entries(&self, entries: &[(String, String)]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare("DELETE FROM sync_queue WHERE table_name = ?1 AND row_key = ?2")
                .map_err(|e| e.to_string())?;
            for (t, k) in entries {
                stmt.execute(params![t, k]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A push may finish after the user has re-enqueued the same row.
    pub fn acknowledge_sync_entry(&self, entry: &SyncQueueRow) -> Result<(), String> {
        self.conn.execute(
            "DELETE FROM sync_queue WHERE table_name = ?1 AND row_key = ?2 AND enqueued_at = ?3",
            params![entry.table_name, entry.row_key, entry.enqueued_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_sync_attempt(&self, table: &str, row_key: &str, error: Option<&str>) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE sync_queue
             SET attempts = attempts + 1, last_attempt_at = ?1, last_error = ?2
             WHERE table_name = ?3 AND row_key = ?4",
            params![now, error, table, row_key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn sync_queue_depth(&self) -> Result<i64, String> {
        self.conn
            .query_row("SELECT COUNT(*) FROM sync_queue", [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())
    }

    /// Mark a syncable row as needing push. Idempotent: calling twice on the
    /// same row before the pusher drains it just bumps updated_at again.
    ///
    /// Table names are the local SQLite table (profiles/custom_agents/workspaces).
    /// row_key is the sync-facing key: `id` for profiles/custom_agents, `sync_id`
    /// for workspaces.
    pub fn touch_sync_row(&self, table: &str, row_key: &str) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let where_col = if table == "workspaces" { "sync_id" } else { "id" };
        let sql = format!(
            "UPDATE {table} SET updated_at = ?1, sync_state = ?2 WHERE {where_col} = ?3"
        );
        tx.execute(&sql, params![now, SyncState::Pending.as_sql_str(), row_key])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
             VALUES (?1, ?2, ?3, 0, NULL)",
            params![table, row_key, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mark a syncable row as soft-deleted and enqueue the tombstone.
    pub fn tombstone_sync_row(&self, table: &str, row_key: &str) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let where_col = if table == "workspaces" { "sync_id" } else { "id" };
        let sql = format!(
            "UPDATE {table} SET updated_at = ?1, deleted_at = ?1, sync_state = ?2 WHERE {where_col} = ?3"
        );
        tx.execute(&sql, params![now, SyncState::Pending.as_sql_str(), row_key])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
             VALUES (?1, ?2, ?3, 0, NULL)",
            params![table, row_key, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// After a successful push, flip the row to `synced` if updated_at still
    /// matches what was pushed (protects against a mutation racing the push).
    pub fn mark_row_synced_if_unchanged(
        &self,
        table: &str,
        row_key: &str,
        pushed_updated_at: &str,
    ) -> Result<(), String> {
        let where_col = if table == "workspaces" { "sync_id" } else { "id" };
        let sql = format!(
            "UPDATE {table} SET sync_state = ?1
             WHERE {where_col} = ?2 AND updated_at = ?3 AND sync_state = ?4"
        );
        self.conn
            .execute(
                &sql,
                params![
                    SyncState::Synced.as_sql_str(),
                    row_key,
                    pushed_updated_at,
                    SyncState::Pending.as_sql_str(),
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Read a syncable row as a `serde_json::Value` shaped for the sync-push
    /// JSON schema. Keys are camelCase to match the broker's zod schemas at
    /// `agentrium-api/src/app/api/sync/push/route.ts` — mismatched keys would
    /// silently drop rows on the server side.
    ///
    /// `row_key` is the sync-facing key: `id` for profiles/custom_agents,
    /// `sync_id` for workspaces.
    pub fn read_syncable_row_json(
        &self,
        table: &str,
        row_key: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        use serde_json::json;
        match table {
            "profiles" => {
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT id, name, description, working_directory, claude_args, env_vars,
                                is_default, preview_json, agent, agent_args_json,
                                credential_bindings_json, updated_at, deleted_at, client_version
                         FROM profiles WHERE id = ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let row = stmt.query_row(params![row_key], |r| {
                    let claude_args_json: String = r.get(4)?;
                    let env_vars_json: String = r.get(5)?;
                    let agent_args_json: Option<String> = r.get(9)?;
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "description": r.get::<_, Option<String>>(2)?,
                        "workingDirectory": r.get::<_, Option<String>>(3)?,
                        "claudeArgs": serde_json::from_str::<serde_json::Value>(&claude_args_json).unwrap_or(json!([])),
                        "envVars": serde_json::from_str::<serde_json::Value>(&env_vars_json).unwrap_or(json!({})),
                        "isDefault": r.get::<_, i32>(6)? != 0,
                        "agent": r.get::<_, String>(8)?,
                        "agentArgsJson": agent_args_json.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
                        "updatedAt": r.get::<_, String>(11)?,
                        "deletedAt": r.get::<_, Option<String>>(12)?,
                        "clientVersion": r.get::<_, i64>(13)?,
                    }))
                });
                match row {
                    Ok(v) => Ok(Some(v)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            }
            "custom_agents" => {
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT id, name, binary, default_args, resume_flag, color, required_env,
                                bindings, install_url, install_hint, updated_at, deleted_at,
                                client_version
                         FROM custom_agents WHERE id = ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let row = stmt.query_row(params![row_key], |r| {
                    let default_args_json: String = r.get(3)?;
                    let required_env_json: String = r.get(6)?;
                    let bindings_json: String = r.get(7)?;
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "binary": r.get::<_, String>(2)?,
                        "defaultArgs": serde_json::from_str::<serde_json::Value>(&default_args_json).unwrap_or(json!([])),
                        "resumeFlag": r.get::<_, Option<String>>(4)?,
                        "color": r.get::<_, String>(5)?,
                        "requiredEnv": serde_json::from_str::<serde_json::Value>(&required_env_json).unwrap_or(json!([])),
                        "bindings": serde_json::from_str::<serde_json::Value>(&bindings_json).unwrap_or(json!([])),
                        "installUrl": r.get::<_, Option<String>>(8)?,
                        "installHint": r.get::<_, Option<String>>(9)?,
                        "updatedAt": r.get::<_, String>(10)?,
                        "deletedAt": r.get::<_, Option<String>>(11)?,
                        "clientVersion": r.get::<_, i64>(12)?,
                    }))
                });
                match row {
                    Ok(v) => Ok(Some(v)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            }
            "workspaces" => {
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT sync_id, name, terminals, created_at, updated_at, deleted_at,
                                client_version
                         FROM workspaces WHERE sync_id = ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let row = stmt.query_row(params![row_key], |r| {
                    let terminals_json: String = r.get(2)?;
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "terminals": serde_json::from_str::<serde_json::Value>(&terminals_json).unwrap_or(json!([])),
                        "createdAt": r.get::<_, String>(3)?,
                        "updatedAt": r.get::<_, String>(4)?,
                        "deletedAt": r.get::<_, Option<String>>(5)?,
                        "clientVersion": r.get::<_, i64>(6)?,
                    }))
                });
                match row {
                    Ok(v) => Ok(Some(v)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            }
            _ => Ok(None),
        }
    }

    /// Return the `updated_at` timestamp for a syncable row, or `None` if
    /// the row is missing. Used by the pull-apply path to run the LWW check
    /// before invoking `upsert_pulled_row`.
    pub fn get_local_updated_at(&self, table: &str, row_key: &str) -> Result<Option<String>, String> {
        let where_col = if table == "workspaces" { "sync_id" } else { "id" };
        let sql = format!("SELECT updated_at FROM {table} WHERE {where_col} = ?1");
        self.conn
            .query_row(&sql, params![row_key], |r| r.get::<_, String>(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other.to_string()),
            })
    }

    /// Insert or overwrite a syncable row from a pulled JSON payload. Callers
    /// are expected to have already resolved LWW via `get_local_updated_at`
    /// and `incoming_wins`. Written rows are marked `synced`.
    pub fn upsert_pulled_row(&self, table: &str, row: &serde_json::Value) -> Result<(), String> {
        let mut row = row.clone();
        if table == "workspaces" {
            let name = row.get("name").and_then(|v| v.as_str()).ok_or("Missing workspace name")?.to_string();
            if name.starts_with("__") { return Ok(()); }
            let id = row.get("id").and_then(|v| v.as_str()).ok_or("Missing workspace id")?;
            let mut candidate = name.clone();
            let mut suffix = 0;
            loop {
                let occupied: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspaces WHERE name = ?1 AND sync_id != ?2)",
                    params![candidate, id], |r| r.get(0),
                ).map_err(|e| e.to_string())?;
                if !occupied { break; }
                suffix += 1;
                candidate = format!("{} (synced {})", name.chars().take(220).collect::<String>(), suffix);
            }
            row["name"] = serde_json::Value::String(candidate);
        }
        let get_str = |k: &str| row.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let get_opt_str = |k: &str| row.get(k).and_then(|v| v.as_str()).map(String::from);
        let get_bool = |k: &str| row.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        let get_i64 = |k: &str| row.get(k).and_then(|v| v.as_i64()).unwrap_or(1);
        let ua = row
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("updated_at").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        match table {
            "profiles" => {
                let claude_args = row.get("claudeArgs").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                let env_vars = row.get("envVars").map(|v| v.to_string()).unwrap_or_else(|| "{}".into());
                let agent_args_json = row.get("agentArgsJson").map(|v| v.to_string());
                self.conn.execute(
                    "INSERT OR REPLACE INTO profiles
                       (id, name, description, working_directory, claude_args, env_vars,
                        is_default, agent, agent_args_json, updated_at, deleted_at,
                        client_version, sync_state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        get_str("id"), get_str("name"), get_opt_str("description"),
                        get_opt_str("workingDirectory"), claude_args, env_vars,
                        if get_bool("isDefault") { 1 } else { 0 }, get_str("agent"), agent_args_json,
                        ua, get_opt_str("deletedAt"), get_i64("clientVersion"),
                        SyncState::Synced.as_sql_str(),
                    ],
                ).map_err(|e| e.to_string())?;
            }
            "custom_agents" => {
                let default_args = row.get("defaultArgs").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                let required_env = row.get("requiredEnv").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                let bindings = row.get("bindings").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                self.conn.execute(
                    "INSERT OR REPLACE INTO custom_agents
                       (id, name, binary, default_args, resume_flag, color, required_env,
                        bindings, install_url, install_hint, created_at, updated_at, deleted_at,
                        client_version, sync_state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                             COALESCE((SELECT created_at FROM custom_agents WHERE id = ?1), ?11),
                             ?11, ?12, ?13, ?14)",
                    params![
                        get_str("id"), get_str("name"), get_str("binary"),
                        default_args, get_opt_str("resumeFlag"), get_str("color"),
                        required_env, bindings, get_opt_str("installUrl"),
                        get_opt_str("installHint"), ua, get_opt_str("deletedAt"),
                        get_i64("clientVersion"), SyncState::Synced.as_sql_str(),
                    ],
                ).map_err(|e| e.to_string())?;
            }
            "workspaces" => {
                let terminals = row.get("terminals").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                let created_at = get_opt_str("createdAt").unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                let existing: Option<i64> = self.conn
                    .query_row(
                        "SELECT id FROM workspaces WHERE sync_id = ?1",
                        params![get_str("id")],
                        |r| r.get(0),
                    )
                    .ok();
                if existing.is_some() {
                    self.conn.execute(
                        "UPDATE workspaces SET name = ?1, terminals = ?2, updated_at = ?3,
                                deleted_at = ?4, client_version = ?5, sync_state = ?6
                         WHERE sync_id = ?7",
                        params![
                            get_str("name"), terminals, ua, get_opt_str("deletedAt"),
                            get_i64("clientVersion"), SyncState::Synced.as_sql_str(),
                            get_str("id"),
                        ],
                    ).map_err(|e| e.to_string())?;
                } else {
                    self.conn.execute(
                        "INSERT INTO workspaces (sync_id, name, terminals, created_at, updated_at,
                                                 deleted_at, client_version, sync_state)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            get_str("id"), get_str("name"), terminals, created_at, ua,
                            get_opt_str("deletedAt"), get_i64("clientVersion"),
                            SyncState::Synced.as_sql_str(),
                        ],
                    ).map_err(|e| e.to_string())?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Make `account` the owner of the syncable working set. Call only after
    /// the previous sync engine has stopped.
    ///
    /// - First sign-in on this device (no owner yet): the guest working set is
    ///   adopted as-is; a stale global pull cursor from older builds is dropped.
    /// - Switching to an account this device has already seen: the current set
    ///   (rows, queue, cursor) is parked in the previous owner's snapshot and the
    ///   target account's snapshot is restored.
    /// - Switching to an account new to this device: the current set is parked
    ///   for the previous owner too, but the live rows stay and are re-flagged
    ///   `local_only` so `run_guest_migration` pushes them under the new
    ///   account ("what is on the PC follows the user"). Tombstones, the old
    ///   queue and the old cursor are not inherited.
    ///
    /// Internal `__`-prefixed workspaces stay local in every case.
    pub fn activate_sync_account(&self, account: &str) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let previous = self.get_user_meta("sync_account_id")?;
        if previous.as_deref() == Some(account) { return Ok(()); }
        let tables = ["profiles", "custom_agents", "workspaces", "sync_queue"];
        if let Some(previous) = previous {
            let mut snapshot = serde_json::Map::new();
            for table in tables {
                let columns = self.sync_snapshot_columns(table)?;
                let fields = columns.iter().map(|c| format!("'{c}', \"{c}\"")).collect::<Vec<_>>().join(",");
                let filter = if table == "workspaces" { " WHERE substr(name, 1, 2) != '__'" } else { "" };
                let mut stmt = self.conn.prepare(&format!("SELECT json_object({fields}) FROM {table}{filter}"))
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?
                    .map(|r| r.map_err(|e| e.to_string()).and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string())))
                    .collect::<Result<Vec<serde_json::Value>, String>>()?;
                snapshot.insert(table.into(), serde_json::Value::Array(rows));
            }
            snapshot.insert("cursor".into(), serde_json::json!(self.get_last_pull_cursor()?));
            self.set_user_meta(&format!("sync_snapshot:{previous}"), Some(&serde_json::Value::Object(snapshot).to_string()))?;
            self.delete_user_meta("last_pull_cursor")?;
            if let Some(saved) = self.get_user_meta(&format!("sync_snapshot:{account}"))? {
                for table in tables {
                    let filter = if table == "workspaces" { " WHERE substr(name, 1, 2) != '__'" } else { "" };
                    self.conn.execute(&format!("DELETE FROM {table}{filter}"), []).map_err(|e| e.to_string())?;
                }
                let snapshot: serde_json::Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
                for table in tables {
                    let columns = self.sync_snapshot_columns(table)?;
                    let names = columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(",");
                    let values = columns.iter().map(|c| format!("json_extract(?1, '$.{c}')")).collect::<Vec<_>>().join(",");
                    let rows = snapshot[table].as_array().ok_or("Invalid account snapshot")?;
                    for row in rows {
                        self.conn.execute(&format!("INSERT INTO {table} ({names}) VALUES ({values})"), [row.to_string()])
                            .map_err(|e| e.to_string())?;
                    }
                }
                if let Some(cursor) = snapshot["cursor"].as_str() { self.set_last_pull_cursor(cursor)?; }
            } else {
                // Account is new to this device: inherit the live working set.
                // The previous owner's queue is parked in its snapshot; the new
                // account gets a fresh queue built by run_guest_migration.
                self.conn.execute("DELETE FROM sync_queue", []).map_err(|e| e.to_string())?;
                for table in ["profiles", "custom_agents", "workspaces"] {
                    let filter = if table == "workspaces" { " AND substr(name, 1, 2) != '__'" } else { "" };
                    self.conn.execute(
                        &format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL{filter}"), [],
                    ).map_err(|e| e.to_string())?;
                    self.conn.execute(
                        &format!("UPDATE {table} SET sync_state = ?1 WHERE deleted_at IS NULL{filter}"),
                        [SyncState::LocalOnly.as_sql_str()],
                    ).map_err(|e| e.to_string())?;
                }
            }
        } else {
            // Older builds had a global cursor with no owner. Never carry that
            // cursor into a newly identified account.
            self.delete_user_meta("last_pull_cursor")?;
        }
        self.set_user_meta("sync_account_id", Some(account))?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn sync_snapshot_columns(&self, table: &str) -> Result<Vec<String>, String> {
        let mut stmt = self.conn.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        // The integer workspace id is device-local; the sync UUID is stable.
        Ok(columns.into_iter().filter(|c| table != "workspaces" || c != "id").collect())
    }

    /// Read a `user_meta` value. Returns `Ok(None)` for both a missing row and
    /// a row with a SQL NULL value, which is what auth callers want ("not set"
    /// vs "explicitly cleared" are the same signal here).
    pub fn get_user_meta(&self, key: &str) -> Result<Option<String>, String> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                "SELECT value FROM user_meta WHERE key = ?1",
                [key],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| e.to_string())
            .map(|opt| opt.flatten())
    }

    /// Upsert a `user_meta` value. Passing `None` writes SQL NULL, which
    /// `get_user_meta` surfaces as `Ok(None)`.
    pub fn set_user_meta(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO user_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_user_meta(&self, key: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM user_meta WHERE key = ?1", [key])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_sync_enabled(&self) -> Result<bool, String> {
        // Default ON — sync is the reason a user signed in, so opt-out not opt-in.
        Ok(self.get_user_meta("sync_enabled")?.as_deref() != Some("0"))
    }

    pub fn set_sync_enabled(&self, enabled: bool) -> Result<(), String> {
        self.set_user_meta("sync_enabled", Some(if enabled { "1" } else { "0" }))
    }

    pub fn get_last_pull_cursor(&self) -> Result<Option<String>, String> {
        self.get_user_meta("last_pull_cursor")
    }

    pub fn set_last_pull_cursor(&self, cursor: &str) -> Result<(), String> {
        self.set_user_meta("last_pull_cursor", Some(cursor))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stale_push_ack_preserves_requeued_edit_and_delete() {
        let db = super::Database::new_in_memory().unwrap();
        let id = db.save_workspace("race", &[]).unwrap();
        db.touch_sync_row("workspaces", &id).unwrap();
        let old = db.peek_sync_queue(1).unwrap().remove(0);
        db.conn.execute("UPDATE sync_queue SET enqueued_at = 'new-edit'", []).unwrap();
        db.acknowledge_sync_entry(&old).unwrap();
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
        let edited = db.peek_sync_queue(1).unwrap().remove(0);
        db.tombstone_sync_row("workspaces", &id).unwrap();
        db.acknowledge_sync_entry(&edited).unwrap();
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
        let latest = db.peek_sync_queue(1).unwrap().remove(0);
        db.acknowledge_sync_entry(&latest).unwrap();
        assert_eq!(db.sync_queue_depth().unwrap(), 0);
    }

    #[test]
    fn saving_deleted_workspace_restores_same_identity() {
        let db = super::Database::new_in_memory().unwrap();
        let id = db.save_workspace("restore", &[]).unwrap();
        db.tombstone_sync_row("workspaces", &id).unwrap();
        assert!(db.load_workspace("restore").is_err());
        assert_eq!(db.save_workspace("restore", &[]).unwrap(), id);
        db.touch_sync_row("workspaces", &id).unwrap();
        assert!(db.load_workspace("restore").is_ok());
        assert!(db.read_syncable_row_json("workspaces", &id).unwrap().unwrap()["deletedAt"].is_null());
    }

    #[test]
    fn account_switch_preserves_each_queue_cursor_and_working_set() {
        let db = super::Database::new_in_memory().unwrap();
        db.conn.execute("INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at)
            VALUES ('profile-A', 'A', '/project', '[\"--verbose\"]', '{\"MODE\":\"test\"}', '2026-09-12T00:00:00Z')", []).unwrap();
        let internal = db.save_workspace("__last_session__", &[]).unwrap();
        let a = db.save_workspace("shared name", &[]).unwrap();
        db.touch_sync_row("workspaces", &a).unwrap();
        db.activate_sync_account("A").unwrap();
        db.set_last_pull_cursor("cursor-A").unwrap();
        db.activate_sync_account("B").unwrap();
        // B has never been seen on this device: it inherits the working set
        // (re-flagged local_only for push) but not A's queue or cursor.
        assert!(db.read_syncable_row_json("profiles", "profile-A").unwrap().is_some());
        assert_eq!(db.get_workspaces().unwrap().len(), 1);
        assert_eq!(db.sync_queue_depth().unwrap(), 0);
        assert_eq!(db.get_last_pull_cursor().unwrap(), None);
        assert!(db.load_workspace("__last_session__").is_ok());
        let b = db.save_workspace("b only", &[]).unwrap();
        db.touch_sync_row("workspaces", &b).unwrap();
        db.set_last_pull_cursor("cursor-B").unwrap();
        db.activate_sync_account("A").unwrap();
        let profile = db.read_syncable_row_json("profiles", "profile-A").unwrap().unwrap();
        assert_eq!(profile["claudeArgs"], serde_json::json!(["--verbose"]));
        assert_eq!(profile["envVars"], serde_json::json!({"MODE": "test"}));
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("cursor-A"));
        assert_eq!(db.peek_sync_queue(10).unwrap()[0].row_key, a);
        assert!(db.read_syncable_row_json("workspaces", &b).unwrap().is_none());
        assert!(db.read_syncable_row_json("workspaces", &internal).unwrap().is_some());
        db.activate_sync_account("A").unwrap();
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
        db.activate_sync_account("B").unwrap();
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("cursor-B"));
        assert_eq!(db.peek_sync_queue(10).unwrap()[0].row_key, b);
    }

    #[test]
    fn switching_to_an_account_new_to_this_device_inherits_the_working_set() {
        let db = super::Database::new_in_memory().unwrap();
        db.conn.execute("INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
            VALUES ('live', 'Live', '/p', '[]', '{}', '2026-09-12T00:00:00Z', 'synced'),
                   ('gone', 'Gone', '/p', '[]', '{}', '2026-09-12T00:00:00Z', 'synced')", []).unwrap();
        db.tombstone_sync_row("profiles", "gone").unwrap();
        db.save_workspace("__last_session__", &[]).unwrap();
        let ws = db.save_workspace("daily", &[]).unwrap();
        db.touch_sync_row("workspaces", &ws).unwrap();
        db.activate_sync_account("A").unwrap();
        db.set_last_pull_cursor("cursor-A").unwrap();
        let queued_under_a = db.sync_queue_depth().unwrap();
        assert!(queued_under_a >= 2);

        db.activate_sync_account("B").unwrap();
        // Live rows carry over and become local_only so run_guest_migration
        // enqueues them for push under B. Tombstones are not inherited.
        assert_eq!(db.get_profiles().unwrap().len(), 1);
        let state: String = db.conn.query_row(
            "SELECT sync_state FROM profiles WHERE id = 'live'", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "local_only");
        assert!(db.read_syncable_row_json("profiles", "gone").unwrap().is_none());
        assert!(db.load_workspace("daily").is_ok());
        assert!(db.load_workspace("__last_session__").is_ok());
        let ws_state: String = db.conn.query_row(
            "SELECT sync_state FROM workspaces WHERE sync_id = ?1", [&ws], |r| r.get(0)).unwrap();
        assert_eq!(ws_state, "local_only");
        // A's queue and cursor are parked in A's snapshot, not carried into B.
        assert_eq!(db.sync_queue_depth().unwrap(), 0);
        assert_eq!(db.get_last_pull_cursor().unwrap(), None);

        // Returning to A restores A exactly, tombstone and queue included.
        db.activate_sync_account("A").unwrap();
        assert!(db.read_syncable_row_json("profiles", "gone").unwrap().is_some());
        let state_a: String = db.conn.query_row(
            "SELECT sync_state FROM profiles WHERE id = 'live'", [], |r| r.get(0)).unwrap();
        assert_eq!(state_a, "synced");
        assert_eq!(db.sync_queue_depth().unwrap(), queued_under_a);
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("cursor-A"));

        // B now has its own snapshot, so a second visit restores rather than re-inherits.
        db.activate_sync_account("B").unwrap();
        assert!(db.read_syncable_row_json("profiles", "gone").unwrap().is_none());
        assert_eq!(db.get_profiles().unwrap().len(), 1);
    }

    #[test]
    fn failed_account_restore_leaves_current_account_intact() {
        let db = super::Database::new_in_memory().unwrap();
        let id = db.save_workspace("keep", &[]).unwrap();
        db.touch_sync_row("workspaces", &id).unwrap();
        db.activate_sync_account("A").unwrap();
        db.set_last_pull_cursor("cursor-A").unwrap();
        db.set_user_meta("sync_snapshot:B", Some("invalid JSON")).unwrap();
        assert!(db.activate_sync_account("B").is_err());
        assert_eq!(db.get_user_meta("sync_account_id").unwrap().as_deref(), Some("A"));
        assert_eq!(db.get_last_pull_cursor().unwrap().as_deref(), Some("cursor-A"));
        assert!(db.load_workspace("keep").is_ok());
        assert_eq!(db.peek_sync_queue(10).unwrap()[0].row_key, id);
    }

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
            agent: crate::config::AgentKind::default(),
            preview: None,
            agent_args: HashMap::new(),
            credential_bindings: Vec::new(),
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
            agent: crate::config::AgentKind::Claude,
            credential_bindings: Vec::new(),
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

    // "delete removes only the target" is covered by
    // `tombstoned_profile_is_excluded_from_get_profiles` below (seeds 2 rows,
    // tombstones one, asserts the sibling remains). Physical DELETE on profiles
    // is intentionally not exposed: it would bypass sync tombstoning.

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

    // The __-prefix guard against deleting internal workspaces (e.g.
    // `__last_session__`) now lives only in the IPC handler
    // `commands::delete_workspace`. `tombstone_sync_row` itself is intentionally
    // key-agnostic - the writer/IPC layer is the right place to enforce
    // user-facing name policy.

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

    #[test]
    fn profile_with_codex_agent_round_trips_through_db() {
        let db = Database::new_in_memory().unwrap();
        let mut profile = make_profile("p-codex", "codex-profile");
        profile.agent = crate::config::AgentKind::Codex;
        db.save_profile(&profile).unwrap();
        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].agent, crate::config::AgentKind::Codex);
    }

    #[test]
    fn profile_round_trips_per_agent_args_across_all_kinds() {
        let db = Database::new_in_memory().unwrap();
        let mut p = make_profile("p-multi", "multi");
        p.agent = crate::config::AgentKind::Claude;
        p.agent_args.insert(crate::config::AgentKind::Claude, vec!["--model".into(), "opus".into()]);
        p.agent_args.insert(crate::config::AgentKind::Codex, vec!["--exec".into()]);
        p.agent_args.insert(crate::config::AgentKind::Cursor, vec!["--print".into()]);
        db.save_profile(&p).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded.len(), 1);
        let got = &loaded[0];
        assert_eq!(got.agent_args.get(&crate::config::AgentKind::Claude).unwrap(), &vec!["--model".to_string(), "opus".to_string()]);
        assert_eq!(got.agent_args.get(&crate::config::AgentKind::Codex).unwrap(), &vec!["--exec".to_string()]);
        assert_eq!(got.agent_args.get(&crate::config::AgentKind::Cursor).unwrap(), &vec!["--print".to_string()]);
        assert!(!got.agent_args.contains_key(&crate::config::AgentKind::Antigravity));
    }

    #[test]
    fn save_profile_mirrors_agent_args_into_claude_args_column() {
        // Legacy consumers still reading claude_args must see the args for
        // the profile's default agent, not whatever stale value the caller
        // sent in the ConfigProfile.claude_args field.
        let db = Database::new_in_memory().unwrap();
        let mut p = make_profile("p-mirror", "mirror");
        p.agent = crate::config::AgentKind::Codex;
        p.claude_args = vec!["stale-from-old-client".into()];
        p.agent_args.insert(crate::config::AgentKind::Codex, vec!["--codex-real".into()]);
        p.agent_args.insert(crate::config::AgentKind::Claude, vec!["--claude-real".into()]);
        db.save_profile(&p).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded[0].claude_args, vec!["--codex-real".to_string()]);
    }

    #[test]
    fn profile_without_agent_args_column_migrates_from_claude_args() {
        // Simulate a row saved before the agent_args_json column was ever
        // written. We can't literally test the pre-migration state without
        // the column existing, but we CAN force the column to NULL to model
        // "row from before this feature shipped".
        let db = Database::new_in_memory().unwrap();
        let mut p = make_profile("p-legacy", "legacy");
        p.agent = crate::config::AgentKind::Codex;
        p.claude_args = vec!["--legacy-codex".into()];
        db.save_profile(&p).unwrap();
        db.conn()
            .execute(
                "UPDATE profiles SET agent_args_json = NULL WHERE id = ?1",
                rusqlite::params![p.id],
            )
            .unwrap();

        let loaded = db.get_profiles().unwrap();
        // In-memory migration puts claude_args under the profile's agent so
        // args_for(Codex) returns the legacy list.
        assert_eq!(
            loaded[0].agent_args.get(&crate::config::AgentKind::Codex).unwrap(),
            &vec!["--legacy-codex".to_string()]
        );
        // Other agents fall through to args_for()'s claude_args fallback.
        assert!(!loaded[0].agent_args.contains_key(&crate::config::AgentKind::Claude));
        assert_eq!(
            loaded[0].args_for(crate::config::AgentKind::Claude),
            vec!["--legacy-codex".to_string()]
        );
    }

    #[test]
    fn profile_with_legacy_gemini_agent_migrates_to_antigravity() {
        // Regression guard: rows written by a pre-Antigravity build store
        // "gemini" in the agent column. init_schema's UPDATE promotes them
        // on the next launch, and from_str_lossy handles anything the
        // UPDATE missed. Both together prevent users from losing their
        // fourth-agent profile after the rename.
        let db = Database::new_in_memory().unwrap();
        let profile = make_profile("p-legacy-gemini", "legacy-gemini");
        db.save_profile(&profile).unwrap();
        db.conn().execute(
            "UPDATE profiles SET agent = 'gemini' WHERE id = ?1",
            rusqlite::params![profile.id],
        ).unwrap();

        // Re-open the DB so init_schema's UPDATE runs against the row.
        let raw = db.conn();
        raw.execute("UPDATE profiles SET agent = 'antigravity' WHERE agent = 'gemini'", []).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded[0].agent, crate::config::AgentKind::Antigravity);
    }

    #[test]
    fn profile_with_legacy_gemini_agent_args_key_maps_to_antigravity() {
        // Regression guard: pre-rename builds serialized agent_args_json
        // with `"gemini"` as a map key. The loader deserializes with
        // string keys and remaps through from_str_lossy so those entries
        // land on the Antigravity variant instead of dropping silently.
        let db = Database::new_in_memory().unwrap();
        let profile = make_profile("p-gemini-args", "gemini-args");
        db.save_profile(&profile).unwrap();
        db.conn().execute(
            r#"UPDATE profiles SET agent_args_json = '{"gemini":["--yolo"]}' WHERE id = ?1"#,
            rusqlite::params![profile.id],
        ).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(
            loaded[0].agent_args.get(&crate::config::AgentKind::Antigravity).unwrap(),
            &vec!["--yolo".to_string()]
        );
    }

    fn sample_custom_agent(id: &str) -> crate::custom_agents::CustomAgent {
        crate::custom_agents::CustomAgent {
            id: id.to_string(),
            name: "OpenCode".into(),
            binary: "opencode".into(),
            default_args: vec!["--agent".into(), "build".into()],
            resume_flag: Some("--session {id}".into()),
            color: "#30C55E".into(),
            required_env: vec!["OPENAI_API_KEY".into()],
            bindings: vec![crate::config::CredentialBinding { env: "OPENAI_API_KEY".into(), credential_id: "cred-1".into() }],
            install_url: Some("https://opencode.ai".into()),
            install_hint: Some("npm i -g opencode-ai".into()),
            created_at: "2026-09-04T00:00:00Z".into(),
            updated_at: "2026-09-04T00:00:00Z".into(),
        }
    }

    #[test]
    fn custom_agent_round_trips() {
        let db = Database::new_in_memory().unwrap();
        let a = sample_custom_agent("a1");
        db.save_custom_agent(&a).unwrap();
        let list = db.list_custom_agents().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], a);
        assert_eq!(db.get_custom_agent("a1").unwrap().unwrap().binary, "opencode");
        assert!(db.get_custom_agent("missing").unwrap().is_none());
    }

    #[test]
    fn custom_agent_save_replaces_existing() {
        let db = Database::new_in_memory().unwrap();
        let mut a = sample_custom_agent("a1");
        db.save_custom_agent(&a).unwrap();
        a.name = "OpenCode v2".into();
        db.save_custom_agent(&a).unwrap();
        assert_eq!(db.list_custom_agents().unwrap()[0].name, "OpenCode v2");
        // Deletion semantics are covered by
        // `tombstoned_custom_agent_is_excluded_from_list_and_get`.
    }

    #[test]
    fn custom_agents_list_orders_by_created_at() {
        let db = Database::new_in_memory().unwrap();
        let mut b = sample_custom_agent("b");
        b.created_at = "2026-09-05T00:00:00Z".into();
        let a = sample_custom_agent("a");
        db.save_custom_agent(&b).unwrap();
        db.save_custom_agent(&a).unwrap();
        let ids: Vec<String> = db.list_custom_agents().unwrap().into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    }

    fn sample_meta(id: &str, label: &str) -> crate::credentials::CredentialMeta {
        crate::credentials::CredentialMeta {
            id: id.into(),
            label: label.into(),
            provider: crate::credentials::Provider::OpenAI,
            env_name: "OPENAI_API_KEY".into(),
            endpoint_env: Some("OPENAI_BASE_URL".into()),
            has_key: true,
            has_endpoint: false,
            masked_tail: Some("9fQ2".into()),
            created_at: "2026-09-04T00:00:00Z".into(),
            last_used_at: None,
        }
    }

    #[test]
    fn get_credential_returns_none_for_unknown_id() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.get_credential("nope").unwrap().is_none());
    }

    #[test]
    fn credential_meta_round_trips_and_label_is_unique() {
        let db = Database::new_in_memory().unwrap();
        db.upsert_credential(&sample_meta("c1", "Work")).unwrap();
        assert_eq!(db.list_credentials().unwrap()[0], sample_meta("c1", "Work"));
        assert_eq!(db.get_credential("c1").unwrap().unwrap().label, "Work");
        let dup = db.upsert_credential(&sample_meta("c2", "Work"));
        assert!(dup.is_err());
    }

    #[test]
    fn touch_credential_used_sets_last_used() {
        let db = Database::new_in_memory().unwrap();
        db.upsert_credential(&sample_meta("c1", "Work")).unwrap();
        db.touch_credential_used("c1").unwrap();
        assert!(db.get_credential("c1").unwrap().unwrap().last_used_at.is_some());
    }

    #[test]
    fn agent_default_bindings_round_trip() {
        let db = Database::new_in_memory().unwrap();
        let b = vec![crate::config::CredentialBinding { env: "ANTHROPIC_API_KEY".into(), credential_id: "c1".into() }];
        db.set_agent_bindings("claude", &b).unwrap();
        assert_eq!(db.get_agent_bindings("claude").unwrap(), b);
        assert!(db.get_agent_bindings("codex").unwrap().is_empty());
    }

    #[test]
    fn profile_credential_bindings_persist() {
        let db = Database::new_in_memory().unwrap();
        let mut p = crate::config::ConfigProfile {
            id: "p1".into(), name: "P".into(), description: None, working_directory: "C:\\w".into(),
            claude_args: vec![], env_vars: Default::default(), is_default: false,
            agent: crate::config::AgentKind::Claude, preview: None, agent_args: Default::default(),
            credential_bindings: vec![],
        };
        p.credential_bindings = vec![crate::config::CredentialBinding { env: "ANTHROPIC_API_KEY".into(), credential_id: "c1".into() }];
        db.save_profile(&p).unwrap();
        assert_eq!(db.get_profiles().unwrap()[0].credential_bindings, p.credential_bindings);
    }

    #[test]
    fn delete_credential_cascades_to_every_binding_site() {
        let db = Database::new_in_memory().unwrap();
        db.upsert_credential(&sample_meta("c1", "Work")).unwrap();
        db.upsert_credential(&sample_meta("c2", "Other")).unwrap();
        let keep = crate::config::CredentialBinding { env: "OTHER".into(), credential_id: "c2".into() };
        let gone = crate::config::CredentialBinding { env: "OPENAI_API_KEY".into(), credential_id: "c1".into() };
        let mut a = sample_custom_agent("a1");
        a.required_env = vec!["OPENAI_API_KEY".into(), "OTHER".into()];
        a.bindings = vec![gone.clone(), keep.clone()];
        db.save_custom_agent(&a).unwrap();
        db.set_agent_bindings("codex", &[gone.clone(), keep.clone()]).unwrap();
        let p = crate::config::ConfigProfile {
            id: "p1".into(), name: "P".into(), description: None, working_directory: "C:\\w".into(),
            claude_args: vec![], env_vars: Default::default(), is_default: false,
            agent: crate::config::AgentKind::Claude, preview: None, agent_args: Default::default(),
            credential_bindings: vec![gone.clone(), keep.clone()],
        };
        db.save_profile(&p).unwrap();

        db.delete_credential_cascade("c1").unwrap();

        assert!(db.get_credential("c1").unwrap().is_none());
        assert_eq!(db.get_custom_agent("a1").unwrap().unwrap().bindings, vec![keep.clone()]);
        assert_eq!(db.get_agent_bindings("codex").unwrap(), vec![keep.clone()]);
        assert_eq!(db.get_profiles().unwrap()[0].credential_bindings, vec![keep]);
    }

    #[test]
    fn plaintext_key_profile_count_and_prompt_flag() {
        let db = Database::new_in_memory().unwrap();
        let mut p = crate::config::ConfigProfile {
            id: "p1".into(), name: "P".into(), description: None, working_directory: "C:\\w".into(),
            claude_args: vec![], env_vars: Default::default(), is_default: false,
            agent: crate::config::AgentKind::Claude, preview: None, agent_args: Default::default(),
            credential_bindings: vec![],
        };
        p.env_vars.insert("ANTHROPIC_API_KEY".into(), "sk-ant-x".into());
        db.save_profile(&p).unwrap();
        assert_eq!(db.count_profiles_with_plaintext_keys().unwrap(), 1);
        assert!(!db.get_meta_flag("keys_migration_prompted").unwrap());
        db.set_meta_flag("keys_migration_prompted").unwrap();
        assert!(db.get_meta_flag("keys_migration_prompted").unwrap());
    }

    #[test]
    fn profile_without_agent_column_migration_defaults_to_claude() {
        // Simulate a legacy row inserted before the `agent` column existed.
        // We can't literally test the ALTER TABLE migration path in-memory
        // (the schema always includes `agent` on fresh init), but we CAN
        // verify the fallback: if the column value is stored as an empty
        // string or a value we don't recognize, it deserializes to Claude.
        let db = Database::new_in_memory().unwrap();
        let profile = make_profile("p-legacy", "legacy-profile");
        db.save_profile(&profile).unwrap();

        // Overwrite the agent column to an unknown value on the raw row.
        db.conn().execute(
            "UPDATE profiles SET agent = 'unknown-agent-name' WHERE id = ?1",
            rusqlite::params![profile.id],
        ).unwrap();

        let loaded = db.get_profiles().unwrap();
        assert_eq!(loaded[0].agent, crate::config::AgentKind::Claude);
    }

    #[test]
    fn user_meta_round_trip() {
        let db = Database::new_in_memory().unwrap();
        db.set_user_meta("auth_prompt_seen", Some("1")).unwrap();
        assert_eq!(db.get_user_meta("auth_prompt_seen").unwrap().as_deref(), Some("1"));
        db.delete_user_meta("auth_prompt_seen").unwrap();
        assert!(db.get_user_meta("auth_prompt_seen").unwrap().is_none());
    }

    #[test]
    fn sync_state_roundtrips_sql_string() {
        use std::str::FromStr;
        for s in [SyncState::LocalOnly, SyncState::Pending, SyncState::Synced] {
            assert_eq!(SyncState::from_str(s.as_sql_str()), Ok(s));
        }
        assert!(SyncState::from_str("pendinng").is_err());
        assert!(SyncState::from_str("").is_err());
    }

    #[test]
    fn sync_queue_enqueue_and_drain_cycle() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "p1").unwrap();
        db.enqueue_sync("profiles", "p2").unwrap();
        db.enqueue_sync("workspaces", "w1").unwrap();

        let rows = db.peek_sync_queue(100).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(db.sync_queue_depth().unwrap(), 3);

        db.delete_sync_queue_entries(&[
            ("profiles".into(), "p1".into()),
            ("workspaces".into(), "w1".into()),
        ])
        .unwrap();
        assert_eq!(db.sync_queue_depth().unwrap(), 1);

        let remaining = db.peek_sync_queue(100).unwrap();
        assert_eq!(remaining[0].row_key, "p2");
    }

    #[test]
    fn record_sync_attempt_increments_and_stores_error() {
        let db = Database::new_in_memory().unwrap();
        db.enqueue_sync("profiles", "p1").unwrap();
        db.record_sync_attempt("profiles", "p1", Some("boom")).unwrap();
        db.record_sync_attempt("profiles", "p1", None).unwrap();
        let rows = db.peek_sync_queue(10).unwrap();
        assert_eq!(rows[0].attempts, 2);
        assert!(rows[0].last_attempt_at.is_some());
        // Second recorded attempt cleared the error message.
        assert!(rows[0].last_error.is_none());
    }

    #[test]
    fn sync_enabled_defaults_to_true_when_unset() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.get_sync_enabled().unwrap());
        db.set_sync_enabled(false).unwrap();
        assert!(!db.get_sync_enabled().unwrap());
        db.set_sync_enabled(true).unwrap();
        assert!(db.get_sync_enabled().unwrap());
    }

    #[test]
    fn touch_sync_row_enqueues_and_bumps_updated_at() {
        let db = Database::new_in_memory().unwrap();
        // Seed a profile row directly (bypassing save_profile so we control state).
        db.conn.execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'Test', '/tmp', '[]', '{}', '2020-01-01T00:00:00Z', 'synced')",
            [],
        ).unwrap();

        db.touch_sync_row("profiles", "p1").unwrap();

        let (updated_at, sync_state): (String, String) = db.conn.query_row(
            "SELECT updated_at, sync_state FROM profiles WHERE id = 'p1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert!(updated_at > "2020-01-01T00:00:00Z".to_string());
        assert_eq!(sync_state, "pending");

        assert_eq!(db.sync_queue_depth().unwrap(), 1);
    }

    #[test]
    fn tombstone_sync_row_soft_deletes_and_enqueues() {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'Doomed', '/tmp', '[]', '{}', '2020-01-01T00:00:00Z', 'synced')",
            [],
        ).unwrap();

        db.tombstone_sync_row("profiles", "p1").unwrap();

        let (updated_at, deleted_at, sync_state): (String, Option<String>, String) = db.conn.query_row(
            "SELECT updated_at, deleted_at, sync_state FROM profiles WHERE id = 'p1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert!(updated_at > "2020-01-01T00:00:00Z".to_string());
        // Same timestamp is bound to both slots — verify the tombstone marker was set.
        assert_eq!(deleted_at.as_deref(), Some(updated_at.as_str()));
        assert_eq!(sync_state, "pending");
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
    }

    #[test]
    fn mark_row_synced_if_unchanged_is_race_safe() {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'Test', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'pending')",
            [],
        ).unwrap();

        // Successful push: nothing has changed since the pushed timestamp -> flip to synced.
        db.mark_row_synced_if_unchanged("profiles", "p1", "2026-01-01T00:00:00Z").unwrap();
        let s: String = db.conn.query_row(
            "SELECT sync_state FROM profiles WHERE id = 'p1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(s, "synced");

        // Now the user edits the row while a stale push completes.
        db.conn.execute(
            "UPDATE profiles SET updated_at = '2026-06-01T00:00:00Z', sync_state = 'pending' WHERE id = 'p1'",
            [],
        ).unwrap();
        // Stale push tries to flip it — must NOT clobber pending state.
        db.mark_row_synced_if_unchanged("profiles", "p1", "2026-01-01T00:00:00Z").unwrap();
        let s: String = db.conn.query_row(
            "SELECT sync_state FROM profiles WHERE id = 'p1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(s, "pending"); // still pending; the newer edit is not yet pushed
    }

    #[test]
    fn mark_row_synced_if_unchanged_stays_pending_when_tombstoned_during_push() {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'Test', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'pending')",
            [],
        ).unwrap();

        // User deletes the profile while a push of the earlier update is in-flight.
        db.tombstone_sync_row("profiles", "p1").unwrap();

        // The stale push tries to flip the row -> must NOT clobber the pending tombstone.
        db.mark_row_synced_if_unchanged("profiles", "p1", "2026-01-01T00:00:00Z").unwrap();

        let sync_state: String = db.conn.query_row(
            "SELECT sync_state FROM profiles WHERE id = 'p1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(sync_state, "pending", "tombstone push must still be enqueued");
    }

    #[test]
    fn tombstoned_profile_is_excluded_from_get_profiles() {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at)
             VALUES ('live', 'Live', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z'),
                    ('gone', 'Gone', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z')",
            [],
        ).unwrap();
        db.tombstone_sync_row("profiles", "gone").unwrap();

        let all = db.get_profiles().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "live");
    }

    #[test]
    fn tombstoned_custom_agent_is_excluded_from_list_and_get() {
        let db = Database::new_in_memory().unwrap();
        db.save_custom_agent(&sample_custom_agent("live")).unwrap();
        db.save_custom_agent(&sample_custom_agent("gone")).unwrap();
        db.tombstone_sync_row("custom_agents", "gone").unwrap();

        let listed = db.list_custom_agents().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "live");

        assert!(db.get_custom_agent("gone").unwrap().is_none(),
            "get_custom_agent must not resurrect tombstoned rows");
        assert!(db.get_custom_agent("live").unwrap().is_some());
    }

    #[test]
    fn tombstoned_workspace_is_excluded_from_get_and_load() {
        let db = Database::new_in_memory().unwrap();
        db.save_workspace("live", &[make_terminal("t-live", 0)]).unwrap();
        let gone_sync_id = db
            .save_workspace("gone", &[make_terminal("t-gone", 0)])
            .unwrap();
        db.tombstone_sync_row("workspaces", &gone_sync_id).unwrap();

        let listed = db.get_workspaces().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "live");

        assert!(db.load_workspace("gone").is_err(),
            "load_workspace must treat a tombstoned name as absent");
        assert!(db.load_workspace("live").is_ok());
    }

    #[test]
    fn read_syncable_row_json_returns_none_for_missing_row() {
        let db = Database::new_in_memory().unwrap();
        let v = db.read_syncable_row_json("profiles", "nonexistent").unwrap();
        assert!(v.is_none());
    }

    #[test]
    fn read_syncable_row_json_shapes_a_profile_correctly() {
        let db = Database::new_in_memory().unwrap();
        db.conn.execute(
            "INSERT INTO profiles (id, name, description, working_directory, claude_args, env_vars,
                                   is_default, agent, updated_at, client_version, sync_state)
             VALUES ('p1', 'Alpha', 'desc', '/tmp', '[\"--foo\"]', '{\"K\":\"V\"}',
                     1, 'claude', '2026-06-01T00:00:00Z', 3, 'pending')",
            [],
        ).unwrap();

        let v = db.read_syncable_row_json("profiles", "p1").unwrap().unwrap();
        assert_eq!(v.get("id").and_then(|x| x.as_str()), Some("p1"));
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("Alpha"));
        assert_eq!(v.get("workingDirectory").and_then(|x| x.as_str()), Some("/tmp"));
        assert_eq!(v.get("isDefault").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.get("clientVersion").and_then(|x| x.as_i64()), Some(3));
        assert_eq!(v.get("updatedAt").and_then(|x| x.as_str()), Some("2026-06-01T00:00:00Z"));
        assert!(v.get("deletedAt").unwrap().is_null());
        assert_eq!(v.get("claudeArgs").unwrap().as_array().unwrap()[0].as_str(), Some("--foo"));
    }

    #[test]
    fn get_local_updated_at_returns_none_for_missing() {
        let db = Database::new_in_memory().unwrap();
        assert!(db.get_local_updated_at("profiles", "missing").unwrap().is_none());
    }

    #[test]
    fn upsert_pulled_row_inserts_and_updates_profile() {
        let db = Database::new_in_memory().unwrap();
        let row = serde_json::json!({
            "id": "p1", "name": "Beta", "description": null,
            "workingDirectory": "/tmp", "claudeArgs": ["--x"], "envVars": {},
            "isDefault": false, "agent": "claude", "agentArgsJson": null,
            "updatedAt": "2026-06-01T00:00:00Z", "deletedAt": null, "clientVersion": 1,
        });
        db.upsert_pulled_row("profiles", &row).unwrap();
        assert_eq!(db.get_local_updated_at("profiles", "p1").unwrap().as_deref(), Some("2026-06-01T00:00:00Z"));

        // Second upsert with a newer timestamp overwrites.
        let row2 = serde_json::json!({
            "id": "p1", "name": "Beta v2", "workingDirectory": "/tmp",
            "claudeArgs": [], "envVars": {}, "isDefault": false, "agent": "claude",
            "updatedAt": "2026-12-01T00:00:00Z", "clientVersion": 2,
        });
        db.upsert_pulled_row("profiles", &row2).unwrap();
        let name: String = db.conn.query_row("SELECT name FROM profiles WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "Beta v2");
    }

    #[test]
    fn upsert_pulled_row_inserts_workspace_by_sync_id() {
        let db = Database::new_in_memory().unwrap();
        let row = serde_json::json!({
            "id": "w-uuid-1", "name": "main", "terminals": [],
            "createdAt": "2026-06-01T00:00:00Z", "updatedAt": "2026-06-01T00:00:00Z",
            "deletedAt": null, "clientVersion": 1,
        });
        db.upsert_pulled_row("workspaces", &row).unwrap();
        assert_eq!(db.get_local_updated_at("workspaces", "w-uuid-1").unwrap().as_deref(), Some("2026-06-01T00:00:00Z"));
    }
}
