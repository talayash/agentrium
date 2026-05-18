//! Detect the Claude Code session id assigned to a freshly-spawned terminal.
//!
//! Claude Code writes each conversation to `~/.claude/projects/<encoded-cwd>/
//! <session-uuid>.jsonl` (cwd encoded by replacing `\`, `/`, and `:` with
//! `-`). We snapshot the existing files before spawn and then poll for new
//! ones afterwards; the new file's stem is the session id we need to pass to
//! `claude --resume <id>` next time the terminal is restored.
//!
//! Snapshotting globally (across all project dirs) rather than just our cwd
//! dir means we still work the first time Claude is run in a new project —
//! the encoded dir may not exist yet when we take the snapshot.

use std::collections::HashSet;
use std::path::PathBuf;

fn claude_projects_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.home_dir().join(".claude").join("projects"))
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
pub fn find_new_session_for_cwd(
    snapshot: &HashSet<PathBuf>,
    cwd: &str,
) -> Option<String> {
    let root = claude_projects_dir()?;
    let dir = root.join(encode_cwd(cwd));
    let entries = std::fs::read_dir(&dir).ok()?;
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
        let mtime = entry.metadata().and_then(|m| m.modified()).ok();
        if let Some(t) = mtime {
            if newest.as_ref().map(|(_, n)| t > *n).unwrap_or(true) {
                newest = Some((stem.to_string(), t));
            }
        }
    }
    newest.map(|(stem, _)| stem)
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
}
