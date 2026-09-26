//! Cloud configuration deliberately excludes all environment values and CLI arguments.
//! These arbitrary strings cannot be reliably classified as secret or public.
use serde_json::{json, Value};

pub fn workspace_terminals(value: &Value) -> Value {
    Value::Array(
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|terminal| {
                let source = terminal.as_object()?;
                let mut out = serde_json::Map::new();
                for key in [
                    "id",
                    "label",
                    "nickname",
                    "profile_id",
                    "working_directory",
                    "created_at",
                    "status",
                    "color_tag",
                    "agent",
                ] {
                    if let Some(v) = source.get(key).filter(|v| v.is_string() || v.is_null()) {
                        out.insert(key.into(), v.clone());
                    }
                }
                out.insert("env_vars".into(), json!({}));
                out.insert("claude_args".into(), json!([]));
                out.insert("credential_bindings".into(), json!([]));
                Value::Object(out).into()
            })
            .collect(),
    )
}

pub fn restore_local_terminals(remote: &Value, local: &Value) -> Value {
    let mut result = workspace_terminals(remote);
    for terminal in result.as_array_mut().unwrap() {
        if let Some(old) = local
            .as_array()
            .into_iter()
            .flatten()
            .find(|old| terminal["id"].as_str().is_some() && old["id"] == terminal["id"])
        {
            for key in [
                "env_vars",
                "claude_args",
                "credential_bindings",
                "claude_session_id",
            ] {
                if let Some(v) = old.get(key) {
                    terminal[key] = v.clone();
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_copy_excludes_secrets_and_unknown_future_fields() {
        let local = json!([{"id":"one", "label":"shell", "env_vars":{"PASSWORD":"private"},
            "claude_args":["--token", "private"], "credential_bindings":["local-key"],
            "future_secret":"private", "claude_session_id":"private"}]);
        let remote = workspace_terminals(&local);
        assert!(!remote.to_string().contains("private"));
        assert_eq!(remote[0]["label"], "shell");
        let restored = restore_local_terminals(&remote, &local);
        assert_eq!(restored[0]["env_vars"], local[0]["env_vars"]);
        assert_eq!(restored[0]["claude_args"], local[0]["claude_args"]);
    }
}
