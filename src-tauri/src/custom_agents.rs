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
