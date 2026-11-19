//! AI Factory persisted types. Factories and runs are local only (never synced).
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{command, State};

use crate::commands::{db_op, wrap_cmd};
use crate::error_reporter::user_err;
use crate::factory_def::{parse_definition, validate, Definition, Lint};
use crate::tasks::ensure_repo_trusted;
use crate::AppState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Factory {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub source_path: String,
    pub definition: Definition,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRow {
    pub at: String,
    pub step_id: String,
    pub kind: String,
    pub detail: String,
}

const MAX_CANDIDATES: usize = 200;
const AGENTRIUM_DIR_DEPTH: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryCandidate {
    pub path: String,
    pub rel_path: String,
    pub has_definition: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionReview {
    pub definition: Option<Definition>,
    pub parse_error: Option<String>,
    pub lint: Lint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiskState {
    Same,
    Changed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryView {
    #[serde(flatten)]
    pub factory: Factory,
    pub disk_state: DiskState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTicket {
    pub import_id: String,
    pub output_path: String,
    pub prompt: String,
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
}

fn is_markdown(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// `SKILL.md` -> `SKILL.factory.json` (same folder).
pub fn definition_path_for(source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    source.with_file_name(format!("{stem}.factory.json"))
}

fn rel_forward(repo: &Path, p: &Path) -> String {
    p.strip_prefix(repo)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Collect `.md` files under `dir` down to `depth` levels. Symlinks are
/// never followed (`DirEntry::file_type` does not resolve them).
fn collect_md(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            if depth > 1 {
                collect_md(&path, depth - 1, out);
            }
        } else if ft.is_file() && is_markdown(&path) {
            out.push(path);
        }
    }
}

pub fn find_candidates(repo: &Path) -> Vec<FactoryCandidate> {
    let mut found: Vec<PathBuf> = Vec::new();

    let claude = repo.join(".claude");
    let skills = claude.join("skills");
    if !is_symlink(&claude) && !is_symlink(&skills) {
        if let Ok(entries) = std::fs::read_dir(&skills) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    let skill = entry.path().join("SKILL.md");
                    if std::fs::symlink_metadata(&skill).is_ok_and(|m| m.is_file()) {
                        found.push(skill);
                    }
                }
            }
        }
    }

    let agentrium = repo.join(".agentrium");
    if !is_symlink(&agentrium) {
        collect_md(&agentrium, AGENTRIUM_DIR_DEPTH, &mut found);
    }

    if let Ok(entries) = std::fs::read_dir(repo) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_file())
                && is_markdown(&path)
                && definition_path_for(&path).is_file()
            {
                found.push(path);
            }
        }
    }

    let mut out: Vec<FactoryCandidate> = found
        .into_iter()
        .map(|p| FactoryCandidate {
            has_definition: definition_path_for(&p).is_file(),
            rel_path: rel_forward(repo, &p),
            path: p.to_string_lossy().into_owned(),
        })
        .collect();
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out.dedup_by(|a, b| a.rel_path == b.rel_path);
    out.truncate(MAX_CANDIDATES);
    out
}

pub fn review_json(json: &str) -> DefinitionReview {
    match parse_definition(json) {
        Err(e) => DefinitionReview {
            definition: None,
            parse_error: Some(e),
            lint: Lint::default(),
        },
        Ok(def) => {
            let lint = validate(&def);
            DefinitionReview {
                definition: Some(def),
                parse_error: None,
                lint,
            }
        }
    }
}

const NOT_REGULAR: &str = "The definition file next to this Markdown file is a link or not a regular file. Remove it and try again.";

/// Refuse a sibling definition file that exists but is not a regular file
/// (symlink, directory, ...). `Ok(true)` when a regular file exists.
fn check_definition_target(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => Ok(true),
        Ok(_) => Err(user_err(NOT_REGULAR)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(user_err(format!("Could not read the definition file: {e}"))),
    }
}

/// Every read of the sibling definition file goes through here. `None` when
/// there is no file. Never reads through a link.
fn read_definition_file(source: &Path) -> Result<Option<String>, String> {
    let path = definition_path_for(source);
    if !check_definition_target(&path)? {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| user_err(format!("Could not read the definition file: {e}")))
}

/// Every write of the sibling definition file goes through here: refuse
/// links, then write a temp file in the same folder and rename over the
/// target. `source` must already be canonical, so the folder is in the repo.
fn write_definition_file(source: &Path, json: &str) -> Result<(), String> {
    let path = definition_path_for(source);
    check_definition_target(&path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", uuid::Uuid::new_v4()));
    let fail = |e: std::io::Error| user_err(format!("Could not write the definition file: {e}"));
    std::fs::write(&tmp, json).map_err(fail)?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(fail(e));
    }
    Ok(())
}

