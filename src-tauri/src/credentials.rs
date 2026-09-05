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
