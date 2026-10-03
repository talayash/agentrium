use crate::config::AgentKind;

/// How a CLI accepts a first prompt at spawn (Race mode delivers the task
/// through argv so every contender starts on the same input). Only filled in
/// for CLIs whose `--help` documents it; anything else gets the prompt staged
/// in the prompt editor instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InitialPrompt {
    /// Trailing positional argument: `claude [options] [prompt]`.
    Positional,
    /// A flag followed by the prompt as its own argument: `--flag <prompt>`.
    Flag(String),
    /// A single `--flag=<prompt>` argument.
    FlagEquals(String),
}

pub const PROMPT_PLACEHOLDER: &str = "{prompt}";

/// Parse a custom agent's `initial_prompt_template`: `{prompt}`,
/// `<flag> {prompt}` or `<flag>={prompt}`. The flag must look like a flag and
/// pass the same metacharacter rule as every other spawn argument.
pub fn parse_initial_prompt_template(template: &str) -> Result<InitialPrompt, String> {
    let t = template.trim();
    if t.matches(PROMPT_PLACEHOLDER).count() != 1 {
        return Err("The initial prompt template must contain {prompt} exactly once".to_string());
    }
    let tokens: Vec<&str> = t.split_whitespace().collect();
    let check_flag = |flag: &str| -> Result<String, String> {
        if !flag.starts_with('-') || flag.len() < 2 || flag.contains(crate::terminal::TerminalManager::SHELL_METACHARACTERS) {
            return Err(format!("\"{flag}\" is not a valid flag for the initial prompt"));
        }
        Ok(flag.to_string())
    };
    match tokens.as_slice() {
        [only] if *only == PROMPT_PLACEHOLDER => Ok(InitialPrompt::Positional),
        [only] => match only.strip_suffix(PROMPT_PLACEHOLDER).and_then(|f| f.strip_suffix('=')) {
            Some(flag) => Ok(InitialPrompt::FlagEquals(check_flag(flag)?)),
            None => Err("Use {prompt}, --flag {prompt} or --flag={prompt}".to_string()),
        },
        [flag, last] if *last == PROMPT_PLACEHOLDER => Ok(InitialPrompt::Flag(check_flag(flag)?)),
        _ => Err("Use {prompt}, --flag {prompt} or --flag={prompt}".to_string()),
    }
}

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
    /// How to pass a first prompt at spawn; `None` = not supported.
    pub initial_prompt: Option<InitialPrompt>,
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
            initial_prompt: None,
        }
    }

    fn with_initial_prompt(mut self, p: InitialPrompt) -> Self {
        self.initial_prompt = Some(p);
        self
    }

    pub fn from_custom(a: &crate::custom_agents::CustomAgent) -> Self {
        AgentSpec {
            kind: AgentKind::Custom(a.id.clone()),
            display_name: a.name.clone(),
            binary: a.binary.clone(),
            install_url: a.install_url.clone(),
            install_hint: a.install_hint.clone(),
            resume_flag: a.resume_flag.clone(),
            // Validated on save; a row that no longer parses (edited by hand,
            // older build) degrades to "no capability" rather than failing.
            initial_prompt: a
                .initial_prompt_template
                .as_deref()
                .filter(|t| !t.trim().is_empty())
                .and_then(|t| parse_initial_prompt_template(t).ok()),
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
        )
        // `claude --help`: "Usage: claude [options] [command] [prompt]".
        .with_initial_prompt(InitialPrompt::Positional),
        AgentKind::Codex => AgentSpec::builtin(
            AgentKind::Codex, "Codex", "codex",
            "https://github.com/openai/codex", "npm install -g @openai/codex",
        )
        // `codex --help`: "Usage: codex [OPTIONS] [PROMPT]".
        .with_initial_prompt(InitialPrompt::Positional),
        // Cursor's CLI binary is literally `agent` (per cursor.com/docs/cli).
        // No initial prompt: its `--help` has not been verified on a machine
        // with the CLI installed, so Race mode stages the prompt instead.
        AgentKind::Cursor => AgentSpec::builtin(
            AgentKind::Cursor, "Cursor", "agent",
            "https://cursor.com/cli", "curl https://cursor.com/install -fsS | bash",
        ),
        // Antigravity ships as `agy` (per antigravity.google/docs/cli).
        AgentKind::Antigravity => AgentSpec::builtin(
            AgentKind::Antigravity, "Antigravity", "agy",
            "https://antigravity.google/docs/cli/install/",
            "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        )
        // `agy --help`: "--prompt-interactive  Run an initial prompt
        // interactively and continue the session" (plain `--prompt` is print mode).
        .with_initial_prompt(InitialPrompt::Flag("--prompt-interactive".to_string())),
        AgentKind::Custom(_) => return None,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
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
            initial_prompt_template: Some("--prompt {prompt}".into()),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let spec = AgentSpec::from_custom(&a);
        assert_eq!(spec.initial_prompt, Some(InitialPrompt::Flag("--prompt".into())));
        assert_eq!(spec.kind, AgentKind::Custom("a1".into()));
        assert_eq!(spec.binary, "opencode");
        assert_eq!(spec.display_name, "OpenCode");
        assert_eq!(spec.resume_flag.as_deref(), Some("--session {id}"));
        assert_eq!(spec.install_url.as_deref(), Some("https://opencode.ai"));
    }

    #[test]
    fn builtin_initial_prompt_capabilities() {
        assert_eq!(builtin_spec(&AgentKind::Claude).unwrap().initial_prompt, Some(InitialPrompt::Positional));
        assert_eq!(builtin_spec(&AgentKind::Codex).unwrap().initial_prompt, Some(InitialPrompt::Positional));
        assert_eq!(builtin_spec(&AgentKind::Cursor).unwrap().initial_prompt, None);
        assert_eq!(
            builtin_spec(&AgentKind::Antigravity).unwrap().initial_prompt,
            Some(InitialPrompt::Flag("--prompt-interactive".into()))
        );
    }

    #[test]
    fn initial_prompt_template_forms() {
        assert_eq!(parse_initial_prompt_template("{prompt}"), Ok(InitialPrompt::Positional));
        assert_eq!(parse_initial_prompt_template(" -i {prompt} "), Ok(InitialPrompt::Flag("-i".into())));
        assert_eq!(
            parse_initial_prompt_template("--message={prompt}"),
            Ok(InitialPrompt::FlagEquals("--message".into()))
        );
        for bad in ["", "--prompt", "{prompt} {prompt}", "run {prompt}", "--x;rm {prompt}", "a b {prompt}", "--x {prompt} --y"] {
            assert!(parse_initial_prompt_template(bad).is_err(), "{bad}");
        }
    }
}