pub fn disk_state(stored: &Definition, source: &Path) -> DiskState {
    let path = definition_path_for(source);
    match check_definition_target(&path) {
        Ok(false) => return DiskState::Missing,
        Err(_) => return DiskState::Changed,
        Ok(true) => {}
    }
    match std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| parse_definition(&t).ok())
    {
        Some(on_disk) if &on_disk == stored => DiskState::Same,
        _ => DiskState::Changed,
    }
}

pub fn import_prompt(source: &Path, output: &Path) -> String {
    let template = r#"Read the file at <SOURCE>. It describes a repeatable process as prose. Convert it into an
Agentrium factory definition and write the result as one JSON file at <OUTPUT>. Do not
modify any other file and do not run the process.

The JSON must have this shape:
{
  "version": 1,
  "name": "<short-kebab-name>",
  "source": "<file name of the source>",
  "input": { "label": "<what one run is started with>", "placeholder": "<example>" },
  "workspace": "worktree" | "in_place",
  "rules": ["<each thing the process says must never happen, one sentence each>"],
  "steps": [
    { "kind": "station", "id": "<id>", "name": "<name>", "prompt": "<full instruction for an agent>",
      "artifact": "<file name it must write into the run folder, optional>",
      "check": { "command": "<command whose exit code 0 means the station is done, optional>", "timeout_sec": 300 },
      "loop_cap": 3 },
    { "kind": "gate", "id": "<id>", "name": "<name>", "question": "<what the human is asked>",
      "pass_label": "<button>", "reject_label": "<button>",
      "show": ["<artifact file names the human should read>"],
      "notes": ["<what passing this gate also allows or causes>"],
      "on_reject": "<id of an earlier station to return to>" }
  ]
}

Rules for the conversion:
- Steps are in the order they happen. The first step is a station.
- A step where a human must approve, sign off, or confirm something is a gate. A step the
  source says is detected from another system (for example "wait until merged") is also a
  gate: ask the human whether it has happened.
- Step ids are 1 to 16 characters from letters, digits, "-" and "_". Reuse the source's
  own ids when it has them.
- In a station prompt use {input} for the run's input and {run_dir} for the folder where
  artifacts go. Tell the agent to write its artifact into {run_dir}. Add {reject_reason}
  to a station a gate can send back to, and {check_output} to a station that has a check.
- Use "in_place" when the process switches branches or works across several repositories
  in one folder. Otherwise use "worktree".
- Only add a check when the source names a real command. Never invent one.
- Copy prohibitions into "rules" in the source's own words.
When the file is written, say "Definition written" and stop."#;
    template
        .replace("<SOURCE>", &source.to_string_lossy())
        .replace("<OUTPUT>", &output.to_string_lossy())
}

