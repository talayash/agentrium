//! Per-agent session providers. Abstracts over the four agents' on-disk
//! conventions so `terminal.rs` and IPC commands can call one interface.

use crate::config::AgentKind;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct AgentSessionInfo {
    pub id: String,
    pub modified_at: String,
    pub preview: Option<String>,
}

/// `Send + Sync` on the trait itself (not just at the `Box<dyn ...>` site)
/// so any provider held across `.await` in the session-detect watcher loop
/// is required to be thread-safe by the compiler, not by convention.
pub trait SessionProvider: Send + Sync {
    /// Files present before spawn - the diff after spawn isolates the new one.
    fn snapshot(&self) -> HashSet<PathBuf>;
    /// New session id in `cwd`, excluding ids already claimed by other terminals.
    fn find_new_for_cwd(&self, snapshot: &HashSet<PathBuf>, cwd: &str, exclude: &HashSet<String>) -> Option<String>;
    /// Every session for `cwd`, newest first, for the picker UI.
    fn list_for_cwd(&self, cwd: &str) -> Vec<AgentSessionInfo>;
}

pub fn provider_for(agent: AgentKind) -> Box<dyn SessionProvider> {
    match agent {
        AgentKind::Claude => Box::new(crate::claude_session::ClaudeSessionProvider),
        // Placeholder impls until later tasks land.
        AgentKind::Codex => Box::new(crate::codex_session::CodexSessionProvider),
        AgentKind::Cursor => Box::new(crate::cursor_session::CursorSessionProvider),
        AgentKind::Antigravity => Box::new(NoOpProvider),
    }
}

struct NoOpProvider;
impl SessionProvider for NoOpProvider {
    fn snapshot(&self) -> HashSet<PathBuf> { HashSet::new() }
    fn find_new_for_cwd(&self, _s: &HashSet<PathBuf>, _c: &str, _e: &HashSet<String>) -> Option<String> { None }
    fn list_for_cwd(&self, _c: &str) -> Vec<AgentSessionInfo> { Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_provider_is_wired() {
        let p = provider_for(AgentKind::Claude);
        // list_for_cwd on a non-existent path returns empty, not panic.
        let out = p.list_for_cwd("Z:\\does\\not\\exist");
        assert!(out.is_empty());
    }

    #[test]
    fn other_agents_return_noop_for_now() {
        // Codex and Cursor are wired up via their real providers now; only
        // Antigravity is still the placeholder NoOpProvider until later tasks
        // land. Cursor is excluded from this iteration because the dev
        // machine has real files under `~/.cursor/chats` that would break
        // the empty-snapshot assertion.
        for a in [AgentKind::Antigravity] {
            let p = provider_for(a);
            assert!(p.snapshot().is_empty());
            assert!(p.find_new_for_cwd(&HashSet::new(), "x", &HashSet::new()).is_none());
            assert!(p.list_for_cwd("x").is_empty());
        }
    }
}
