//! Codex CLI session provider. Codex writes each conversation to
//! `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The first
//! line is a `session_meta` record whose payload holds `session_id`, `cwd`,
//! and `timestamp` - exactly what we need for both find-new and list-per-cwd.
//!
//! Cwd matching normalizes separators to `/` and folds to lowercase so a
//! captured `C:\\Users\\talay\\proj` matches a spawn cwd of
//! `C:/Users/talay/proj` and vice versa - PTY spawn paths can use either.

use crate::session_provider::{AgentSessionInfo, SessionProvider};
use serde::Deserialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

fn codex_sessions_root() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.home_dir().join(".codex").join("sessions"))
}

fn normalize_cwd(cwd: &str) -> String {
    cwd.replace('\\', "/").to_lowercase()
}

#[derive(Deserialize)]
struct SessionMetaLine {
    #[serde(rename = "type")]
    kind: String,
    payload: SessionMetaPayload,
}

#[derive(Deserialize)]
struct SessionMetaPayload {
    session_id: String,
    cwd: String,
}

pub(crate) fn read_session_meta(path: &Path) -> Option<(String, String)> {
    let f = std::fs::File::open(path).ok()?;
    let first = BufReader::new(f).lines().next()?.ok()?;
    let meta: SessionMetaLine = serde_json::from_str(&first).ok()?;
    if meta.kind != "session_meta" { return None; }
    Some((meta.payload.session_id, meta.payload.cwd))
}

fn walk_rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(years) = std::fs::read_dir(root) else { return out };
    for y in years.flatten() {
        let Ok(months) = std::fs::read_dir(y.path()) else { continue };
        for m in months.flatten() {
            let Ok(days) = std::fs::read_dir(m.path()) else { continue };
            for d in days.flatten() {
                let Ok(files) = std::fs::read_dir(d.path()) else { continue };
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

fn read_first_user_preview(path: &Path, max_lines: usize, max_chars: usize) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    for line in BufReader::new(f).lines().take(max_lines).flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v, Err(_) => continue,
        };
        let payload = v.get("payload")?;
        if payload.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        let content = payload.get("content")?.as_array()?;
        let text = content.iter().find_map(|p| p.get("text").and_then(|t| t.as_str()))?;
        let mut t: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.chars().count() > max_chars {
            t = t.chars().take(max_chars).collect::<String>() + "…";
        }
        if t.is_empty() { return None; }
        return Some(t);
    }
    None
}

pub struct CodexSessionProvider;

impl SessionProvider for CodexSessionProvider {
    fn snapshot(&self) -> HashSet<PathBuf> {
        let Some(root) = codex_sessions_root() else { return HashSet::new() };
        walk_rollout_files(&root).into_iter().collect()
    }

    fn find_new_for_cwd(&self, snapshot: &HashSet<PathBuf>, cwd: &str, exclude: &HashSet<String>) -> Option<String> {
        let root = codex_sessions_root()?;
        let target = normalize_cwd(cwd);
        let mut newest: Option<(String, std::time::SystemTime)> = None;
        for path in walk_rollout_files(&root) {
            if snapshot.contains(&path) { continue; }
            let Some((sid, meta_cwd)) = read_session_meta(&path) else { continue };
            if normalize_cwd(&meta_cwd) != target { continue; }
            if exclude.contains(&sid) { continue; }
            let Ok(mtime) = path.metadata().and_then(|m| m.modified()) else { continue };
            if newest.as_ref().map(|(_, n)| mtime > *n).unwrap_or(true) {
                newest = Some((sid, mtime));
            }
        }
        newest.map(|(id, _)| id)
    }

    fn list_for_cwd(&self, cwd: &str) -> Vec<AgentSessionInfo> {
        let Some(root) = codex_sessions_root() else { return Vec::new() };
        let target = normalize_cwd(cwd);
        let mut rows: Vec<(AgentSessionInfo, std::time::SystemTime)> = Vec::new();
        for path in walk_rollout_files(&root) {
            let Some((sid, meta_cwd)) = read_session_meta(&path) else { continue };
            if normalize_cwd(&meta_cwd) != target { continue; }
            let Ok(mtime) = path.metadata().and_then(|m| m.modified()) else { continue };
            let modified_at = chrono::DateTime::<chrono::Utc>::from(mtime).to_rfc3339();
            let preview = read_first_user_preview(&path, 40, 120);
            rows.push((AgentSessionInfo { id: sid, modified_at, preview }, mtime));
        }
        rows.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
        rows.into_iter().map(|(info, _)| info).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_rollout(dir: &Path, name: &str, session_id: &str, cwd: &str, extra: &[&str]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        let meta = format!(
            r#"{{"type":"session_meta","payload":{{"session_id":"{sid}","cwd":"{cwd}","timestamp":"2026-08-28T10:00:00Z"}}}}"#,
            sid = session_id,
            cwd = cwd.replace('\\', "\\\\")
        );
        writeln!(f, "{meta}").unwrap();
        for line in extra { writeln!(f, "{line}").unwrap(); }
        p
    }

    #[test]
    fn read_session_meta_parses_first_line() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_rollout(tmp.path(), "rollout.jsonl", "abc-123", r"C:\Users\a", &[]);
        let (sid, cwd) = read_session_meta(&p).unwrap();
        assert_eq!(sid, "abc-123");
        assert_eq!(cwd, r"C:\Users\a");
    }

    #[test]
    fn normalize_cwd_folds_case_and_slashes() {
        assert_eq!(normalize_cwd(r"C:\Users\A"), "c:/users/a");
        assert_eq!(normalize_cwd("C:/Users/A"), "c:/users/a");
    }

    #[test]
    fn read_first_user_preview_extracts_input_text() {
        let tmp = tempfile::tempdir().unwrap();
        let extra = [r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello world"}]}}"#];
        let p = write_rollout(tmp.path(), "r.jsonl", "s", r"C:\a", &extra);
        assert_eq!(read_first_user_preview(&p, 10, 40).as_deref(), Some("hello world"));
    }
}
