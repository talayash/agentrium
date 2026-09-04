# Custom Agents and API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users register any local coding-agent CLI as a first-class agent and store provider API keys in the OS credential store, injected into the agent process only at launch.

**Architecture:** `AgentKind` gains a `Custom(String)` variant (wire form `custom:<id>`) backed by a `custom_agents` SQLite table; the spawn path resolves an owned `AgentSpec` instead of matching on the enum. A `credentials.rs` module wraps the `keyring` crate behind a `SecretStore` trait; SQLite keeps label/env-name metadata only, and `create_terminal` resolves `{env, credential_id}` bindings into a secret env map that is applied to the child process but never stored. The frontend mirrors this with a template-literal `AgentKind` union, a Zustand registry store, two new modals, and a settings page.

**Tech Stack:** Rust 2021 (Tauri 2, rusqlite, keyring 3, reqwest, serde), React 18 + TypeScript (Zustand, Tailwind), vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-04-custom-agents-and-api-keys-design.md`

**Conventions used throughout**

- Run Rust tests from `src-tauri/`: `cargo test --quiet 2>&1 | tail -20`.
- Run TS tests from repo root: `npx vitest run <file> 2>&1 | tail -20`. Type-check with `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`.
- Every `#[command]` body is wrapped in `wrap_cmd("name", async move { ... })`. User/environment errors are returned with `error_reporter::user_err(...)`.
- Commit after every task with the message shown. Never commit the `.claude-flow/` state files.

---

## Part A - Rust agent identity and registry

### Task 1: `AgentKind::Custom` variant with string wire form

**Files:**
- Modify: `src-tauri/src/config.rs:1-47`
- Modify: `src-tauri/src/database.rs:242`
- Modify: `src-tauri/src/terminal.rs:78-124` (`resume_flags_for` match), `:348`
- Modify: `src-tauri/src/commands.rs:394-398, 445, 502, 791`
- Modify: `src-tauri/src/session_provider.rs:28-36`

- [ ] **Step 1: Write the failing tests** at the bottom of `src-tauri/src/config.rs`:

```rust
#[cfg(test)]
mod agent_kind_tests {
    use super::*;

    #[test]
    fn builtins_serialize_lowercase() {
        assert_eq!(serde_json::to_string(&AgentKind::Claude).unwrap(), "\"claude\"");
        assert_eq!(serde_json::to_string(&AgentKind::Antigravity).unwrap(), "\"antigravity\"");
    }

    #[test]
    fn custom_round_trips_with_prefix() {
        let k = AgentKind::Custom("abc-123".to_string());
        let json = serde_json::to_string(&k).unwrap();
        assert_eq!(json, "\"custom:abc-123\"");
        let back: AgentKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, k);
    }

    #[test]
    fn from_str_lossy_handles_custom_legacy_and_garbage() {
        assert_eq!(AgentKind::from_str_lossy("custom:xyz"), AgentKind::Custom("xyz".into()));
        assert_eq!(AgentKind::from_str_lossy("gemini"), AgentKind::Antigravity);
        assert_eq!(AgentKind::from_str_lossy("nonsense"), AgentKind::Claude);
        // Empty id after the prefix is not a custom agent.
        assert_eq!(AgentKind::from_str_lossy("custom:"), AgentKind::Claude);
    }

    #[test]
    fn custom_works_as_hashmap_key_in_json() {
        let mut m: HashMap<AgentKind, Vec<String>> = HashMap::new();
        m.insert(AgentKind::Custom("k1".into()), vec!["--x".into()]);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"custom:k1\""));
        let back: HashMap<AgentKind, Vec<String>> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get(&AgentKind::Custom("k1".into())).unwrap(), &vec!["--x".to_string()]);
    }

    #[test]
    fn is_custom_and_custom_id() {
        assert!(AgentKind::Custom("a".into()).is_custom());
        assert!(!AgentKind::Codex.is_custom());
        assert_eq!(AgentKind::Custom("a".into()).custom_id(), Some("a"));
        assert_eq!(AgentKind::Claude.custom_id(), None);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet agent_kind_tests 2>&1 | tail -20`
Expected: compile error, `no variant named Custom`.

- [ ] **Step 3: Replace the `AgentKind` definition** (`config.rs` lines 4-47) with:

```rust
/// The coding-agent CLI a terminal should launch. `Default` is `Claude` so
/// profile rows written before this field existed migrate transparently on
/// their next deserialize.
///
/// Wire/DB form is a plain string: built-ins are their lowercase name,
/// user-defined agents are `custom:<custom_agents.id>`. Serde is hand-rolled
/// so the enum can carry the id while still serialising as a string (and so
/// it works as a JSON map key in `ConfigProfile::agent_args`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub enum AgentKind {
    #[default]
    Claude,
    Codex,
    Cursor,
    Antigravity,
    /// A user-registered CLI. The payload is the `custom_agents.id`.
    Custom(String),
}

pub const CUSTOM_AGENT_PREFIX: &str = "custom:";

impl AgentKind {
    /// String form used for database storage, the IPC wire, and error
    /// messages. Inverse of `from_str_lossy` for every valid value.
    pub fn to_wire(&self) -> String {
        match self {
            AgentKind::Claude => "claude".to_string(),
            AgentKind::Codex => "codex".to_string(),
            AgentKind::Cursor => "cursor".to_string(),
            AgentKind::Antigravity => "antigravity".to_string(),
            AgentKind::Custom(id) => format!("{}{}", CUSTOM_AGENT_PREFIX, id),
        }
    }

    /// Parse from the wire/DB string form. Unknown strings become Claude,
    /// which is the same fallback strategy `#[serde(default)]` uses on
    /// missing fields, so an unrecognized value (e.g. a future agent name
    /// loaded by an older build) is silently downgraded rather than
    /// crashing at startup.
    ///
    /// The legacy `"gemini"` token maps to `Antigravity`: Antigravity
    /// replaced Gemini as the fourth agent slot. `custom:<id>` with a
    /// non-empty id is a user-defined agent.
    pub fn from_str_lossy(s: &str) -> Self {
        if let Some(id) = s.strip_prefix(CUSTOM_AGENT_PREFIX) {
            if !id.is_empty() {
                return AgentKind::Custom(id.to_string());
            }
            return AgentKind::Claude;
        }
        match s {
            "codex" => AgentKind::Codex,
            "cursor" => AgentKind::Cursor,
            "antigravity" | "gemini" => AgentKind::Antigravity,
            _ => AgentKind::Claude,
        }
    }

    pub fn is_custom(&self) -> bool {
        matches!(self, AgentKind::Custom(_))
    }

    pub fn custom_id(&self) -> Option<&str> {
        match self {
            AgentKind::Custom(id) => Some(id.as_str()),
            _ => None,
        }
    }
}

impl Serialize for AgentKind {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_wire())
    }
}

