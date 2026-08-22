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
}
