//! Small, persisted descriptions for live session cards. Manual nicknames are
//! deliberately outside this data model and are never written by generation.
use crate::{
    commands::{db_op, wrap_cmd},
    AppState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContext {
    pub title: String,
    pub goal: String,
    pub latest: String,
    pub updated_at: String,
    pub generated: bool,
    #[serde(default)]
    pub session_id: Option<String>,
}

fn compact(text: &str, limit: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

// Derive context only from the provider's user-request preview, never arbitrary
// terminal output (which can contain banners, tool results, or login prompts).
fn local_context(preview: &str) -> Option<SessionContext> {
    let title = compact(
        &preview
            .split_whitespace()
            .take(6)
            .collect::<Vec<_>>()
            .join(" "),
        64,
    );
    if title.is_empty() {
        return None;
    }
    Some(SessionContext {
        title,
        goal: compact(preview, 240),
        latest: String::new(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        generated: false,
        session_id: None,
    })
}

#[tauri::command]
pub async fn get_terminal_context(
    state: State<'_, AppState>,
    id: String,
    screen: Option<String>,
    regenerate: bool,
) -> Result<Option<SessionContext>, String> {
    wrap_cmd("get_terminal_context", async move {
        let config = {
            let terminals = state.terminals.lock().await;
            terminals.terminals.get(&id).map(|t| t.config.clone())
        };
        let Some(config) = config else {
            return Ok(None);
        };
        // Namespaced keys reuse the existing summary storage without changing
        // legacy stopped-session summaries. Session IDs survive app restarts.
        let terminal_key = format!("context:terminal:{}", id);
        let session_key = config.claude_session_id.as_ref().map(|sid| {
            format!(
                "context:agent:{}:{}",
                serde_json::to_string(&config.agent).unwrap_or_default(),
                sid
            )
        });
        let read_key = terminal_key.clone();
        let alternate = session_key.clone();
        let existing = db_op(&state.db, move |db| {
            let saved = db.get_session_summary(&read_key)?;
            if saved.is_some() {
                return Ok(saved);
            }
            match alternate {
                Some(key) => db.get_session_summary(&key),
                None => Ok(None),
            }
        })
        .await?
        .and_then(|s| serde_json::from_str::<SessionContext>(&s).ok())
        .filter(|c| c.session_id.is_none() || c.session_id == config.claude_session_id);
        // Keep the existing IPC shape: null means load only. Screen text is
        // ignored; subtitle extraction never launches an AI process.
        if screen.is_none() || (!regenerate && existing.is_some()) {
            return Ok(existing);
        }
        let agent = config.agent.clone();
        let cwd = config.working_directory.clone();
        let sid = config.claude_session_id.clone();
        let preview = tokio::task::spawn_blocking(move || {
            let sid = sid?;
            crate::session_provider::provider_for(&agent)
                .list_for_cwd(&cwd)
                .into_iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.preview)
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(mut context) = preview.as_deref().and_then(local_context) else {
            return Ok(existing);
        };
        // Do not attach a preview to a different conversation if detection changed
        // the session while its metadata was being read.
        let live_config = {
            let terminals = state.terminals.lock().await;
            terminals.terminals.get(&id).map(|t| t.config.clone())
        };
        let Some(live_config) = live_config else {
            return Ok(None);
        };
        if config.claude_session_id != live_config.claude_session_id {
            return Ok(None); // The terminal moved to a different conversation.
        }
        let session_key = live_config.claude_session_id.as_ref().map(|sid| {
            format!(
                "context:agent:{}:{}",
                serde_json::to_string(&live_config.agent).unwrap_or_default(),
                sid
            )
        });
        context.session_id = live_config.claude_session_id;
        let serialized = serde_json::to_string(&context).map_err(|e| e.to_string())?;
        db_op(&state.db, move |db| {
            db.save_session_summary(&terminal_key, &serialized)?;
            if let Some(key) = session_key {
                db.save_session_summary(&key, &serialized)?;
            }
            Ok(())
        })
        .await?;
        Ok(Some(context))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_title_requires_a_request() {
        assert!(local_context(" \n\t ").is_none());
    }

    #[test]
    fn local_title_uses_six_words_and_normalizes_whitespace() {
        let context =
            local_context("Fix  login\nredirect and preserve existing sessions after restart")
                .unwrap();
        assert_eq!(context.title, "Fix login redirect and preserve existing");
        assert_eq!(
            context.goal,
            "Fix login redirect and preserve existing sessions after restart"
        );
        assert!(!context.generated);
        assert!(context.latest.is_empty());
    }

    #[test]
    fn local_title_bounds_unicode_without_splitting_characters() {
        let context = local_context(&"\u{05d0}".repeat(400)).unwrap();
        assert_eq!(context.title.chars().count(), 64);
        assert_eq!(context.goal.chars().count(), 240);
    }

    #[test]
    fn saved_ai_context_remains_readable() {
        let context: SessionContext = serde_json::from_str(r#"{"title":"Fix login","goal":"Keep users signed in","latest":"Investigating","updatedAt":"2026-09-15T10:00:00Z","generated":true}"#).unwrap();
        assert!(context.generated);
        assert!(context.session_id.is_none());
        assert_eq!(context.title, "Fix login");
    }
}
