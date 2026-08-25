use crate::config::AgentKind;

pub struct AgentSpec {
    pub kind: AgentKind,
    /// Human-readable name for the UI.
    pub display_name: &'static str,
    /// Executable name that will be resolved through PATH at spawn time.
    pub binary: &'static str,
    /// URL the "install" hint links to when the binary isn't found.
    pub install_url: &'static str,
    /// Short one-line install command shown in error messages.
    pub install_hint: &'static str,
}

pub fn spec_for(kind: AgentKind) -> AgentSpec {
    match kind {
        AgentKind::Claude => AgentSpec {
            kind: AgentKind::Claude,
            display_name: "Claude Code",
            binary: "claude",
            install_url: "https://docs.claude.com/claude-code",
            install_hint: "npm install -g @anthropic-ai/claude-code",
        },
        AgentKind::Codex => AgentSpec {
            kind: AgentKind::Codex,
            display_name: "Codex",
            binary: "codex",
            install_url: "https://github.com/openai/codex",
            install_hint: "npm install -g @openai/codex",
        },
    }
}

pub fn all_specs() -> Vec<AgentSpec> {
    vec![spec_for(AgentKind::Claude), spec_for(AgentKind::Codex)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_spec_has_claude_binary() {
        assert_eq!(spec_for(AgentKind::Claude).binary, "claude");
    }

    #[test]
    fn codex_spec_has_codex_binary() {
        assert_eq!(spec_for(AgentKind::Codex).binary, "codex");
    }

    #[test]
    fn all_specs_lists_every_agent_kind() {
        // If a new AgentKind variant is added and forgotten here, this test
        // fails - forces the catalog to stay in sync with the enum.
        let specs = all_specs();
        assert!(specs.iter().any(|s| s.kind == AgentKind::Claude));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Codex));
        assert_eq!(specs.len(), 2);
    }
}
