//! Detect the Claude Code session id assigned to a freshly-spawned terminal.
//!
//! Claude Code writes each conversation to `~/.claude/projects/<encoded-cwd>/
//! <session-uuid>.jsonl` (cwd encoded by replacing `\`, `/`, and `:` with
//! `-`). We snapshot the existing files before spawn and then poll for new
//! ones afterwards; the new file's stem is the session id we need to pass to
//! `claude --resume <id>` next time the terminal is restored.
//!
//! Snapshotting globally (across all project dirs) rather than just our cwd
//! dir means we still work the first time Claude is run in a new project -
//! the encoded dir may not exist yet when we take the snapshot.

use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

fn claude_projects_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.home_dir().join(".claude").join("projects"))
}

/// Summary of one session for the sidebar list. We keep this small -
/// timestamps and a preview are enough for the user to pick the right
/// conversation. Full content is loaded on demand when the user resumes.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeSessionInfo {
    pub id: String,
    pub modified_at: String,
    /// Excerpt of the first user message in the conversation; `None` if we
    /// couldn't find one in the first few JSONL lines (e.g. empty file or
    /// a format we don't recognise).
    pub preview: Option<String>,
}

/// Encode a working-directory path the way Claude Code names its project
/// subdirectory. Empirically observed: `\`, `/`, `:`, and spaces all become
/// `-` (so `C:\Dev\AlefBar - Kornish` becomes `C--Dev-AlefBar---Kornish`).
/// Every other character is preserved.
fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | ' ') { '-' } else { c })
        .collect()
}

/// Set of every `.jsonl` session file currently on disk. Take this *before*
/// spawning Claude so the diff afterwards isolates the new session.
pub fn snapshot_session_files() -> HashSet<PathBuf> {
    let mut out = HashSet::new();
    let Some(root) = claude_projects_dir() else { return out };
    let Ok(entries) = std::fs::read_dir(&root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                out.insert(path);
            }
        }
    }
    out
}

/// Look inside the project dir for `cwd` for a `.jsonl` file that wasn't in
/// `snapshot`. Returns the UUID stem of the newest such file. Returns `None`
/// if the project dir doesn't exist yet, has no new files, or its entries
/// can't be read.
///
/// `exclude` holds session ids already claimed by OTHER live terminals in the
/// same app. Several terminals in one cwd all see each other's session files
/// as "new" relative to their own snapshots; without the exclusion they all
/// converge on the same (most recently active) session, and the next restore
/// then attaches every terminal to ONE shared Claude conversation.
pub fn find_new_session_for_cwd(
    snapshot: &HashSet<PathBuf>,
    cwd: &str,
    exclude: &HashSet<String>,
) -> Option<String> {
    let root = claude_projects_dir()?;
    let dir = root.join(encode_cwd(cwd));
    find_new_session_in_dir(&dir, snapshot, exclude)
}

/// Testable core of [`find_new_session_for_cwd`]: scan `dir` directly.
fn find_new_session_in_dir(
    dir: &std::path::Path,
    snapshot: &HashSet<PathBuf>,
    exclude: &HashSet<String>,
) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut newest: Option<(String, std::time::SystemTime)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            continue;
        }
        if snapshot.contains(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if exclude.contains(stem) {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).ok();
        if let Some(t) = mtime {
            if newest.as_ref().map(|(_, n)| t > *n).unwrap_or(true) {
                newest = Some((stem.to_string(), t));
            }
        }
    }
    newest.map(|(stem, _)| stem)
}