impl<'de> Deserialize<'de> for AgentKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(AgentKind::from_str_lossy(&s))
    }
}
```

- [ ] **Step 4: Fix the `Copy` fallout.** The enum is no longer `Copy`; the compiler will list every site. Apply these changes:

`src-tauri/src/database.rs:242`: `profile.agent.as_str(),` → `profile.agent.to_wire(),`

`src-tauri/src/terminal.rs:78-84` (`resume_flags_for` head) - borrow the agent:
```rust
pub(crate) fn resume_flags_for(
    agent: &crate::config::AgentKind,
    resume_id: Option<&str>,
    continue_recent: bool,
) -> ResumeInjection {
    use crate::config::AgentKind;
    match (agent, resume_id) {
```
and add a final arm before `_ => ResumeInjection::default(),` (Task 4 replaces it with the real template logic):
```rust
        (AgentKind::Custom(_), _) => ResumeInjection::default(),
```
`terminal.rs:232`: `resume_flags_for(agent, ...)` → `resume_flags_for(&agent, ...)`.
`terminal.rs:279`: `build_agent_command(agent, &claude_args)` → `build_agent_command(&agent, &claude_args)` and change `build_agent_command`'s parameter to `agent: &crate::config::AgentKind` (its body `spec_for(agent)` also takes `&AgentKind` after this step - see next bullet).
`terminal.rs:348`: `if agent == crate::config::AgentKind::Claude` stays valid (PartialEq); ensure `agent` was not moved earlier - it is stored into `TerminalConfig { agent, .. }` at ~line 385, so change that struct literal to `agent: agent.clone(),`.
Tests at `terminal.rs:1082-1179`: prefix every `AgentKind::X` argument to `build_agent_command` / `resume_flags_for` with `&`.

`src-tauri/src/agents.rs`: `pub fn spec_for(kind: AgentKind)` → `pub fn spec_for(kind: &AgentKind)` and inside the match use `kind` by reference; each arm's `kind: AgentKind::Claude` literal stays. Add a temporary arm `AgentKind::Custom(_) => unreachable!("custom specs resolve through the DB in Task 4"),` (removed in Task 4). Update `all_specs()` to pass `&AgentKind::Claude` etc.

`src-tauri/src/session_provider.rs:28`: `pub fn provider_for(agent: &AgentKind)`; add arm `AgentKind::Custom(_) => Box::new(NoOpProvider),`. Tests at lines 51 and 65: pass `&AgentKind::Claude` / `&a`.

`src-tauri/src/commands.rs`: line 394 `let agent = request.agent;` → `let agent = request.agent.clone();`; line 398, 445, 502 `provider_for(agent)` → `provider_for(&agent)` (at 502 the closure moves `agent` - clone it into the closure with `let agent_for_detect = agent.clone();` before the spawn and use `&agent_for_detect`); line 791 `if agent == ...` is fine; line 802 `spec_for(agent)` → `spec_for(&agent)`; line 1255 `provider_for(agent)` → `provider_for(&agent)`.

- [ ] **Step 5: Build and run all Rust tests**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -20`
Expected: all tests pass, including the 5 new `agent_kind_tests`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/database.rs src-tauri/src/terminal.rs src-tauri/src/commands.rs src-tauri/src/agents.rs src-tauri/src/session_provider.rs
git commit -m "feat(agents): AgentKind::Custom variant with custom:<id> wire form"
```

---

### Task 2: `CustomAgent` type and validation

**Files:**
- Create: `src-tauri/src/custom_agents.rs`
- Modify: `src-tauri/src/config.rs` (add `CredentialBinding`)
- Modify: `src-tauri/src/terminal.rs:157-183` (make constants `pub(crate)`)
- Modify: `src-tauri/src/main.rs:3-19` (add `mod custom_agents;`)

- [ ] **Step 1: Add the shared binding type** to `src-tauri/src/config.rs` after `AgentKind`:

```rust
/// Links an environment variable an agent needs to a stored credential.
/// Values are never carried here - only the id of the credential row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialBinding {
    pub env: String,
    pub credential_id: String,
}
```

- [ ] **Step 2: Expose the terminal constants.** In `src-tauri/src/terminal.rs` change `const SHELL_METACHARACTERS` and `const BLOCKED_ENV_VARS` to `pub(crate) const ...` (same values).

- [ ] **Step 3: Write the failing tests** in the new file `src-tauri/src/custom_agents.rs`:

```rust
//! User-registered coding-agent CLIs. Validation lives here; persistence is
//! in `database.rs`; spawn resolution is `agents::AgentSpec::from_custom`.

use crate::config::CredentialBinding;
use serde::{Deserialize, Serialize};

/// Tile colours offered by the Add Agent dialog. Kept in sync with
/// `src/lib/agentPresets.ts` `AGENT_COLORS`.
pub const ALLOWED_COLORS: &[&str] = &[
    "#30C55E", "#3899FF", "#FFA028", "#B48CFF", "#FF6B8A", "#5AC8FA",
];

/// Characters rejected in a binary name/path. `SHELL_METACHARACTERS` minus
/// `\` and `~` so Windows absolute paths (`C:\Users\...\x.cmd`) still pass.
pub const BINARY_FORBIDDEN: &[char] = &[
    '&', '|', ';', '`', '$', '(', ')', '{', '}', '<', '>', '^', '\n', '\r',
    '\'', '"', '*', '?', '[', ']', '!', '\t', '#',
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CustomAgent {
    /// uuid v4. Empty on a create request; the save command fills it.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub binary: String,
    #[serde(default)]
    pub default_args: Vec<String>,
    /// `--session {id}` (resume by id) or `--continue` (continue recent).
    /// `None` = the CLI cannot resume.
    #[serde(default)]
    pub resume_flag: Option<String>,
    pub color: String,
    /// Env var names this agent reads a key from.
    #[serde(default)]
    pub required_env: Vec<String>,
    /// Default credential per env var, used when the New Session modal is in
    /// API-key mode and the user does not override.
    #[serde(default)]
    pub bindings: Vec<CredentialBinding>,
    #[serde(default)]
    pub install_url: Option<String>,
    #[serde(default)]
    pub install_hint: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

pub fn is_valid_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_uppercase() || c.is_ascii_digit())
}

pub fn is_blocked_env(name: &str) -> bool {
    crate::terminal::TerminalManager::BLOCKED_ENV_VARS
        .iter()
        .any(|b| b.eq_ignore_ascii_case(name))
}

pub fn validate_binary(binary: &str) -> Result<(), String> {
    let b = binary.trim();
    if b.is_empty() {
        return Err("Command is required".to_string());
    }
    if b.len() > 512 {
        return Err("Command is too long".to_string());
    }
    if b.contains(BINARY_FORBIDDEN) {
        return Err(format!("Invalid character in command \"{}\"", b));
    }
    Ok(())
}

fn validate_arg(arg: &str) -> Result<(), String> {
    if arg.contains(crate::terminal::TerminalManager::SHELL_METACHARACTERS) {
        return Err(format!(
            "Invalid character in argument: \"{}\". Shell metacharacters are not allowed.",
            arg
        ));
    }
    Ok(())
}

/// Every rule from spec section 5.2. Returns the first violation as a plain
/// message; callers wrap it in `error_reporter::user_err`.
pub fn validate(agent: &CustomAgent) -> Result<(), String> {
    let name = agent.name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("Display name must be 1-40 characters".to_string());
    }
    validate_binary(&agent.binary)?;
    for a in &agent.default_args {
        validate_arg(a)?;
    }
    if let Some(tpl) = &agent.resume_flag {
        let t = tpl.trim();
        if t.is_empty() {
            return Err("Resume flag cannot be blank; leave it unset instead".to_string());
        }
        if t.matches("{id}").count() > 1 {
            return Err("Resume flag may contain {id} at most once".to_string());
        }
        // Validate each whitespace token like an arg, with the placeholder
        // removed so its braces do not trip the metacharacter check.
        for tok in t.replace("{id}", "ID").split_whitespace() {
            validate_arg(tok)?;
        }
    }
    if !ALLOWED_COLORS.contains(&agent.color.as_str()) {
        return Err("Tile colour must be one of the offered swatches".to_string());
    }
    for env in &agent.required_env {
        if !is_valid_env_name(env) {
            return Err(format!("\"{}\" is not a valid environment variable name", env));
        }
        if is_blocked_env(env) {
            return Err(format!("\"{}\" cannot be set by an agent", env));
        }
    }
    for b in &agent.bindings {
        if !agent.required_env.contains(&b.env) {
            return Err(format!("Binding for \"{}\" has no matching required variable", b.env));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_agent() -> CustomAgent {
        CustomAgent {
            id: String::new(),
            name: "OpenCode".into(),
            binary: "opencode".into(),
            default_args: vec!["--model".into(), "gpt-5.6-terra".into()],
            resume_flag: Some("--session {id}".into()),
            color: "#30C55E".into(),
            required_env: vec!["OPENAI_API_KEY".into()],
            bindings: vec![],
            install_url: None,
            install_hint: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn valid_agent_passes() {
        assert!(validate(&ok_agent()).is_ok());
    }

    #[test]
    fn windows_path_binary_is_allowed() {
        let mut a = ok_agent();
        a.binary = r"C:\Users\me\AppData\Roaming\npm\opencode.cmd".into();
        assert!(validate(&a).is_ok());
    }

    #[test]
    fn rejects_metachar_in_binary() {
        let mut a = ok_agent();
        a.binary = "opencode; rm -rf /".into();
        assert!(validate(&a).unwrap_err().contains("Invalid character in command"));
    }

    #[test]
    fn rejects_metachar_in_arg() {
        let mut a = ok_agent();
        a.default_args = vec!["--x=$(whoami)".into()];
        assert!(validate(&a).unwrap_err().contains("Invalid character in argument"));
    }

    #[test]
    fn rejects_two_id_placeholders() {
        let mut a = ok_agent();
        a.resume_flag = Some("--a {id} --b {id}".into());
        assert!(validate(&a).unwrap_err().contains("at most once"));
    }

    #[test]
    fn continue_style_template_without_id_is_valid() {
        let mut a = ok_agent();
        a.resume_flag = Some("--continue".into());
        assert!(validate(&a).is_ok());
    }

    #[test]
    fn rejects_bad_colour_and_env_names() {
        let mut a = ok_agent();
        a.color = "#123456".into();
        assert!(validate(&a).unwrap_err().contains("swatches"));
        let mut b = ok_agent();
        b.required_env = vec!["lowercase".into()];
        assert!(validate(&b).unwrap_err().contains("not a valid environment"));
        let mut c = ok_agent();
        c.required_env = vec!["PATH".into()];
        assert!(validate(&c).unwrap_err().contains("cannot be set"));
    }

    #[test]
    fn binding_must_reference_required_env() {
        let mut a = ok_agent();
        a.bindings = vec![CredentialBinding { env: "OTHER".into(), credential_id: "c1".into() }];
        assert!(validate(&a).unwrap_err().contains("no matching required variable"));
    }
}
```

- [ ] **Step 4: Register the module.** In `src-tauri/src/main.rs` add `mod custom_agents;` after `mod agents;`.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --quiet custom_agents 2>&1 | tail -20`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/custom_agents.rs src-tauri/src/config.rs src-tauri/src/terminal.rs src-tauri/src/main.rs
git commit -m "feat(agents): CustomAgent type with validation rules"
```

---

### Task 3: `custom_agents` table and CRUD

**Files:**
- Modify: `src-tauri/src/database.rs` (`init_schema` ~line 60-135; new methods after `get_profiles`)

- [ ] **Step 1: Write the failing tests** in `database.rs` inside the existing `#[cfg(test)] mod tests` (create one at the end of the file if none exists, with `use super::*;`):

```rust
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
    fn custom_agent_save_replaces_and_delete_removes() {
        let db = Database::new_in_memory().unwrap();
        let mut a = sample_custom_agent("a1");
        db.save_custom_agent(&a).unwrap();
        a.name = "OpenCode v2".into();
        db.save_custom_agent(&a).unwrap();
        assert_eq!(db.list_custom_agents().unwrap()[0].name, "OpenCode v2");
        db.delete_custom_agent("a1").unwrap();
        assert!(db.list_custom_agents().unwrap().is_empty());
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet custom_agent 2>&1 | tail -20`
Expected: `no method named save_custom_agent`.

- [ ] **Step 3: Add the table** to the `execute_batch` string in `init_schema`, after the `changelist_files` table:

```sql
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
```

- [ ] **Step 4: Add the CRUD methods** to `impl Database` after `get_profiles`:

```rust
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
        let sql = format!("SELECT {} FROM custom_agents ORDER BY created_at ASC, name ASC", Self::CUSTOM_AGENT_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], Self::row_to_custom_agent).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_custom_agent(&self, id: &str) -> Result<Option<crate::custom_agents::CustomAgent>, String> {
        let sql = format!("SELECT {} FROM custom_agents WHERE id = ?1", Self::CUSTOM_AGENT_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query_map(params![id], Self::row_to_custom_agent).map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn delete_custom_agent(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM custom_agents WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
```

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --quiet custom_agent 2>&1 | tail -20`
Expected: the 3 new tests pass (plus the 8 from Task 2).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(db): custom_agents table with CRUD"
```

---
### Task 4: Owned `AgentSpec`, custom resume templates, spec-driven spawn

**Files:**
- Modify: `src-tauri/src/agents.rs` (whole file)
- Modify: `src-tauri/src/terminal.rs:58-124` (`build_agent_command`, `resume_flags_for`), `:184-200` (`create_terminal` signature), `:1030` (test call), `:1081-1179` (tests)
- Modify: `src-tauri/src/commands.rs:394-430` (`create_terminal` command), `:802`

- [ ] **Step 1: Write the failing tests.** Replace the `tests` module in `src-tauri/src/agents.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentKind;

    #[test]
    fn claude_spec_has_claude_binary() {
        assert_eq!(builtin_spec(&AgentKind::Claude).unwrap().binary, "claude");
    }

    #[test]
    fn codex_spec_has_codex_binary() {
        assert_eq!(builtin_spec(&AgentKind::Codex).unwrap().binary, "codex");
    }

    #[test]
    fn cursor_spec_has_agent_binary() {
        // Cursor's official CLI binary is `agent`, not `cursor`.
        assert_eq!(builtin_spec(&AgentKind::Cursor).unwrap().binary, "agent");
    }

    #[test]
    fn antigravity_spec_has_agy_binary() {
        assert_eq!(builtin_spec(&AgentKind::Antigravity).unwrap().binary, "agy");
    }

    #[test]
    fn custom_kind_has_no_builtin_spec() {
        assert!(builtin_spec(&AgentKind::Custom("x".into())).is_none());
    }

    #[test]
    fn all_builtin_specs_lists_every_builtin_kind() {
        let specs = all_builtin_specs();
        assert_eq!(specs.len(), 4);
        assert!(specs.iter().any(|s| s.kind == AgentKind::Claude));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Antigravity));
    }

    #[test]
    fn from_custom_carries_binary_and_template() {
        let a = crate::custom_agents::CustomAgent {
            id: "a1".into(),
            name: "OpenCode".into(),
            binary: "opencode".into(),
            default_args: vec![],
            resume_flag: Some("--session {id}".into()),
            color: "#30C55E".into(),
            required_env: vec![],
            bindings: vec![],
            install_url: Some("https://opencode.ai".into()),
            install_hint: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let spec = AgentSpec::from_custom(&a);
        assert_eq!(spec.kind, AgentKind::Custom("a1".into()));
        assert_eq!(spec.binary, "opencode");
        assert_eq!(spec.display_name, "OpenCode");
        assert_eq!(spec.resume_flag.as_deref(), Some("--session {id}"));
        assert_eq!(spec.install_url.as_deref(), Some("https://opencode.ai"));
    }
}
```

Then in `src-tauri/src/terminal.rs` add these tests next to the existing `resume_flags_for_*` tests (same module, which has `use crate::config::AgentKind;`):

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -20`
Expected: compile errors (`builtin_spec` not found, `AgentSpec` has no field `resume_flag`).

- [ ] **Step 3: Rewrite `src-tauri/src/agents.rs`** (everything above the tests module):

```rust
use crate::config::AgentKind;

/// Everything the spawn path needs to know about an agent, resolved once per
/// `create_terminal`. Built-ins come from `builtin_spec`; user-defined agents
/// from `AgentSpec::from_custom` after a `custom_agents` lookup.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSpec {
    pub kind: AgentKind,
    /// Human-readable name for the UI and error messages.
    pub display_name: String,
    /// Executable name or absolute path, resolved through PATH at spawn time.
    pub binary: String,
    /// URL the "install" hint links to when the binary isn't found.
    pub install_url: Option<String>,
    /// Short one-line install command shown in error messages.
    pub install_hint: Option<String>,
    /// Custom agents only: resume template (`--session {id}` / `--continue`).
    /// Built-ins encode their resume forms in `terminal::resume_flags_for`.
    pub resume_flag: Option<String>,
}

impl AgentSpec {
    fn builtin(kind: AgentKind, display_name: &str, binary: &str, install_url: &str, install_hint: &str) -> Self {
        AgentSpec {
            kind,
            display_name: display_name.to_string(),
            binary: binary.to_string(),
            install_url: Some(install_url.to_string()),
            install_hint: Some(install_hint.to_string()),
            resume_flag: None,
        }
    }

    pub fn from_custom(a: &crate::custom_agents::CustomAgent) -> Self {
        AgentSpec {
            kind: AgentKind::Custom(a.id.clone()),
            display_name: a.name.clone(),
            binary: a.binary.clone(),
            install_url: a.install_url.clone(),
            install_hint: a.install_hint.clone(),
            resume_flag: a.resume_flag.clone(),
        }
    }
}

/// Spec for a built-in agent; `None` for `Custom` (resolve those through the
/// database - see `commands::resolve_agent_spec`).
pub fn builtin_spec(kind: &AgentKind) -> Option<AgentSpec> {
    Some(match kind {
        AgentKind::Claude => AgentSpec::builtin(
            AgentKind::Claude, "Claude Code", "claude",
            "https://docs.claude.com/claude-code", "npm install -g @anthropic-ai/claude-code",
        ),
        AgentKind::Codex => AgentSpec::builtin(
            AgentKind::Codex, "Codex", "codex",
            "https://github.com/openai/codex", "npm install -g @openai/codex",
        ),
        // Cursor's CLI binary is literally `agent` (per cursor.com/docs/cli).
        AgentKind::Cursor => AgentSpec::builtin(
            AgentKind::Cursor, "Cursor", "agent",
            "https://cursor.com/cli", "curl https://cursor.com/install -fsS | bash",
        ),
        // Antigravity ships as `agy` (per antigravity.google/docs/cli).
        AgentKind::Antigravity => AgentSpec::builtin(
            AgentKind::Antigravity, "Antigravity", "agy",
            "https://antigravity.google/docs/cli/install/",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        ),
        AgentKind::Custom(_) => return None,
    })
}

pub fn all_builtin_specs() -> Vec<AgentSpec> {
    [AgentKind::Claude, AgentKind::Codex, AgentKind::Cursor, AgentKind::Antigravity]
        .iter()
        .filter_map(builtin_spec)
        .collect()
}
```

- [ ] **Step 4: Make the spawn path spec-driven** in `src-tauri/src/terminal.rs`.

Replace `build_agent_command`:
```rust
/// Resolve the binary + arg list for a resolved agent spec. Args are cloned
/// so callers keep ownership of the original vec.
pub fn build_agent_command(spec: &crate::agents::AgentSpec, args: &[String]) -> (String, Vec<String>) {
    (spec.binary.clone(), args.to_vec())
}
```

Replace the head of `resume_flags_for`:
```rust
pub(crate) fn resume_flags_for(
    spec: &crate::agents::AgentSpec,
    resume_id: Option<&str>,
    continue_recent: bool,
) -> ResumeInjection {
    use crate::config::AgentKind;
    match (&spec.kind, resume_id) {
```
(keep every built-in arm unchanged) and replace the placeholder `(AgentKind::Custom(_), _) => ResumeInjection::default(),` arm with:
```rust
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
```

In `TerminalManager::create_terminal` change the parameter `agent: crate::config::AgentKind,` to `spec: crate::agents::AgentSpec,`. Inside the body:
- `resume_flags_for(&agent, ...)` becomes `resume_flags_for(&spec, ...)`
- `build_agent_command(&agent, &claude_args)` becomes `build_agent_command(&spec, &claude_args)`
- `if agent == crate::config::AgentKind::Claude {` becomes `if spec.kind == crate::config::AgentKind::Claude {`
- the `TerminalConfig { ... agent: agent.clone(), ... }` literal becomes `agent: spec.kind.clone(),`

Update the existing test call at ~line 1030: replace the `crate::config::AgentKind::Claude,` argument with `crate::agents::builtin_spec(&crate::config::AgentKind::Claude).unwrap(),`.

Update the existing `build_agent_command_*` and `resume_flags_for_*` tests: every `&AgentKind::X` / `&crate::config::AgentKind::X` argument becomes `&crate::agents::builtin_spec(&AgentKind::X).unwrap()`.

- [ ] **Step 5: Resolve the spec in the command layer.** In `src-tauri/src/commands.rs` add, above `create_terminal`:

```rust
/// Built-ins resolve statically; `Custom(id)` reads the `custom_agents` row.
/// A deleted custom agent is a user-state error, not a bug.
async fn resolve_agent_spec(
    state: &State<'_, AppState>,
    kind: &crate::config::AgentKind,
) -> Result<crate::agents::AgentSpec, String> {
    if let Some(spec) = crate::agents::builtin_spec(kind) {
        return Ok(spec);
    }
    let id = kind.custom_id().unwrap_or_default().to_string();
    let row = db_op(&state.db, move |db| db.get_custom_agent(&id)).await?;
    match row {
        Some(a) => Ok(crate::agents::AgentSpec::from_custom(&a)),
        None => Err(error_reporter::user_err(
            "This agent was removed. Pick another agent or add it again in Settings > Agents & Keys.",
        )),
    }
}
```

In `create_terminal`, right after `let agent = request.agent.clone();` add `let spec = resolve_agent_spec(&state, &agent).await?;` and pass `spec` in place of `request.agent` in the `terminals.create_terminal(...)` call.

Change `get_agent_version` (line ~785) to take `state: State<'_, AppState>` as its first parameter and replace `let binary = crate::agents::spec_for(&agent).binary;` with `let binary = resolve_agent_spec(&state, &agent).await?.binary;` (adjust the `shell_command(binary, ...)` calls to `shell_command(&binary, ...)` and `&[binary]` to `&[binary.as_str()]`).

- [ ] **Step 6: Build and run all tests**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -25`
Expected: all pass, including 7 new `agents` tests and 7 new custom resume tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/agents.rs src-tauri/src/terminal.rs src-tauri/src/commands.rs
git commit -m "feat(agents): owned AgentSpec, custom resume templates, spec-driven spawn"
```

---

### Task 5: `probe_binary` and custom-agent IPC commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (refactor `get_agent_version` ~line 785-845; add commands)
- Modify: `src-tauri/src/main.rs:140+` (register commands)

- [ ] **Step 1: Write the failing unit test** for the probe helper's pure part. Add to the `tests` module in `commands.rs` (the one containing the `extract_version_line` tests):

```rust
    #[test]
    fn first_path_line_takes_first_non_empty_trimmed_line() {
        assert_eq!(first_path_line("  C:\\a\\b.cmd\r\nC:\\a\\b\r\n"), Some("C:\\a\\b.cmd".to_string()));
        assert_eq!(first_path_line("\n\n"), None);
        assert_eq!(first_path_line(""), None);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet first_path_line 2>&1 | tail -10`
Expected: `cannot find function first_path_line`.

- [ ] **Step 3: Add the probe helper and refactor `get_agent_version`.** Above `get_agent_version` add:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct BinaryProbe {
    pub found: bool,
    pub resolved_path: Option<String>,
    pub version: Option<String>,
}

pub(crate) fn first_path_line(stdout: &str) -> Option<String> {
    stdout.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

/// Two-stage detector shared by `get_agent_version` and `probe_binary`:
/// (1) `<binary> --version`, parsing a semver-shaped line from stdout or
/// stderr; (2) `where` / `which` to prove PATH resolution even when the
/// version format is unparseable. Runs through `shell_command` so Windows
/// gets CREATE_NO_WINDOW.
pub(crate) async fn probe_binary_impl(binary: &str) -> BinaryProbe {
    let mut version: Option<String> = None;
    let mut cmd: tokio::process::Command = shell_command(binary, &["--version"]).into();
    if let Ok(output) = cmd.output().await {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        for buf in [&stdout, &stderr] {
            let line = extract_version_line(buf);
            if !line.is_empty() && has_semver_like(&line) {
                version = Some(line);
                break;
            }
        }
    }
    let mut probe: tokio::process::Command = if cfg!(target_os = "windows") {
        shell_command("where", &[binary]).into()
    } else {
        shell_command("which", &[binary]).into()
    };
    let resolved_path = match probe.output().await {
        Ok(o) if o.status.success() => first_path_line(&String::from_utf8_lossy(&o.stdout)),
        _ => None,
    };
    BinaryProbe { found: version.is_some() || resolved_path.is_some(), resolved_path, version }
}
```

Replace the non-Claude body of `get_agent_version` (everything after the Claude early-return) with:

```rust
        let binary = resolve_agent_spec(&state, &agent).await?.binary;
        let probe = probe_binary_impl(&binary).await;
        if let Some(v) = probe.version {
            return Ok(v);
        }
        if probe.found {
            return Ok("installed".to_string());
        }
        Err(error_reporter::user_err(format!("`{}` not found on PATH", binary)))
```

- [ ] **Step 4: Add the commands** after `get_agent_version`:

```rust
#[command]
pub async fn probe_binary(binary: String) -> Result<BinaryProbe, String> {
    wrap_cmd("probe_binary", async move {
        crate::custom_agents::validate_binary(&binary).map_err(error_reporter::user_err)?;
        Ok(probe_binary_impl(binary.trim()).await)
    })
    .await
}

#[command]
pub async fn list_custom_agents(
    state: State<'_, AppState>,
) -> Result<Vec<crate::custom_agents::CustomAgent>, String> {
    wrap_cmd("list_custom_agents", async move {
        db_op(&state.db, |db| db.list_custom_agents()).await
    })
    .await
}

#[command]
pub async fn save_custom_agent(
    state: State<'_, AppState>,
    mut agent: crate::custom_agents::CustomAgent,
) -> Result<crate::custom_agents::CustomAgent, String> {
    wrap_cmd("save_custom_agent", async move {
        crate::custom_agents::validate(&agent).map_err(error_reporter::user_err)?;
        let now = chrono::Utc::now().to_rfc3339();
        if agent.id.trim().is_empty() {
            agent.id = uuid::Uuid::new_v4().to_string();
            agent.created_at = now.clone();
        } else {
            // Keep the original created_at so the picker order is stable.
            let id = agent.id.clone();
            if let Some(existing) = db_op(&state.db, move |db| db.get_custom_agent(&id)).await? {
                agent.created_at = existing.created_at;
            } else if agent.created_at.is_empty() {
                agent.created_at = now.clone();
            }
        }
        agent.updated_at = now;
        agent.name = agent.name.trim().to_string();
        agent.binary = agent.binary.trim().to_string();
        let to_save = agent.clone();
        db_op(&state.db, move |db| db.save_custom_agent(&to_save)).await?;
        Ok(agent)
    })
    .await
}

#[command]
pub async fn delete_custom_agent(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_custom_agent", async move {
        db_op(&state.db, move |db| db.delete_custom_agent(&id)).await
    })
    .await
}
```

- [ ] **Step 5: Register** in `src-tauri/src/main.rs` inside `generate_handler![ ... ]`, directly after the `commands::get_agent_version,` line:

```rust
            commands::probe_binary,
            commands::list_custom_agents,
            commands::save_custom_agent,
            commands::delete_custom_agent,
```

- [ ] **Step 6: Build and test**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(agents): probe_binary and custom agent IPC commands"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
## Part B - Rust credentials

### Task 6: `credentials.rs` with a `SecretStore` trait over `keyring`

**Files:**
- Modify: `src-tauri/Cargo.toml:10-38` (add dependency)
- Create: `src-tauri/src/credentials.rs`
- Modify: `src-tauri/src/main.rs:3-19` (`mod credentials;`)

- [ ] **Step 1: Add the dependency** to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
# OS credential store (Windows Credential Manager / macOS Keychain / Linux
# Secret Service) for API keys. Values never touch SQLite or the WebView.
keyring = { version = "3", features = ["windows-native", "apple-native", "sync-secret-service"] }
```

Run: `cd src-tauri && cargo check --quiet 2>&1 | tail -5`
Expected: compiles (downloads `keyring`). If cargo rejects a feature name, run `cargo info keyring` and use the listed platform-store features; the API used below (`Entry::new`, `set_password`, `get_password`, `delete_credential`, `Error::NoEntry`) is stable across keyring 3.x.

- [ ] **Step 2: Write the failing tests** in the new file `src-tauri/src/credentials.rs` (full file, tests included):

```rust
//! API-key credentials. Metadata (label, env var, masked tail) lives in SQLite
//! via `database.rs`; the secret values live only in the OS credential store
//! behind `SecretStore`. Nothing in this module returns a value to the IPC
//! layer - see `resolve_for_spawn` for the single read path.

use crate::config::CredentialBinding;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SERVICE_NAME: &str = "com.claudeterminal.agentrium";

/// Store key for a credential's API key value.
pub fn key_entry(id: &str) -> String {
    format!("cred:{}", id)
}
/// Store key for a credential's endpoint override.
pub fn endpoint_entry(id: &str) -> String {
    format!("cred:{}:endpoint", id)
}

pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    /// Human name shown in the UI ("Windows Credential Manager").
    fn display_name(&self) -> &'static str;
}

pub struct KeyringStore;

impl KeyringStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE_NAME, key).map_err(|e| format!("Credential store unavailable: {}", e))
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(value)
            .map_err(|e| format!("Could not write to {}: {}", self.display_name(), e))
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Could not read from {}: {}", self.display_name(), e)),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not delete from {}: {}", self.display_name(), e)),
        }
    }

    fn display_name(&self) -> &'static str {
        if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else if cfg!(target_os = "macos") {
            "Keychain"
        } else {
            "Secret Service"
        }
    }
}

/// In-memory store for unit tests and for CI machines with no keyring daemon.
#[derive(Default)]
pub struct MemoryStore {
    inner: std::sync::Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.inner.lock().unwrap().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.inner.lock().unwrap().get(key).cloned())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.inner.lock().unwrap().remove(key);
        Ok(())
    }
    fn display_name(&self) -> &'static str {
        "in-memory store"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    OpenAI,
    Google,
    Cursor,
    OpenRouter,
    Custom,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenAI => "openai",
            Provider::Google => "google",
            Provider::Cursor => "cursor",
            Provider::OpenRouter => "openrouter",
            Provider::Custom => "custom",
        }
    }
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "anthropic" => Provider::Anthropic,
            "openai" => Provider::OpenAI,
            "google" => Provider::Google,
            "cursor" => Provider::Cursor,
            "openrouter" => Provider::OpenRouter,
            _ => Provider::Custom,
        }
    }
}

/// Everything about a credential except its secret values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CredentialMeta {
    #[serde(default)]
    pub id: String,
    pub label: String,
    pub provider: Provider,
    pub env_name: String,
    #[serde(default)]
    pub endpoint_env: Option<String>,
    #[serde(default)]
    pub has_key: bool,
    #[serde(default)]
    pub has_endpoint: bool,
    #[serde(default)]
    pub masked_tail: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

pub fn masked_tail_of(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let n = chars.len();
    if n <= 4 {
        return "****".to_string();
    }
    chars[n - 4..].iter().collect()
}

fn validate_env(name: &str, what: &str) -> Result<(), String> {
    if !crate::custom_agents::is_valid_env_name(name) {
        return Err(format!("{} \"{}\" is not a valid environment variable name", what, name));
    }
    if crate::custom_agents::is_blocked_env(name) {
        return Err(format!("{} \"{}\" cannot be set by an agent", what, name));
    }
    Ok(())
}

pub fn validate_endpoint(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Endpoint must be a valid http(s) URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Endpoint must use http or https".to_string());
    }
    Ok(())
}

/// Validate metadata plus the incoming values. `key`/`endpoint` follow the
/// save-command contract: `None` = unchanged, `Some("")` = clear, `Some(v)` =
/// set. `will_have_key` / `will_have_endpoint` are the post-save states the
/// caller computed from those plus the existing row.
pub fn validate_save(
    meta: &CredentialMeta,
    key: Option<&str>,
    endpoint: Option<&str>,
    will_have_key: bool,
    will_have_endpoint: bool,
) -> Result<(), String> {
    let label = meta.label.trim();
    if label.is_empty() || label.chars().count() > 40 {
        return Err("Label must be 1-40 characters".to_string());
    }
    validate_env(&meta.env_name, "Variable")?;
    if let Some(e) = &meta.endpoint_env {
        validate_env(e, "Endpoint variable")?;
    }
    if let Some(k) = key {
        if !k.is_empty() && k.chars().any(|c| c.is_control()) {
            return Err("API key contains control characters".to_string());
        }
    }
    if let Some(u) = endpoint {
        if !u.is_empty() {
            validate_endpoint(u)?;
        }
    }
    if will_have_endpoint && meta.endpoint_env.is_none() {
        return Err("Pick an endpoint variable to store an endpoint override".to_string());
    }
    if !will_have_key && !will_have_endpoint {
        return Err("Enter an API key or an endpoint override".to_string());
    }
    Ok(())
}

/// The one place secret values are read for use. Returns env additions for
/// the child process; never store the result. Missing values are user-state
/// errors (the key was deleted from the OS store outside Agentrium).
pub fn resolve_for_spawn(
    store: &dyn SecretStore,
    metas: &HashMap<String, CredentialMeta>,
    bindings: &[CredentialBinding],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for b in bindings {
        let meta = metas.get(&b.credential_id).ok_or_else(|| {
            crate::error_reporter::user_err(format!(
                "The key bound to {} was removed. Re-select a key in the session's Authentication row.",
                b.env
            ))
        })?;
        if meta.has_key {
            let value = store.get(&key_entry(&meta.id))?.ok_or_else(|| {
                crate::error_reporter::user_err(format!(
                    "Key '{}' is no longer in {}. Re-enter it in Settings > Agents & Keys.",
                    meta.label,
                    store.display_name()
                ))
            })?;
            crate::error_reporter::register_secret(&value);
            out.insert(b.env.clone(), value);
        }
        if let (true, Some(env)) = (meta.has_endpoint, &meta.endpoint_env) {
            if let Some(url) = store.get(&endpoint_entry(&meta.id))? {
                out.insert(env.clone(), url);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str) -> CredentialMeta {
        CredentialMeta {
            id: id.into(),
            label: "Work OpenAI".into(),
            provider: Provider::OpenAI,
            env_name: "OPENAI_API_KEY".into(),
            endpoint_env: Some("OPENAI_BASE_URL".into()),
            has_key: true,
            has_endpoint: false,
            masked_tail: Some("9fQ2".into()),
            created_at: String::new(),
            last_used_at: None,
        }
    }

    #[test]
    fn memory_store_round_trip_and_delete_is_idempotent() {
        let s = MemoryStore::default();
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".to_string()));
        s.delete("k").unwrap();
        s.delete("k").unwrap();
        assert_eq!(s.get("k").unwrap(), None);
    }

    #[test]
    fn masked_tail_is_last_four_or_stars() {
        assert_eq!(masked_tail_of("sk-proj-abcdef9fQ2"), "9fQ2");
        assert_eq!(masked_tail_of("abc"), "****");
    }

    #[test]
    fn validate_save_rejects_bad_label_env_and_url() {
        let mut m = meta("c1");
        m.label = String::new();
        assert!(validate_save(&m, Some("sk-x"), None, true, false).unwrap_err().contains("Label"));
        let mut m = meta("c1");
        m.env_name = "bad name".into();
        assert!(validate_save(&m, Some("sk-x"), None, true, false).unwrap_err().contains("not a valid"));
        let m = meta("c1");
        assert!(validate_save(&m, None, Some("ftp://x"), true, true).unwrap_err().contains("http"));
    }

    #[test]
    fn validate_save_requires_key_or_endpoint() {
        let m = meta("c1");
        assert!(validate_save(&m, Some(""), Some(""), false, false).unwrap_err().contains("Enter an API key"));
        assert!(validate_save(&m, Some(""), Some("http://localhost:11434"), false, true).is_ok());
    }

    #[test]
    fn validate_save_needs_endpoint_env_when_endpoint_present() {
        let mut m = meta("c1");
        m.endpoint_env = None;
        assert!(validate_save(&m, None, Some("http://localhost:11434"), true, true).unwrap_err().contains("endpoint variable"));
    }

    #[test]
    fn resolve_for_spawn_maps_binding_env_to_value_and_endpoint() {
        let s = MemoryStore::default();
        s.set(&key_entry("c1"), "sk-secret").unwrap();
        s.set(&endpoint_entry("c1"), "http://localhost:11434").unwrap();
        let mut m = meta("c1");
        m.has_endpoint = true;
        let metas = HashMap::from([("c1".to_string(), m)]);
        let bindings = vec![CredentialBinding { env: "MY_KEY".into(), credential_id: "c1".into() }];
        let env = resolve_for_spawn(&s, &metas, &bindings).unwrap();
        assert_eq!(env.get("MY_KEY").unwrap(), "sk-secret");
        assert_eq!(env.get("OPENAI_BASE_URL").unwrap(), "http://localhost:11434");
    }

    #[test]
    fn resolve_for_spawn_reports_missing_row_and_missing_value_as_user_errors() {
        let s = MemoryStore::default();
        let metas = HashMap::from([("c1".to_string(), meta("c1"))]);
        let missing_row = vec![CredentialBinding { env: "K".into(), credential_id: "nope".into() }];
        let e = resolve_for_spawn(&s, &metas, &missing_row).unwrap_err();
        assert!(crate::error_reporter::is_user_error(&e));
        let missing_value = vec![CredentialBinding { env: "K".into(), credential_id: "c1".into() }];
        let e = resolve_for_spawn(&s, &metas, &missing_value).unwrap_err();
        assert!(crate::error_reporter::is_user_error(&e));
        assert!(e.contains("no longer in"));
    }
}
```

- [ ] **Step 3: Add `register_secret` to `error_reporter.rs`.** Near `pub fn scrub` add:

```rust
/// Secret values resolved for a spawn. `scrub` replaces any occurrence in an
/// outgoing report with `<credential>`. Bounded so a long session cannot grow
/// it without limit; the oldest entries fall off.
static RUNTIME_SECRETS: std::sync::Mutex<std::collections::VecDeque<String>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
const MAX_RUNTIME_SECRETS: usize = 64;

pub fn register_secret(value: &str) {
    if value.len() < 8 {
        return; // too short to redact safely without mangling ordinary text
    }
    let mut q = RUNTIME_SECRETS.lock().unwrap_or_else(|p| p.into_inner());
    if q.iter().any(|v| v == value) {
        return;
    }
    if q.len() >= MAX_RUNTIME_SECRETS {
        q.pop_front();
    }
    q.push_back(value.to_string());
}
```

and at the end of `scrub`, before `s.into_owned()`, add:

```rust
    let mut s = s.into_owned();
    if let Ok(q) = RUNTIME_SECRETS.lock() {
        for secret in q.iter() {
            if s.contains(secret.as_str()) {
                s = s.replace(secret.as_str(), "<credential>");
            }
        }
    }
    s
```

(remove the original `s.into_owned()` line). Add a test to the `error_reporter` tests module:

```rust
    #[test]
    fn scrub_replaces_registered_runtime_secret() {
        register_secret("zz-runtime-secret-value-123");
        let out = scrub("failed with key zz-runtime-secret-value-123 in env");
        assert_eq!(out, "failed with key <credential> in env");
    }
```

- [ ] **Step 4: Register the module** in `src-tauri/src/main.rs`: add `mod credentials;` after `mod custom_agents;`.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --quiet credentials error_reporter 2>&1 | tail -20`
Expected: 7 credential tests and the new scrub test pass. Silence the `KeyringStore` dead-code warning by adding `#[allow(dead_code)]` above `pub struct KeyringStore;` until Task 8 wires it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/credentials.rs src-tauri/src/error_reporter.rs src-tauri/src/main.rs
git commit -m "feat(credentials): SecretStore over keyring, metadata type, spawn resolution"
```

---

### Task 7: Credential tables, agent defaults, profile bindings, cascade delete

**Files:**
- Modify: `src-tauri/src/database.rs` (`init_schema`, profile save/load, new methods, tests)
- Modify: `src-tauri/src/config.rs:56-80` (`ConfigProfile`)

- [ ] **Step 1: Write the failing tests** in `database.rs` `mod tests`:

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet credential 2>&1 | tail -10`
Expected: compile errors (`no field credential_bindings`, missing methods).

- [ ] **Step 3: Extend `ConfigProfile`** in `config.rs` - add after `agent_args`:

```rust
    /// Credentials pinned by this profile, applied when the New Session modal
    /// is in API-key mode and the user has not overridden the row.
    #[serde(default)]
    pub credential_bindings: Vec<CredentialBinding>,
```

Fix the `ConfigProfile { ... }` literal at `config.rs:~351` (default profile) by adding `credential_bindings: Vec::new(),`, and any other literal the compiler reports.

- [ ] **Step 4: Schema.** In `init_schema`'s `execute_batch` add after `custom_agents`:

```sql
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
```

Add `"credential_bindings_json TEXT",` to the profiles `ALTER TABLE` column list (the array that already contains `"agent_args_json TEXT"`).

- [ ] **Step 5: Profile save/load.** In `save_profile` add `let credential_bindings_json = serde_json::to_string(&profile.credential_bindings).map_err(|e| e.to_string())?;`, extend the INSERT column list with `credential_bindings_json` and `?11`, and pass `credential_bindings_json` as the 11th param. In `get_profiles` extend the SELECT with `, credential_bindings_json` and, before the `Ok(ConfigProfile {` literal, add:

```rust
            let cb_raw: Option<String> = row.get(10)?;
            let credential_bindings: Vec<crate::config::CredentialBinding> = match cb_raw {
                Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
                    eprintln!("[profiles] corrupt credential_bindings for '{}' ({}): {}", name, id, e);
                    Vec::new()
                }),
                None => Vec::new(),
            };
```

and `credential_bindings,` in the literal.

- [ ] **Step 6: Credential and defaults methods** in `impl Database`:

```rust
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
            return Err(crate::error_reporter::user_err(format!("A key labelled \"{}\" already exists", m.label)));
        }
        self.conn
            .execute(
                "INSERT OR REPLACE INTO credentials
                 (id, label, provider, env_name, endpoint_env, has_key, has_endpoint, masked_tail, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    m.id, m.label, m.provider.as_str(), m.env_name, m.endpoint_env,
                    m.has_key as i32, m.has_endpoint as i32, m.masked_tail, m.created_at, m.last_used_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_credentials(&self) -> Result<Vec<crate::credentials::CredentialMeta>, String> {
        let sql = format!("SELECT {} FROM credentials ORDER BY created_at ASC, label ASC", Self::CREDENTIAL_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], Self::row_to_credential).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_credential(&self, id: &str) -> Result<Option<crate::credentials::CredentialMeta>, String> {
        let sql = format!("SELECT {} FROM credentials WHERE id = ?1", Self::CREDENTIAL_COLUMNS);
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query_map(params![id], Self::row_to_credential).map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn touch_credential_used(&self, id: &str) -> Result<(), String> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .execute("UPDATE credentials SET last_used_at = ?1 WHERE id = ?2", params![now, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_agent_bindings(&self, agent_wire: &str) -> Result<Vec<crate::config::CredentialBinding>, String> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT bindings FROM agent_defaults WHERE agent = ?1", params![agent_wire], |r| r.get(0))
            .ok();
        Ok(raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    pub fn set_agent_bindings(&self, agent_wire: &str, bindings: &[crate::config::CredentialBinding]) -> Result<(), String> {
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
                let mut stmt = self.conn.prepare("SELECT agent FROM agent_defaults").map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
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
```

- [ ] **Step 7: Run tests**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -20`
Expected: all pass, including the 5 new database tests.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/database.rs src-tauri/src/config.rs
git commit -m "feat(db): credentials, agent_defaults, profile bindings, cascade delete"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
### Task 8: Credential IPC commands and `AppState.secrets`

**Files:**
- Modify: `src-tauri/src/main.rs:25-40` (`AppState`), `:109-115` (construction), handler list
- Modify: `src-tauri/src/commands.rs` (new commands)

- [ ] **Step 1: Add the store to `AppState`.** In `src-tauri/src/main.rs` add the field:

```rust
    /// OS credential store. `Arc<dyn ...>` so tests can swap in `MemoryStore`.
    pub secrets: Arc<dyn credentials::SecretStore>,
```

and in the `app.manage(AppState { ... })` literal add `secrets: Arc::new(credentials::KeyringStore),`. Remove the `#[allow(dead_code)]` added in Task 6.

- [ ] **Step 2: Write the failing test** for the pure test-request builder. In `commands.rs` `mod tests`:

```rust
    #[test]
    fn credential_test_request_shapes_per_provider() {
        use crate::credentials::Provider;
        let (url, headers) = credential_test_request(&Provider::Anthropic, None, "sk-ant-x").unwrap();
        assert_eq!(url, "https://api.anthropic.com/v1/models");
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant-x");
        assert!(headers.contains_key("anthropic-version"));

        let (url, headers) = credential_test_request(&Provider::OpenAI, Some("http://localhost:11434/v1"), "k").unwrap();
        assert_eq!(url, "http://localhost:11434/v1/models");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer k");

        let (url, _) = credential_test_request(&Provider::Google, None, "AIza").unwrap();
        assert_eq!(url, "https://generativelanguage.googleapis.com/v1beta/models?key=AIza");

        assert!(credential_test_request(&Provider::Cursor, None, "k").is_none());
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet credential_test_request 2>&1 | tail -10`
Expected: `cannot find function credential_test_request`.

- [ ] **Step 4: Add the commands** to `commands.rs` after `delete_custom_agent`:

```rust
/// URL + headers for a one-shot "list models" call. `None` = the provider has
/// no cheap test endpoint (Cursor). Anthropic-compatible endpoints (Ollama,
/// LiteLLM) take the Anthropic shape; OpenAI-compatible gateways take Bearer.
pub(crate) fn credential_test_request(
    provider: &crate::credentials::Provider,
    endpoint: Option<&str>,
    key: &str,
) -> Option<(String, HashMap<String, String>)> {
    use crate::credentials::Provider;
    let base = |default: &str| endpoint.unwrap_or(default).trim_end_matches('/').to_string();
    let mut headers = HashMap::new();
    let url = match provider {
        Provider::Anthropic => {
            headers.insert("x-api-key".into(), key.to_string());
            headers.insert("anthropic-version".into(), "2023-06-01".into());
            format!("{}/v1/models", base("https://api.anthropic.com"))
        }
        Provider::OpenAI => {
            headers.insert("authorization".into(), format!("Bearer {}", key));
            format!("{}/models", base("https://api.openai.com/v1"))
        }
        Provider::OpenRouter => {
            headers.insert("authorization".into(), format!("Bearer {}", key));
            format!("{}/models", base("https://openrouter.ai/api/v1"))
        }
        Provider::Google => {
            format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", key)
        }
        Provider::Custom => {
            headers.insert("authorization".into(), format!("Bearer {}", key));
            format!("{}/models", base(""))
        }
        Provider::Cursor => return None,
    };
    Some((url, headers))
}

#[derive(Debug, Serialize)]
pub struct CredentialTestResult {
    pub ok: bool,
    pub detail: String,
    pub latency_ms: u64,
}

#[command]
pub async fn list_credentials(
    state: State<'_, AppState>,
) -> Result<Vec<crate::credentials::CredentialMeta>, String> {
    wrap_cmd("list_credentials", async move {
        db_op(&state.db, |db| db.list_credentials()).await
    })
    .await
}

/// `key` / `endpoint`: `None` = leave unchanged, `Some("")` = clear,
/// `Some(v)` = set. Values are written to the OS store before metadata so a
/// failed store write never leaves a row claiming `has_key`.
#[command]
pub async fn save_credential(
    state: State<'_, AppState>,
    mut meta: crate::credentials::CredentialMeta,
    key: Option<String>,
    endpoint: Option<String>,
) -> Result<crate::credentials::CredentialMeta, String> {
    wrap_cmd("save_credential", async move {
        use crate::credentials::{endpoint_entry, key_entry, masked_tail_of};
        let existing = if meta.id.trim().is_empty() {
            meta.id = uuid::Uuid::new_v4().to_string();
            None
        } else {
            let id = meta.id.clone();
            db_op(&state.db, move |db| db.get_credential(&id)).await?
        };
        let will_have_key = match key.as_deref() {
            None => existing.as_ref().map(|e| e.has_key).unwrap_or(false),
            Some("") => false,
            Some(_) => true,
        };
        let will_have_endpoint = match endpoint.as_deref() {
            None => existing.as_ref().map(|e| e.has_endpoint).unwrap_or(false),
            Some("") => false,
            Some(_) => true,
        };
        crate::credentials::validate_save(&meta, key.as_deref(), endpoint.as_deref(), will_have_key, will_have_endpoint)
            .map_err(error_reporter::user_err)?;

        let store = state.secrets.clone();
        let id = meta.id.clone();
        match key.as_deref() {
            None => {
                meta.has_key = will_have_key;
                meta.masked_tail = existing.as_ref().and_then(|e| e.masked_tail.clone());
            }
            Some("") => {
                store.delete(&key_entry(&id))?;
                meta.has_key = false;
                meta.masked_tail = None;
            }
            Some(v) => {
                store.set(&key_entry(&id), v)?;
                meta.has_key = true;
                meta.masked_tail = Some(masked_tail_of(v));
            }
        }
        match endpoint.as_deref() {
            None => meta.has_endpoint = will_have_endpoint,
            Some("") => {
                store.delete(&endpoint_entry(&id))?;
                meta.has_endpoint = false;
            }
            Some(v) => {
                store.set(&endpoint_entry(&id), v.trim_end_matches('/'))?;
                meta.has_endpoint = true;
            }
        }
        meta.label = meta.label.trim().to_string();
        meta.created_at = existing
            .as_ref()
            .map(|e| e.created_at.clone())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        meta.last_used_at = existing.as_ref().and_then(|e| e.last_used_at.clone());
        let to_save = meta.clone();
        db_op(&state.db, move |db| db.upsert_credential(&to_save)).await?;
        Ok(meta)
    })
    .await
}

#[command]
pub async fn delete_credential(state: State<'_, AppState>, id: String) -> Result<(), String> {
    wrap_cmd("delete_credential", async move {
        use crate::credentials::{endpoint_entry, key_entry};
        state.secrets.delete(&key_entry(&id))?;
        state.secrets.delete(&endpoint_entry(&id))?;
        db_op(&state.db, move |db| db.delete_credential_cascade(&id)).await
    })
    .await
}

#[command]
pub async fn test_credential(
    state: State<'_, AppState>,
    id: String,
) -> Result<CredentialTestResult, String> {
    wrap_cmd("test_credential", async move {
        use crate::credentials::{endpoint_entry, key_entry, Provider};
        let lookup_id = id.clone();
        let meta = db_op(&state.db, move |db| db.get_credential(&lookup_id))
            .await?
            .ok_or_else(|| error_reporter::user_err("Key not found"))?;
        let key = if meta.has_key { state.secrets.get(&key_entry(&id))?.unwrap_or_default() } else { String::new() };
        let endpoint = if meta.has_endpoint { state.secrets.get(&endpoint_entry(&id))? } else { None };
        if meta.provider == Provider::Cursor {
            return Ok(CredentialTestResult { ok: false, detail: "No test endpoint for Cursor; saved anyway".into(), latency_ms: 0 });
        }
        let Some((url, headers)) = credential_test_request(&meta.provider, endpoint.as_deref(), &key) else {
            return Ok(CredentialTestResult { ok: false, detail: "No test endpoint".into(), latency_ms: 0 });
        };
        if meta.provider == Provider::Custom && endpoint.is_none() {
            return Err(error_reporter::user_err("Custom providers need an endpoint override to test"));
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.get(&url);
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let started = std::time::Instant::now();
        let resp = req.send().await.map_err(|e| error_reporter::user_err(format!("Connection failed: {}", e)))?;
        let latency_ms = started.elapsed().as_millis() as u64;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let snippet: String = body.chars().take(160).collect();
            return Ok(CredentialTestResult { ok: false, detail: format!("HTTP {} {}", status.as_u16(), snippet.trim()), latency_ms });
        }
        // Every provider returns a JSON list of models under `data` (OpenAI,
        // Anthropic) or `models` (Google); grab the first id/name.
        let first_model = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                let list = v.get("data").or_else(|| v.get("models"))?.as_array()?.first()?.clone();
                list.get("id").or_else(|| list.get("name"))?.as_str().map(|s| s.to_string())
            })
            .unwrap_or_else(|| "models listed".to_string());
        let _ = db_op(&state.db, move |db| db.touch_credential_used(&id)).await;
        Ok(CredentialTestResult { ok: true, detail: first_model, latency_ms })
    })
    .await
}

/// Default credential bindings for an agent. Built-ins live in
/// `agent_defaults`; custom agents carry theirs on the row.
#[command]
pub async fn get_agent_bindings(
    state: State<'_, AppState>,
    agent: crate::config::AgentKind,
) -> Result<Vec<crate::config::CredentialBinding>, String> {
    wrap_cmd("get_agent_bindings", async move {
        if let Some(id) = agent.custom_id() {
            let id = id.to_string();
            return Ok(db_op(&state.db, move |db| db.get_custom_agent(&id))
                .await?
                .map(|a| a.bindings)
                .unwrap_or_default());
        }
        let wire = agent.to_wire();
        db_op(&state.db, move |db| db.get_agent_bindings(&wire)).await
    })
    .await
}

#[command]
pub async fn set_agent_bindings(
    state: State<'_, AppState>,
    agent: crate::config::AgentKind,
    bindings: Vec<crate::config::CredentialBinding>,
) -> Result<(), String> {
    wrap_cmd("set_agent_bindings", async move {
        for b in &bindings {
            if !crate::custom_agents::is_valid_env_name(&b.env) || crate::custom_agents::is_blocked_env(&b.env) {
                return Err(error_reporter::user_err(format!("\"{}\" is not an allowed variable", b.env)));
            }
        }
        if let Some(id) = agent.custom_id() {
            let id = id.to_string();
            return db_op(&state.db, move |db| {
                let Some(mut a) = db.get_custom_agent(&id)? else {
                    return Err(error_reporter::user_err("Agent not found"));
                };
                for b in &bindings {
                    if !a.required_env.contains(&b.env) {
                        a.required_env.push(b.env.clone());
                    }
                }
                a.bindings = bindings;
                db.save_custom_agent(&a)
            })
            .await;
        }
        let wire = agent.to_wire();
        db_op(&state.db, move |db| db.set_agent_bindings(&wire, &bindings)).await
    })
    .await
}
```

- [ ] **Step 5: Register** in `main.rs` after `commands::delete_custom_agent,`:

```rust
            commands::list_credentials,
            commands::save_credential,
            commands::delete_credential,
            commands::test_credential,
            commands::get_agent_bindings,
            commands::set_agent_bindings,
```

- [ ] **Step 6: Build and test**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -15`
Expected: all pass including `credential_test_request_shapes_per_provider`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(credentials): IPC commands for keys, test connection, agent bindings"
```

---

### Task 9: Inject credentials at spawn without storing them

**Files:**
- Modify: `src-tauri/src/terminal.rs:10-33` (`TerminalConfig`), `:184-200` and `:339-345` (`create_terminal`), `:556, :677, :974` (struct literals), `:1030` (test)
- Modify: `src-tauri/src/commands.rs:342-366` (`CreateTerminalRequest`), `create_terminal` body
- Modify: `src-tauri/src/database.rs:627` (struct literal)

- [ ] **Step 1: Write the failing test** in `terminal.rs` tests (the module that already builds a `TerminalConfig` around line 969):

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test --quiet terminal_config_carries 2>&1 | tail -10`
Expected: `no field credential_bindings`.

- [ ] **Step 3: Extend `TerminalConfig`** - add after `agent`:

```rust
    /// Credentials this terminal was launched with, by id only. Session
    /// restore re-resolves them from the OS store; values are never stored.
    #[serde(default)]
    pub credential_bindings: Vec<crate::config::CredentialBinding>,
```

Add `credential_bindings: Vec::new(),` to every `TerminalConfig { ... }` literal the compiler reports (`terminal.rs` shell/test constructions and `database.rs:627`).

- [ ] **Step 4: Extend `TerminalManager::create_terminal`.** Add two parameters after `env_vars: HashMap<String, String>,`:

```rust
        /// Resolved credential values. Applied to the child env, filtered by
        /// BLOCKED_ENV_VARS like everything else, and NEVER written to
        /// `TerminalConfig` (which is persisted for restore).
        secret_env_vars: HashMap<String, String>,
        credential_bindings: Vec<crate::config::CredentialBinding>,
```

After the `safe_env_vars` filter add:

```rust
        let safe_secret_env: HashMap<String, String> = secret_env_vars
            .into_iter()
            .filter(|(key, _)| {
                let upper = key.to_uppercase();
                !Self::BLOCKED_ENV_VARS.iter().any(|blocked| blocked.eq_ignore_ascii_case(&upper))
            })
            .collect();
```

After the `for (key, value) in &safe_env_vars { cmd.env(key, value); }` loop add:

```rust
        // Bindings win over profile env vars with the same name.
        for (key, value) in &safe_secret_env {
            cmd.env(key, value);
        }
```

In the `TerminalConfig { ... }` literal that this function builds, add `credential_bindings,`. Update the test call at ~line 1030 to pass `HashMap::new(), Vec::new(),` in the new positions.

- [ ] **Step 5: Request field and resolution in `commands.rs`.** Add to `CreateTerminalRequest`:

```rust
    /// Credentials to inject, by id. Resolved from the OS store at spawn.
    #[serde(default)]
    pub credential_bindings: Vec<crate::config::CredentialBinding>,
```

In `create_terminal`, after `let spec = resolve_agent_spec(&state, &agent).await?;` add:

```rust
        // Resolve credential values once, in Rust, and hand them straight to
        // the PTY env. They never enter the returned config or the DB.
        let secret_env = if request.credential_bindings.is_empty() {
            HashMap::new()
        } else {
            let ids: Vec<String> = request.credential_bindings.iter().map(|b| b.credential_id.clone()).collect();
            let metas = db_op(&state.db, move |db| {
                let mut m = HashMap::new();
                for id in ids {
                    if let Some(meta) = db.get_credential(&id)? {
                        m.insert(id, meta);
                    }
                }
                Ok(m)
            })
            .await?;
            let env = crate::credentials::resolve_for_spawn(state.secrets.as_ref(), &metas, &request.credential_bindings)?;
            let used: Vec<String> = metas.keys().cloned().collect();
            let _ = db_op(&state.db, move |db| {
                for id in &used {
                    db.touch_credential_used(id)?;
                }
                Ok(())
            })
            .await;
            env
        };
```

and pass `secret_env, request.credential_bindings.clone(),` after `request.env_vars,` in the `terminals.create_terminal(...)` call.

- [ ] **Step 6: Build and test**

Run: `cd src-tauri && cargo test --quiet 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/terminal.rs src-tauri/src/commands.rs src-tauri/src/database.rs
git commit -m "feat(spawn): resolve credential bindings into the PTY env without persisting values"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
## Part C - Frontend library and stores

### Task 10: `AgentKind` union with custom kinds and a spec registry

**Files:**
- Modify: `src/lib/agents.ts`
- Modify: `src/lib/agents.test.ts`

- [ ] **Step 1: Add failing tests** to `src/lib/agents.test.ts` (keep the existing tests; add a new `describe`):

```ts
import { isCustomAgent, customKind, setCustomAgentSpecs, allAgentSpecs, defaultArgsFor } from './agents';

describe('custom agent kinds', () => {
  const oc = {
    kind: customKind('a1'),
    displayName: 'OpenCode',
    binary: 'opencode',
    installUrl: 'https://opencode.ai',
    installHint: 'npm i -g opencode-ai',
    defaultArgsHint: '',
    color: '#30C55E',
    monogram: 'OC',
    defaultArgs: ['--agent', 'build'],
    resumeFlag: '--session {id}',
    requiredEnv: ['OPENAI_API_KEY'],
  };

  it('customKind builds the wire form and isCustomAgent detects it', () => {
    expect(customKind('a1')).toBe('custom:a1');
    expect(isCustomAgent('custom:a1')).toBe(true);
    expect(isCustomAgent('claude')).toBe(false);
  });

  it('specFor resolves a registered custom spec and allAgentSpecs appends it after built-ins', () => {
    setCustomAgentSpecs([oc]);
    expect(specFor('custom:a1').binary).toBe('opencode');
    const kinds = allAgentSpecs().map(s => s.kind);
    expect(kinds.slice(0, 4)).toEqual(['claude', 'codex', 'cursor', 'antigravity']);
    expect(kinds[4]).toBe('custom:a1');
    setCustomAgentSpecs([]);
    expect(() => specFor('custom:a1')).toThrow();
  });

  it('filterArgsForAgent treats custom kinds like cursor', () => {
    const out = filterArgsForAgent('custom:a1', ['--dangerously-skip-permissions', '--model', 'opus', '--verbose']);
    expect(out).toEqual(['--verbose']);
  });

  it('defaultArgsFor returns the custom agent default args, else the builtin map entry', () => {
    setCustomAgentSpecs([oc]);
    expect(defaultArgsFor('custom:a1', { claude: ['--x'], codex: [], cursor: [], antigravity: [] })).toEqual(['--agent', 'build']);
    expect(defaultArgsFor('claude', { claude: ['--x'], codex: [], cursor: [], antigravity: [] })).toEqual(['--x']);
    setCustomAgentSpecs([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agents.test.ts 2>&1 | tail -15`
Expected: FAIL, `isCustomAgent` is not exported.

- [ ] **Step 3: Update `src/lib/agents.ts`.** Replace the type block and `specFor`, and change the strip maps:

```ts
export type BuiltinAgentKind = 'claude' | 'codex' | 'cursor' | 'antigravity';
/** Built-in kinds plus user-registered `custom:<uuid>` kinds. */
export type AgentKind = BuiltinAgentKind | `custom:${string}`;

export const BUILTIN_AGENT_KINDS: readonly BuiltinAgentKind[] = ['claude', 'codex', 'cursor', 'antigravity'];

export function isCustomAgent(kind: AgentKind): kind is `custom:${string}` {
  return kind.startsWith('custom:');
}
export function customKind(id: string): `custom:${string}` {
  return `custom:${id}`;
}
export function customIdOf(kind: AgentKind): string | null {
  return isCustomAgent(kind) ? kind.slice('custom:'.length) : null;
}

export interface AgentSpec {
  kind: AgentKind;
  displayName: string;
  binary: string;
  installUrl: string;
  installHint: string;
  defaultArgsHint: string;
  /** Custom agents only. */
  color?: string;
  monogram?: string;
  defaultArgs?: string[];
  resumeFlag?: string | null;
  requiredEnv?: string[];
}
```

Keep `AGENT_SPECS` exactly as it is (built-ins only). Below it add the registry:

```ts
// Custom specs are pushed in by agentRegistryStore after it loads the
// `custom_agents` table. Kept module-level (not React state) so pure helpers
// like specFor / filterArgsForAgent can read them synchronously.
let customSpecs: AgentSpec[] = [];
export function setCustomAgentSpecs(specs: AgentSpec[]) {
  customSpecs = specs;
}
/** Built-ins first, then custom agents in registry order. */
export function allAgentSpecs(): AgentSpec[] {
  return [...AGENT_SPECS, ...customSpecs];
}

export function specFor(kind: AgentKind): AgentSpec {
  const spec = allAgentSpecs().find(s => s.kind === kind);
  if (!spec) throw new Error(`Unknown agent kind: ${kind}`);
  return spec;
}

/** Two-letter monogram for a custom agent tile ("OpenCode" -> "OC"). */
export function monogramFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

/** Starter args for a kind: custom agents carry their own; built-ins read
 *  the persisted per-agent map from appStore. */
export function defaultArgsFor(kind: AgentKind, builtinMap: Record<BuiltinAgentKind, string[]>): string[] {
  if (isCustomAgent(kind)) return [...(specFor(kind).defaultArgs ?? [])];
  return builtinMap[kind] ?? [];
}
```

Change both strip maps to `Record<BuiltinAgentKind, ReadonlySet<string>>` and inside `filterArgsForAgent` replace the two lookups with:

```ts
  // Custom agents get the conservative Cursor rules: drop Claude-only flags
  // and Claude-shaped --model/--effort/--resume pairs.
  const key: BuiltinAgentKind = isCustomAgent(agent) ? 'cursor' : agent;
  const noValue = NO_VALUE_STRIP[key];
  const withValue = WITH_VALUE_STRIP[key];
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/lib/agents.test.ts 2>&1 | tail -15`
Expected: all pass. `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30` will now list every `Record<AgentKind, ...>` site; Task 13 fixes those. Note them but do not fix yet.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents.ts src/lib/agents.test.ts
git commit -m "feat(agents): custom AgentKind union and spec registry"
```

---

### Task 11: Agent presets and provider table

**Files:**
- Create: `src/lib/agentPresets.ts`
- Create: `src/lib/agentPresets.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/agentPresets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AGENT_PRESETS, AGENT_COLORS, PROVIDERS, providerDefaults, ENV_NAME_RE } from './agentPresets';

describe('agent presets', () => {
  it('every preset has a binary, an allowed colour, and valid env names', () => {
    for (const p of AGENT_PRESETS) {
      expect(p.binary.length).toBeGreaterThan(0);
      expect(AGENT_COLORS).toContain(p.color);
      for (const e of p.requiredEnv) expect(e).toMatch(ENV_NAME_RE);
    }
  });

  it('ships the five agreed presets plus a custom entry', () => {
    expect(AGENT_PRESETS.map(p => p.id)).toEqual(['opencode', 'gemini', 'aider', 'goose', 'qwen', 'custom']);
  });

  it('provider defaults map key env and endpoint env', () => {
    expect(providerDefaults('anthropic')).toEqual({ envName: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL', defaultEndpoint: 'https://api.anthropic.com' });
    expect(providerDefaults('google').endpointEnv).toBeNull();
    expect(PROVIDERS.map(p => p.id)).toContain('openrouter');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agentPresets.test.ts 2>&1 | tail -10`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Create `src/lib/agentPresets.ts`**:

```ts
// Static tables behind the Add Agent / Add API Key dialogs. Colours must
// match `ALLOWED_COLORS` in src-tauri/src/custom_agents.rs - the backend
// rejects anything else.

export const AGENT_COLORS = ['#30C55E', '#3899FF', '#FFA028', '#B48CFF', '#FF6B8A', '#5AC8FA'] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface AgentPreset {
  id: string;
  name: string;
  binary: string;
  defaultArgs: string[];
  /** `--session {id}` style, or a `--continue` style flag, or null. */
  resumeFlag: string | null;
  color: AgentColor;
  requiredEnv: string[];
  installUrl: string | null;
  installHint: string | null;
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'opencode', name: 'OpenCode', binary: 'opencode',
    defaultArgs: [], resumeFlag: '--session {id}', color: '#30C55E',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://opencode.ai/docs', installHint: 'npm install -g opencode-ai',
  },
  {
    id: 'gemini', name: 'Gemini CLI', binary: 'gemini',
    defaultArgs: [], resumeFlag: '--resume {id}', color: '#3899FF',
    requiredEnv: ['GEMINI_API_KEY'],
    installUrl: 'https://github.com/google-gemini/gemini-cli', installHint: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'aider', name: 'Aider', binary: 'aider',
    defaultArgs: [], resumeFlag: '--restore-chat-history', color: '#FFA028',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://aider.chat/docs/install.html', installHint: 'python -m pip install aider-install && aider-install',
  },
  {
    id: 'goose', name: 'Goose', binary: 'goose',
    defaultArgs: [], resumeFlag: '--resume', color: '#B48CFF',
    requiredEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    installUrl: 'https://block.github.io/goose/docs/getting-started/installation', installHint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
  },
  {
    id: 'qwen', name: 'Qwen Code', binary: 'qwen',
    defaultArgs: [], resumeFlag: null, color: '#FF6B8A',
    requiredEnv: ['OPENAI_API_KEY'],
    installUrl: 'https://github.com/QwenLM/qwen-code', installHint: 'npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'custom', name: '', binary: '',
    defaultArgs: [], resumeFlag: null, color: '#5AC8FA',
    requiredEnv: [], installUrl: null, installHint: null,
  },
];

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'cursor' | 'openrouter' | 'custom';

export const PROVIDERS: readonly { id: ProviderId; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', label: 'Custom' },
];

export interface ProviderDefaults {
  envName: string;
  endpointEnv: string | null;
  defaultEndpoint: string | null;
}

export function providerDefaults(id: ProviderId): ProviderDefaults {
  switch (id) {
    case 'anthropic': return { envName: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL', defaultEndpoint: 'https://api.anthropic.com' };
    case 'openai': return { envName: 'OPENAI_API_KEY', endpointEnv: 'OPENAI_BASE_URL', defaultEndpoint: 'https://api.openai.com/v1' };
    case 'google': return { envName: 'GEMINI_API_KEY', endpointEnv: null, defaultEndpoint: null };
    case 'cursor': return { envName: 'CURSOR_API_KEY', endpointEnv: null, defaultEndpoint: null };
    case 'openrouter': return { envName: 'OPENROUTER_API_KEY', endpointEnv: 'OPENAI_BASE_URL', defaultEndpoint: 'https://openrouter.ai/api/v1' };
    case 'custom': return { envName: '', endpointEnv: null, defaultEndpoint: null };
  }
}

/** Env var names that look like secrets - drives the Profile modal's
 *  "Move to keychain" action and the one-time migration prompt. */
export const SECRET_ENV_RE = /(_API_KEY|_TOKEN|_SECRET)$/;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/agentPresets.test.ts 2>&1 | tail -10`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agentPresets.ts src/lib/agentPresets.test.ts
git commit -m "feat(agents): preset and provider tables"
```

---

### Task 12: Credential types and the agent registry store

**Files:**
- Create: `src/lib/credentials.ts`
- Create: `src/store/agentRegistryStore.ts`
- Create: `src/store/agentRegistryStore.test.ts`

- [ ] **Step 1: Create `src/lib/credentials.ts`** (typed IPC wrappers, no logic to test):

```ts
import { invoke } from '@tauri-apps/api/core';
import type { AgentKind } from './agents';
import type { ProviderId } from './agentPresets';

export interface CredentialBinding { env: string; credential_id: string }

/** Mirrors Rust `credentials::CredentialMeta`. Never contains a key value. */
export interface CredentialMeta {
  id: string;
  label: string;
  provider: ProviderId;
  env_name: string;
  endpoint_env: string | null;
  has_key: boolean;
  has_endpoint: boolean;
  masked_tail: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Mirrors Rust `custom_agents::CustomAgent`. */
export interface CustomAgent {
  id: string;
  name: string;
  binary: string;
  default_args: string[];
  resume_flag: string | null;
  color: string;
  required_env: string[];
  bindings: CredentialBinding[];
  install_url: string | null;
  install_hint: string | null;
  created_at: string;
  updated_at: string;
}

export interface BinaryProbe { found: boolean; resolved_path: string | null; version: string | null }
export interface CredentialTestResult { ok: boolean; detail: string; latency_ms: number }

export const listCredentials = () => invoke<CredentialMeta[]>('list_credentials');
/** `key`/`endpoint`: undefined = unchanged, '' = clear, string = set. */
export const saveCredential = (meta: CredentialMeta, key?: string, endpoint?: string) =>
  invoke<CredentialMeta>('save_credential', { meta, key: key ?? null, endpoint: endpoint ?? null });
export const deleteCredential = (id: string) => invoke<void>('delete_credential', { id });
export const testCredential = (id: string) => invoke<CredentialTestResult>('test_credential', { id });
export const listCustomAgents = () => invoke<CustomAgent[]>('list_custom_agents');
export const saveCustomAgent = (agent: CustomAgent) => invoke<CustomAgent>('save_custom_agent', { agent });
export const deleteCustomAgent = (id: string) => invoke<void>('delete_custom_agent', { id });
export const probeBinary = (binary: string) => invoke<BinaryProbe>('probe_binary', { binary });
export const getAgentBindings = (agent: AgentKind) => invoke<CredentialBinding[]>('get_agent_bindings', { agent });
export const setAgentBindings = (agent: AgentKind, bindings: CredentialBinding[]) =>
  invoke<void>('set_agent_bindings', { agent, bindings });
```

- [ ] **Step 2: Write the failing store test** `src/store/agentRegistryStore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { useAgentRegistryStore } from './agentRegistryStore';
import { specFor, allAgentSpecs } from '../lib/agents';

const agentRow = {
  id: 'a1', name: 'OpenCode', binary: 'opencode', default_args: ['--agent', 'build'],
  resume_flag: '--session {id}', color: '#30C55E', required_env: ['OPENAI_API_KEY'],
  bindings: [{ env: 'OPENAI_API_KEY', credential_id: 'c1' }],
  install_url: null, install_hint: null, created_at: '', updated_at: '',
};
const credRow = {
  id: 'c1', label: 'Work OpenAI', provider: 'openai', env_name: 'OPENAI_API_KEY', endpoint_env: 'OPENAI_BASE_URL',
  has_key: true, has_endpoint: false, masked_tail: '9fQ2', created_at: '', last_used_at: null,
};

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ customAgents: [], credentials: [], builtinBindings: {}, loaded: false, addAgentOpen: false, editingAgentId: null, addKeyOpen: false, keyPrefill: null });
});

describe('agentRegistryStore', () => {
  it('refresh loads agents, credentials and builtin bindings, and registers custom specs', async () => {
    invoke.mockImplementation(async (cmd: string, args?: { agent?: string }) => {
      if (cmd === 'list_custom_agents') return [agentRow];
      if (cmd === 'list_credentials') return [credRow];
      if (cmd === 'get_agent_bindings') return args?.agent === 'claude' ? [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] : [];
      return [];
    });
    await useAgentRegistryStore.getState().refresh();
    const s = useAgentRegistryStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.customAgents).toHaveLength(1);
    expect(s.credentials[0].label).toBe('Work OpenAI');
    expect(s.builtinBindings.claude).toEqual([{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }]);
    expect(specFor('custom:a1').monogram).toBe('OC');
    expect(allAgentSpecs()).toHaveLength(5);
  });

  it('defaultBindingsFor reads custom rows or the builtin map', async () => {
    useAgentRegistryStore.setState({ customAgents: [agentRow], builtinBindings: { codex: [{ env: 'OPENAI_API_KEY', credential_id: 'c9' }] } });
    const s = useAgentRegistryStore.getState();
    expect(s.defaultBindingsFor('custom:a1')).toEqual(agentRow.bindings);
    expect(s.defaultBindingsFor('codex')[0].credential_id).toBe('c9');
    expect(s.defaultBindingsFor('cursor')).toEqual([]);
  });

  it('deleteCredential removes the row locally and strips bindings', async () => {
    invoke.mockResolvedValue(undefined);
    useAgentRegistryStore.setState({ customAgents: [agentRow], credentials: [credRow], builtinBindings: { claude: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] } });
    await useAgentRegistryStore.getState().deleteCredential('c1');
    const s = useAgentRegistryStore.getState();
    expect(invoke).toHaveBeenCalledWith('delete_credential', { id: 'c1' });
    expect(s.credentials).toEqual([]);
    expect(s.customAgents[0].bindings).toEqual([]);
    expect(s.builtinBindings.claude).toEqual([]);
  });

  it('credentialsForEnv filters by env name', () => {
    useAgentRegistryStore.setState({ credentials: [credRow, { ...credRow, id: 'c2', label: 'Anth', env_name: 'ANTHROPIC_API_KEY' }] });
    expect(useAgentRegistryStore.getState().credentialsForEnv('OPENAI_API_KEY').map(c => c.id)).toEqual(['c1']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/store/agentRegistryStore.test.ts 2>&1 | tail -10`
Expected: FAIL, cannot find module.

- [ ] **Step 4: Create `src/store/agentRegistryStore.ts`**:

```ts
import { create } from 'zustand';
import {
  BUILTIN_AGENT_KINDS, customKind, isCustomAgent, monogramFor, setCustomAgentSpecs,
  type AgentKind, type AgentSpec, type BuiltinAgentKind,
} from '../lib/agents';
import {
  deleteCredential as ipcDeleteCredential, deleteCustomAgent as ipcDeleteCustomAgent,
  getAgentBindings, listCredentials, listCustomAgents, probeBinary,
  saveCredential as ipcSaveCredential, saveCustomAgent as ipcSaveCustomAgent, setAgentBindings,
  type BinaryProbe, type CredentialBinding, type CredentialMeta, type CustomAgent,
} from '../lib/credentials';

export function toSpec(a: CustomAgent): AgentSpec {
  return {
    kind: customKind(a.id),
    displayName: a.name,
    binary: a.binary,
    installUrl: a.install_url ?? '',
    installHint: a.install_hint ?? '',
    defaultArgsHint: a.default_args.join('\n'),
    color: a.color,
    monogram: monogramFor(a.name),
    defaultArgs: a.default_args,
    resumeFlag: a.resume_flag,
    requiredEnv: a.required_env,
  };
}

export interface KeyPrefill {
  provider?: CredentialMeta['provider'];
  label?: string;
  env_name?: string;
  key?: string;
  /** Profile id whose env var is being moved; the modal removes it on save. */
  fromProfileId?: string;
}

interface AgentRegistryState {
  customAgents: CustomAgent[];
  credentials: CredentialMeta[];
  builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>>;
  probes: Record<string, BinaryProbe>;
  loaded: boolean;

  refresh: () => Promise<void>;
  probe: (binary: string) => Promise<BinaryProbe>;
  saveAgent: (agent: CustomAgent) => Promise<CustomAgent>;
  deleteAgent: (id: string) => Promise<void>;
  saveCredential: (meta: CredentialMeta, key?: string, endpoint?: string) => Promise<CredentialMeta>;
  deleteCredential: (id: string) => Promise<void>;
  setBindings: (kind: AgentKind, bindings: CredentialBinding[]) => Promise<void>;
  defaultBindingsFor: (kind: AgentKind) => CredentialBinding[];
  credentialsForEnv: (env: string) => CredentialMeta[];

  addAgentOpen: boolean;
  editingAgentId: string | null;
  openAddAgent: (editId?: string) => void;
  closeAddAgent: () => void;
  addKeyOpen: boolean;
  keyPrefill: KeyPrefill | null;
  openAddKey: (prefill?: KeyPrefill) => void;
  closeAddKey: () => void;
}

export const useAgentRegistryStore = create<AgentRegistryState>((set, get) => ({
  customAgents: [],
  credentials: [],
  builtinBindings: {},
  probes: {},
  loaded: false,

  refresh: async () => {
    const [customAgents, credentials, ...bindingLists] = await Promise.all([
      listCustomAgents(),
      listCredentials(),
      ...BUILTIN_AGENT_KINDS.map(k => getAgentBindings(k)),
    ]);
    const builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>> = {};
    BUILTIN_AGENT_KINDS.forEach((k, i) => { builtinBindings[k] = bindingLists[i]; });
    setCustomAgentSpecs(customAgents.map(toSpec));
    set({ customAgents, credentials, builtinBindings, loaded: true });
  },

  probe: async (binary) => {
    const result = await probeBinary(binary);
    set(s => ({ probes: { ...s.probes, [binary]: result } }));
    return result;
  },

  saveAgent: async (agent) => {
    const saved = await ipcSaveCustomAgent(agent);
    set(s => {
      const rest = s.customAgents.filter(a => a.id !== saved.id);
      const customAgents = [...rest, saved].sort((a, b) => a.created_at.localeCompare(b.created_at));
      setCustomAgentSpecs(customAgents.map(toSpec));
      return { customAgents };
    });
    return saved;
  },

  deleteAgent: async (id) => {
    await ipcDeleteCustomAgent(id);
    set(s => {
      const customAgents = s.customAgents.filter(a => a.id !== id);
      setCustomAgentSpecs(customAgents.map(toSpec));
      return { customAgents };
    });
  },

  saveCredential: async (meta, key, endpoint) => {
    const saved = await ipcSaveCredential(meta, key, endpoint);
    set(s => ({ credentials: [...s.credentials.filter(c => c.id !== saved.id), saved] }));
    return saved;
  },

  deleteCredential: async (id) => {
    await ipcDeleteCredential(id);
    // Mirror the backend cascade so the UI never shows a dangling binding.
    set(s => {
      const strip = (b: CredentialBinding[]) => b.filter(x => x.credential_id !== id);
      const builtinBindings: Partial<Record<BuiltinAgentKind, CredentialBinding[]>> = {};
      for (const k of Object.keys(s.builtinBindings) as BuiltinAgentKind[]) builtinBindings[k] = strip(s.builtinBindings[k] ?? []);
      return {
        credentials: s.credentials.filter(c => c.id !== id),
        customAgents: s.customAgents.map(a => ({ ...a, bindings: strip(a.bindings) })),
        builtinBindings,
      };
    });
  },

  setBindings: async (kind, bindings) => {
    await setAgentBindings(kind, bindings);
    if (isCustomAgent(kind)) {
      set(s => ({ customAgents: s.customAgents.map(a => customKind(a.id) === kind ? { ...a, bindings } : a) }));
    } else {
      set(s => ({ builtinBindings: { ...s.builtinBindings, [kind]: bindings } }));
    }
  },

  defaultBindingsFor: (kind) => {
    const s = get();
    if (isCustomAgent(kind)) return s.customAgents.find(a => customKind(a.id) === kind)?.bindings ?? [];
    return s.builtinBindings[kind] ?? [];
  },

  credentialsForEnv: (env) => get().credentials.filter(c => c.env_name === env),

  addAgentOpen: false,
  editingAgentId: null,
  openAddAgent: (editId) => set({ addAgentOpen: true, editingAgentId: editId ?? null }),
  closeAddAgent: () => set({ addAgentOpen: false, editingAgentId: null }),
  addKeyOpen: false,
  keyPrefill: null,
  openAddKey: (prefill) => set({ addKeyOpen: true, keyPrefill: prefill ?? null }),
  closeAddKey: () => set({ addKeyOpen: false, keyPrefill: null }),
}));
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/store/agentRegistryStore.test.ts 2>&1 | tail -10`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/credentials.ts src/store/agentRegistryStore.ts src/store/agentRegistryStore.test.ts
git commit -m "feat(agents): credential IPC wrappers and agent registry store"
```

---

### Task 13: Narrow every `Record<AgentKind, T>` to built-ins and thread bindings through `createTerminal`

**Files:**
- Modify: `src/store/appStore.ts:85-86, 539, 734-737, 1211-1230`, `src/store/appStore.test.ts` (types only)
- Modify: `src/lib/agentModels.ts:38, 62`
- Modify: `src/components/SessionCards.tsx:18-23` and its tint lookup
- Modify: `src/components/settings/categories/AboutPage.tsx:19-24`
- Modify: `src/store/terminalStore.ts:98-113, 247-262`

- [ ] **Step 1: Run the type-check to get the list**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected: errors at the files above (a `Record<AgentKind, X>` literal is missing the `custom:${string}` index).

- [ ] **Step 2: Apply the narrowing**

`src/store/appStore.ts`: import `BuiltinAgentKind` and change the two declarations to `defaultAgentArgs: Record<BuiltinAgentKind, string[]>;` and `setDefaultAgentArgs: (agent: BuiltinAgentKind, args: string[]) => void;`. The migration blocks at 1211-1230 already produce exactly the four keys - no change.

`src/lib/agentModels.ts`: `import type { AgentKind, BuiltinAgentKind } from './agents'; import { isCustomAgent } from './agents';`, change `AGENT_MODELS: Record<Exclude<BuiltinAgentKind, 'claude'>, readonly AgentModel[]>`, and:
```ts
export function modelsForAgent(kind: AgentKind): readonly AgentModel[] {
  if (kind === 'claude' || isCustomAgent(kind)) return [];
  return AGENT_MODELS[kind];
}
```

`src/components/SessionCards.tsx`: change `AGENT_TINT: Record<BuiltinAgentKind, string>` and wherever it is read (`AGENT_TINT[kind]`) use a helper defined below the map:
```ts
function agentTint(kind: AgentKind): string {
  return isCustomAgent(kind) ? 'bg-fill-hover text-text-secondary' : AGENT_TINT[kind];
}
```

`src/components/settings/categories/AboutPage.tsx`: `useState<Partial<Record<AgentKind, string | null>>>({})` and read with `agentVersions[spec.kind] ?? null`.

`src/store/terminalStore.ts`: add to `TerminalConfig`:
```ts
  /** Credentials this terminal was launched with, by id. Restore replays
   *  them; values never reach the frontend. */
  credential_bindings?: CredentialBinding[];
```
(import `type { CredentialBinding } from '../lib/credentials'`). Add a 12th parameter to `createTerminal` in both the interface and the implementation: `credentialBindings?: CredentialBinding[]`, and include `credential_bindings: credentialBindings ?? [],` in the `request` object.

- [ ] **Step 3: Type-check and run the full test suite**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no errors.
Run: `npx vitest run 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/store/appStore.ts src/lib/agentModels.ts src/components/SessionCards.tsx src/components/settings/categories/AboutPage.tsx src/store/terminalStore.ts
git commit -m "refactor(agents): narrow builtin-only maps and thread credential bindings to create_terminal"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
## Part D - Frontend UI

### Task 14: Monogram icons and the extended agent picker

**Files:**
- Modify: `src/components/BrandIcon.tsx:60-95`
- Modify: `src/components/AgentPicker.tsx` (whole file)
- Create: `src/components/AgentPicker.test.tsx`

- [ ] **Step 1: Write the failing test** `src/components/AgentPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPicker } from './AgentPicker';
import { setCustomAgentSpecs } from '../lib/agents';

beforeEach(() => setCustomAgentSpecs([]));

describe('AgentPicker', () => {
  it('renders built-ins, custom agents, and an Add agent tile', () => {
    setCustomAgentSpecs([{
      kind: 'custom:a1', displayName: 'OpenCode', binary: 'opencode', installUrl: '', installHint: '',
      defaultArgsHint: '', color: '#30C55E', monogram: 'OC', defaultArgs: [], resumeFlag: null, requiredEnv: [],
    }]);
    const onAdd = vi.fn();
    render(<AgentPicker value="claude" onChange={() => {}} onAddAgent={onAdd} />);
    expect(screen.getByText('OpenCode')).toBeTruthy();
    expect(screen.getByText('OC')).toBeTruthy();
    expect(screen.getByText('Local')).toBeTruthy();
    fireEvent.click(screen.getByText('Add agent'));
    expect(onAdd).toHaveBeenCalled();
  });

  it('uses a 3-column grid once there are more than four tiles', () => {
    setCustomAgentSpecs([{
      kind: 'custom:a1', displayName: 'X', binary: 'x', installUrl: '', installHint: '', defaultArgsHint: '',
      color: '#30C55E', monogram: 'X', defaultArgs: [], resumeFlag: null, requiredEnv: [],
    }]);
    const { container } = render(<AgentPicker value="claude" onChange={() => {}} onAddAgent={() => {}} />);
    expect(container.firstElementChild?.className).toContain('grid-cols-3');
  });
});
```

If `@testing-library/react` is not installed (`ls node_modules/@testing-library/react`), run `npm i -D @testing-library/react@16` first and commit `package.json` + `package-lock.json` with this task.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/AgentPicker.test.tsx 2>&1 | tail -10`
Expected: FAIL (`onAddAgent` unknown prop / no "Add agent" text).

- [ ] **Step 3: Monogram fallback in `BrandIcon.tsx`.** Replace the `BrandIcon` function:

```tsx
export interface BrandIconProps {
  kind: AgentKind;
  /** Icon edge in px. Defaults to 22 (matches the AgentPicker sizing). */
  size?: number;
}

export function BrandIcon({ kind, size = 22 }: BrandIconProps) {
  switch (kind) {
    case 'claude':
      return <span style={{ color: '#DA7756' }}><AnthropicMark size={size} /></span>;
    case 'codex':
      return <span style={{ color: '#10A37F' }}><OpenAIMark size={size} /></span>;
    case 'cursor':
      return <span className="text-text-primary"><CursorMark size={size} /></span>;
    case 'antigravity':
      return <span style={{ color: '#7C3AED' }}><AntigravityMark size={size} /></span>;
    default: {
      // Custom agents have no brand mark: a tinted rounded square with the
      // agent's two-letter monogram. Colour and monogram come from the spec.
      const spec = allAgentSpecs().find(s => s.kind === kind);
      return (
        <span
          aria-hidden
          className="inline-flex items-center justify-center rounded-[6px] font-bold leading-none"
          style={{
            width: size, height: size,
            background: spec?.color ?? '#5AC8FA',
            color: '#0F1320',
            fontSize: Math.max(8, Math.round(size * 0.5)),
          }}
        >
          {spec?.monogram ?? '?'}
        </span>
      );
    }
  }
}
```

and change the import to `import { allAgentSpecs, type AgentKind } from '../lib/agents';`.

- [ ] **Step 4: Rewrite `src/components/AgentPicker.tsx`**:

```tsx
import { Plus } from 'lucide-react';
import { allAgentSpecs, isCustomAgent, type AgentKind } from '../lib/agents';
import { BrandIcon } from './BrandIcon';

interface AgentPickerProps {
  value: AgentKind;
  onChange: (kind: AgentKind) => void;
  /** Opens the Add Agent dialog. When omitted the dashed tile is hidden. */
  onAddAgent?: () => void;
  className?: string;
}

/**
 * Agent picker: built-in brand tiles, then user-registered agents (monogram
 * tiles tagged LOCAL), then a dashed "Add agent" tile. Four or fewer tiles
 * use a 4-column grid; more switch to 3 columns so two rows stay even.
 */
export function AgentPicker({ value, onChange, onAddAgent, className = '' }: AgentPickerProps) {
  const specs = allAgentSpecs();
  const tileCount = specs.length + (onAddAgent ? 1 : 0);
  // Tailwind JIT needs literal class names, so map count -> class explicitly.
  const cols =
    tileCount <= 2 ? 'grid-cols-2'
    : tileCount === 3 ? 'grid-cols-3'
    : tileCount === 4 ? 'grid-cols-4'
    : 'grid-cols-3';
  return (
    <div className={`grid ${cols} gap-2 ${className}`}>
      {specs.map((spec) => {
        const selected = spec.kind === value;
        return (
          <button
            key={spec.kind}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(spec.kind)}
            className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl transition-[background-color,box-shadow,transform] duration-100 active:scale-[0.97] ${
              selected
                ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45 shadow-[0_2px_10px_var(--accent-glow-md)]'
                : 'bg-fill-hover ring-1 ring-seam hover:bg-fill-active hover:ring-seam-strong'
            }`}
          >
            <BrandIcon kind={spec.kind} />
            <p className="text-text-primary text-[12px] font-medium text-center leading-tight">{spec.displayName}</p>
            {isCustomAgent(spec.kind) && (
              <span className="absolute top-1.5 right-2 text-[9px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">Local</span>
            )}
          </button>
        );
      })}
      {onAddAgent && (
        <button
          type="button"
          onClick={onAddAgent}
          className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-dashed border-[rgba(255,255,255,0.14)] text-text-tertiary hover:text-text-secondary hover:bg-fill-hover transition-colors"
        >
          <Plus size={18} strokeWidth={2.25} />
          <p className="text-[12px] font-medium leading-tight">Add agent</p>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/components/AgentPicker.test.tsx 2>&1 | tail -10` then `npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: 2 passed; no type errors (existing `<AgentPicker>` callers compile because `onAddAgent` is optional).

- [ ] **Step 6: Commit**

```bash
git add src/components/BrandIcon.tsx src/components/AgentPicker.tsx src/components/AgentPicker.test.tsx
git commit -m "feat(ui): monogram icons and Add agent tile in the agent picker"
```

---

### Task 15: Add API Key modal

**Files:**
- Create: `src/components/AddApiKeyModal.tsx`
- Create: `src/components/AddApiKeyModal.test.tsx`
- Modify: `src/App.tsx` (mount next to `<NewTerminalModal />`)

- [ ] **Step 1: Write the failing test** `src/components/AddApiKeyModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { AddApiKeyModal } from './AddApiKeyModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ addKeyOpen: true, keyPrefill: null, credentials: [], customAgents: [], builtinBindings: {} });
});

describe('AddApiKeyModal', () => {
  it('picking a provider fills env var and endpoint var; saving sends key but never echoes it', async () => {
    invoke.mockImplementation(async (cmd: string, args: { meta?: { env_name: string }; key?: string }) => {
      if (cmd === 'save_credential') return { id: 'c1', label: 'Work', provider: 'openai', env_name: args.meta!.env_name, endpoint_env: 'OPENAI_BASE_URL', has_key: true, has_endpoint: false, masked_tail: 'abcd', created_at: '', last_used_at: null };
      if (cmd === 'set_agent_bindings') return undefined;
      return [];
    });
    render(<AddApiKeyModal />);
    fireEvent.click(screen.getByText('OpenAI'));
    expect((screen.getByLabelText('Environment variable') as HTMLInputElement).value).toBe('OPENAI_API_KEY');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-proj-secretabcd' } });
    fireEvent.click(screen.getByText('Save Key'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_credential', expect.objectContaining({ key: 'sk-proj-secretabcd' })));
    expect(useAgentRegistryStore.getState().credentials[0].masked_tail).toBe('abcd');
    expect(useAgentRegistryStore.getState().addKeyOpen).toBe(false);
  });

  it('blocks save when neither key nor endpoint is given', () => {
    render(<AddApiKeyModal />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Empty' } });
    fireEvent.click(screen.getByText('Save Key'));
    expect(screen.getByText('Enter an API key or an endpoint override.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('save_credential', expect.anything());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/AddApiKeyModal.test.tsx 2>&1 | tail -10`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Create `src/components/AddApiKeyModal.tsx`**:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, EyeOff, KeyRound, Play, ShieldCheck } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { allAgentSpecs, isCustomAgent, type AgentKind } from '../lib/agents';
import { ENV_NAME_RE, PROVIDERS, providerDefaults, type ProviderId } from '../lib/agentPresets';
import { testCredential, type CredentialMeta, type CredentialTestResult } from '../lib/credentials';
import { invoke } from '@tauri-apps/api/core';

const BUILTIN_REQUIRED_ENV: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  antigravity: [],
};

const inputCls = 'w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors';
const chip = (sel: boolean) =>
  `h-[30px] px-3 rounded-lg text-[12px] font-medium transition-colors ${sel ? 'bg-accent-primary text-white shadow-[0_2px_8px_var(--accent-glow-md)]' : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active hover:text-text-primary'}`;

/**
 * Create or edit a credential. The key value goes to Rust exactly once via
 * `save_credential`; the modal never receives it back (only a masked tail).
 * `editing` = an existing CredentialMeta; blank key field then means "keep".
 */
export function AddApiKeyModal({ editing }: { editing?: CredentialMeta | null } = {}) {
  const { closeAddKey, keyPrefill, saveCredential, credentials, setBindings, defaultBindingsFor } = useAgentRegistryStore();
  const [provider, setProvider] = useState<ProviderId>(editing?.provider ?? keyPrefill?.provider ?? 'anthropic');
  const [label, setLabel] = useState(editing?.label ?? keyPrefill?.label ?? '');
  const [envName, setEnvName] = useState(editing?.env_name ?? keyPrefill?.env_name ?? providerDefaults('anthropic').envName);
  const [key, setKey] = useState(keyPrefill?.key ?? '');
  const [showKey, setShowKey] = useState(false);
  const [endpointEnv, setEndpointEnv] = useState<string>(editing?.endpoint_env ?? providerDefaults('anthropic').endpointEnv ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [endpointOpen, setEndpointOpen] = useState(!!editing?.has_endpoint);
  const [useFor, setUseFor] = useState<Set<AgentKind>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<CredentialTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Provider pick fills the env defaults unless the user already typed one.
  const pickProvider = (p: ProviderId) => {
    setProvider(p);
    const d = providerDefaults(p);
    if (!editing) {
      setEnvName(d.envName);
      setEndpointEnv(d.endpointEnv ?? '');
    }
  };

  const candidateAgents = useMemo(
    () => allAgentSpecs().filter(s => (isCustomAgent(s.kind) ? s.requiredEnv ?? [] : BUILTIN_REQUIRED_ENV[s.kind] ?? []).includes(envName)),
    [envName],
  );
  useEffect(() => { setUseFor(new Set()); }, [envName]);

  const validate = (): string | null => {
    if (!label.trim() || label.trim().length > 40) return 'Label is required (1-40 characters).';
    if (credentials.some(c => c.label === label.trim() && c.id !== editing?.id)) return `A key labelled "${label.trim()}" already exists.`;
    if (!ENV_NAME_RE.test(envName)) return 'Environment variable must look like ANTHROPIC_API_KEY.';
    const hasKey = key.trim().length > 0 || !!editing?.has_key;
    const hasEndpoint = endpoint.trim().length > 0 || !!editing?.has_endpoint;
    if (hasEndpoint && !ENV_NAME_RE.test(endpointEnv)) return 'Endpoint variable must look like ANTHROPIC_BASE_URL.';
    if (!hasKey && !hasEndpoint) return 'Enter an API key or an endpoint override.';
    return null;
  };

  const handleSave = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const meta: CredentialMeta = {
        id: editing?.id ?? '',
        label: label.trim(),
        provider,
        env_name: envName,
        endpoint_env: endpointEnv || null,
        has_key: false, has_endpoint: false, masked_tail: null, created_at: '', last_used_at: null,
      };
      const saved = await saveCredential(meta, key.trim() || undefined, endpoint.trim() || undefined);
      for (const kind of useFor) {
        const existing = defaultBindingsFor(kind).filter(b => b.env !== envName);
        await setBindings(kind, [...existing, { env: envName, credential_id: saved.id }]);
      }
      if (keyPrefill?.fromProfileId) {
        // Moving a plaintext var out of a profile: drop it there now that the
        // value lives in the OS store.
        await invoke('strip_profile_env_var', { profileId: keyPrefill.fromProfileId, env: envName, credentialId: saved.id });
      }
      toast.success('Key saved', `"${saved.label}" is stored in your OS credential store.`);
      closeAddKey();
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('save_credential', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    // Test needs a saved row (values live only in the OS store), so save first.
    const v = validate();
    if (v) { setError(v); return; }
    setTesting(true);
    try {
      const meta: CredentialMeta = {
        id: editing?.id ?? '', label: label.trim(), provider, env_name: envName, endpoint_env: endpointEnv || null,
        has_key: false, has_endpoint: false, masked_tail: null, created_at: '', last_used_at: null,
      };
      const saved = await saveCredential(meta, key.trim() || undefined, endpoint.trim() || undefined);
      setKey('');
      setTest(await testCredential(saved.id));
    } catch (err) {
      setTest({ ok: false, detail: String(err), latency_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const toggleUseFor = (kind: AgentKind) => setUseFor(prev => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });

  return (
    <Modal onClose={closeAddKey} closeOn="doubleClick" scrimClassName="bg-black/50 z-[60]" panelClassName="w-full max-w-lg max-h-[90vh] flex flex-col" showHeader title={editing ? 'Edit API Key' : 'Add API Key'} icon={<KeyRound size={16} className="text-text-secondary" />}>
      <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
        <div>
          <label className="block text-text-tertiary text-[11px] font-semibold uppercase tracking-wider mb-2">Provider</label>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map(p => (
              <button key={p.id} type="button" onClick={() => pickProvider(p.id)} className={chip(provider === p.id)}>{p.label}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor="cred-label" className="block text-text-secondary text-[12px] mb-1.5">Label</label>
            <input id="cred-label" value={label} onChange={e => setLabel(e.target.value)} placeholder="Work Anthropic" className={inputCls} />
          </div>
          <div>
            <label htmlFor="cred-env" className="block text-text-secondary text-[12px] mb-1.5">Environment variable</label>
            <input id="cred-env" value={envName} onChange={e => setEnvName(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} />
          </div>
        </div>

        <div>
          <label htmlFor="cred-key" className="block text-text-secondary text-[12px] mb-1.5">API key</label>
          <div className="relative">
            <input
              id="cred-key" type={showKey ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)}
              autoComplete="off" spellCheck={false}
              placeholder={editing?.has_key ? `Stored (…${editing.masked_tail ?? ''}) - leave blank to keep` : 'Paste your key'}
              className={`${inputCls} font-mono pr-10`}
            />
            <button type="button" aria-label={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-tertiary hover:text-text-secondary">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-success/[0.08] ring-1 ring-success/20">
            <ShieldCheck size={14} className="text-success mt-0.5 flex-shrink-0" />
            <p className="text-text-secondary text-[11.5px] leading-relaxed">
              Saved to your OS credential store. Agentrium keeps only the label and variable name; the value is read at launch and handed to the agent process, never written to profiles, session logs or telemetry.
            </p>
          </div>
        </div>

        <div className="rounded-xl ring-1 ring-seam bg-elevation-2 overflow-hidden">
          <button type="button" onClick={() => setEndpointOpen(v => !v)} aria-expanded={endpointOpen} className="w-full flex items-center gap-2 h-[38px] px-3 text-left">
            <ChevronDown size={12} className={`text-text-tertiary transition-transform ${endpointOpen ? '' : '-rotate-90'}`} />
            <span className="flex-1 text-text-primary text-[12px] font-semibold">Endpoint override</span>
            <span className="text-text-tertiary text-[11px]">Local models, proxies, gateways</span>
          </button>
          {endpointOpen && (
            <div className="px-3 pb-3 space-y-2">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="cred-endpoint-env" className="block text-text-tertiary text-[11px] font-mono mb-1.5">Endpoint variable</label>
                  <input id="cred-endpoint-env" value={endpointEnv} onChange={e => setEndpointEnv(e.target.value.toUpperCase())} placeholder="ANTHROPIC_BASE_URL" className={`${inputCls} font-mono bg-elevation-0`} />
                </div>
                <div>
                  <label htmlFor="cred-endpoint" className="block text-text-tertiary text-[11px] font-mono mb-1.5">URL</label>
                  <input id="cred-endpoint" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder={editing?.has_endpoint ? 'Stored - leave blank to keep' : providerDefaults(provider).defaultEndpoint ?? 'http://localhost:11434'} className={`${inputCls} font-mono bg-elevation-0`} />
                </div>
              </div>
              <p className="text-text-tertiary text-[11px] leading-relaxed">Ollama 0.14+ speaks the Anthropic Messages API natively at http://localhost:11434. Empty keeps the provider's default endpoint.</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" icon={<Play size={12} />} onClick={handleTest} loading={testing}>Test connection</Button>
          {test && (
            <span className={`text-[12px] ${test.ok ? 'text-text-secondary' : 'text-error'}`}>
              {test.ok ? <>Authenticated · <span className="font-mono text-text-primary">{test.detail}</span> · {test.latency_ms} ms</> : test.detail}
            </span>
          )}
        </div>

        {candidateAgents.length > 0 && (
          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">Use as default for</label>
            <div className="flex flex-wrap gap-1.5">
              {candidateAgents.map(s => (
                <button key={s.kind} type="button" aria-pressed={useFor.has(s.kind)} onClick={() => toggleUseFor(s.kind)} className={`h-7 px-2.5 rounded-lg text-[12px] transition-colors ${useFor.has(s.kind) ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45 text-text-primary' : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:bg-fill-active'}`}>
                  {s.displayName}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20"><p className="text-error text-[12px]">{error}</p></div>
        )}
      </div>
      <div className="flex justify-end gap-2 p-3 border-t border-seam">
        <Button variant="ghost" onClick={closeAddKey}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} loading={saving}>Save Key</Button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Add the `strip_profile_env_var` command** used by the move-to-keychain flow. In `src-tauri/src/commands.rs` after `delete_profile`:

```rust
/// Move-to-keychain helper: drop `env` from the profile's plaintext env vars
/// and pin the new credential instead. Idempotent.
#[command]
pub async fn strip_profile_env_var(
    state: State<'_, AppState>,
    profile_id: String,
    env: String,
    credential_id: String,
) -> Result<(), String> {
    wrap_cmd("strip_profile_env_var", async move {
        db_op(&state.db, move |db| {
            let profiles = db.get_profiles()?;
            let Some(mut p) = profiles.into_iter().find(|p| p.id == profile_id) else {
                return Err(error_reporter::user_err("Profile not found"));
            };
            p.env_vars.remove(&env);
            p.credential_bindings.retain(|b| b.env != env);
            p.credential_bindings.push(crate::config::CredentialBinding { env, credential_id });
            db.save_profile(&p)
        })
        .await
    })
    .await
}
```

Register `commands::strip_profile_env_var,` in `main.rs` after `commands::delete_profile,`.

- [ ] **Step 5: Mount the modal.** In `src/App.tsx`, next to where `<NewTerminalModal />` is conditionally rendered (search `newTerminalModalOpen &&`), add:

```tsx
      {addKeyOpen && <AddApiKeyModal />}
```

with `const addKeyOpen = useAgentRegistryStore((s) => s.addKeyOpen);` near the other store reads and the imports `import { AddApiKeyModal } from './components/AddApiKeyModal'; import { useAgentRegistryStore } from './store/agentRegistryStore';`. Also add, in the mount effect that loads initial data (the first `useEffect(() => { ... }, [])` in `App.tsx`):

```tsx
    // Custom agents + credentials feed the agent picker, so load them once at
    // startup. Failure here degrades to built-ins only; the settings page
    // surfaces the error when the user opens it.
    useAgentRegistryStore.getState().refresh().catch(() => {});
```

- [ ] **Step 6: Run tests, type-check, cargo check**

Run: `npx vitest run src/components/AddApiKeyModal.test.tsx 2>&1 | tail -10`; `npx tsc --noEmit -p tsconfig.json 2>&1 | head`; `cd src-tauri && cargo check --quiet 2>&1 | tail -5`
Expected: 2 passed; clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/AddApiKeyModal.tsx src/components/AddApiKeyModal.test.tsx src/App.tsx src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(ui): Add API Key modal with endpoint override and test connection"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
### Task 16: Add Agent modal

**Files:**
- Create: `src/components/AddAgentModal.tsx`
- Create: `src/components/AddAgentModal.test.tsx`
- Modify: `src/App.tsx:898` (mount)

- [ ] **Step 1: Write the failing test** `src/components/AddAgentModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { AddAgentModal } from './AddAgentModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';

beforeEach(() => {
  invoke.mockReset();
  useAgentRegistryStore.setState({ addAgentOpen: true, editingAgentId: null, customAgents: [], credentials: [], builtinBindings: {}, probes: {} });
});

describe('AddAgentModal', () => {
  it('a preset fills the form, the probe reports the binary, and save posts a CustomAgent', async () => {
    invoke.mockImplementation(async (cmd: string, args: { agent?: { name: string; binary: string; color: string } }) => {
      if (cmd === 'probe_binary') return { found: true, resolved_path: 'C:\\npm\\opencode.cmd', version: '1.4.2' };
      if (cmd === 'save_custom_agent') return { id: 'a1', ...args.agent, default_args: [], resume_flag: '--session {id}', required_env: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], bindings: [], install_url: null, install_hint: null, created_at: '1', updated_at: '1' };
      return [];
    });
    render(<AddAgentModal />);
    fireEvent.click(screen.getByText('OpenCode'));
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('OpenCode');
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('opencode');
    await waitFor(() => expect(screen.getByText(/Found/)).toBeTruthy());
    expect(screen.getByText(/v1\.4\.2/)).toBeTruthy();
    fireEvent.click(screen.getByText('Add Agent'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_custom_agent', expect.objectContaining({ agent: expect.objectContaining({ binary: 'opencode', color: '#30C55E' }) })));
    expect(useAgentRegistryStore.getState().customAgents).toHaveLength(1);
    expect(useAgentRegistryStore.getState().addAgentOpen).toBe(false);
  });

  it('rejects an empty command before calling the backend', () => {
    render(<AddAgentModal />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Thing' } });
    fireEvent.click(screen.getByText('Add Agent'));
    expect(screen.getByText('Command is required.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith('save_custom_agent', expect.anything());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/AddAgentModal.test.tsx 2>&1 | tail -10`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Create `src/components/AddAgentModal.tsx`**:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Code2, KeyRound, Plus, SquarePlus, Terminal, Trash2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { monogramFor } from '../lib/agents';
import { AGENT_COLORS, AGENT_PRESETS, ENV_NAME_RE, type AgentColor, type AgentPreset } from '../lib/agentPresets';
import type { BinaryProbe, CredentialBinding, CustomAgent } from '../lib/credentials';
import { AddApiKeyModal } from './AddApiKeyModal';

const inputCls = 'w-full bg-elevation-2 ring-1 ring-seam rounded-lg h-9 px-3 text-text-primary text-[13px] focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors';

type Tab = 'cli' | 'key';

/**
 * Register or edit a local agent CLI. Presets pre-fill every field; "Custom
 * binary" clears them. The Command field is probed live (debounced 400 ms)
 * through `probe_binary`; a missing binary warns but does not block saving.
 * The "Hosted API (key only)" tab swaps the body for the Add API Key form.
 */
export function AddAgentModal() {
  const { closeAddAgent, editingAgentId, customAgents, saveAgent, deleteAgent, probe, credentialsForEnv, openAddKey, addKeyOpen } = useAgentRegistryStore();
  const editing = useMemo(() => customAgents.find(a => a.id === editingAgentId) ?? null, [customAgents, editingAgentId]);

  const [tab, setTab] = useState<Tab>('cli');
  const [presetId, setPresetId] = useState<string | null>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [binary, setBinary] = useState(editing?.binary ?? '');
  const [argsText, setArgsText] = useState(editing?.default_args.join('\n') ?? '');
  const [resumeFlag, setResumeFlag] = useState(editing?.resume_flag ?? '');
  const [color, setColor] = useState<AgentColor>((editing?.color as AgentColor) ?? AGENT_COLORS[0]);
  const [requiredEnv, setRequiredEnv] = useState<string[]>(editing?.required_env ?? []);
  const [bindings, setBindings] = useState<CredentialBinding[]>(editing?.bindings ?? []);
  const [newEnv, setNewEnv] = useState('');
  const [installUrl, setInstallUrl] = useState<string | null>(editing?.install_url ?? null);
  const [installHint, setInstallHint] = useState<string | null>(editing?.install_hint ?? null);
  const [probeResult, setProbeResult] = useState<BinaryProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyPreset = (p: AgentPreset) => {
    setPresetId(p.id);
    setName(p.name);
    setBinary(p.binary);
    setArgsText(p.defaultArgs.join('\n'));
    setResumeFlag(p.resumeFlag ?? '');
    setColor(p.color);
    setRequiredEnv([...p.requiredEnv]);
    setBindings([]);
    setInstallUrl(p.installUrl);
    setInstallHint(p.installHint);
  };

  // Debounced live probe. Cleared when the command empties.
  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    const b = binary.trim();
    if (!b) { setProbeResult(null); return; }
    probeTimer.current = setTimeout(() => {
      // Best-effort: a probe failure (bad chars, IPC error) just shows no status.
      probe(b).then(setProbeResult).catch(() => setProbeResult(null));
    }, 400);
    return () => { if (probeTimer.current) clearTimeout(probeTimer.current); };
  }, [binary, probe]);

  const validate = (): string | null => {
    if (!name.trim() || name.trim().length > 40) return 'Display name is required (1-40 characters).';
    if (!binary.trim()) return 'Command is required.';
    const rf = resumeFlag.trim();
    if (rf && (rf.match(/\{id\}/g) ?? []).length > 1) return 'Resume flag may contain {id} at most once.';
    for (const e of requiredEnv) if (!ENV_NAME_RE.test(e)) return `"${e}" is not a valid environment variable name.`;
    return null;
  };

  const handleSave = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSaving(true);
    try {
      const agent: CustomAgent = {
        id: editing?.id ?? '',
        name: name.trim(),
        binary: binary.trim(),
        default_args: argsText.split('\n').map(s => s.trim()).filter(Boolean),
        resume_flag: resumeFlag.trim() || null,
        color,
        required_env: requiredEnv,
        bindings: bindings.filter(b => requiredEnv.includes(b.env)),
        install_url: installUrl,
        install_hint: installHint,
        created_at: editing?.created_at ?? '',
        updated_at: '',
      };
      const saved = await saveAgent(agent);
      toast.success(editing ? 'Agent updated' : 'Agent added', `"${saved.name}" is ready in the agent picker.`);
      closeAddAgent();
    } catch (err) {
      setError(String(err));
      reportInvokeFailure('save_custom_agent', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    try {
      await deleteAgent(editing.id);
      toast.success('Agent removed', `"${editing.name}" no longer appears in the picker.`);
      closeAddAgent();
    } catch (err) {
      toast.error('Delete failed', String(err));
      reportInvokeFailure('delete_custom_agent', err);
    }
  };

  const setBindingFor = (env: string, credentialId: string | '') => {
    setBindings(prev => {
      const rest = prev.filter(b => b.env !== env);
      return credentialId ? [...rest, { env, credential_id: credentialId }] : rest;
    });
  };

  const addEnv = () => {
    const e = newEnv.trim().toUpperCase();
    if (!e) return;
    if (!ENV_NAME_RE.test(e)) { setError(`"${e}" is not a valid environment variable name.`); return; }
    if (!requiredEnv.includes(e)) setRequiredEnv(prev => [...prev, e]);
    setNewEnv('');
    setError(null);
  };

  const commandPreview = [binary.trim(), ...argsText.split('\n').map(s => s.trim()).filter(Boolean)].filter(Boolean).join(' ');

  return (
    <>
    <Modal onClose={closeAddAgent} closeOn="doubleClick" scrimClassName="bg-black/50 z-[55]" panelClassName="w-full max-w-lg max-h-[90vh] flex flex-col" showHeader title={editing ? 'Edit Agent' : 'Add Agent'} icon={<SquarePlus size={16} className="text-text-secondary" />}>
      <div className="p-5 space-y-5 overflow-y-auto flex-1 min-h-0">
        {!editing && (
          <div className="flex gap-1 p-[3px] rounded-[10px] bg-elevation-2 ring-1 ring-seam">
            {([['cli', 'Local CLI', Terminal], ['key', 'Hosted API (key only)', KeyRound]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`flex-1 h-[30px] flex items-center justify-center gap-1.5 rounded-lg text-[12px] transition-colors ${tab === id ? 'bg-elevation-4 text-text-primary font-semibold shadow-elevation-2' : 'text-text-secondary hover:text-text-primary'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
        )}

        {tab === 'key' ? (
          <p className="text-text-secondary text-[12.5px]">Store a provider key without adding a CLI. <button type="button" className="text-accent-primary hover:underline" onClick={() => openAddKey()}>Open Add API Key</button></p>
        ) : (
        <>
          {!editing && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-text-tertiary text-[11px] font-semibold uppercase tracking-wider">Start from</label>
                <span className="text-text-tertiary text-[11px]">Presets fill in binary, args and key name</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {AGENT_PRESETS.map(p => {
                  const sel = presetId === p.id;
                  const isCustom = p.id === 'custom';
                  return (
                    <button key={p.id} type="button" onClick={() => applyPreset(p)} aria-pressed={sel}
                      className={`flex flex-col items-center gap-1.5 p-3 rounded-xl transition-colors ${isCustom ? 'border border-dashed border-[rgba(255,255,255,0.14)] text-text-tertiary hover:bg-fill-hover' : sel ? 'bg-accent-primary/12 ring-1 ring-accent-primary/45' : 'bg-fill-hover ring-1 ring-seam hover:bg-fill-active'}`}>
                      {isCustom ? <Code2 size={18} /> : (
                        <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[6px] text-[12px] font-bold" style={{ background: p.color, color: '#0F1320' }}>{monogramFor(p.name)}</span>
                      )}
                      <span className="text-[12px] font-medium text-text-primary">{isCustom ? 'Custom binary' : p.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="agent-name" className="block text-text-secondary text-[12px] mb-1.5">Display name</label>
              <input id="agent-name" value={name} onChange={e => setName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="agent-binary" className="block text-text-secondary text-[12px] mb-1.5">Command</label>
              <input id="agent-binary" value={binary} onChange={e => setBinary(e.target.value)} placeholder="opencode" className={`${inputCls} font-mono`} spellCheck={false} />
            </div>
          </div>
          {probeResult && (
            <p className={`-mt-2 flex items-center gap-2 text-[11px] font-mono ${probeResult.found ? 'text-text-tertiary' : 'text-warning'}`}>
              {probeResult.found ? <Check size={13} className="text-success" /> : null}
              {probeResult.found
                ? `Found ${probeResult.resolved_path ?? binary.trim()}${probeResult.version ? ` · v${probeResult.version.replace(/^v/, '')}` : ''}`
                : 'Not found on PATH - you can still save and install it later.'}
            </p>
          )}

          <div>
            <label htmlFor="agent-args" className="block text-text-secondary text-[12px] mb-1.5">Default arguments <span className="text-text-tertiary">(one per line)</span></label>
            <textarea id="agent-args" value={argsText} onChange={e => setArgsText(e.target.value)} className={`${inputCls} h-16 py-2 font-mono text-[12px] resize-none`} spellCheck={false} />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="agent-resume" className="block text-text-secondary text-[12px] mb-1.5">Resume flag</label>
              <input id="agent-resume" value={resumeFlag} onChange={e => setResumeFlag(e.target.value)} placeholder="--session {id}" className={`${inputCls} font-mono`} spellCheck={false} />
              <p className="text-text-tertiary text-[11px] mt-1 leading-relaxed">Use {'{id}'} to resume by id, or a plain flag like --continue for "continue most recent". Leave empty if the CLI cannot resume.</p>
            </div>
            <div>
              <label className="block text-text-secondary text-[12px] mb-1.5">Tile colour</label>
              <div className="flex items-center gap-2 h-9">
                {AGENT_COLORS.map(c => (
                  <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} className="w-[22px] h-[22px] rounded-[6px] transition-shadow" style={{ background: c, boxShadow: color === c ? '0 0 0 2px var(--elevation-4), 0 0 0 3.5px rgb(var(--text-primary))' : undefined }} />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-text-secondary text-[12px] mb-1.5">Credentials this agent needs</label>
            <div className="rounded-xl ring-1 ring-seam bg-elevation-2 divide-y divide-[var(--seam)]">
              {requiredEnv.map(env => {
                const options = credentialsForEnv(env);
                const current = bindings.find(b => b.env === env)?.credential_id ?? '';
                return (
                  <div key={env} className="flex items-center gap-2.5 h-[42px] px-3">
                    <span className="flex-1 font-mono text-[12px] text-text-primary">{env}</span>
                    <select aria-label={`Credential for ${env}`} value={current} onChange={e => setBindingFor(env, e.target.value)} className="bg-elevation-0 text-text-primary text-[12px] px-2 h-7 rounded ring-1 ring-border-light">
                      <option value="">None</option>
                      {options.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <button type="button" aria-label={`Add key for ${env}`} onClick={() => openAddKey({ env_name: env })} className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-fill-hover"><KeyRound size={13} /></button>
                    <button type="button" aria-label={`Remove ${env}`} onClick={() => { setRequiredEnv(prev => prev.filter(x => x !== env)); setBindingFor(env, ''); }} className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10"><Trash2 size={13} /></button>
                  </div>
                );
              })}
              <div className="flex items-center gap-2 h-9 px-3">
                <input aria-label="New variable name" value={newEnv} onChange={e => setNewEnv(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnv(); } }} placeholder="ANOTHER_API_KEY" className="flex-1 bg-transparent font-mono text-[12px] text-text-primary focus:outline-none" spellCheck={false} />
                <button type="button" onClick={addEnv} className="flex items-center gap-1 text-accent-primary text-[12px]"><Plus size={12} strokeWidth={2.5} /> Add variable</button>
              </div>
            </div>
            <p className="text-text-tertiary text-[11px] mt-1.5 leading-relaxed">Values live in the OS credential store and are injected only into this agent's process at launch. Profiles and logs never see them.</p>
          </div>
        </>
        )}

        {error && (
          <div className="p-3 rounded-md bg-error/5 ring-1 ring-error/20"><p className="text-error text-[12px]">{error}</p></div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 p-3 border-t border-seam">
        <span className="font-mono text-[11px] text-text-tertiary truncate">{commandPreview}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {editing && (confirmDelete
            ? <Button variant="ghost" onClick={handleDelete} className="text-error">Confirm delete</Button>
            : <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete agent</Button>)}
          <Button variant="ghost" onClick={closeAddAgent}>Cancel</Button>
          {tab === 'cli' && <Button variant="primary" onClick={handleSave} loading={saving}>{editing ? 'Save' : 'Add Agent'}</Button>}
        </div>
      </div>
    </Modal>
    {addKeyOpen && <AddApiKeyModal />}
    </>
  );
}
```

- [ ] **Step 4: Mount in `src/App.tsx`** below `{newTerminalModalOpen && <NewTerminalModal />}` (line 898):

```tsx
            {addAgentOpen && <AddAgentModal />}
            {!addAgentOpen && addKeyOpen && <AddApiKeyModal />}
```

Replace the Task 15 line `{addKeyOpen && <AddApiKeyModal />}` with the two lines above (the Add Agent modal renders the key modal itself when both are open, so it can sit above it). Add `const addAgentOpen = useAgentRegistryStore((s) => s.addAgentOpen);` and `import { AddAgentModal } from './components/AddAgentModal';`.

- [ ] **Step 5: Run tests and type-check**

Run: `npx vitest run src/components/AddAgentModal.test.tsx 2>&1 | tail -10`; `npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: 2 passed; clean. If `Button` does not accept `size="sm"`, drop the prop in `AddApiKeyModal.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/AddAgentModal.tsx src/components/AddAgentModal.test.tsx src/App.tsx
git commit -m "feat(ui): Add Agent modal with presets, live probe, and credential rows"
```

---

### Task 17: New Session modal - Authentication row, bindings, custom-agent defaults

**Files:**
- Modify: `src/components/NewTerminalModal.tsx:12-21` (imports), `:62-88` (state), `:156-190` (args sync), `:385-427` (create), `:473-478` (picker), `:772-778` (model section)

- [ ] **Step 1: Write the failing behaviour test** `src/components/NewTerminalModal.auth.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => 'C:\\w' }));

import { NewTerminalModal } from './NewTerminalModal';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import { useAppStore } from '../store/appStore';

const cred = { id: 'c1', label: 'Work Anthropic', provider: 'anthropic', env_name: 'ANTHROPIC_API_KEY', endpoint_env: null, has_key: true, has_endpoint: false, masked_tail: 'Zk3q', created_at: '', last_used_at: null } as const;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_profiles') return [];
    if (cmd === 'create_terminal') return { id: 't1', label: 'Terminal 1', nickname: null, profile_id: null, working_directory: 'C:\\w', claude_args: [], env_vars: {}, created_at: '', status: 'Running', color_tag: null, agent: 'claude', credential_bindings: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] };
    return [];
  });
  useAppStore.setState({ newTerminalModalOpen: true, newTerminalPreselectedAgent: null });
  useAgentRegistryStore.setState({ credentials: [cred], customAgents: [], builtinBindings: { claude: [{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }] }, loaded: true });
});

describe('NewTerminalModal authentication', () => {
  it('API key mode sends credential_bindings and never a key value', async () => {
    render(<NewTerminalModal />);
    fireEvent.click(await screen.findByText('API key'));
    expect(screen.getByText('Work Anthropic')).toBeTruthy();
    fireEvent.click(screen.getByText('Start Session'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_terminal', expect.anything()));
    const call = invoke.mock.calls.find(c => c[0] === 'create_terminal')!;
    const req = (call[1] as { request: { credential_bindings: unknown; env_vars: Record<string, string> } }).request;
    expect(req.credential_bindings).toEqual([{ env: 'ANTHROPIC_API_KEY', credential_id: 'c1' }]);
    expect(JSON.stringify(req)).not.toContain('Zk3q');
    expect(Object.keys(req.env_vars)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('CLI login mode (default) sends no bindings', async () => {
    render(<NewTerminalModal />);
    await screen.findByText('CLI login');
    fireEvent.click(screen.getByText('Start Session'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('create_terminal', expect.anything()));
    const call = invoke.mock.calls.find(c => c[0] === 'create_terminal')!;
    expect((call[1] as { request: { credential_bindings: unknown[] } }).request.credential_bindings).toEqual([]);
  });
});
```

If the modal's mount effects call other commands not stubbed above, extend the `mockImplementation` switch to return `[]`/`''` for them (read the failing test output for the command name); the modal already swallows background probe failures.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/NewTerminalModal.auth.test.tsx 2>&1 | tail -15`
Expected: FAIL - no "API key" text.

- [ ] **Step 3: Wire the modal.**

Imports (top of `NewTerminalModal.tsx`): add
```ts
import { defaultArgsFor, isCustomAgent } from '../lib/agents';
import { useAgentRegistryStore } from '../store/agentRegistryStore';
import type { CredentialBinding } from '../lib/credentials';
import { KeyRound } from 'lucide-react';
```
(merge `filterArgsForAgent, specFor, type AgentKind` into the existing `../lib/agents` import.)

State (after `const [selectedAgent, ...]`):
```ts
  const { credentials, defaultBindingsFor, openAddAgent, openAddKey } = useAgentRegistryStore();
  const [authMode, setAuthMode] = useState<'cli' | 'key'>('cli');
  // env -> credential id chosen for this session. Seeded from the agent's
  // defaults (and the selected profile's pins) whenever agent/profile change.
  const [sessionBindings, setSessionBindings] = useState<CredentialBinding[]>([]);
  const requiredEnvFor = (kind: AgentKind): string[] =>
    isCustomAgent(kind)
      ? (specFor(kind).requiredEnv ?? [])
      : ({ claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY'], cursor: ['CURSOR_API_KEY'], antigravity: [] } as Record<string, string[]>)[kind] ?? [];
```

Replace `useState<string[]>(defaultAgentArgs.claude)` with `useState<string[]>(defaultArgsFor(preselectedAgent ?? 'claude', defaultAgentArgs))` (move the `preselectedAgent` line above it), and in the args-sync effect (lines ~165-183) replace every `defaultAgentArgs[selectedAgent]` with `defaultArgsFor(selectedAgent, defaultAgentArgs)`.

Add a seeding effect after the args-sync effect:
```ts
  useEffect(() => {
    const profile = profiles.find(p => p.id === selectedProfileId);
    const agentDefaults = defaultBindingsFor(selectedAgent);
    const merged = new Map<string, CredentialBinding>();
    for (const b of agentDefaults) merged.set(b.env, b);
    for (const b of profile?.credential_bindings ?? []) merged.set(b.env, b); // profile pins win
    setSessionBindings([...merged.values()]);
    setAuthMode(merged.size > 0 ? 'key' : 'cli');
  }, [selectedAgent, selectedProfileId, profiles, defaultBindingsFor]);
```
Add `credential_bindings?: CredentialBinding[];` to the local `ConfigProfile` interface (line ~43-49).

In `handleCreateTerminal`, before `newTerminalId = await createTerminal(`, compute:
```ts
        // Only env vars the agent actually needs, and only in API-key mode.
        const needed = new Set(requiredEnvFor(selectedAgent));
        const bindingsToSend = authMode === 'key'
          ? sessionBindings.filter(b => needed.size === 0 || needed.has(b.env))
          : [];
        // Never let a plaintext profile var shadow a keychain binding.
        const envForSpawn = { ...envVars };
        for (const b of bindingsToSend) delete envForSpawn[b.env];
```
and pass `envForSpawn` instead of `envVars`, and `bindingsToSend` as the 12th argument after `selectedAgent`.

Also make the model section custom-aware: change `{selectedAgent === 'claude' ? (` block's wrapper condition at line ~773 from `{!plainShell && (` to `{!plainShell && !isCustomAgent(selectedAgent) && (` so the model chips are hidden for custom agents.

Picker (line ~477): `<AgentPicker value={selectedAgent} onChange={setSelectedAgent} onAddAgent={() => openAddAgent()} />`.

Authentication section - insert directly after the Agent block (`</div>` closing the `{!plainShell && (` Agent wrapper):
```tsx
          {!plainShell && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-text-tertiary text-[11px] font-semibold uppercase tracking-wider">Authentication</label>
                <button type="button" onClick={() => openAddKey({ env_name: requiredEnvFor(selectedAgent)[0] })} className="text-accent-primary text-[11px] hover:underline">Manage keys</button>
              </div>
              <div className="flex gap-1 mb-2">
                {([['cli', 'CLI login'], ['key', 'API key']] as const).map(([mode, label]) => (
                  <button key={mode} type="button" aria-pressed={authMode === mode} onClick={() => setAuthMode(mode)}
                    className={`px-3 h-7 text-[12px] font-medium rounded-lg transition-colors ${authMode === mode ? 'bg-accent-primary text-white shadow-[0_2px_8px_var(--accent-glow-md)]' : 'bg-fill-hover ring-1 ring-seam text-text-secondary hover:text-text-primary hover:bg-fill-active'}`}>
                    {label}
                  </button>
                ))}
              </div>
              {authMode === 'key' && (
                <div className="rounded-xl ring-1 ring-seam bg-elevation-2 divide-y divide-[var(--seam)]">
                  {(requiredEnvFor(selectedAgent).length ? requiredEnvFor(selectedAgent) : [...new Set(credentials.map(c => c.env_name))]).map(env => {
                    const options = credentials.filter(c => c.env_name === env);
                    const current = sessionBindings.find(b => b.env === env)?.credential_id ?? '';
                    const chosen = options.find(c => c.id === current);
                    return (
                      <div key={env} className="flex items-center gap-2.5 h-[42px] px-3">
                        <KeyRound size={15} className="text-accent-primary flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-text-primary text-[12.5px] font-medium leading-tight truncate">{chosen?.label ?? 'No key selected'}</p>
                          <p className="text-text-tertiary text-[11px] font-mono leading-tight truncate">{env}{chosen?.has_endpoint ? ' · endpoint override' : ''}</p>
                        </div>
                        <select aria-label={`Key for ${env}`} value={current}
                          onChange={e => setSessionBindings(prev => [...prev.filter(b => b.env !== env), ...(e.target.value ? [{ env, credential_id: e.target.value }] : [])])}
                          className="bg-elevation-0 text-text-primary text-[12px] px-2 h-7 rounded ring-1 ring-border-light">
                          <option value="">None</option>
                          {options.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
```

Command preview (the line near 904 rendering `Command: <code>...`): append
```tsx
{authMode === 'key' && sessionBindings.length > 0 && <span className="text-success"> · key injected at launch</span>}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/components/NewTerminalModal.auth.test.tsx 2>&1 | tail -15`; `npx tsc --noEmit -p tsconfig.json 2>&1 | head`; `npx vitest run 2>&1 | tail -8`
Expected: 2 passed; clean; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/components/NewTerminalModal.tsx src/components/NewTerminalModal.auth.test.tsx
git commit -m "feat(ui): Authentication row in New Session, bindings sent on create"
```

---
[INFO] Recording command outcome: cat

[OK] Command outcome recorded
### Task 18: Settings - Agents & Keys page

**Design note:** the spec's section 4.4 asks for an "Agents" group holding Agents & Keys plus the Claude pages while keeping the `claude.defaults` / `claude.updates` ids. The cleanest way to satisfy both is to keep the existing group id `claude`, relabel it "Agents", and add `agents-keys` as its first page. No page id changes, `index.test.ts` keeps passing.

**Files:**
- Modify: `src/components/settings/index.ts:43-46`
- Modify: `src/components/settings/index.test.ts` (add one test)
- Modify: `src/components/settings/SettingsWindow.tsx:22` (map entry)
- Create: `src/components/settings/categories/AgentsKeysPage.tsx`

- [ ] **Step 1: Add the failing test** to `index.test.ts`:

```ts
  it('the claude group is labelled Agents and leads with the Agents & Keys page', () => {
    const g = CATEGORY_GROUPS.find((x) => x.id === 'claude')!;
    expect(g.label).toBe('Agents');
    expect(g.pages[0]).toEqual({ id: 'agents-keys', label: 'Agents & Keys' });
    expect(g.pages.map((p) => p.id)).toEqual(['agents-keys', 'defaults', 'updates']);
  });
```

Run: `npx vitest run src/components/settings/index.test.ts 2>&1 | tail -8` - expected FAIL.

- [ ] **Step 2: Update the group** in `index.ts`:

```ts
  { id: 'claude', label: 'Agents', pages: [
    { id: 'agents-keys', label: 'Agents & Keys' },
    { id: 'defaults',    label: 'Claude Code Defaults' },
    { id: 'updates',     label: 'Claude Code Updates' },
  ]},
```

and in `SettingsWindow.tsx` add before `'claude.defaults'`:
```ts
  'claude.agents-keys':                   lazy(() => import('./categories/AgentsKeysPage')),
```

- [ ] **Step 3: Create `src/components/settings/categories/AgentsKeysPage.tsx`**:

```tsx
import { useEffect, useState } from 'react';
import { KeyRound, Plus, Server } from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { useAgentRegistryStore } from '../../../store/agentRegistryStore';
import { PageHeader } from '../SettingRow';
import { registerSetting } from '../index';
import { BrandIcon } from '../../BrandIcon';
import { allAgentSpecs, isCustomAgent, customIdOf, type AgentKind } from '../../../lib/agents';
import type { BinaryProbe } from '../../../lib/credentials';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { invoke } from '@tauri-apps/api/core';

const cat = { group: 'claude', page: 'agents-keys' } as const;
registerSetting({ category: cat, id: 'agents', label: 'Agents', keywords: ['agent', 'cli', 'opencode', 'gemini', 'aider', 'goose', 'custom', 'binary'] });
registerSetting({ category: cat, id: 'api-keys', label: 'API keys', keywords: ['key', 'credential', 'keychain', 'token', 'anthropic', 'openai', 'ollama', 'endpoint'] });

const BUILTIN_REQUIRED_ENV: Record<string, string[]> = { claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY'], cursor: ['CURSOR_API_KEY'], antigravity: [] };

function relative(iso: string | null): string {
  if (!iso) return 'Never used';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `Used ${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Used ${h} h ago`;
  return `Used ${Math.round(h / 24)} d ago`;
}

type Status = { dot: string; word: string; action: { label: string; run: () => void } | null };

export default function AgentsKeysPage() {
  const { customAgents, credentials, builtinBindings, refresh, deleteCredential, openAddAgent, openAddKey } = useAgentRegistryStore();
  const openSettingsPage = useAppStore((s) => s.openSettings);
  const [probes, setProbes] = useState<Record<string, BinaryProbe | null>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    refresh().catch((e) => setLoadError(String(e)));
  }, [refresh]);

  // One probe per agent, in parallel, cached for the page lifetime.
  const specs = allAgentSpecs();
  useEffect(() => {
    for (const s of specs) {
      if (s.binary in probes) continue;
      setProbes((p) => ({ ...p, [s.binary]: null }));
      invoke<BinaryProbe>('probe_binary', { binary: s.binary })
        .then((r) => setProbes((p) => ({ ...p, [s.binary]: r })))
        .catch(() => setProbes((p) => ({ ...p, [s.binary]: { found: false, resolved_path: null, version: null } })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specs.map((s) => s.binary).join('|')]);

  const bindingsFor = (kind: AgentKind) =>
    isCustomAgent(kind) ? customAgents.find((a) => customIdOf(kind) === a.id)?.bindings ?? [] : builtinBindings[kind] ?? [];

  const statusFor = (kind: AgentKind, binary: string): Status => {
    const probe = probes[binary];
    const required = isCustomAgent(kind) ? allAgentSpecs().find((s) => s.kind === kind)?.requiredEnv ?? [] : BUILTIN_REQUIRED_ENV[kind] ?? [];
    if (probe === undefined || probe === null) return { dot: 'bg-text-tertiary', word: 'Checking', action: null };
    if (!probe.found) {
      const spec = allAgentSpecs().find((s) => s.kind === kind);
      return { dot: 'bg-error', word: 'Missing', action: spec?.installUrl ? { label: 'Install', run: () => { invoke('open_external_url', { url: spec.installUrl }).catch(() => {}); } } : null };
    }
    const bound = new Set(bindingsFor(kind).map((b) => b.env));
    const unbound = required.filter((e) => !bound.has(e));
    // Cursor is the only built-in that cannot run on CLI login alone.
    if (unbound.length && (kind === 'cursor' || isCustomAgent(kind))) {
      return { dot: 'bg-warning', word: 'No key', action: { label: 'Add key', run: () => openAddKey({ env_name: unbound[0] }) } };
    }
    return { dot: 'bg-success', word: 'Ready', action: null };
  };

  const handleDeleteKey = async (id: string, label: string) => {
    setConfirmDeleteId(null);
    try {
      await deleteCredential(id);
      toast.success('Key removed', `"${label}" was deleted from your OS credential store.`);
    } catch (err) {
      toast.error('Remove failed', String(err));
      reportInvokeFailure('delete_credential', err);
    }
  };

  const usersOf = (credId: string): string[] =>
    specs.filter((s) => bindingsFor(s.kind).some((b) => b.credential_id === credId)).map((s) => s.displayName);

  return (
    <div>
      <PageHeader title="Agents & Keys" description="Which coding agents Agentrium can launch, and the credentials it hands them." />

      {loadError && (
        <div className="mb-4 p-3 rounded-md bg-error/5 ring-1 ring-error/20 text-error text-[12px]">Credential store unavailable: {loadError}</div>
      )}

      <section className="mb-6">
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-text-primary text-[13px] font-semibold">Agents</h3>
          <button onClick={() => openAddAgent()} className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-accent-primary text-white text-[11.5px] font-semibold hover:bg-accent-secondary">
            <Plus size={12} strokeWidth={2.5} /> Add agent
          </button>
        </div>
        <div className="bg-elevation-2 rounded-xl ring-1 ring-seam px-3.5 divide-y divide-[var(--seam)]">
          {specs.map((s) => {
            const st = statusFor(s.kind, s.binary);
            const probe = probes[s.binary];
            const custom = isCustomAgent(s.kind);
            const keyLabels = bindingsFor(s.kind).map((b) => credentials.find((c) => c.id === b.credential_id)?.label).filter(Boolean);
            const sub = [
              s.binary,
              probe?.version ? `v${probe.version.replace(/^v/, '')}` : probe && !probe.found ? 'not found on PATH' : null,
              keyLabels.length ? `key: ${keyLabels.join(', ')}` : null,
              custom && s.resumeFlag ? `resume ${s.resumeFlag}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <div key={s.kind} className="flex items-center gap-3 h-[46px]">
                <BrandIcon kind={s.kind} size={18} />
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary text-[13px] truncate">{s.displayName} <span className="text-text-tertiary text-[11px] ml-1.5">{custom ? 'Local CLI' : 'Built in'}</span></p>
                  <p className="text-text-tertiary text-[11px] font-mono truncate">{sub}</p>
                </div>
                <span className={`w-[7px] h-[7px] rounded-full ${st.dot}`} />
                <span className="text-text-tertiary text-[12px] w-[70px]">{st.word}</span>
                {st.action
                  ? <button onClick={st.action.run} className="text-accent-primary text-[12px] hover:underline">{st.action.label}</button>
                  : custom
                    ? <button onClick={() => openAddAgent(customIdOf(s.kind)!)} className="text-accent-primary text-[12px] hover:underline">Edit</button>
                    : s.kind === 'claude'
                      ? <button onClick={() => openSettingsPage()} className="text-accent-primary text-[12px] hover:underline">Defaults</button>
                      : <span className="w-[52px]" />}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-start justify-between mb-1.5">
          <div>
            <h3 className="text-text-primary text-[13px] font-semibold">API keys</h3>
            <p className="text-text-tertiary text-[11.5px]">Stored in your OS credential store. Agentrium keeps labels only.</p>
          </div>
          <button onClick={() => openAddKey()} className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-fill-hover ring-1 ring-seam text-text-primary text-[11.5px] font-semibold hover:bg-fill-active">
            <Plus size={12} strokeWidth={2.5} /> Add key
          </button>
        </div>
        <div className="bg-elevation-2 rounded-xl ring-1 ring-seam px-3.5 divide-y divide-[var(--seam)]">
          {credentials.length === 0 && (
            <p className="py-4 text-text-tertiary text-[12px]">No keys yet. Agents use their own CLI login until you add one.</p>
          )}
          {credentials.map((c) => {
            const users = usersOf(c.id);
            const sub = [
              c.env_name,
              c.has_key ? `…${c.masked_tail ?? '****'}` : null,
              c.has_endpoint && c.endpoint_env ? `${c.endpoint_env} set` : null,
              users.length ? `used by ${users.join(', ')}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <div key={c.id} className="flex items-center gap-3 h-[46px]">
                {c.has_key ? <KeyRound size={15} className="text-accent-primary flex-shrink-0" /> : <Server size={15} className="text-text-tertiary flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-text-primary text-[13px] truncate">{c.label}</p>
                  <p className="text-text-tertiary text-[11px] font-mono truncate">{sub}</p>
                </div>
                <span className="text-text-tertiary text-[12px]">{relative(c.last_used_at)}</span>
                {confirmDeleteId === c.id
                  ? <button onClick={() => handleDeleteKey(c.id, c.label)} className="text-error text-[12px] font-semibold">Confirm</button>
                  : <button onClick={() => setConfirmDeleteId(c.id)} className="text-error text-[12px] hover:underline">Remove</button>}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
```

`open_external_url` already exists (CLAUDE.md lists it). If `openSettings` takes no page argument, the "Defaults" link simply keeps the settings window open; leave it.

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/components/settings/index.test.ts 2>&1 | tail -8`; `npx tsc --noEmit -p tsconfig.json 2>&1 | head`
Expected: pass; clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/index.ts src/components/settings/index.test.ts src/components/settings/SettingsWindow.tsx src/components/settings/categories/AgentsKeysPage.tsx
git commit -m "feat(settings): Agents & Keys page"
```

---

### Task 19: Profile modal - pinned bindings and "Move to keychain"

**Files:**
- Modify: `src/components/ProfileModal.tsx:30-45` (interface), `:313-356` (env editor)

- [ ] **Step 1: Extend the local `ConfigProfile` interface** with `credential_bindings?: CredentialBinding[];` (import the type from `../lib/credentials`) and, where a new blank profile object is built (line ~89 with `env_vars: {}`), add `credential_bindings: [],`.

- [ ] **Step 2: Add the move action.** Import `SECRET_ENV_RE` from `../lib/agentPresets`, `KeyRound` from `lucide-react`, and `useAgentRegistryStore` from `../store/agentRegistryStore`. Inside the component read `const openAddKey = useAgentRegistryStore((s) => s.openAddKey);`. In the env-var row, between the value input and the trash button, add:

```tsx
                        {SECRET_ENV_RE.test(key) && value && (
                          <button
                            type="button"
                            title="Move to keychain"
                            aria-label={`Move ${key} to keychain`}
                            onClick={() => openAddKey({ env_name: key, key: value, label: `${selectedProfile.name} ${key.replace(/_API_KEY|_TOKEN|_SECRET$/, '')}`.trim(), fromProfileId: selectedProfile.id })}
                            className="p-1 rounded hover:bg-accent-primary/10 text-text-tertiary hover:text-accent-primary transition-colors flex-shrink-0"
                          >
                            <KeyRound size={13} />
                          </button>
                        )}
```

Below the env editor (after the `Add Variable` button's closing `</div>`), show pinned keys read-only:

```tsx
                  {(selectedProfile.credential_bindings ?? []).length > 0 && (
                    <div className="mt-3">
                      <label className="block text-text-secondary text-[12px] mb-1.5">Keys from the OS credential store</label>
                      <div className="space-y-1">
                        {(selectedProfile.credential_bindings ?? []).map((b) => (
                          <div key={b.env} className="flex items-center gap-2 h-8 px-2 rounded-md bg-bg-primary ring-1 ring-border-light text-[12px]">
                            <KeyRound size={12} className="text-accent-primary" />
                            <span className="font-mono text-text-primary flex-1">{b.env}</span>
                            <button type="button" onClick={() => setSelectedProfile({ ...selectedProfile, credential_bindings: (selectedProfile.credential_bindings ?? []).filter((x) => x.env !== b.env) })} className="text-text-tertiary hover:text-error">Unpin</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
```

The Add API Key modal handles the profile update itself through `strip_profile_env_var` (Task 15), so after the modal closes the Profile modal must reload: in the existing profile-load effect, also depend on `useAgentRegistryStore((s) => s.addKeyOpen)` turning false (mirror the `prevProfileModalOpen` pattern from `NewTerminalModal.tsx:120-127`).

- [ ] **Step 3: Type-check and run the suite**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head`; `npx vitest run 2>&1 | tail -8`
Expected: clean; green.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProfileModal.tsx
git commit -m "feat(profiles): pin keychain credentials and move plaintext keys out of profiles"
```

---

### Task 20: Welcome screen and workspace restore

**Files:**
- Modify: `src/components/WelcomeScreen.tsx:5, 65`
- Modify: `src/App.tsx:722-734` (restore call)

- [ ] **Step 1: Welcome cards from the merged list.** Replace `import { AGENT_SPECS } from '../lib/agents';` with `import { allAgentSpecs } from '../lib/agents';` and `{AGENT_SPECS.map((spec) => (` with `{allAgentSpecs().map((spec) => (`. Subscribe so it re-renders when agents load: add `useAgentRegistryStore((s) => s.customAgents);` at the top of the component (import from `../store/agentRegistryStore`). Change the grid class to `grid-cols-2 sm:grid-cols-3 md:grid-cols-4` so five or six cards wrap evenly.

- [ ] **Step 2: Restore replays bindings.** In `src/App.tsx` the restore `createTerminal(` call (line ~722) passes `config.agent` as its 11th argument. Add a 12th: `config.credential_bindings ?? [],`. Missing keys surface through the existing `reportInvokeFailure('restore_terminal', err)` path; add a toast so the user learns why a tab did not come back:

```tsx
      } catch (err) {
        toast.error('Could not restore a session', String(err));
        reportInvokeFailure('restore_terminal', err);
      }
```

- [ ] **Step 3: Type-check, run suite, commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head`; `npx vitest run 2>&1 | tail -8`

```bash
git add src/components/WelcomeScreen.tsx src/App.tsx
git commit -m "feat(agents): custom agents on the welcome screen; restore replays credential bindings"
```

---

### Task 21: One-time plaintext-key migration prompt

**Files:**
- Modify: `src-tauri/src/database.rs` (two `app_meta` helpers + count)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs` (command)
- Modify: `src/App.tsx` (effect)

- [ ] **Step 1: Failing Rust test** in `database.rs` tests:

```rust
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
```

- [ ] **Step 2: Implement** in `impl Database`:

```rust
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
```

Command in `commands.rs` (register in `main.rs` after `commands::strip_profile_env_var,`):

```rust
/// Returns how many profiles still hold plaintext API keys, but only the
/// first time it is asked (then stamps app_meta so the toast shows once).
#[command]
pub async fn plaintext_key_profiles_to_prompt(state: State<'_, AppState>) -> Result<usize, String> {
    wrap_cmd("plaintext_key_profiles_to_prompt", async move {
        db_op(&state.db, |db| {
            if db.get_meta_flag("keys_migration_prompted")? {
                return Ok(0);
            }
            let n = db.count_profiles_with_plaintext_keys()?;
            if n > 0 {
                db.set_meta_flag("keys_migration_prompted")?;
            }
            Ok(n)
        })
        .await
    })
    .await
}
```

- [ ] **Step 3: Frontend effect** in `src/App.tsx`, inside the startup effect where `useAgentRegistryStore.getState().refresh()` was added (Task 15):

```tsx
    invoke<number>('plaintext_key_profiles_to_prompt')
      .then((n) => {
        if (n > 0) {
          toast.warning(
            `${n} profile${n === 1 ? '' : 's'} store API keys as plain text`,
            'Move them to your OS credential store from Settings > Agents > Agents & Keys, or open the profile and use the key icon next to the variable.',
          );
        }
      })
      .catch(() => {}); // one-time nicety; nothing to do if it fails
```

- [ ] **Step 4: Test, check, commit**

Run: `cd src-tauri && cargo test --quiet plaintext_key 2>&1 | tail -8`; `npx tsc --noEmit -p tsconfig.json 2>&1 | head`

```bash
git add src-tauri/src/database.rs src-tauri/src/commands.rs src-tauri/src/main.rs src/App.tsx
git commit -m "feat(credentials): one-time prompt to move plaintext profile keys to the OS store"
```

---

### Task 22: Docs and changelog

**Files:**
- Modify: `CLAUDE.md` (Key Patterns, IPC Commands)
- Modify: `src/changelog.json` (top entry)

- [ ] **Step 1: CLAUDE.md.** Under **IPC Commands** add a bullet:

```
- `probe_binary` / `list_custom_agents` / `save_custom_agent` / `delete_custom_agent` / `list_credentials` / `save_credential` / `delete_credential` / `test_credential` / `get_agent_bindings` / `set_agent_bindings` / `strip_profile_env_var`
```

Under **Key Patterns** add:

```
- **Custom agents and credentials**: `AgentKind::Custom(id)` (wire form `custom:<id>`) resolves through `custom_agents.rs` + the `custom_agents` table into an owned `agents::AgentSpec`; `resume_flags_for` renders the agent's `resume_flag` template. API keys live only in the OS credential store behind `credentials::SecretStore` (`keyring` crate); SQLite keeps `CredentialMeta` (label, env var, masked tail). `create_terminal` resolves `credential_bindings` into a `secret_env_vars` map applied to the PTY but never written to `TerminalConfig`. Frontend: `AgentKind` is `BuiltinAgentKind | \`custom:${string}\``, custom specs are registered via `setCustomAgentSpecs` from `agentRegistryStore`, and any `Record<AgentKind, T>` must be `Record<BuiltinAgentKind, T>` plus a fallback for custom kinds.
```

- [ ] **Step 2: Changelog.** Prepend an entry to `src/changelog.json` for the next version (the `/publish` step sets the number; use the current `package.json` version + 1 minor):

```json
  {
    "version": "1.34.0",
    "date": "2026-09-XX",
    "features": [
      { "title": "Add your own agents", "description": "Register any coding-agent CLI (OpenCode, Gemini CLI, Aider, Goose, Qwen Code, or a custom binary) from the agent picker or Settings > Agents. Presets fill in the binary, resume flag and the API key variable it needs; Agentrium probes your PATH live." },
      { "title": "API keys in your OS credential store", "description": "Store Anthropic, OpenAI, Google, Cursor, OpenRouter or custom keys once. They live in Windows Credential Manager / macOS Keychain and are injected into the agent process only at launch - never in profiles, logs or telemetry. An endpoint override lets Claude Code run against Ollama or a gateway." }
    ]
  },
```

Replace `2026-09-XX` with the release date when publishing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/changelog.json
git commit -m "docs: custom agents and API keys"
```

---

## Manual verification before release

1. Windows: Settings > Agents > Add agent > OpenCode preset shows `Found ... v<x>` when `opencode` is installed and `Not found on PATH` otherwise; save succeeds either way and the tile appears in New Session and the welcome screen.
2. Add an Anthropic key. Confirm it appears in Windows Credential Manager under `com.claudeterminal.agentrium`, and that `claudeterminal.db` `credentials` row has no value column.
3. New Session > Claude Code > API key > pick the key > Start. In the terminal run `echo %ANTHROPIC_API_KEY%` (or `$env:ANTHROPIC_API_KEY`) and see the value; check `session_history` and the workspace JSON contain only the binding id.
4. Add a key with endpoint override `http://localhost:11434` and Test connection against a running Ollama.
5. Remove the key in Settings: the Claude/OpenCode rows lose `key:` in their subline, and a profile that pinned it no longer lists it.
6. Uninstall or rename the custom binary: the agent row flips to Missing with an Install link; New Session start shows the install hint error.
7. Restart the app with a saved workspace that used a key: tabs restore and the key is injected again.

## Plan self-review notes

- Spec 4.1-4.6, 5.1-5.6, 6, 7, 8 each map to Tasks 1-22 above; section 8's `MockStore` is `MemoryStore` in Task 6.
- Task 4 names `resolve_agent_spec`; Tasks 5, 8, 9 reuse it unchanged. Task 6 names `resolve_for_spawn` (module `credentials`), used verbatim in Task 9. `CredentialBinding` lives in `config.rs` (Task 2) and is the type every later task imports.
- Frontend `createTerminal` gains its 12th positional parameter in Task 13; Tasks 17 and 20 are the only callers that pass it. All other callers keep compiling because it is optional.
- The `Button` component's `size` prop and the `@testing-library/react` dependency are the two external assumptions; both have a fallback instruction inline (Tasks 14, 16).
