//! Hunk-patch normalization and `git apply` wrapper.

/// Prepend a minimal `diff --git` header to a raw hunk if the caller sent
/// only the `@@ ...` region. Idempotent when the header is already present.
pub fn normalize_hunk_patch(file_path: &str, hunk_patch: &str) -> String {
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
        assert!(out.starts_with("diff --git a/src/foo.rs b/src/foo.rs\n"));
        assert!(out.contains("--- a/src/foo.rs\n"));
        assert!(out.contains("+++ b/src/foo.rs\n"));
        assert!(out.ends_with("+new\n"));
    }

    #[test]
    fn preserves_existing_header() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let out = normalize_hunk_patch("x", patch);
        assert_eq!(out, patch);
    }

    #[test]
    fn ensures_trailing_newline() {
        let patch = "@@ -1,1 +1,1 @@\n-a\n+b";
        let out = normalize_hunk_patch("x", patch);
        assert!(out.ends_with('\n'));
    }
}
