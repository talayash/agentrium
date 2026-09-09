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
