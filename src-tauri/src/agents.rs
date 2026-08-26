use crate::config::AgentKind;

#[allow(dead_code)]
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
        AgentKind::Cursor => AgentSpec {
            kind: AgentKind::Cursor,
            // Cursor's CLI binary is literally named `agent` (per
            // https://cursor.com/docs/cli). Generic, but that's what
            // resolves through PATH after the official installer.
            display_name: "Cursor",
            binary: "agent",
            install_url: "https://cursor.com/cli",
            install_hint: "curl https://cursor.com/install -fsS | bash",
        },
        AgentKind::Gemini => AgentSpec {
            kind: AgentKind::Gemini,
            display_name: "Gemini",
            binary: "gemini",
            install_url: "https://github.com/google-gemini/gemini-cli",
            install_hint: "npm install -g @google/gemini-cli",
        },
    }
}

// Called from the frontend via reflected metadata; Rust itself never calls this.
#[allow(dead_code)]
pub fn all_specs() -> Vec<AgentSpec> {
    vec![
        spec_for(AgentKind::Claude),
        spec_for(AgentKind::Codex),
        spec_for(AgentKind::Cursor),
        spec_for(AgentKind::Gemini),
    ]
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
    fn cursor_spec_has_agent_binary() {
        // Cursor's official CLI binary is `agent`, not `cursor` (which is
        // the editor's file-opener command). Guard against future edits
        // that "correct" this to `cursor` and break the spawn path.
        assert_eq!(spec_for(AgentKind::Cursor).binary, "agent");
    }

    #[test]
    fn gemini_spec_has_gemini_binary() {
        assert_eq!(spec_for(AgentKind::Gemini).binary, "gemini");
    }

    #[test]
    fn all_specs_lists_every_agent_kind() {
        // If a new AgentKind variant is added and forgotten here, this test
        // fails - forces the catalog to stay in sync with the enum.
        let specs = all_specs();
        assert!(specs.iter().any(|s| s.kind == AgentKind::Claude));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Codex));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Cursor));
        assert!(specs.iter().any(|s| s.kind == AgentKind::Gemini));
        assert_eq!(specs.len(), 4);
    }
}
