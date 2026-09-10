use crate::commands::{git_cmd_async, FileChange};
use std::path::{Component, Path};

/// Porcelain -z uses literal paths and places the destination before the
/// additional source record for renames/copies. Paths may contain newlines.
pub fn parse_status(bytes: &[u8]) -> Vec<FileChange> {
    let mut records = bytes.split(|b| *b == 0);
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (x, y) = (record[0], record[1]);
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            records.next();
        }
        if x == b'?' && y == b'?' {
            changes.push(FileChange {
                path,
                status: "untracked".into(),
                staged: false,
            });
            continue;
        }
        for (code, staged) in [(x, true), (y, false)] {
            let status = match code {
                b'A' | b'C' => "new",
                b'M' | b'U' | b'T' => "modified",
                b'D' => "deleted",
                b'R' => "renamed",
                _ => continue,
            };
            changes.push(FileChange {
                path: path.clone(),
                status: status.into(),
                staged,
            });
        }
    }
    changes
}

/// Branch resolution is independent of repository membership: HEAD may be unborn.
pub async fn repository_branch(path: &str) -> (bool, Option<String>) {
    let inside = git_cmd_async(&["rev-parse", "--is-inside-work-tree"])
        .current_dir(path)
        .output()
        .await;
    if !inside.is_ok_and(|o| o.status.success() && o.stdout.starts_with(b"true")) {
        return (false, None);
    }
    for args in [
        vec!["symbolic-ref", "--short", "HEAD"],
        vec!["rev-parse", "--abbrev-ref", "HEAD"],
    ] {
        if let Ok(output) = git_cmd_async(&args).current_dir(path).output().await {
            if output.status.success() {
                return (
                    true,
                    Some(String::from_utf8_lossy(&output.stdout).trim().into()),
                );
            }
        }
    }
    (true, None)
}

/// Resolve the parent, never the selected entry: deleting a symlink must
/// unlink it even if its target is outside the repository or is the root.
pub fn discard_untracked(root: &Path, file: &str) -> Result<(), String> {
    let relative = Path::new(file);
    if file.is_empty()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Invalid untracked path".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let joined = root.join(relative);
    let parent = joined
        .parent()
        .ok_or("Missing parent")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("Refusing to delete outside repo".into());
    }
    let target = parent.join(joined.file_name().ok_or("Missing filename")?);
    if target == root {
        return Err("Refusing to delete repo root".into());
    }
    let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if meta.file_type().is_symlink_dir() {
            return std::fs::remove_dir(&target).map_err(|e| e.to_string());
        }
    }
    if meta.file_type().is_symlink() || !meta.is_dir() {
        std::fs::remove_file(target)
    } else {
        std::fs::remove_dir_all(target)
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_literal_paths_and_rename_records() {
        let changes = parse_status("?? file with spaces.txt\0?? café.txt\0RM new -> name.txt\0old name.txt\0 M line\nbreak.txt\0".as_bytes());
        assert_eq!(changes.len(), 5);
        assert_eq!(changes[0].path, "file with spaces.txt");
        assert_eq!(changes[1].path, "café.txt");
        assert_eq!(changes[2].path, "new -> name.txt");
        assert!(changes[2].staged);
        assert_eq!(changes[3].path, "new -> name.txt");
        assert!(!changes[3].staged);
        assert_eq!(changes[4].path, "line\nbreak.txt");
    }

    #[tokio::test]
    async fn unborn_repo_lists_stageable_literal_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert!(git_cmd_async(&["init"])
            .current_dir(root)
            .output()
            .await
            .unwrap()
            .status
            .success());
        assert_eq!(repository_branch(root).await.0, true);
        assert!(repository_branch(root).await.1.is_some());
        for name in ["file with spaces.txt", "café.txt"] {
            std::fs::write(dir.path().join(name), "test").unwrap();
        }
        let status = git_cmd_async(&["status", "--porcelain=v1", "-z"])
            .current_dir(root)
            .output()
            .await
            .unwrap();
        let changes = parse_status(&status.stdout);
        assert_eq!(changes.len(), 2);
        for change in changes {
            assert!(git_cmd_async(&["add", "--", &change.path])
                .current_dir(root)
                .output()
                .await
                .unwrap()
                .status
                .success());
        }
    }

    #[test]
    fn discard_rejects_root_and_traversal_and_removes_regular_entries() {
        let dir = tempfile::tempdir().unwrap();
        for path in ["", ".", "..", "../other", dir.path().to_str().unwrap()] {
            assert!(discard_untracked(dir.path(), path).is_err());
        }
        std::fs::create_dir(dir.path().join("new")).unwrap();
        std::fs::write(dir.path().join("new/file"), "test").unwrap();
        discard_untracked(dir.path(), "new").unwrap();
        assert!(!dir.path().join("new").exists());
        assert!(dir.path().exists());
    }

    #[test]
    fn discard_links_preserves_file_directory_and_root_targets() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tracked.txt"), "keep").unwrap();
        std::fs::create_dir(dir.path().join("tracked-dir")).unwrap();
        for (name, target, is_dir) in [
            ("file-link", dir.path().join("tracked.txt"), false),
            ("dir-link", dir.path().join("tracked-dir"), true),
            ("root-link", dir.path().to_path_buf(), true),
        ] {
            let link = dir.path().join(name);
            #[cfg(unix)]
            let result = {
                let _ = is_dir;
                std::os::unix::fs::symlink(&target, &link)
            };
            #[cfg(windows)]
            let result = if is_dir {
                std::os::windows::fs::symlink_dir(&target, &link)
            } else {
                std::os::windows::fs::symlink_file(&target, &link)
            };
            #[cfg(windows)]
            if result
                .as_ref()
                .is_err_and(|e| e.raw_os_error() == Some(1314))
            {
                if !is_dir {
                    // File symlinks need Developer Mode. Unix CI covers this
                    // case; directory junctions below require no privilege.
                    continue;
                }
                let status = std::process::Command::new("cmd")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(&target)
                    .output()
                    .unwrap();
                assert!(
                    status.status.success(),
                    "{}",
                    String::from_utf8_lossy(&status.stderr)
                );
            } else {
                result.unwrap();
            }
            #[cfg(unix)]
            result.unwrap();
            discard_untracked(dir.path(), name).unwrap();
            assert!(target.exists());
            assert!(std::fs::symlink_metadata(link).is_err());
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tracked.txt")).unwrap(),
            "keep"
        );
    }
}
