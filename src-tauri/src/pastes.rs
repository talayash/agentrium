use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasteEntry {
    pub file_name: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub size_bytes: u64,
    pub created_at: String,
    pub detected_kind: String,
}

const PASTES_SUBDIR: &str = ".claudeterminal/pastes";
const GITIGNORE_DIR: &str = ".claudeterminal";
const FILENAME_RE: &str = r"^[A-Za-z0-9._-]+$";

pub fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("File name cannot be empty".into());
    }
    if name.len() > 200 {
        return Err("File name too long".into());
    }
    let re = regex::Regex::new(FILENAME_RE).expect("static regex compiles");
    if !re.is_match(name) {
        return Err(format!(
            "Invalid file name: {} (must match {})",
            name, FILENAME_RE
        ));
    }
    if name.starts_with('.') {
        return Err("File name must not start with '.'".into());
    }
    Ok(())
}

pub fn pastes_dir(cwd: &Path) -> PathBuf {
    cwd.join(PASTES_SUBDIR)
}

pub fn ensure_dir_with_gitignore(cwd: &Path) -> Result<(), String> {
    let dir = cwd.join(GITIGNORE_DIR);
    fs::create_dir_all(dir.join("pastes")).map_err(|e| e.to_string())?;
    let gi = dir.join(".gitignore");
    if !gi.exists() {
        fs::write(&gi, "*\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn sniff_kind(content: &str) -> &'static str {
    let trimmed = content.trim_start();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(content).is_ok()
    {
        return "json";
    }
    if trimmed.starts_with('<') && trimmed.contains('>') {
        return "xml";
    }
    let log_markers = ["[INFO]", "[ERROR]", "[WARN]", "[DEBUG]", "ERROR:", "WARN:"];
    let line_count = content.lines().take(50).count();
    let log_hits = content
        .lines()
        .take(50)
        .filter(|l| log_markers.iter().any(|m| l.contains(m)))
        .count();
    if line_count >= 5 && log_hits * 4 >= line_count {
        return "log";
    }
    "text"
}

fn safe_join(cwd: &Path, file_name: &str) -> Result<PathBuf, String> {
    validate_file_name(file_name)?;
    let dir = pastes_dir(cwd);
    let candidate = dir.join(file_name);
    // Defense-in-depth: even after regex validation, walk the joined path and
    // confirm it stays inside the pastes dir.
    let canonical_dir = dir.canonicalize().unwrap_or(dir.clone());
    let canonical_target = candidate.parent().map(|p| p.canonicalize().unwrap_or(p.to_path_buf()));
    match canonical_target {
        Some(parent) if parent == canonical_dir => Ok(candidate),
        _ => Err(format!("File name {} resolves outside pastes dir", file_name)),
    }
}

fn next_available_name(dir: &Path, base: &str, ext: &str) -> String {
    let primary = format!("{}.{}", base, ext);
    if !dir.join(&primary).exists() {
        return primary;
    }
    for i in 2..=99 {
        let candidate = format!("{}-{}.{}", base, i, ext);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{}-{}.{}", base, uuid::Uuid::new_v4().simple(), ext)
}

pub fn write_paste(
    cwd: &Path,
    content: &str,
    suggested_base: &str,
    extension: &str,
) -> Result<PasteEntry, String> {
    if !cwd.exists() {
        return Err(format!("Working directory {} no longer exists", cwd.display()));
    }
    validate_file_name(suggested_base)?;
    // Ensure extension is safe (no separators, etc).
    validate_file_name(&format!("x.{}", extension))?;
    ensure_dir_with_gitignore(cwd)?;
    let dir = pastes_dir(cwd);
    let file_name = next_available_name(&dir, suggested_base, extension);
    let abs_path = dir.join(&file_name);
    fs::write(&abs_path, content).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&abs_path).map_err(|e| e.to_string())?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let detected_kind = sniff_kind(content).to_string();
    Ok(PasteEntry {
        file_name: file_name.clone(),
        relative_path: format!("{}/{}", PASTES_SUBDIR, file_name),
        absolute_path: abs_path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        created_at,
        detected_kind,
    })
}

pub fn list_pastes(cwd: &Path) -> Result<Vec<PasteEntry>, String> {
    let dir = pastes_dir(cwd);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<(SystemTime, PasteEntry)> = vec![];
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let mtime = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let file_name = entry.file_name().to_string_lossy().to_string();
        let detected_kind = match path.extension().and_then(|s| s.to_str()) {
            Some("json") => "json",
            Some("log") => "log",
            Some("xml") => "xml",
            _ => "text",
        }
        .to_string();
        entries.push((
            mtime,
            PasteEntry {
                file_name: file_name.clone(),
                relative_path: format!("{}/{}", PASTES_SUBDIR, file_name),
                absolute_path: path.to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at: chrono::DateTime::<chrono::Utc>::from(mtime).to_rfc3339(),
                detected_kind,
            },
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, e)| e).collect())
}

pub fn read_paste(cwd: &Path, file_name: &str) -> Result<String, String> {
    let path = safe_join(cwd, file_name)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn delete_paste(cwd: &Path, file_name: &str) -> Result<(), String> {
    let path = safe_join(cwd, file_name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn purge_pastes(cwd: &Path) -> Result<(), String> {
    let dir = pastes_dir(cwd);
    if !dir.exists() {
        return Ok(());
    }
    let canonical_dir = dir.canonicalize().unwrap_or(dir.clone());
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Some(parent) = path.parent() {
                let canonical_parent = parent.canonicalize().unwrap_or(parent.to_path_buf());
                if canonical_parent == canonical_dir {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    #[test]
    fn validate_rejects_path_traversal() {
        assert!(validate_file_name("..").is_err());
        assert!(validate_file_name("../etc/passwd").is_err());
        assert!(validate_file_name("foo/bar").is_err());
        assert!(validate_file_name("foo\\bar").is_err());
        assert!(validate_file_name("C:\\windows").is_err());
        assert!(validate_file_name("foo\0bar").is_err());
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name(".hidden").is_err());
    }

    #[test]
    fn validate_accepts_simple_names() {
        assert!(validate_file_name("paste-2026-05-10-1432.json").is_ok());
        assert!(validate_file_name("errors_1102.log").is_ok());
        assert!(validate_file_name("a.b.c").is_ok());
    }

    #[test]
    fn write_paste_creates_dir_and_gitignore() {
        let dir = tmp();
        let entry = write_paste(dir.path(), "{\"a\":1}", "p1", "json").unwrap();
        assert_eq!(entry.detected_kind, "json");
        assert_eq!(entry.file_name, "p1.json");
        assert!(dir.path().join(".claudeterminal/.gitignore").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".claudeterminal/.gitignore")).unwrap(),
            "*\n"
        );
    }

    #[test]
    fn write_paste_collision_suffixes() {
        let dir = tmp();
        let a = write_paste(dir.path(), "x", "p", "txt").unwrap();
        let b = write_paste(dir.path(), "y", "p", "txt").unwrap();
        let c = write_paste(dir.path(), "z", "p", "txt").unwrap();
        assert_eq!(a.file_name, "p.txt");
        assert_eq!(b.file_name, "p-2.txt");
        assert_eq!(c.file_name, "p-3.txt");
    }

    #[test]
    fn read_paste_rejects_traversal() {
        let dir = tmp();
        write_paste(dir.path(), "ok", "f", "txt").unwrap();
        assert!(read_paste(dir.path(), "../../../etc/passwd").is_err());
        assert!(read_paste(dir.path(), "f.txt").is_ok());
    }

    #[test]
    fn delete_paste_rejects_traversal() {
        let dir = tmp();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "keep me").unwrap();
        let _ = delete_paste(dir.path(), "../outside.txt");
        assert!(outside.exists(), "delete must not escape pastes dir");
    }

    #[test]
    fn purge_pastes_only_clears_subdir() {
        let dir = tmp();
        write_paste(dir.path(), "a", "f1", "txt").unwrap();
        write_paste(dir.path(), "b", "f2", "txt").unwrap();
        let sibling = dir.path().join(".claudeterminal/sibling.txt");
        std::fs::write(&sibling, "stay").unwrap();
        purge_pastes(dir.path()).unwrap();
        assert!(sibling.exists(), "sibling files in .claudeterminal must survive");
        let listed = list_pastes(dir.path()).unwrap();
        assert!(listed.is_empty(), "pastes dir should be empty after purge");
    }

    #[test]
    fn list_pastes_sorted_newest_first() {
        let dir = tmp();
        write_paste(dir.path(), "1", "a", "txt").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_paste(dir.path(), "2", "b", "txt").unwrap();
        let listed = list_pastes(dir.path()).unwrap();
        assert_eq!(listed[0].file_name, "b.txt");
        assert_eq!(listed[1].file_name, "a.txt");
    }

    #[test]
    fn sniff_detects_kinds() {
        assert_eq!(sniff_kind("{\"a\":1}"), "json");
        assert_eq!(sniff_kind("[1,2,3]"), "json");
        assert_eq!(sniff_kind("<root><a/></root>"), "xml");
        let log = "[INFO] start\n[ERROR] boom\n[WARN] x\n[DEBUG] y\n[INFO] z\n";
        assert_eq!(sniff_kind(log), "log");
        assert_eq!(sniff_kind("hello world"), "text");
    }
}
