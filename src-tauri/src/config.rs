use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

/// Links an environment variable an agent needs to a stored credential.
/// Values are never carried here - only the id of the credential row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialBinding {
    pub env: String,
    pub credential_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PreviewProfile {
    pub enabled: bool,
    pub url_override: Option<String>,
    pub framework_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub working_directory: String,
    // Legacy single-agent args list. Kept for wire back-compat and so any
    // caller that hasn't been updated to the per-agent map still gets a
    // usable value. On save we mirror `agent_args[profile.agent]` here so
    // it always represents the currently-selected agent's args.
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub is_default: bool,
    #[serde(default)]
    pub agent: AgentKind,
    #[serde(default)]
    pub preview: Option<PreviewProfile>,
    /// Per-agent args: the same profile can hold a distinct arg list for
    /// each supported agent (Claude/Codex/Cursor/Antigravity). Consumers
    /// should prefer `args_for(kind)` over indexing directly - it falls
    /// back to `claude_args` when a kind isn't present, which preserves
    /// behavior for profiles saved before this field existed.
    #[serde(default)]
    pub agent_args: HashMap<AgentKind, Vec<String>>,
    /// Credentials pinned by this profile, applied when the New Session modal
    /// is in API-key mode and the user has not overridden the row.
    #[serde(default)]
    pub credential_bindings: Vec<CredentialBinding>,
}