/// App data dir (same one `Database::new` uses), created if missing.
pub fn factory_data_dir() -> Result<PathBuf, String> {
    let app_name = format!("ClaudeTerminal{}", crate::instance_suffix());
    let dir = directories::ProjectDirs::from("com", "claudeterminal", &app_name)
        .ok_or("Failed to get project directories")?
        .data_dir()
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `<data_dir>/<id>.json`, only for a lowercase hyphenated uuid (no braces,
/// `urn:` prefix, `:` or path separators).
pub(crate) fn import_output_path(data_dir: &Path, import_id: &str) -> Result<PathBuf, String> {
    match uuid::Uuid::parse_str(import_id) {
        Ok(id) if id.hyphenated().to_string() == import_id => {
            Ok(data_dir.join(format!("{import_id}.json")))
        }
        _ => Err(user_err("Unknown import.")),
    }
}

fn imports_dir() -> Result<PathBuf, String> {
    let dir = factory_data_dir()?.join("factory-imports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Drop the Windows `\\?\` prefix that `canonicalize` adds, so stored paths
/// read like the ones the user picked.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn canonical_repo(repo: &Path) -> Result<PathBuf, String> {
    repo.canonicalize()
        .map(strip_verbatim)
        .map_err(|e| user_err(format!("Invalid path '{}': {e}", repo.display())))
}

/// Canonicalise `source` and require it to be a `.md` file inside `repo`.
fn resolve_source(repo: &Path, source: &Path) -> Result<PathBuf, String> {
    let bad = || user_err("Pick a Markdown file inside the repo.");
    let repo = repo.canonicalize().map_err(|_| bad())?;
    let source = source.canonicalize().map_err(|_| bad())?;
    if !is_markdown(&source) || !source.starts_with(&repo) || !source.is_file() {
        return Err(bad());
    }
    Ok(strip_verbatim(source))
}

/// Validate, stamp the source fields and optionally write the sibling JSON.
pub(crate) fn prepare_save(
    repo: &Path,
    source: &Path,
    mut definition: Definition,
    write_file: bool,
) -> Result<Definition, String> {
    let source = resolve_source(repo, source)?;
    let lint = validate(&definition);
    if let Some(first) = lint.errors.first() {
        return Err(user_err(format!(
            "This definition has errors and cannot be saved: {}",
            first.message
        )));
    }
    let bytes = std::fs::read(&source)
        .map_err(|e| user_err(format!("Could not read the Markdown file: {e}")))?;
    definition.source = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    definition.source_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if write_file {
        let mut json = serde_json::to_string_pretty(&definition).map_err(|e| e.to_string())?;
        json.push('\n');
        write_definition_file(&source, &json)?;
    }
    Ok(definition)
}

fn view_of(factory: Factory) -> FactoryView {
    let disk_state = disk_state(&factory.definition, Path::new(&factory.source_path));
    FactoryView {
        factory,
        disk_state,
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn read_review(source: &Path) -> Result<Option<DefinitionReview>, String> {
    Ok(read_definition_file(source)?.map(|text| review_json(&text)))
}

#[command]
pub async fn list_factory_candidates(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<Vec<FactoryCandidate>, String> {
    wrap_cmd("list_factory_candidates", async move {
        ensure_repo_trusted(&state, &repo_path).await?;
        blocking(move || Ok(find_candidates(Path::new(&repo_path)))).await
    })
    .await
}

#[command]
pub async fn read_factory_definition_file(
    state: State<'_, AppState>,
    repo_path: String,
    source_path: String,
) -> Result<Option<DefinitionReview>, String> {
    wrap_cmd("read_factory_definition_file", async move {
        ensure_repo_trusted(&state, &repo_path).await?;
        blocking(move || {
            let source = resolve_source(Path::new(&repo_path), Path::new(&source_path))?;
            read_review(&source)
        })
        .await
    })
    .await
}

#[command]
pub async fn begin_factory_import(
    state: State<'_, AppState>,
    repo_path: String,
    source_path: String,
) -> Result<ImportTicket, String> {
    wrap_cmd("begin_factory_import", async move {
        ensure_repo_trusted(&state, &repo_path).await?;
        blocking(move || {
            let source = resolve_source(Path::new(&repo_path), Path::new(&source_path))?;
            let import_id = uuid::Uuid::new_v4().to_string();
            let output = import_output_path(&imports_dir()?, &import_id)?;
            let prompt = import_prompt(&source, &output);
            Ok(ImportTicket {
                import_id,
                output_path: output.to_string_lossy().into_owned(),
                prompt,
            })
        })
        .await
    })
    .await
}

#[command]
pub async fn poll_factory_import(import_id: String) -> Result<Option<DefinitionReview>, String> {
    wrap_cmd("poll_factory_import", async move {
        blocking(move || {
            let path = import_output_path(&imports_dir()?, &import_id)?;
            if !path.exists() {
                return Ok(None);
            }
            let text = std::fs::read_to_string(&path)
                .map_err(|e| user_err(format!("Could not read the import output: {e}")))?;
            Ok(Some(review_json(&text)))
        })
        .await
    })
    .await
}

#[command]
pub async fn save_factory(
    state: State<'_, AppState>,
    repo_path: String,
    source_path: String,
    definition: Definition,
    write_file: bool,
) -> Result<FactoryView, String> {
    wrap_cmd("save_factory", async move {
        ensure_repo_trusted(&state, &repo_path).await?;
        let (definition, repo, source) = blocking(move || {
            let repo = canonical_repo(Path::new(&repo_path))?;
            let source = resolve_source(&repo, Path::new(&source_path))?;
            let def = prepare_save(&repo, &source, definition, write_file)?;
            Ok((def, repo, source))
        })
        .await?;
        let now = chrono::Utc::now().to_rfc3339();
        let factory = Factory {
            id: uuid::Uuid::new_v4().to_string(),
            name: definition.name.clone(),
            repo_path: repo.to_string_lossy().into_owned(),
            source_path: source.to_string_lossy().into_owned(),
            definition,
            created_at: now.clone(),
            updated_at: now,
        };
        let stored = db_op(&state.db, move |db| db.upsert_factory(&factory)).await?;
        blocking(move || Ok(view_of(stored))).await
    })
    .await
}

#[command]
pub async fn list_factories(state: State<'_, AppState>) -> Result<Vec<FactoryView>, String> {
    wrap_cmd("list_factories", async move {
        let rows = db_op(&state.db, |db| db.list_factories()).await?;
        blocking(move || Ok(rows.into_iter().map(view_of).collect())).await
    })
    .await
}

#[command]
pub async fn delete_factory(state: State<'_, AppState>, factory_id: String) -> Result<(), String> {
    wrap_cmd("delete_factory", async move {
        db_op(&state.db, move |db| {
            if db.factory_has_open_runs(&factory_id)? {
                return Err(user_err(
                    "This factory still has open runs. Cancel them first.",
                ));
            }
            db.delete_factory(&factory_id)
        })
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::factory_def::{Step, SAMPLE};

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn sample() -> Definition {
        parse_definition(SAMPLE).unwrap()
    }

    #[test]
    fn definition_path_replaces_md() {
        assert_eq!(
            definition_path_for(Path::new("a/SKILL.md")),
            Path::new("a/SKILL.factory.json")
        );
        assert_eq!(
            definition_path_for(Path::new("x.MD")),
            Path::new("x.factory.json")
        );
    }

    #[test]
    fn find_candidates_lists_skills_agentrium_and_paired_root_files() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(&r.join(".claude/skills/flow/SKILL.md"), "x");
        write(&r.join(".agentrium/a/b.md"), "x");
        write(&r.join("README.md"), "x");
        write(&r.join("ROOT.md"), "x");
        write(&r.join("ROOT.factory.json"), "{}");
        write(&r.join("node_modules/x/SKILL.md"), "x");
        let got = find_candidates(r);
        let rels: Vec<&str> = got.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            [
                ".agentrium/a/b.md",
                ".claude/skills/flow/SKILL.md",
                "ROOT.md"
            ]
        );
        let with: Vec<&str> = got
            .iter()
            .filter(|c| c.has_definition)
            .map(|c| c.rel_path.as_str())
            .collect();
        assert_eq!(with, ["ROOT.md"]);
    }

    #[test]
    fn review_json_reports_parse_error() {
        let r = review_json("{ not json");
        assert!(r.definition.is_none());
        assert!(r.parse_error.is_some());
        assert!(r.lint.errors.is_empty());
    }

    #[test]
    fn review_json_returns_lint() {
        let mut def = sample();
        def.steps.clear();
        let r = review_json(&serde_json::to_string(&def).unwrap());
        assert!(r.parse_error.is_none());
        assert!(r.definition.is_some());
        assert!(!r.lint.errors.is_empty());
    }

    #[test]
    fn disk_state_same_changed_missing() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let def = sample();
        let file = definition_path_for(&source);
        std::fs::write(&file, serde_json::to_string_pretty(&def).unwrap()).unwrap();
        assert_eq!(disk_state(&def, &source), DiskState::Same);
        let mut changed = def.clone();
        if let Step::Station(s) = &mut changed.steps[0] {
            s.prompt.push_str(" more");
        }
        std::fs::write(&file, serde_json::to_string_pretty(&changed).unwrap()).unwrap();
        assert_eq!(disk_state(&def, &source), DiskState::Changed);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(disk_state(&def, &source), DiskState::Missing);
    }

    #[test]
    fn disk_state_is_changed_for_unparsable_file() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        std::fs::write(definition_path_for(&source), "{ not json").unwrap();
        assert_eq!(disk_state(&sample(), &source), DiskState::Changed);
    }

    #[test]
    fn import_prompt_contains_both_paths_and_schema() {
        let p = import_prompt(Path::new("/r/SKILL.md"), Path::new("/data/out.json"));
        assert!(p.contains("/r/SKILL.md"));
        assert!(p.contains("/data/out.json"));
        assert!(p.contains("\"version\": 1"));
        assert!(p.contains("Definition written"));
    }

    #[test]
    fn save_impl_sets_source_fields_and_writes_file() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "# process\n");
        let out = prepare_save(d.path(), &source, sample(), true).unwrap();
        assert_eq!(out.source, "SKILL.md");
        assert_eq!(out.source_sha256.len(), 64);
        assert!(out.source_sha256.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            out.source_sha256,
            format!("{:x}", Sha256::digest(b"# process\n"))
        );
        let text = std::fs::read_to_string(definition_path_for(&source)).unwrap();
        assert!(text.ends_with('\n'));
        assert_eq!(parse_definition(&text).unwrap(), out);

        let d2 = tempfile::tempdir().unwrap();
        let s2 = d2.path().join("SKILL.md");
        write(&s2, "x");
        prepare_save(d2.path(), &s2, sample(), false).unwrap();
        assert!(!definition_path_for(&s2).exists());
    }

    #[test]
    fn prepare_save_refuses_errors() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let mut def = sample();
        def.steps.clear();
        let err = prepare_save(d.path(), &source, def, true).unwrap_err();
        assert!(err.contains("has errors"), "{err}");
    }

    #[test]
    fn prepare_save_refuses_a_source_outside_the_repo() {
        let repo = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let source = other.path().join("SKILL.md");
        write(&source, "x");
        let err = prepare_save(repo.path(), &source, sample(), true).unwrap_err();
        assert!(err.contains("Markdown file inside the repo"), "{err}");
    }

    #[test]
    fn prepare_save_refuses_a_non_markdown_source() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("notes.txt");
        write(&source, "x");
        let err = prepare_save(d.path(), &source, sample(), true).unwrap_err();
        assert!(err.contains("Markdown file inside the repo"), "{err}");
    }

    fn symlink_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let r = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let r = std::os::windows::fs::symlink_file(target, link);
        match r {
            Ok(()) => true,
            Err(e) => {
                eprintln!("SKIP: cannot create a symlink here ({e})");
                false
            }
        }
    }

    fn symlink_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let r = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let r = std::os::windows::fs::symlink_dir(target, link);
        match r {
            Ok(()) => true,
            Err(e) => {
                eprintln!("SKIP: cannot create a symlink here ({e})");
                false
            }
        }
    }

    #[test]
    fn save_refuses_a_symlinked_definition_file() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let target = outside.path().join("victim.txt");
        write(&target, "precious");
        if !symlink_file(&target, &definition_path_for(&source)) {
            return;
        }
        let err = prepare_save(d.path(), &source, sample(), true).unwrap_err();
        assert!(err.contains("link or not a regular file"), "{err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "precious");
    }

    #[test]
    fn review_refuses_a_symlinked_definition_file() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let target = outside.path().join("other.json");
        write(&target, SAMPLE);
        if !symlink_file(&target, &definition_path_for(&source)) {
            return;
        }
        let err = read_review(&source).unwrap_err();
        assert!(err.contains("link or not a regular file"), "{err}");
    }

    #[test]
    fn disk_state_is_changed_for_a_symlinked_definition_file() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let target = outside.path().join("same.json");
        write(&target, SAMPLE);
        if !symlink_file(&target, &definition_path_for(&source)) {
            return;
        }
        assert_eq!(disk_state(&sample(), &source), DiskState::Changed);
    }

    #[test]
    fn save_replaces_an_existing_regular_definition_file() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        std::fs::write(definition_path_for(&source), "old").unwrap();
        let out = prepare_save(d.path(), &source, sample(), true).unwrap();
        let text = std::fs::read_to_string(definition_path_for(&source)).unwrap();
        assert_eq!(parse_definition(&text).unwrap(), out);
        let leftovers: Vec<String> = std::fs::read_dir(d.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn import_output_path_accepts_only_plain_hyphenated_uuids() {
        let dir = Path::new("/data");
        let id = uuid::Uuid::new_v4().to_string();
        let ok = import_output_path(dir, &id).unwrap();
        assert_eq!(ok, dir.join(format!("{id}.json")));
        for bad in [
            format!("{{{id}}}"),
            format!("urn:uuid:{id}"),
            id.to_uppercase(),
            "../x".to_string(),
            String::new(),
        ] {
            let err = import_output_path(dir, &bad).unwrap_err();
            assert!(err.contains("Unknown import."), "{bad}: {err}");
        }
    }

    #[test]
    fn find_candidates_skips_a_symlinked_root() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("a.md"), "x");
        write(&outside.path().join("flow/SKILL.md"), "x");
        if !symlink_dir(outside.path(), &d.path().join(".agentrium")) {
            return;
        }
        std::fs::create_dir_all(d.path().join(".claude")).unwrap();
        if !symlink_dir(outside.path(), &d.path().join(".claude/skills")) {
            return;
        }
        assert!(find_candidates(d.path()).is_empty());
    }
}
