//! Cursor `agent` CLI session provider. Cursor writes each chat to
//! `~/.cursor/chats/<projectHash>/<chatUuid>/` with `meta.json` holding
//! `title`, `cwd`, `createdAtMs`, `updatedAtMs`, and `hasConversation`.
//! We match by comparing the normalized cwd in meta.json rather than
//! reverse-engineering the projectHash - the hash function is undocumented
//! and comparing cwd is authoritative anyway.
//!
//! The chat UUID is the parent-directory name of `meta.json` and is what
//! `cursor-agent --resume <chatId>` accepts.

use crate::session_provider::{AgentSessionInfo, SessionProvider};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

fn cursor_chats_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Ok(dir) = std::env::var("AGENTRIUM_CURSOR_CHATS_DIR") {
            return Some(PathBuf::from(dir));
        }
    }
    directories::BaseDirs::new().map(|d| d.home_dir().join(".cursor").join("chats"))
}

fn normalize_cwd(cwd: &str) -> String {
    cwd.replace('\\', "/").to_lowercase()
}

#[derive(Deserialize)]
struct MetaJson {
    #[serde(rename = "createdAtMs")]
    created_at_ms: Option<i64>,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: Option<i64>,
    cwd: Option<String>,
    title: Option<String>,
    #[serde(rename = "hasConversation", default)]
    has_conversation: bool,
}

fn walk_meta_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(proj_dirs) = std::fs::read_dir(root) else { return out };
    for proj in proj_dirs.flatten() {
        let Ok(chats) = std::fs::read_dir(proj.path()) else { continue };
        for chat in chats.flatten() {
            let meta = chat.path().join("meta.json");
            if meta.is_file() { out.push(meta); }
        }
    }
    out
}

fn parse_meta(path: &Path) -> Option<(String, MetaJson)> {
    let uuid = path.parent()?.file_name()?.to_str()?.to_string();
    let raw = std::fs::read_to_string(path).ok()?;
    let meta: MetaJson = serde_json::from_str(&raw).ok()?;
    Some((uuid, meta))
}

pub struct CursorSessionProvider;

impl SessionProvider for CursorSessionProvider {
    fn snapshot(&self) -> HashSet<PathBuf> {
        let Some(root) = cursor_chats_root() else { return HashSet::new() };
        walk_meta_files(&root).into_iter().collect()
    }

    fn find_new_for_cwd(&self, snapshot: &HashSet<PathBuf>, cwd: &str, exclude: &HashSet<String>) -> Option<String> {
        let root = cursor_chats_root()?;
        let target = normalize_cwd(cwd);
        let mut newest: Option<(String, i64)> = None;
        for path in walk_meta_files(&root) {
            if snapshot.contains(&path) { continue; }
            let Some((uuid, meta)) = parse_meta(&path) else { continue };
            if !meta.has_conversation { continue; }
            let meta_cwd = meta.cwd.as_deref().unwrap_or("");
            if normalize_cwd(meta_cwd) != target { continue; }
            if exclude.contains(&uuid) { continue; }
            let ts = meta.updated_at_ms.or(meta.created_at_ms).unwrap_or(0);
            if newest.as_ref().map(|(_, n)| ts > *n).unwrap_or(true) {
                newest = Some((uuid, ts));
            }
        }
        newest.map(|(id, _)| id)
    }

    fn list_for_cwd(&self, cwd: &str) -> Vec<AgentSessionInfo> {
        let Some(root) = cursor_chats_root() else { return Vec::new() };
        let target = normalize_cwd(cwd);
        let mut rows: Vec<(AgentSessionInfo, i64)> = Vec::new();
        for path in walk_meta_files(&root) {
            let Some((uuid, meta)) = parse_meta(&path) else { continue };
            let meta_cwd = meta.cwd.as_deref().unwrap_or("");
            if normalize_cwd(meta_cwd) != target { continue; }
            let ts = meta.updated_at_ms.or(meta.created_at_ms).unwrap_or(0);
            let modified_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts)
                .unwrap_or_else(chrono::Utc::now)
                .to_rfc3339();
            rows.push((AgentSessionInfo { id: uuid, modified_at, preview: meta.title }, ts));
        }
        rows.sort_by_key(|(_, ts)| std::cmp::Reverse(*ts));
        rows.into_iter().map(|(info, _)| info).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_meta(root: &Path, proj: &str, uuid: &str, cwd: &str, title: &str, updated_ms: i64) -> PathBuf {
        let chat_dir = root.join(proj).join(uuid);
        std::fs::create_dir_all(&chat_dir).unwrap();
        let p = chat_dir.join("meta.json");
        let mut f = std::fs::File::create(&p).unwrap();
        let body = format!(
            r#"{{"schemaVersion":1,"createdAtMs":{ts},"hasConversation":true,"title":"{title}","updatedAtMs":{ts},"cwd":"{cwd}"}}"#,
            ts = updated_ms,
            title = title,
            cwd = cwd.replace('\\', "\\\\")
        );
        f.write_all(body.as_bytes()).unwrap();
        p
    }

    #[test]
    fn list_for_cwd_matches_normalized_paths() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENTRIUM_CURSOR_CHATS_DIR", tmp.path());
        write_meta(tmp.path(), "projA", "uuid-1", r"C:\Users\Talay\proj", "Chat One", 1_700_000_000_000);
        write_meta(tmp.path(), "projA", "uuid-2", r"C:\Users\Talay\other", "Skip", 1_700_000_001_000);
        let got = CursorSessionProvider.list_for_cwd("c:/users/talay/proj");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "uuid-1");
        assert_eq!(got[0].preview.as_deref(), Some("Chat One"));
        std::env::remove_var("AGENTRIUM_CURSOR_CHATS_DIR");
    }

    #[test]
    fn find_new_picks_newest_unclaimed() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENTRIUM_CURSOR_CHATS_DIR", tmp.path());
        let old = write_meta(tmp.path(), "p", "old", r"C:\a", "old", 1_700_000_000_000);
        let snap: HashSet<PathBuf> = [old].into_iter().collect();
        write_meta(tmp.path(), "p", "new", r"C:\a", "new", 1_700_000_100_000);
        let got = CursorSessionProvider.find_new_for_cwd(&snap, r"C:\a", &HashSet::new());
        assert_eq!(got.as_deref(), Some("new"));
        std::env::remove_var("AGENTRIUM_CURSOR_CHATS_DIR");
    }

    #[test]
    fn find_new_skips_when_has_conversation_false() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENTRIUM_CURSOR_CHATS_DIR", tmp.path());
        // Write a meta with hasConversation=false manually (helper always sets true).
        let chat_dir = tmp.path().join("p").join("empty-chat");
        std::fs::create_dir_all(&chat_dir).unwrap();
        std::fs::write(
            chat_dir.join("meta.json"),
            r#"{"schemaVersion":1,"createdAtMs":123,"hasConversation":false,"title":"","updatedAtMs":123,"cwd":"C:\\a"}"#,
        ).unwrap();
        let got = CursorSessionProvider.find_new_for_cwd(&HashSet::new(), r"C:\a", &HashSet::new());
        assert!(got.is_none(), "chats with hasConversation=false must not be candidates");
        std::env::remove_var("AGENTRIUM_CURSOR_CHATS_DIR");
    }
}