impl ConfigProfile {
    /// Args to pass when launching this profile with `kind`. Returns the
    /// per-agent list if set; otherwise falls back to the legacy
    /// `claude_args` (which itself mirrors the profile's default agent).
    pub fn args_for(&self, kind: AgentKind) -> Vec<String> {
        self.agent_args
            .get(&kind)
            .cloned()
            .unwrap_or_else(|| self.claude_args.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintCategory {
    pub name: String,
    pub icon: String,
    pub hints: Vec<Hint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hint {
    pub title: String,
    pub command: String,
    pub description: String,
}

pub fn get_default_hints() -> Vec<HintCategory> {
    vec![
        HintCategory {
            name: "Top 10 Commands".to_string(),
            icon: "star".to_string(),
            hints: vec![
                Hint {
                    title: "Fix this error".to_string(),
                    command: "Fix this error: [paste error]".to_string(),
                    description: "Quickly fix any error by pasting it".to_string(),
                },
                Hint {
                    title: "Explain this code".to_string(),
                    command: "Explain what this code does: [paste code]".to_string(),
                    description: "Get a clear explanation of any code".to_string(),
                },
                Hint {
                    title: "Write tests".to_string(),
                    command: "Write unit tests for [filename]".to_string(),
                    description: "Generate comprehensive tests".to_string(),
                },
                Hint {
                    title: "Refactor this".to_string(),
                    command: "Refactor this code to be cleaner: [paste code]".to_string(),
                    description: "Improve code quality and readability".to_string(),
                },
                Hint {
                    title: "Add comments".to_string(),
                    command: "Add documentation comments to [filename]".to_string(),
                    description: "Document your code automatically".to_string(),
                },
                Hint {
                    title: "Create component".to_string(),
                    command: "Create a React component for [description]".to_string(),
                    description: "Generate React/Vue/Angular components".to_string(),
                },
                Hint {
                    title: "API endpoint".to_string(),
                    command: "Create an API endpoint that [description]".to_string(),
                    description: "Build REST/GraphQL endpoints".to_string(),
                },
                Hint {
                    title: "Debug this".to_string(),
                    command: "Help me debug why [describe issue]".to_string(),
                    description: "Get help debugging tricky issues".to_string(),
                },
                Hint {
                    title: "Optimize performance".to_string(),
                    command: "Optimize the performance of [filename]".to_string(),
                    description: "Make your code faster".to_string(),
                },
                Hint {
                    title: "Convert format".to_string(),
                    command: "Convert this [from format] to [to format]".to_string(),
                    description: "Convert between file formats, languages".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Getting Started".to_string(),
            icon: "rocket".to_string(),
            hints: vec![
                Hint {
                    title: "Start Claude Code".to_string(),
                    command: "claude".to_string(),
                    description: "Launch Claude Code in interactive mode".to_string(),
                },
                Hint {
                    title: "With Custom Model".to_string(),
                    command: "claude --model opus".to_string(),
                    description: "Start with a specific model (opus, sonnet, haiku)".to_string(),
                },
                Hint {
                    title: "Skip Permissions".to_string(),
                    command: "claude --dangerously-skip-permissions".to_string(),
                    description: "Skip permission prompts (use with caution)".to_string(),
                },
                Hint {
                    title: "Resume Session".to_string(),
                    command: "claude --resume".to_string(),
                    description: "Continue from your last session".to_string(),
                },
            ],
        },
        HintCategory {
            name: "File Operations".to_string(),
            icon: "folder".to_string(),
            hints: vec![
                Hint {
                    title: "Read File".to_string(),
                    command: "Read the contents of [filename]".to_string(),
                    description: "Ask Claude to read and analyze a file".to_string(),
                },
                Hint {
                    title: "Create File".to_string(),
                    command: "Create a new file called [name] with [content]".to_string(),
                    description: "Ask Claude to create a new file".to_string(),
                },
                Hint {
                    title: "Edit File".to_string(),
                    command: "Edit [filename] and [describe changes]".to_string(),
                    description: "Ask Claude to modify an existing file".to_string(),
                },
                Hint {
                    title: "Find in Files".to_string(),
                    command: "Find all files that contain [pattern]".to_string(),
                    description: "Search across your codebase".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Git Operations".to_string(),
            icon: "git-branch".to_string(),
            hints: vec![
                Hint {
                    title: "Git Status".to_string(),
                    command: "Show me the git status".to_string(),
                    description: "Check repository status".to_string(),
                },
                Hint {
                    title: "Create Commit".to_string(),
                    command: "Commit these changes with an appropriate message".to_string(),
                    description: "Stage and commit changes".to_string(),
                },
                Hint {
                    title: "Create Branch".to_string(),
                    command: "Create a new branch called [name]".to_string(),
                    description: "Create and switch to a new branch".to_string(),
                },
                Hint {
                    title: "Create PR".to_string(),
                    command: "Create a pull request for these changes".to_string(),
                    description: "Open a pull request on GitHub".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Code Generation".to_string(),
            icon: "code".to_string(),
            hints: vec![
                Hint {
                    title: "Generate Function".to_string(),
                    command: "Write a function that [description]".to_string(),
                    description: "Generate code based on description".to_string(),
                },
                Hint {
                    title: "Refactor Code".to_string(),
                    command: "Refactor [filename] to [improvement]".to_string(),
                    description: "Improve existing code".to_string(),
                },
                Hint {
                    title: "Add Tests".to_string(),
                    command: "Write tests for [filename/function]".to_string(),
                    description: "Generate unit tests".to_string(),
                },
                Hint {
                    title: "Add Types".to_string(),
                    command: "Add TypeScript types to [filename]".to_string(),
                    description: "Add type annotations to JavaScript".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Debugging".to_string(),
            icon: "bug".to_string(),
            hints: vec![
                Hint {
                    title: "Find Bug".to_string(),
                    command: "Find the bug in [filename]".to_string(),
                    description: "Ask Claude to identify issues".to_string(),
                },
                Hint {
                    title: "Explain Error".to_string(),
                    command: "Explain this error: [error message]".to_string(),
                    description: "Get explanation for error messages".to_string(),
                },
                Hint {
                    title: "Fix Issue".to_string(),
                    command: "Fix the [issue description] in [filename]".to_string(),
                    description: "Ask Claude to fix a specific problem".to_string(),
                },
                Hint {
                    title: "Security Audit".to_string(),
                    command: "Check [filename] for security vulnerabilities".to_string(),
                    description: "Find potential security issues".to_string(),
                },
            ],
        },
        HintCategory {
            name: "CLI Flags".to_string(),
            icon: "terminal".to_string(),
            hints: vec![
                Hint {
                    title: "Max Turns".to_string(),
                    command: "--max-turns <number>".to_string(),
                    description: "Limit conversation turns".to_string(),
                },
                Hint {
                    title: "Output Format".to_string(),
                    command: "--output-format json".to_string(),
                    description: "Set output format (text, json, stream-json)".to_string(),
                },
                Hint {
                    title: "Verbose Mode".to_string(),
                    command: "--verbose".to_string(),
                    description: "Enable verbose logging".to_string(),
                },
                Hint {
                    title: "Working Directory".to_string(),
                    command: "--cwd /path/to/dir".to_string(),
                    description: "Set working directory".to_string(),
                },
                Hint {
                    title: "Allowed Tools".to_string(),
                    command: "--allowed-tools Read,Write,Bash".to_string(),
                    description: "Restrict available tools".to_string(),
                },
                Hint {
                    title: "Print Cost".to_string(),
                    command: "--print-cost".to_string(),
                    description: "Show token usage and cost".to_string(),
                },
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> ConfigProfile {
        let mut env = HashMap::new();
        env.insert("KEY".to_string(), "value".to_string());
        ConfigProfile {
            id: "p1".to_string(),
            name: "Default".to_string(),
            description: Some("desc".to_string()),
            working_directory: "C:/work".to_string(),
            claude_args: vec!["--model".to_string(), "opus".to_string()],
            env_vars: env,
            is_default: true,
            agent: AgentKind::default(),
            preview: None,
            agent_args: HashMap::new(),
            credential_bindings: Vec::new(),
        }
    }

    #[test]
    fn config_profile_serde_round_trips() {
        let p = sample_profile();
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(back.id, p.id);
        assert_eq!(back.name, p.name);
        assert_eq!(back.description, p.description);
        assert_eq!(back.working_directory, p.working_directory);
        assert_eq!(back.claude_args, p.claude_args);
        assert_eq!(back.env_vars, p.env_vars);
        assert_eq!(back.is_default, p.is_default);
    }

    #[test]
    fn config_profile_round_trips_when_optional_fields_are_empty() {
        let p = ConfigProfile {
            id: "p1".to_string(),
            name: "min".to_string(),
            description: None,
            working_directory: String::new(),
            claude_args: vec![],
            env_vars: HashMap::new(),
            is_default: false,
            agent: AgentKind::default(),
            preview: None,
            agent_args: HashMap::new(),
            credential_bindings: Vec::new(),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(back.description, None);
        assert!(back.claude_args.is_empty());
        assert!(back.env_vars.is_empty());
    }

    #[test]
    fn preview_profile_default_and_roundtrip() {
        let p = PreviewProfile {
            enabled: true,
            url_override: Some("http://localhost:3000".into()),
            framework_hint: Some("vite".into()),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: PreviewProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.enabled, true);
        assert_eq!(back.url_override.as_deref(), Some("http://localhost:3000"));
        assert_eq!(back.framework_hint.as_deref(), Some("vite"));
    }

    #[test]
    fn missing_preview_deserializes_as_none_on_config_profile() {
        // Simulate an old serialized ConfigProfile without the preview field.
        // Include every non-defaultable field (id, name, working_directory,
        // claude_args, env_vars, is_default) so serde is not asked to
        // synthesise them - the assertion under test is that `preview`
        // defaults to None when absent.
        let json = r#"{
            "id": "p1",
            "name": "x",
            "description": null,
            "working_directory": "/tmp",
            "claude_args": [],
            "env_vars": {},
            "is_default": false
        }"#;
        let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
        assert!(cfg.preview.is_none());
    }

    #[test]
    fn default_hints_have_at_least_one_category_and_no_blank_entries() {
        let categories = get_default_hints();
        assert!(!categories.is_empty(), "expected at least one category");

        for cat in &categories {
            assert!(!cat.name.is_empty(), "category name is blank");
            assert!(!cat.icon.is_empty(), "category icon is blank");
            assert!(!cat.hints.is_empty(), "category {} has no hints", cat.name);
            for hint in &cat.hints {
                assert!(!hint.title.is_empty(), "hint title in {} is blank", cat.name);
                assert!(!hint.command.is_empty(), "hint command in {} is blank", cat.name);
                assert!(
                    !hint.description.is_empty(),
                    "hint description in {} is blank",
                    cat.name
                );
            }
        }
    }

    #[test]
    fn default_hints_lead_with_top_10_commands_category() {
        // The UI surfaces categories in order; "Top 10 Commands" must come
        // first so the most common prompts are visible above the fold.
        let categories = get_default_hints();
        assert_eq!(categories[0].name, "Top 10 Commands");
        assert_eq!(categories[0].hints.len(), 10);
    }

    #[test]
    fn agent_kind_defaults_to_claude() {
        assert_eq!(AgentKind::default(), AgentKind::Claude);
    }

    #[test]
    fn agent_kind_serializes_lowercase() {
        let json = serde_json::to_string(&AgentKind::Codex).unwrap();
        assert_eq!(json, "\"codex\"");
    }

    #[test]
    fn missing_agent_field_deserializes_as_claude() {
        // Simulate an existing profile row written before the migration.
        // All non-default fields present; `agent` intentionally omitted.
        let json = r#"{
            "id": "p1",
            "name": "legacy",
            "description": null,
            "working_directory": "/tmp",
            "claude_args": [],
            "env_vars": {},
            "is_default": false
        }"#;
        let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.agent, AgentKind::Claude);
    }

    #[test]
    fn explicit_codex_agent_round_trips() {
        let mut p = sample_profile();
        p.agent = AgentKind::Codex;
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agent, AgentKind::Codex);
    }

    #[test]
    fn agent_kind_to_wire_matches_wire_format() {
        assert_eq!(AgentKind::Claude.to_wire(), "claude");
        assert_eq!(AgentKind::Codex.to_wire(), "codex");
        assert_eq!(AgentKind::Cursor.to_wire(), "cursor");
        assert_eq!(AgentKind::Antigravity.to_wire(), "antigravity");
    }

    #[test]
    fn agent_args_round_trip_preserves_per_agent_lists() {
        let mut p = sample_profile();
        let mut map: HashMap<AgentKind, Vec<String>> = HashMap::new();
        map.insert(AgentKind::Claude, vec!["--model".into(), "opus".into()]);
        map.insert(AgentKind::Codex, vec!["--exec".into()]);
        p.agent_args = map;
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.agent_args.get(&AgentKind::Claude).unwrap(), &vec!["--model".to_string(), "opus".to_string()]);
        assert_eq!(back.agent_args.get(&AgentKind::Codex).unwrap(), &vec!["--exec".to_string()]);
        assert!(!back.agent_args.contains_key(&AgentKind::Cursor));
    }

    #[test]
    fn missing_agent_args_field_deserializes_as_empty_map() {
        // Legacy profile JSON (pre-multi-agent-args) must still deserialize
        // without agent_args, and the field must default to an empty map so
        // args_for() falls back to claude_args.
        let json = r#"{
            "id": "p1",
            "name": "legacy",
            "description": null,
            "working_directory": "/tmp",
            "claude_args": ["--model", "opus"],
            "env_vars": {},
            "is_default": false
        }"#;
        let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
        assert!(cfg.agent_args.is_empty());
        assert_eq!(
            cfg.args_for(AgentKind::Claude),
            vec!["--model".to_string(), "opus".to_string()]
        );
    }

    #[test]
    fn args_for_returns_per_agent_list_when_present() {
        let mut p = sample_profile();
        p.agent_args.insert(AgentKind::Codex, vec!["--codex-flag".into()]);
        assert_eq!(p.args_for(AgentKind::Codex), vec!["--codex-flag".to_string()]);
    }

    #[test]
    fn args_for_falls_back_to_claude_args_when_kind_missing() {
        // No per-agent entry for Antigravity -> caller sees the legacy
        // list. This is what preserves behavior for profiles that predate
        // agent_args.
        let mut p = sample_profile();
        p.claude_args = vec!["--legacy".into()];
        p.agent_args.clear();
        assert_eq!(p.args_for(AgentKind::Antigravity), vec!["--legacy".to_string()]);
    }

    #[test]
    fn agent_kind_from_str_lossy_defaults_unknown_to_claude() {
        assert_eq!(AgentKind::from_str_lossy("codex"), AgentKind::Codex);
        assert_eq!(AgentKind::from_str_lossy("cursor"), AgentKind::Cursor);
        assert_eq!(AgentKind::from_str_lossy("antigravity"), AgentKind::Antigravity);
        assert_eq!(AgentKind::from_str_lossy("claude"), AgentKind::Claude);
        assert_eq!(AgentKind::from_str_lossy("something-new"), AgentKind::Claude);
        assert_eq!(AgentKind::from_str_lossy(""), AgentKind::Claude);
    }

    #[test]
    fn agent_kind_from_str_lossy_migrates_gemini_to_antigravity() {
        // Regression guard: rows written by pre-Antigravity builds carry
        // "gemini" in the agent column. Silent-downgrade to Claude here
        // would wipe user config on upgrade, so the loader promotes the
        // legacy value to the current fourth-agent slot.
        assert_eq!(AgentKind::from_str_lossy("gemini"), AgentKind::Antigravity);
    }
}

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
