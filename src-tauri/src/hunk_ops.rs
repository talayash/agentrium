//! Hunk-patch normalization for `git apply`-compatible unified diffs.

/// Prepend a minimal `diff --git` header to a raw hunk if the caller sent
/// only the `@@ ...` region. Idempotent when the header is already present.
///
/// `file_path` must be a repository-relative POSIX-style path (no leading `/`,
/// forward slashes). Absolute paths and backslash paths produce a `diff --git`
/// header that `git apply` will reject.
pub fn normalize_hunk_patch(file_path: &str, hunk_patch: &str) -> String {
    debug_assert!(
        !file_path.starts_with('/'),
        "normalize_hunk_patch: file_path must be repo-relative, got {file_path}",
    );
    debug_assert!(
        !file_path.contains('\\'),
        "normalize_hunk_patch: file_path must use forward slashes, got {file_path}",
    );
    let trimmed = hunk_patch.trim_start_matches('\n');
    if trimmed.starts_with("diff --git ") {
        return hunk_patch.to_string();
    }
    // Preserve trailing newline: git apply needs one at the end of the patch.
    let body = if hunk_patch.ends_with('\n') {
        hunk_patch.to_string()
    } else {
        format!("{hunk_patch}\n")
    };
    format!(
        "diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n{body}",
        p = file_path,
    )
}

use tokio::process::Command as TokioCommand;
use tokio::io::AsyncWriteExt;
use std::process::Stdio;

/// Pipe a unified diff to `git -C <repo> apply <extra_args>` via stdin.
/// Returns Ok(()) on git exit 0, or a user_err on non-zero (context mismatch,
/// invalid patch, etc). Does NOT normalize the patch: caller must pass the
/// output of `normalize_hunk_patch` (or a fully headered diff).
pub async fn apply_hunk_patch(
    repo_path: &str,
    normalized_patch: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    let mut cmd = TokioCommand::new("git");
    cmd.arg("-C").arg(repo_path).arg("apply");
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Windows: hide flashing console.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| {
        crate::error_reporter::user_err(&format!("spawn git failed: {e}"))
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(normalized_patch.as_bytes())
            .await
            .map_err(|e| crate::error_reporter::user_err(&format!("write patch: {e}")))?;
        drop(stdin);
    }

    let output = child.wait_with_output().await.map_err(|e| {
        crate::error_reporter::user_err(&format!("git wait: {e}"))
    })?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(crate::error_reporter::user_err(&format!(
            "git apply failed: {}",
            stderr.trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_header_to_raw_hunk() {
        let patch = "@@ -1,3 +1,3 @@\n context\n-old\n+new\n";
        let out = normalize_hunk_patch("src/foo.rs", patch);
        let expected = "diff --git a/src/foo.rs b/src/foo.rs\n\
                        --- a/src/foo.rs\n\
                        +++ b/src/foo.rs\n\
                        @@ -1,3 +1,3 @@\n \
                        context\n\
                        -old\n\
                        +new\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn preserves_existing_header() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let out = normalize_hunk_patch("x", patch);
        assert_eq!(out, patch);
    }

    #[test]
    fn ensures_trailing_newline_and_preserves_body() {
        let patch = "@@ -1,1 +1,1 @@\n-a\n+b";
        let out = normalize_hunk_patch("x", patch);
        assert!(out.ends_with('\n'));
        assert!(out.contains("-a\n+b\n"));
    }

    // -----------------------------------------------------------------
    // apply_hunk_patch tests using a scratch git repo
    // -----------------------------------------------------------------
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    fn run(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        StdCommand::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("git command failed to spawn")
    }

    fn init_repo(dir: &std::path::Path) {
        run(dir, &["init", "-q", "-b", "main"]);
        run(dir, &["config", "user.email", "t@t"]);
        run(dir, &["config", "user.name", "t"]);
    }

    fn write_and_commit(dir: &std::path::Path, name: &str, contents: &str, msg: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
        run(dir, &["add", name]);
        run(dir, &["commit", "-q", "-m", msg]);
    }

    fn diff(dir: &std::path::Path, staged: bool) -> String {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        let out = run(dir, &args);
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// Extract the first `@@ ... @@ ...` region from a full `git diff`.
    fn first_bare_hunk(full_diff: &str) -> String {
        let idx = full_diff.find("@@").expect("no hunk in diff");
        full_diff[idx..].to_string()
    }

    #[tokio::test]
    async fn stage_single_hunk_moves_to_index() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\ntwo\nthree\n", "init");
        std::fs::write(d.join("a.txt"), "one\nTWO\nthree\n").unwrap();

        let bare = first_bare_hunk(&diff(d, false));
        let normalized = super::normalize_hunk_patch("a.txt", &bare);
        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .expect("apply --cached");

        let staged = diff(d, true);
        assert!(staged.contains("-two"));
        assert!(staged.contains("+TWO"));
    }

    #[tokio::test]
    async fn discard_reverses_working_tree_change() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "keep\n", "init");
        std::fs::write(d.join("a.txt"), "keep\nadded\n").unwrap();

        let bare = first_bare_hunk(&diff(d, false));
        let normalized = super::normalize_hunk_patch("a.txt", &bare);
        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["-R"])
            .await
            .expect("apply -R");

        let contents = std::fs::read_to_string(d.join("a.txt")).unwrap();
        // Normalize CRLF so the test passes on both Windows and Unix.
        assert_eq!(contents.replace("\r\n", "\n"), "keep\n");
    }

    #[tokio::test]
    async fn stale_hunk_returns_user_err() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\n", "init");
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();

        let bogus = "@@ -1,2 +1,2 @@\n-nonexistent\n+replacement\n";
        let normalized = super::normalize_hunk_patch("a.txt", bogus);
        let err = super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .unwrap_err();
        assert!(err.contains("git apply failed"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn unstage_reverses_a_stage() {
        let td = TempDir::new().unwrap();
        let d = td.path();
        init_repo(d);
        write_and_commit(d, "a.txt", "one\n", "init");
        std::fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();

        let bare = first_bare_hunk(&diff(d, false));
        let normalized = super::normalize_hunk_patch("a.txt", &bare);

        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["--cached"])
            .await
            .unwrap();
        assert!(diff(d, true).contains("+two"));

        super::apply_hunk_patch(d.to_str().unwrap(), &normalized, &["-R", "--cached"])
            .await
            .unwrap();
        assert_eq!(diff(d, true), "");
    }
}
