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
/// subdirectory: `path.replace(/[^a-zA-Z0-9]/g, "-")`. Every character that
/// is not an ASCII letter or digit becomes `-`, including `.` and `_`
/// (so `C:\Users\me\.agentrium` becomes `C--Users-me--agentrium`). The JS
/// regex runs on UTF-16 code units, so an astral char yields two dashes.
fn encode_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

/// Claude Code caps the encoded name at this many chars; longer names are
/// truncated and suffixed with `-<hash of the full path>`.
const MAX_ENCODED_LEN: usize = 200;

/// Resolve the Claude project dir for `cwd` under `root`. For over-long paths
/// we can't recompute Claude's hash, so we pick the existing dir that starts
/// with the truncated prefix. Falls back to the plain encoded name (which may
/// not exist yet - callers treat a missing dir as "no sessions").
fn project_dir_in(root: &std::path::Path, cwd: &str) -> PathBuf {
    let encoded = encode_cwd(cwd);
    if encoded.len() <= MAX_ENCODED_LEN {
        return root.join(encoded);
    }
    // `encoded` is pure ASCII, so byte slicing is char-safe.
    let prefix = format!("{}-", &encoded[..MAX_ENCODED_LEN]);
    std::fs::read_dir(root)
        .ok()
        .and_then(|entries| {
            entries.flatten().map(|e| e.path()).find(|p| {
                p.is_dir()
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&prefix))
            })
        })
        .unwrap_or_else(|| root.join(encoded))
}

/// Absolute path of the `.jsonl` file for session `id` in `cwd`'s project dir.
pub fn session_file_path(cwd: &str, id: &str) -> Option<PathBuf> {
    let root = claude_projects_dir()?;
    Some(project_dir_in(&root, cwd).join(format!("{id}.jsonl")))
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
    let dir = project_dir_in(&root, cwd);
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
    let dir = project_dir_in(&root, cwd);
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
    out.sort_by_key(|e| std::cmp::Reverse(e.1));
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
    fn encodes_dots_and_underscores() {
        // Claude Code replaces every non-alphanumeric character (#91).
        assert_eq!(encode_cwd("/a/b-c.d_e"), "-a-b-c-d-e");
        assert_eq!(
            encode_cwd(r"C:\Users\talay\.agentrium\worktrees\app"),
            "C--Users-talay--agentrium-worktrees-app"
        );
    }

    #[test]
    fn encodes_non_ascii_per_utf16_unit() {
        // JS regex replacement works on UTF-16 code units: a BMP char is one
        // dash, an astral char (surrogate pair) is two.
        assert_eq!(encode_cwd("C:\\פרויקט"), format!("C{}", "-".repeat(8)));
        assert_eq!(encode_cwd("/a/😀"), "-a---");
    }

    #[test]
    fn resolves_short_path_to_exact_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(project_dir_in(tmp.path(), "/a/b.c"), tmp.path().join("-a-b-c"));
    }

    #[test]
    fn resolves_long_path_to_hashed_dir() {
        // Claude Code truncates names over 200 chars and appends `-<hash>`.
        // We can't reproduce the hash, so match on the 200-char prefix.
        let tmp = tempfile::tempdir().unwrap();
        let cwd = format!("/{}", "x".repeat(250));
        let encoded = encode_cwd(&cwd);
        let hashed = format!("{}-abc123", &encoded[..200]);
        std::fs::create_dir(tmp.path().join(&hashed)).unwrap();
        assert_eq!(project_dir_in(tmp.path(), &cwd), tmp.path().join(hashed));
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

pub struct ClaudeSessionProvider;

impl crate::session_provider::SessionProvider for ClaudeSessionProvider {
    fn snapshot(&self) -> std::collections::HashSet<std::path::PathBuf> {
        snapshot_session_files()
    }
    fn find_new_for_cwd(
        &self,
        snapshot: &std::collections::HashSet<std::path::PathBuf>,
        cwd: &str,
        exclude: &std::collections::HashSet<String>,
    ) -> Option<String> {
        find_new_session_for_cwd(snapshot, cwd, exclude)
    }
    fn list_for_cwd(&self, cwd: &str) -> Vec<crate::session_provider::AgentSessionInfo> {
        list_sessions_for_cwd(cwd)
            .into_iter()
            .map(|s| crate::session_provider::AgentSessionInfo {
                id: s.id,
                modified_at: s.modified_at,
                preview: s.preview,
            })
            .collect()
    }
}