/// Read the first few lines of a session JSONL and extract a short excerpt
/// from the first user message. Returns `None` if no user message is found
/// in the scanned window. Defensive across the two content shapes Claude
/// uses (string vs list of content blocks).
fn read_first_user_preview(path: &std::path::Path, max_lines: usize, max_chars: usize) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(max_lines).flatten() {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Each entry has a "type" tag. We only care about user turns.
        if v.get("type").and_then(|t| t.as_str()) != Some("user") {
            continue;
        }
        let msg = v.get("message")?;
        let content = msg.get("content")?;
        // Two shapes: a plain string, or an array of content blocks where
        // each block has a `text` field for text parts. Take the first text
        // we can find.
        let text: Option<String> = match content {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(parts) => parts
                .iter()
                .find_map(|p| p.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())),
            _ => None,
        };
        let mut t = text?;
        // Collapse whitespace + truncate so the sidebar row stays compact.
        t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.chars().count() > max_chars {
            t = t.chars().take(max_chars).collect::<String>() + "…";
        }
        if t.is_empty() {
            return None;
        }
        return Some(t);
    }
    None
}

/// List every `.jsonl` session file Claude has stored for the given cwd,
/// sorted newest-first. Returns an empty list when the project dir doesn't
/// exist yet - first-run in a new folder is a normal state.
pub fn list_sessions_for_cwd(cwd: &str) -> Vec<ClaudeSessionInfo> {
    let mut out: Vec<(ClaudeSessionInfo, std::time::SystemTime)> = Vec::new();
    let Some(root) = claude_projects_dir() else { return Vec::new() };
    let dir = root.join(encode_cwd(cwd));
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let modified_at = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();
            let preview = read_first_user_preview(&path, 20, 120);
            out.push((
                ClaudeSessionInfo { id: stem.to_string(), modified_at, preview },
                modified,
            ));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out.into_iter().map(|(info, _)| info).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_windows_path() {
        assert_eq!(encode_cwd(r"C:\Dev\Arik\claude-terminal"), "C--Dev-Arik-claude-terminal");
    }

    #[test]
    fn encodes_unix_path() {
        assert_eq!(encode_cwd("/Users/x/projects/foo"), "-Users-x-projects-foo");
    }

    #[test]
    fn preserves_dashes_and_dots() {
        assert_eq!(encode_cwd("/a/b-c.d"), "-a-b-c.d");
    }

    #[test]
    fn encodes_spaces_around_dash() {
        // C:\Dev\AlefBar - Kornish → C--Dev-AlefBar---Kornish
        assert_eq!(
            encode_cwd(r"C:\Dev\AlefBar - Kornish"),
            "C--Dev-AlefBar---Kornish"
        );
    }

    fn touch(dir: &std::path::Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "{}").unwrap();
        p
    }

    #[test]
    fn finds_newest_new_session() {
        let tmp = tempfile::tempdir().unwrap();
        let old = touch(tmp.path(), "old-session.jsonl");
        let snapshot: HashSet<PathBuf> = [old].into_iter().collect();
        touch(tmp.path(), "new-session.jsonl");
        let found = find_new_session_in_dir(tmp.path(), &snapshot, &HashSet::new());
        assert_eq!(found.as_deref(), Some("new-session"));
    }

    #[test]
    fn skips_sessions_claimed_by_other_terminals() {
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = HashSet::new();
        touch(tmp.path(), "claimed-by-z.jsonl");
        let exclude: HashSet<String> = ["claimed-by-z".to_string()].into_iter().collect();
        // The only new file is claimed elsewhere - must NOT bind to it.
        assert_eq!(find_new_session_in_dir(tmp.path(), &snapshot, &exclude), None);
        // A second, unclaimed file is fair game even if it's older.
        touch(tmp.path(), "mine.jsonl");
        assert_eq!(
            find_new_session_in_dir(tmp.path(), &snapshot, &exclude).as_deref(),
            Some("mine")
        );
    }

    #[test]
    fn ignores_files_already_in_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let pre = touch(tmp.path(), "pre-existing.jsonl");
        let snapshot: HashSet<PathBuf> = [pre].into_iter().collect();
        assert_eq!(find_new_session_in_dir(tmp.path(), &snapshot, &HashSet::new()), None);
    }
}
