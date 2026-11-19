//! AI Factory: definition management and the run lifecycle commands.
//! Factories and runs are local only (never synced).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{command, AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::Notify;

use crate::commands::{db_op, wrap_cmd};
use crate::config::AgentKind;
use crate::database::Database;
use crate::error_reporter::{report_bg, strip_user_prefix, user_err};
use crate::factory_def::{
    input_is_safe, is_plain_file_name, parse_definition, render_check_command, render_prompt,
    validate, Definition, Lint, PromptVars, Workspace,
};
use crate::factory_engine::{apply, wrong_state, Action, FactoryRun, RunEvent, RunStatus};
use crate::races::{cancel_check, run_check, running_checks, CheckGuard, RaceCheckResult};
use crate::tasks::{
    ensure_repo_trusted, finish_task_impl, same_path, start_task_impl, FinishAction,
    StartTaskRequest, TaskInfo,
};
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

/// `def` with the two fields `prepare_save` stamps blanked, so a stored copy
/// and the file on disk compare by content only.
fn without_source_fields(def: &Definition) -> Definition {
    let mut def = def.clone();
    def.source.clear();
    def.source_sha256.clear();
    def
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
        Some(on_disk) if without_source_fields(&on_disk) == without_source_fields(stored) => {
            DiskState::Same
        }
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
- In a check command, never write {run_dir} without double quotes around the path; prefer the AGENTRIUM_RUN_DIR environment variable.
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

/// The folder named in `ensure_repo_trusted`'s refusal for a folder
/// Agentrium has never worked in, without the `\\?\` prefix. `None` for any
/// other error.
fn unknown_repo_path(err: &str) -> Option<PathBuf> {
    strip_user_prefix(err)
        .strip_prefix("Open a session in '")
        .and_then(|rest| rest.strip_suffix("' first, then start a task there."))
        .map(|p| strip_verbatim(PathBuf::from(p)))
}

/// The factory flows' refusal for a folder that is not known yet.
fn unknown_repo_error(path: &Path) -> String {
    user_err(format!(
        "Agentrium has not worked in this folder yet: {}. Confirm the folder to continue.",
        path.display()
    ))
}

/// Canonical folders the user granted in this app run, each through the
/// native dialog of `confirm_factory_repo`. Nothing else adds to it and it is
/// never persisted: after a restart a saved factory's own repo keeps working
/// through `factory_repo_paths`.
static CONFIRMED_REPOS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn confirmed_repos() -> std::sync::MutexGuard<'static, HashSet<PathBuf>> {
    CONFIRMED_REPOS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn remember_confirmed(path: PathBuf) {
    confirmed_repos().insert(path);
}

/// `path` (canonical) is a granted folder or inside one. Granting a folder
/// never grants its parent.
fn is_confirmed(path: &Path) -> bool {
    confirmed_repos().iter().any(|root| path.starts_with(root))
}

/// The repo folders of the saved factories (our own DB, so as trustworthy as
/// a saved profile).
fn factory_repo_paths(db: &Database) -> Result<Vec<String>, String> {
    Ok(db
        .list_factories()?
        .into_iter()
        .map(|f| f.repo_path)
        .collect())
}

/// `path` (canonical) equals or is inside one of `folders`.
fn inside_folders(path: &Path, folders: &[String]) -> bool {
    folders.iter().any(|f| {
        canonical_repo(Path::new(f))
            .map(|root| path.starts_with(root))
            .unwrap_or(false)
    })
}

/// A repo folder is accepted when it passes the task trust rule, was
/// confirmed in the native dialog in this app run, or belongs to a saved
/// factory. Any error other than the unknown-folder refusal is returned as is.
async fn ensure_factory_repo_known(
    state: &State<'_, AppState>,
    repo_path: &str,
) -> Result<(), String> {
    let err = match ensure_repo_trusted(state, repo_path).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    if unknown_repo_path(&err).is_none() {
        return Err(err);
    }
    let path = canonical_repo(Path::new(repo_path))?;
    if is_confirmed(&path) {
        return Ok(());
    }
    let folders = db_op(&state.db, factory_repo_paths).await?;
    let candidate = path.clone();
    if blocking(move || Ok(inside_folders(&candidate, &folders))).await? {
        return Ok(());
    }
    Err(unknown_repo_error(&path))
}

/// Canonical form of a folder the user wants to confirm; it must exist.
fn existing_folder(repo_path: &str) -> Result<PathBuf, String> {
    match canonical_repo(Path::new(repo_path)) {
        Ok(p) if p.is_dir() => Ok(p),
        Ok(p) => Err(user_err(format!(
            "This folder does not exist: {}",
            p.display()
        ))),
        Err(_) => Err(user_err(format!("This folder does not exist: {repo_path}"))),
    }
}

const CONFIRM_TITLE: &str = "Add this folder?";

fn confirm_message(path: &Path) -> String {
    format!(
        "Agentrium will read the factory files in this folder and run agent sessions there:\n\n{}",
        path.display()
    )
}

/// Ask in a native dialog owned by the backend, so the renderer cannot answer
/// it. Non-blocking: the dialog reports through a oneshot channel.
async fn ask_to_add_folder(app: &AppHandle, path: &Path) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .message(confirm_message(path))
        .title(CONFIRM_TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Add folder".to_string(),
            "Cancel".to_string(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |accepted| {
        let _ = tx.send(accepted);
    });
    rx.await.unwrap_or(false)
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
        ensure_factory_repo_known(&state, &repo_path).await?;
        blocking(move || Ok(find_candidates(Path::new(&repo_path)))).await
    })
    .await
}

/// Grant a repo folder for the factory flows. `true` when it is already
/// known or the user accepted the native dialog, `false` on Cancel.
#[command]
pub async fn confirm_factory_repo(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<bool, String> {
    wrap_cmd("confirm_factory_repo", async move {
        let path = blocking(move || existing_folder(&repo_path)).await?;
        if ensure_factory_repo_known(&state, &path.to_string_lossy())
            .await
            .is_ok()
        {
            return Ok(true);
        }
        let accepted = ask_to_add_folder(&app, &path).await;
        if accepted {
            remember_confirmed(path);
        }
        Ok(accepted)
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
        ensure_factory_repo_known(&state, &repo_path).await?;
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
        ensure_factory_repo_known(&state, &repo_path).await?;
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
        ensure_factory_repo_known(&state, &repo_path).await?;
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

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

const RUN_LIST_LIMIT: u32 = 500;
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024;
const EVENT_DETAIL_CHARS: usize = 500;
const BRANCH_SLUG_LEN: usize = 40;
const MAX_BRANCH_SUFFIX: u32 = 9;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StepAction {
    #[serde(rename_all = "camelCase")]
    StartStation {
        step_id: String,
        step_name: String,
        attempt: u32,
        prompt: String,
        agent: AgentKind,
        cwd: String,
        /// Boxed only to keep the enum small; serialises as a plain object.
        task: Option<Box<TaskInfo>>,
    },
    #[serde(rename_all = "camelCase")]
    AwaitGate {
        step_id: String,
    },
    Queued,
    Blocked,
    Finished,
    Cancelled,
    /// evaluate only: the station is not finished yet
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    pub run: FactoryRun,
    pub action: StepAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunControl {
    Resume,
    AllowRetry,
    LineFreed,
    Cancel,
}

/// Where a new run works. A worktree run carries the task it was given.
pub(crate) enum WorkspaceSpec {
    InPlace,
    Worktree(TaskInfo),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EvalDecision {
    Waiting,
    RunCheck { command: String, timeout: Duration },
    Pass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CheckOutcome {
    Pass,
    Fail(String),
    Cancelled,
    SpawnError(String),
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn run_missing() -> String {
    user_err("This run no longer exists.")
}

fn load_run(db: &Database, run_id: &str) -> Result<FactoryRun, String> {
    db.get_factory_run(run_id)?.ok_or_else(run_missing)
}

/// Lowercase, every char outside `[a-z0-9]` becomes `-`, repeats collapsed,
/// `-` trimmed, capped at 40 chars.
fn branch_slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let c = c.to_ascii_lowercase();
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() {
            c
        } else {
            '-'
        };
        if !(c == '-' && out.ends_with('-')) {
            out.push(c);
        }
    }
    let mut s: String = out
        .trim_matches('-')
        .chars()
        .take(BRANCH_SLUG_LEN)
        .collect();
    s.truncate(s.trim_end_matches('-').len());
    s
}

pub(crate) fn worktree_branch(factory_name: &str, input: &str) -> String {
    format!(
        "agentrium/factory-{}-{}",
        branch_slug(factory_name),
        branch_slug(input)
    )
}

/// The trimmed input, or the user error that refuses it.
fn checked_input(def: &Definition, input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err(user_err(format!(
            "Enter the {}.",
            def.input.label.trim().to_lowercase()
        )));
    }
    if def.has_check() && !input_is_safe(input) {
        return Err(user_err(
            "This factory passes the input to a check command, so it may only contain letters, digits and . _ : / # @ -",
        ));
    }
    Ok(input.to_string())
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn step_action(db: &Database, run: &FactoryRun, action: Action) -> Result<StepAction, String> {
    Ok(match action {
        Action::StartStation { step_id, attempt } => {
            let station = run
                .definition
                .station(&step_id)
                .ok_or_else(|| user_err("This run is not at a station."))?;
            let prompt = render_prompt(
                &run.definition,
                station,
                &PromptVars {
                    input: &run.input,
                    run_dir: &run.run_dir,
                    reject_reason: &run.reject_reason,
                    check_output: &run.check_output,
                },
            );
            let task = match run.branch {
                Some(_) => db
                    .list_tasks()?
                    .into_iter()
                    .find(|t| same_path(&t.worktree_path, &run.workspace_path))
                    .map(Box::new),
                None => None,
            };
            StepAction::StartStation {
                step_name: station.name.clone(),
                step_id,
                attempt,
                prompt,
                agent: run.definition.agent.clone(),
                cwd: run.workspace_path.clone(),
                task,
            }
        }
        Action::AwaitGate { step_id } => StepAction::AwaitGate { step_id },
        Action::Queued => StepAction::Queued,
        Action::Blocked => StepAction::Blocked,
        Action::Finished => StepAction::Finished,
        Action::Cancelled => StepAction::Cancelled,
    })
}

/// Event kind logged after the caller's own kind when the transition ended
/// somewhere worth its own line.
fn outcome_kind(action: &Action) -> Option<&'static str> {
    match action {
        Action::Queued => Some("queued"),
        Action::Blocked => Some("blocked"),
        Action::Finished => Some("finished"),
        _ => None,
    }
}

/// Every run transition goes through here, so persistence is uniform: apply
/// the event, store the run, log the event, build the action. Opening a
/// station by any event except a Resume (which re-opens the same attempt)
/// moves `station_started_at`.
fn transition(
    db: &Database,
    mut run: FactoryRun,
    event: RunEvent,
    event_kind: &str,
    detail: &str,
) -> Result<RunStep, String> {
    let line_busy = db.factory_line_busy(&run.factory_id, &run.id)?;
    let step_before = run.current_step.clone();
    let resumed = event == RunEvent::Resume;
    let action = apply(&mut run, event, line_busy)?;
    let at = now();
    if matches!(action, Action::StartStation { .. }) && !resumed {
        run.station_started_at = Some(at.clone());
    }
    run.updated_at = at.clone();
    db.update_factory_run(&run)?;
    let step_id = if step_before.is_empty() {
        &run.current_step
    } else {
        &step_before
    };
    db.insert_factory_run_event(&run.id, &at, step_id, event_kind, detail)?;
    if let Some(kind) = outcome_kind(&action).filter(|k| *k != event_kind) {
        db.insert_factory_run_event(&run.id, &at, &run.current_step, kind, "")?;
    }
    let action = step_action(db, &run, action)?;
    Ok(RunStep { run, action })
}

/// Validate the input, create the run folder, store the run as queued and
/// start it. The caller has already created the worktree for a worktree run.
pub(crate) fn start_run_in(
    db: &Database,
    factory: &Factory,
    input: &str,
    data_dir: &Path,
    workspace: WorkspaceSpec,
) -> Result<RunStep, String> {
    let input = checked_input(&factory.definition, input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let run_dir = data_dir.join("factory-runs").join(&id);
    std::fs::create_dir_all(&run_dir)
        .map_err(|e| format!("Could not create the run folder: {e}"))?;
    let (workspace_path, branch) = match workspace {
        WorkspaceSpec::InPlace => (factory.repo_path.clone(), None),
        WorkspaceSpec::Worktree(task) => (task.worktree_path, Some(task.branch)),
    };
    let at = now();
    let run = FactoryRun {
        id,
        factory_id: factory.id.clone(),
        input,
        status: RunStatus::Queued,
        current_step: String::new(),
        attempts: Default::default(),
        reject_reason: String::new(),
        check_output: String::new(),
        definition: factory.definition.clone(),
        workspace_path,
        branch,
        run_dir: run_dir.to_string_lossy().into_owned(),
        terminal_id: None,
        station_started_at: None,
        created_at: at.clone(),
        updated_at: at,
    };
    if let Err(e) = db.insert_factory_run(&run) {
        // Nothing refers to the folder yet; do not leave it behind.
        let _ = std::fs::remove_dir_all(&run_dir);
        return Err(e);
    }
    transition(db, run, RunEvent::Start, "started", "")
}

/// True when the artifact at `path` is a regular file (never through a link)
/// that counts for this evaluation: a manual evaluation takes any existing
/// file, a tracked one only a file modified at or after the station opened.
fn artifact_counts(path: &Path, started_at: Option<&str>, manual: bool) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_file() {
        return false;
    }
    if manual {
        return true;
    }
    let Some(started) = started_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    else {
        return true;
    };
    match meta.modified() {
        Ok(modified) => chrono::DateTime::<chrono::Utc>::from(modified) >= started,
        Err(_) => true,
    }
}

/// What evaluating the current station should do. Pure apart from checking
/// whether the station's artifact is in the run folder and fresh enough.
pub(crate) fn evaluate_decision(run: &FactoryRun, manual: bool) -> Result<EvalDecision, String> {
    match run.status {
        RunStatus::Running => {}
        RunStatus::Checking => return Err(user_err("This run is already being checked.")),
        _ => return Err(wrong_state(run)),
    }
    let station = run
        .definition
        .station(&run.current_step)
        .ok_or_else(|| user_err("This run is not at a station."))?;
    let has_artifact = match &station.artifact {
        Some(name) => {
            if !is_plain_file_name(name) {
                return Err(user_err("Not an artifact name."));
            }
            let path = Path::new(&run.run_dir).join(name);
            if !artifact_counts(&path, run.station_started_at.as_deref(), manual) {
                if manual {
                    return Err(user_err(format!("{name} is not in the run folder yet.")));
                }
                return Ok(EvalDecision::Waiting);
            }
            true
        }
        None => false,
    };
    if let Some(command) = render_check_command(station, &run.input, &run.run_dir) {
        return Ok(EvalDecision::RunCheck {
            command,
            timeout: Duration::from_secs(station.timeout_secs()),
        });
    }
    if has_artifact || manual {
        Ok(EvalDecision::Pass)
    } else {
        Ok(EvalDecision::Waiting)
    }
}

/// True when `run` is still at the same station attempt as `snapshot`.
fn same_attempt(run: &FactoryRun, snapshot: &FactoryRun) -> bool {
    run.current_step == snapshot.current_step
        && run.attempts.get(&run.current_step) == snapshot.attempts.get(&snapshot.current_step)
}

/// Identifies one `Checking` state created by one `begin_check`. Drawn from a
/// process-wide counter, so no two `begin_check` calls ever get the same one;
/// a check never outlives the process, so tokens never need to survive a
/// restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CheckToken(u64);

/// Run id -> token of the check that currently owns that run's `Checking`.
fn check_owners() -> &'static Mutex<HashMap<String, CheckToken>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, CheckToken>>> = OnceLock::new();
    OWNERS.get_or_init(Default::default)
}

/// Mark the run `Checking` before its check starts and record which check
/// owns that state. Refuses unless the stored run is still `Running` at the
/// attempt that was evaluated. Runs under the DB lock (inside `db_op`), so it
/// is serialised with `finish_check` and every other transition.
fn begin_check(db: &Database, snapshot: &FactoryRun) -> Result<(FactoryRun, CheckToken), String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let mut run = load_run(db, &snapshot.id)?;
    if run.status == RunStatus::Checking {
        return Err(user_err("This run is already being checked."));
    }
    if run.status != RunStatus::Running || !same_attempt(&run, snapshot) {
        return Err(wrong_state(&run));
    }
    run.status = RunStatus::Checking;
    run.updated_at = now();
    db.update_factory_run(&run)?;
    let token = CheckToken(NEXT.fetch_add(1, Ordering::Relaxed));
    check_owners()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run.id.clone(), token);
    Ok((run, token))
}

fn back_to_running(db: &Database, run: &mut FactoryRun) -> Result<(), String> {
    if run.status == RunStatus::Checking {
        run.status = RunStatus::Running;
        run.updated_at = now();
        db.update_factory_run(run)?;
    }
    Ok(())
}

fn ignored(run: FactoryRun) -> RunStep {
    RunStep {
        run,
        action: StepAction::Waiting,
    }
}

/// Apply a station's result without a check (the `EvalDecision::Pass` path):
/// only while the run still holds the line at the evaluated attempt.
pub(crate) fn finish_evaluation(
    db: &Database,
    snapshot: &FactoryRun,
    outcome: CheckOutcome,
) -> Result<RunStep, String> {
    let run = load_run(db, &snapshot.id)?;
    if !run.status.holds_line() || !same_attempt(&run, snapshot) {
        return Ok(ignored(run));
    }
    apply_outcome(db, run, outcome)
}

/// Apply a check's result only while the run is still in the `Checking` state
/// that this check's `begin_check` created. A late result (after a Resume,
/// Cancel, or a newer check) is ignored: no change, no event.
pub(crate) fn finish_check(
    db: &Database,
    run_id: &str,
    token: CheckToken,
    outcome: CheckOutcome,
) -> Result<RunStep, String> {
    let owns = {
        let mut owners = check_owners().lock().map_err(|e| e.to_string())?;
        let owns = owners.get(run_id) == Some(&token);
        if owns {
            owners.remove(run_id);
        }
        owns
    };
    let run = load_run(db, run_id)?;
    if !owns || run.status != RunStatus::Checking {
        return Ok(ignored(run));
    }
    apply_outcome(db, run, outcome)
}

fn apply_outcome(
    db: &Database,
    mut run: FactoryRun,
    outcome: CheckOutcome,
) -> Result<RunStep, String> {
    match outcome {
        CheckOutcome::Pass => transition(db, run, RunEvent::StationPassed, "passed", ""),
        CheckOutcome::Fail(output) => {
            let detail = first_chars(&output, EVENT_DETAIL_CHARS);
            transition(
                db,
                run,
                RunEvent::StationFailed { output },
                "failed",
                &detail,
            )
        }
        CheckOutcome::Cancelled => {
            back_to_running(db, &mut run)?;
            Ok(RunStep {
                run,
                action: StepAction::Waiting,
            })
        }
        CheckOutcome::SpawnError(e) => {
            back_to_running(db, &mut run)?;
            Err(e)
        }
    }
}

fn outcome_of(result: &RaceCheckResult, timeout_secs: u64) -> CheckOutcome {
    if result.cancelled {
        return CheckOutcome::Cancelled;
    }
    if result.exit_code == Some(0) && !result.timed_out {
        return CheckOutcome::Pass;
    }
    let mut output = String::new();
    if result.timed_out {
        output.push_str(&format!("Timed out after {timeout_secs} s.\n"));
    }
    output.push_str(&result.output_tail);
    CheckOutcome::Fail(output)
}

/// The body of `evaluate_factory_station`. The check command comes only from
/// the definition stored on the run row.
pub(crate) async fn evaluate_station(
    db: &Arc<Mutex<Database>>,
    run_id: String,
    manual: bool,
    eval_id: String,
) -> Result<RunStep, String> {
    let run = db_op(db, move |db| load_run(db, &run_id)).await?;
    match evaluate_decision(&run, manual)? {
        EvalDecision::Waiting => Ok(RunStep {
            run,
            action: StepAction::Waiting,
        }),
        EvalDecision::Pass => {
            db_op(db, move |db| {
                finish_evaluation(db, &run, CheckOutcome::Pass)
            })
            .await
        }
        EvalDecision::RunCheck { command, timeout } => {
            // Register first so a duplicate id changes nothing and an early
            // cancel is kept as a permit.
            let cancel = Arc::new(Notify::new());
            {
                let mut running = running_checks().lock().map_err(|e| e.to_string())?;
                if running.contains_key(&eval_id) {
                    return Err(user_err("That check is already running."));
                }
                running.insert(eval_id.clone(), cancel.clone());
            }
            let _guard = CheckGuard(eval_id);
            let (checking, token) = db_op(db, move |db| begin_check(db, &run)).await?;
            let envs = [
                ("AGENTRIUM_RUN_DIR".to_string(), checking.run_dir.clone()),
                (
                    "AGENTRIUM_FACTORY_INPUT".to_string(),
                    checking.input.clone(),
                ),
            ];
            let cwd = PathBuf::from(&checking.workspace_path);
            let outcome = match run_check(&command, &cwd, timeout, cancel, &envs).await {
                Ok(result) => outcome_of(&result, timeout.as_secs()),
                Err(e) => CheckOutcome::SpawnError(e),
            };
            db_op(db, move |db| finish_check(db, &checking.id, token, outcome)).await
        }
    }
}

pub(crate) fn answer_gate_in(
    db: &Database,
    run_id: &str,
    step_id: &str,
    approve: bool,
    reason: Option<String>,
) -> Result<RunStep, String> {
    let run = load_run(db, run_id)?;
    let step_id = step_id.to_string();
    if approve {
        transition(db, run, RunEvent::GateApproved { step_id }, "approved", "")
    } else {
        let reason = reason.unwrap_or_default();
        let detail = reason.trim().to_string();
        transition(
            db,
            run,
            RunEvent::GateRejected { step_id, reason },
            "rejected",
            &detail,
        )
    }
}

pub(crate) fn control_in(db: &Database, run_id: &str, op: RunControl) -> Result<RunStep, String> {
    let run = load_run(db, run_id)?;
    let (event, kind) = match op {
        RunControl::Resume => (RunEvent::Resume, "resumed"),
        RunControl::AllowRetry => (RunEvent::AllowRetry, "retry_allowed"),
        RunControl::LineFreed => (RunEvent::LineFreed, "started"),
        RunControl::Cancel => (RunEvent::Cancel, "cancelled"),
    };
    transition(db, run, event, kind, "")
}

/// Read a text artifact from the run folder. `None` when it is not there yet.
pub(crate) fn read_artifact(run_dir: &Path, name: &str) -> Result<Option<String>, String> {
    if !is_plain_file_name(name) {
        return Err(user_err("Not an artifact name."));
    }
    let path = run_dir.join(name);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(user_err(format!("Could not read {name}: {e}"))),
    };
    // Never read through a link: it could point anywhere on the machine.
    if !meta.file_type().is_file() {
        return Err(user_err(format!("{name} is not a regular file.")));
    }
    if meta.len() > MAX_ARTIFACT_BYTES {
        return Err(user_err(format!(
            "{name} is too large to show (over 2 MB)."
        )));
    }
    let bytes =
        std::fs::read(&path).map_err(|e| user_err(format!("Could not read {name}: {e}")))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| user_err(format!("{name} is not a text file.")))
}

/// The error `start_task_impl` returns when the requested branch exists.
fn branch_taken(branch: &str) -> String {
    user_err(format!("Branch '{branch}' already exists."))
}

/// Create the task worktree for a new run of `factory_name` with `input`.
/// When the branch name is taken (an earlier run of the same input), retry
/// with `-2` up to `-9`.
pub(crate) async fn create_run_worktree(
    repo_path: &str,
    factory_name: &str,
    input: &str,
) -> Result<TaskInfo, String> {
    let base = worktree_branch(factory_name, input);
    for n in 1..=MAX_BRANCH_SUFFIX {
        let branch = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let request = StartTaskRequest {
            repo_path: repo_path.to_string(),
            title: format!("{factory_name} {input}"),
            base_branch: None,
            branch_name: Some(branch.clone()),
            worktree_root: None,
            setup_files: Vec::new(),
        };
        match start_task_impl(&request).await {
            Ok((_, task)) => return Ok(task),
            Err(e) if e == branch_taken(&branch) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(user_err(
        "A run for this input already has a branch. Finish or remove the earlier runs first.",
    ))
}

/// Best-effort undo of a worktree created for a run that then failed to start.
async fn discard_run_worktree(state: &State<'_, AppState>, task: TaskInfo) {
    // Nothing else refers to this fresh worktree. A failed cleanup keeps the
    // task row, so the user can still discard it from the Tasks UI.
    let removed = finish_task_impl(
        &task,
        &FinishAction::Discard {
            confirm_unmerged: true,
        },
    )
    .await;
    match removed {
        Ok(_) => {
            let _ = db_op(&state.db, move |db| db.delete_task(&task.worktree_path)).await;
        }
        Err(e) => report_bg(
            "factory_worktree_cleanup",
            format!(
                "Could not remove the worktree of a run that failed to start: {}",
                strip_user_prefix(&e)
            ),
        ),
    }
}

#[command]
pub async fn start_factory_run(
    state: State<'_, AppState>,
    factory_id: String,
    input: String,
) -> Result<RunStep, String> {
    wrap_cmd("start_factory_run", async move {
        let factory = db_op(&state.db, move |db| db.get_factory(&factory_id))
            .await?
            .ok_or_else(|| user_err("This factory no longer exists."))?;
        ensure_factory_repo_known(&state, &factory.repo_path).await?;
        let input = checked_input(&factory.definition, &input)?;
        let data_dir = blocking(factory_data_dir).await?;
        match factory.definition.workspace {
            Workspace::InPlace => {
                db_op(&state.db, move |db| {
                    start_run_in(db, &factory, &input, &data_dir, WorkspaceSpec::InPlace)
                })
                .await
            }
            Workspace::Worktree => {
                let task = create_run_worktree(&factory.repo_path, &factory.name, &input).await?;
                let registered = task.clone();
                let result = db_op(&state.db, move |db| {
                    db.insert_task(&registered)?;
                    start_run_in(
                        db,
                        &factory,
                        &input,
                        &data_dir,
                        WorkspaceSpec::Worktree(registered),
                    )
                })
                .await;
                if result.is_err() {
                    discard_run_worktree(&state, task).await;
                }
                result
            }
        }
    })
    .await
}

#[command]
pub async fn list_factory_runs(state: State<'_, AppState>) -> Result<Vec<FactoryRun>, String> {
    wrap_cmd("list_factory_runs", async move {
        db_op(&state.db, |db| db.list_factory_runs(RUN_LIST_LIMIT)).await
    })
    .await
}

#[command]
pub async fn get_factory_run_events(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Vec<RunEventRow>, String> {
    wrap_cmd("get_factory_run_events", async move {
        db_op(&state.db, move |db| {
            load_run(db, &run_id)?;
            db.list_factory_run_events(&run_id)
        })
        .await
    })
    .await
}

#[command]
pub async fn set_factory_run_terminal(
    state: State<'_, AppState>,
    run_id: String,
    terminal_id: Option<String>,
) -> Result<(), String> {
    wrap_cmd("set_factory_run_terminal", async move {
        db_op(&state.db, move |db| {
            load_run(db, &run_id)?;
            db.set_factory_run_terminal(&run_id, terminal_id.as_deref())
        })
        .await
    })
    .await
}

#[command]
pub async fn evaluate_factory_station(
    state: State<'_, AppState>,
    run_id: String,
    manual: bool,
    eval_id: String,
) -> Result<RunStep, String> {
    wrap_cmd("evaluate_factory_station", async move {
        evaluate_station(&state.db, run_id, manual, eval_id).await
    })
    .await
}

/// Returns false when no check with that id is running (already finished).
#[command]
pub async fn cancel_factory_check(eval_id: String) -> Result<bool, String> {
    wrap_cmd(
        "cancel_factory_check",
        async move { Ok(cancel_check(&eval_id)) },
    )
    .await
}

#[command]
pub async fn answer_factory_gate(
    state: State<'_, AppState>,
    run_id: String,
    step_id: String,
    approve: bool,
    reason: Option<String>,
) -> Result<RunStep, String> {
    wrap_cmd("answer_factory_gate", async move {
        db_op(&state.db, move |db| {
            answer_gate_in(db, &run_id, &step_id, approve, reason)
        })
        .await
    })
    .await
}

#[command]
pub async fn control_factory_run(
    state: State<'_, AppState>,
    run_id: String,
    op: RunControl,
) -> Result<RunStep, String> {
    wrap_cmd("control_factory_run", async move {
        db_op(&state.db, move |db| control_in(db, &run_id, op)).await
    })
    .await
}

#[command]
pub async fn next_queued_factory_run(
    state: State<'_, AppState>,
    factory_id: String,
) -> Result<Option<String>, String> {
    wrap_cmd("next_queued_factory_run", async move {
        db_op(&state.db, move |db| {
            db.oldest_queued_factory_run(&factory_id)
        })
        .await
    })
    .await
}

#[command]
pub async fn get_factory_artifact(
    state: State<'_, AppState>,
    run_id: String,
    name: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_factory_artifact", async move {
        let run = db_op(&state.db, move |db| load_run(db, &run_id)).await?;
        blocking(move || read_artifact(Path::new(&run.run_dir), &name)).await
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
        assert!(p.contains(
            "- In a check command, never write {run_dir} without double quotes around the path; prefer the AGENTRIUM_RUN_DIR environment variable."
        ));
    }

    #[test]
    fn unknown_folder_refusal_is_explained_without_the_verbatim_prefix() {
        let refusal = user_err(
            r"Open a session in '\\?\C:\repositories\backend-workspace' first, then start a task there.",
        );
        let path = unknown_repo_path(&refusal).unwrap();
        assert_eq!(
            unknown_repo_error(&path),
            user_err(
                r"Agentrium has not worked in this folder yet: C:\repositories\backend-workspace. Confirm the folder to continue."
            )
        );
        assert!(!unknown_repo_error(&path).contains(r"\\?\"));
        let plain = user_err("Open a session in '/home/me/repo' first, then start a task there.");
        assert_eq!(
            unknown_repo_error(&unknown_repo_path(&plain).unwrap()),
            user_err("Agentrium has not worked in this folder yet: /home/me/repo. Confirm the folder to continue.")
        );
    }

    #[test]
    fn confirm_dialog_text() {
        assert_eq!(CONFIRM_TITLE, "Add this folder?");
        assert_eq!(
            confirm_message(Path::new("/home/me/repo")),
            "Agentrium will read the factory files in this folder and run agent sessions there:\n\n/home/me/repo"
        );
    }

    fn canon(p: &Path) -> PathBuf {
        canonical_repo(p).unwrap()
    }

    #[test]
    fn a_confirmed_folder_and_its_subfolders_are_known() {
        let d = tempfile::tempdir().unwrap();
        let sub = d.path().join("packages").join("api");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(!is_confirmed(&canon(d.path())));
        remember_confirmed(canon(d.path()));
        assert!(is_confirmed(&canon(d.path())));
        assert!(is_confirmed(&canon(&sub)));
    }

    #[test]
    fn an_unrelated_folder_or_a_parent_of_a_confirmed_one_is_not_known() {
        let d = tempfile::tempdir().unwrap();
        let inner = d.path().join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let other = tempfile::tempdir().unwrap();
        remember_confirmed(canon(&inner));
        assert!(!is_confirmed(&canon(other.path())));
        assert!(!is_confirmed(&canon(d.path())));
    }

    #[test]
    fn the_repo_of_a_saved_factory_is_known_after_a_restart() {
        // A fresh database with a factory saved in an earlier app run and an
        // empty confirmed set: the factory must still start runs.
        let repo = tempfile::tempdir().unwrap();
        let sub = repo.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        let other = tempfile::tempdir().unwrap();
        let db = Database::new_in_memory().unwrap();
        let path = repo.path().to_string_lossy().into_owned();
        db.upsert_factory(&Factory {
            id: "f1".to_string(),
            name: "demo".to_string(),
            repo_path: path.clone(),
            source_path: format!("{path}/SKILL.md"),
            definition: sample(),
            created_at: "2026-11-19T00:00:00Z".to_string(),
            updated_at: "2026-11-19T00:00:00Z".to_string(),
        })
        .unwrap();
        let known =
            |db: &Database, p: &Path| inside_folders(&canon(p), &factory_repo_paths(db).unwrap());
        assert!(!is_confirmed(&canon(repo.path())));
        assert!(known(&db, repo.path()));
        assert!(known(&db, &sub));
        assert!(!known(&db, other.path()));
        let empty = Database::new_in_memory().unwrap();
        assert!(!known(&empty, repo.path()));
    }

    #[test]
    fn confirming_needs_an_existing_folder() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(
            existing_folder(&d.path().to_string_lossy()).unwrap(),
            canon(d.path())
        );
        let missing = d.path().join("nope");
        let missing = missing.to_string_lossy().into_owned();
        assert_eq!(
            existing_folder(&missing).unwrap_err(),
            user_err(format!("This folder does not exist: {missing}"))
        );
        let file = d.path().join("f.txt");
        write(&file, "x");
        let err = existing_folder(&file.to_string_lossy()).unwrap_err();
        assert!(err.contains("This folder does not exist: "), "{err}");
        assert!(!err.contains(r"\\?\"), "{err}");
    }

    #[test]
    fn other_repo_errors_are_not_the_unknown_folder_refusal() {
        assert_eq!(
            unknown_repo_path(&user_err("Invalid path 'C:\nope': not found")),
            None
        );
        assert_eq!(unknown_repo_path("db locked"), None);
    }

    #[test]
    fn disk_state_is_same_after_save_without_write() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "# process\n");
        let on_disk = sample();
        assert!(on_disk.source_sha256.is_empty());
        std::fs::write(
            definition_path_for(&source),
            serde_json::to_string_pretty(&on_disk).unwrap(),
        )
        .unwrap();
        let stored = prepare_save(d.path(), &source, on_disk, false).unwrap();
        assert!(!stored.source_sha256.is_empty());
        assert_eq!(disk_state(&stored, &source), DiskState::Same);
    }

    #[test]
    fn disk_state_ignores_source_fields_but_not_steps() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().join("SKILL.md");
        write(&source, "x");
        let file = definition_path_for(&source);
        let mut stored = sample();
        stored.source = "OTHER.md".to_string();
        stored.source_sha256 = "abc".to_string();
        std::fs::write(&file, serde_json::to_string_pretty(&sample()).unwrap()).unwrap();
        assert_eq!(disk_state(&stored, &source), DiskState::Same);
        let mut changed = sample();
        if let Step::Station(s) = &mut changed.steps[0] {
            s.prompt.push_str(" more");
        }
        std::fs::write(&file, serde_json::to_string_pretty(&changed).unwrap()).unwrap();
        assert_eq!(disk_state(&stored, &source), DiskState::Changed);
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

    // -----------------------------------------------------------------------
    // Run lifecycle
    // -----------------------------------------------------------------------

    use crate::database::Database;
    use crate::factory_def::Station;
    use crate::factory_engine::RunStatus;

    struct Env {
        db: Database,
        factory: Factory,
        data: tempfile::TempDir,
        workspace: tempfile::TempDir,
    }

    fn env_with(def: Definition) -> Env {
        let db = Database::new_in_memory().unwrap();
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path().to_string_lossy().into_owned();
        let factory = db
            .upsert_factory(&Factory {
                id: "f1".to_string(),
                name: "demo".to_string(),
                repo_path: ws.clone(),
                source_path: format!("{ws}/SKILL.md"),
                definition: def,
                created_at: "2026-11-19T00:00:00Z".to_string(),
                updated_at: "2026-11-19T00:00:00Z".to_string(),
            })
            .unwrap();
        Env {
            db,
            factory,
            data,
            workspace,
        }
    }

    fn env() -> Env {
        env_with(sample())
    }

    fn start(e: &Env, input: &str) -> Result<RunStep, String> {
        start_run_in(
            &e.db,
            &e.factory,
            input,
            e.data.path(),
            WorkspaceSpec::InPlace,
        )
    }

    fn station0_mut(def: &mut Definition) -> &mut Station {
        match &mut def.steps[0] {
            Step::Station(s) => s,
            Step::Gate(_) => panic!("not a station"),
        }
    }

    fn kinds(db: &Database, run_id: &str) -> Vec<String> {
        db.list_factory_run_events(run_id)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    fn started_prompt(step: &RunStep) -> (String, u32) {
        match &step.action {
            StepAction::StartStation {
                prompt, attempt, ..
            } => (prompt.clone(), *attempt),
            other => panic!("expected StartStation, got {other:?}"),
        }
    }

    #[test]
    fn start_creates_run_dir_and_first_station() {
        let e = env();
        let step = start(&e, "A-1").unwrap();
        let ws = e.workspace.path().to_string_lossy().into_owned();
        match &step.action {
            StepAction::StartStation {
                step_id,
                attempt,
                prompt,
                cwd,
                task,
                ..
            } => {
                assert_eq!(step_id, "S1");
                assert_eq!(*attempt, 1);
                assert!(prompt.contains("A-1"), "{prompt}");
                assert!(prompt.contains(&step.run.run_dir), "{prompt}");
                assert_eq!(cwd, &ws);
                assert_eq!(task, &None);
            }
            other => panic!("expected StartStation, got {other:?}"),
        }
        assert!(Path::new(&step.run.run_dir).is_dir());
        assert!(Path::new(&step.run.run_dir).starts_with(e.data.path().join("factory-runs")));
        assert_eq!(step.run.status, RunStatus::Running);
        assert_eq!(kinds(&e.db, &step.run.id), ["started"]);
    }

    #[test]
    fn start_refuses_blank_input() {
        let e = env();
        let err = start(&e, "   ").unwrap_err();
        assert!(err.contains("Enter the ticket."), "{err}");
        assert!(e.db.list_factory_runs(500).unwrap().is_empty());
    }

    #[test]
    fn start_refuses_unsafe_input_when_a_check_uses_it() {
        let e = env();
        let err = start(&e, "A-1; rm -rf .").unwrap_err();
        assert!(err.contains("may only contain"), "{err}");
        assert!(e.db.list_factory_runs(500).unwrap().is_empty());
        let runs = e.data.path().join("factory-runs");
        assert!(
            !runs.exists() || std::fs::read_dir(&runs).unwrap().next().is_none(),
            "a run dir was created"
        );
    }

    #[test]
    fn start_refuses_unsafe_input_when_any_station_has_a_check() {
        // The command never mentions {input}, but the input still reaches it
        // through AGENTRIUM_FACTORY_INPUT, which cmd expands before parsing.
        let mut def = sample();
        station0_mut(&mut def).check.as_mut().unwrap().command = "npm test".to_string();
        let e = env_with(def);
        let err = start(&e, "fix A & B").unwrap_err();
        assert!(err.contains("may only contain"), "{err}");
        assert!(e.db.list_factory_runs(500).unwrap().is_empty());
    }

    /// No station has a check, so nothing can execute the input.
    #[test]
    fn start_allows_free_text_input_when_no_check_uses_it() {
        let mut def = sample();
        station0_mut(&mut def).check = None;
        let e = env_with(def);
        let step = start(&e, "fix the login bug").unwrap();
        assert_eq!(step.run.input, "fix the login bug");
    }

    /// Write plan.md as the agent would during the station. Its modified time
    /// is set past `station_started_at` explicitly: the file system clock can
    /// lag the clock that stamped the mark by a few milliseconds.
    fn write_plan(run: &FactoryRun) {
        let plan = Path::new(&run.run_dir).join("plan.md");
        std::fs::write(&plan, "plan").unwrap();
        let started =
            chrono::DateTime::parse_from_rfc3339(run.station_started_at.as_deref().unwrap())
                .unwrap();
        set_mtime(
            &plan,
            std::time::SystemTime::from(started) + Duration::from_secs(1),
        );
    }

    /// Start a run, put plan.md in place and begin its check.
    fn checking(e: &Env) -> (FactoryRun, CheckToken) {
        let run = start(e, "A-1").unwrap().run;
        write_plan(&run);
        begin_check(&e.db, &run).unwrap()
    }

    #[test]
    fn late_check_result_after_resume_is_ignored() {
        let e = env();
        let (run, token) = checking(&e);
        assert_eq!(run.status, RunStatus::Checking);
        control_in(&e.db, &run.id, RunControl::Resume).unwrap();
        let before = kinds(&e.db, &run.id);

        let step = finish_check(&e.db, &run.id, token, CheckOutcome::Pass).unwrap();
        assert_eq!(step.action, StepAction::Waiting);
        assert_eq!(step.run.status, RunStatus::Running);
        assert_eq!(step.run.current_step, "S1");
        assert_eq!(kinds(&e.db, &run.id), before);
        assert_eq!(e.db.get_factory_run(&run.id).unwrap().unwrap(), step.run);
    }

    #[test]
    fn late_check_result_after_cancel_is_ignored() {
        let e = env();
        let (run, token) = checking(&e);
        control_in(&e.db, &run.id, RunControl::Cancel).unwrap();
        let before = kinds(&e.db, &run.id);

        let step = finish_check(
            &e.db,
            &run.id,
            token,
            CheckOutcome::Fail("boom".to_string()),
        )
        .unwrap();
        assert_eq!(step.action, StepAction::Waiting);
        assert_eq!(step.run.status, RunStatus::Cancelled);
        assert_eq!(kinds(&e.db, &run.id), before);
    }

    #[test]
    fn only_the_newest_check_after_resume_is_applied() {
        let e = env();
        let (run, old) = checking(&e);
        let resumed = control_in(&e.db, &run.id, RunControl::Resume).unwrap().run;
        let (_, new) = begin_check(&e.db, &resumed).unwrap();
        assert_ne!(old, new);

        let ignored = finish_check(&e.db, &run.id, old, CheckOutcome::Pass).unwrap();
        assert_eq!(ignored.action, StepAction::Waiting);
        assert_eq!(ignored.run.status, RunStatus::Checking);

        let applied = finish_check(&e.db, &run.id, new, CheckOutcome::Pass).unwrap();
        assert_eq!(
            applied.action,
            StepAction::AwaitGate {
                step_id: "G1".to_string()
            }
        );
        // The token is spent: a repeat of the same result changes nothing.
        let again = finish_check(&e.db, &run.id, new, CheckOutcome::Pass).unwrap();
        assert_eq!(again.action, StepAction::Waiting);
        assert_eq!(again.run.status, RunStatus::WaitingGate);
    }

    #[test]
    fn second_in_place_run_is_queued() {
        let e = env();
        start(&e, "A-1").unwrap();
        let second = start(&e, "A-2").unwrap();
        assert_eq!(second.action, StepAction::Queued);
        assert_eq!(second.run.status, RunStatus::Queued);
    }

    #[test]
    fn evaluate_waits_for_a_missing_artifact() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        assert_eq!(
            evaluate_decision(&run, false).unwrap(),
            EvalDecision::Waiting
        );
        let err = evaluate_decision(&run, true).unwrap_err();
        assert!(
            err.contains("plan.md is not in the run folder yet."),
            "{err}"
        );
    }

    #[test]
    fn evaluate_runs_the_check_when_the_artifact_exists() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        write_plan(&run);
        assert_eq!(
            evaluate_decision(&run, false).unwrap(),
            EvalDecision::RunCheck {
                command: "node check.js A-1".to_string(),
                timeout: std::time::Duration::from_secs(300),
            }
        );
    }

    fn set_mtime(path: &Path, at: std::time::SystemTime) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(at)
            .unwrap();
    }

    /// Start a run, pass S1 with plan.md written an hour ago, then reject at
    /// G1 so S1 is re-entered. Returns the re-entered run and plan.md's path.
    fn re_entered(e: &Env) -> (FactoryRun, PathBuf) {
        let run = start(e, "A-1").unwrap().run;
        let plan = Path::new(&run.run_dir).join("plan.md");
        std::fs::write(&plan, "old plan").unwrap();
        set_mtime(
            &plan,
            std::time::SystemTime::now() - Duration::from_secs(3600),
        );
        finish_evaluation(&e.db, &run, CheckOutcome::Pass).unwrap();
        let step =
            answer_gate_in(&e.db, &run.id, "G1", false, Some("cover AC2".to_string())).unwrap();
        assert!(
            matches!(&step.action, StepAction::StartStation { step_id, .. } if step_id == "S1")
        );
        (step.run, plan)
    }

    fn check_of_s1() -> EvalDecision {
        EvalDecision::RunCheck {
            command: "node check.js A-1".to_string(),
            timeout: Duration::from_secs(300),
        }
    }

    #[test]
    fn stale_artifact_does_not_pass_a_re_entered_station() {
        let e = env();
        let (run, _) = re_entered(&e);
        assert_eq!(
            evaluate_decision(&run, false).unwrap(),
            EvalDecision::Waiting
        );
    }

    #[test]
    fn artifact_written_after_re_entry_passes() {
        let e = env();
        let (run, plan) = re_entered(&e);
        std::fs::write(&plan, "new plan").unwrap();
        set_mtime(
            &plan,
            std::time::SystemTime::now() + Duration::from_secs(60),
        );
        assert_eq!(evaluate_decision(&run, false).unwrap(), check_of_s1());
    }

    #[test]
    fn manual_evaluation_accepts_a_stale_artifact() {
        let e = env();
        let (run, _) = re_entered(&e);
        assert_eq!(evaluate_decision(&run, true).unwrap(), check_of_s1());
    }

    #[test]
    fn resume_does_not_move_station_started_at() {
        let e = env();
        let started = start(&e, "A-1").unwrap().run;
        assert!(started.station_started_at.is_some());
        let mut run = started;
        let mark = Some("2026-11-19T00:00:00+00:00".to_string());
        run.station_started_at = mark.clone();
        e.db.update_factory_run(&run).unwrap();

        let resumed = control_in(&e.db, &run.id, RunControl::Resume).unwrap();
        assert!(matches!(resumed.action, StepAction::StartStation { .. }));
        assert_eq!(resumed.run.station_started_at, mark);
        assert_eq!(
            e.db.get_factory_run(&run.id)
                .unwrap()
                .unwrap()
                .station_started_at,
            mark
        );

        // Any other way into a station moves the mark.
        let failed =
            finish_evaluation(&e.db, &resumed.run, CheckOutcome::Fail("again".to_string()))
                .unwrap();
        assert!(matches!(failed.action, StepAction::StartStation { .. }));
        assert_ne!(failed.run.station_started_at, mark);
    }

    fn shared(db: Database) -> std::sync::Arc<std::sync::Mutex<Database>> {
        std::sync::Arc::new(std::sync::Mutex::new(db))
    }

    #[tokio::test]
    async fn evaluate_refuses_a_run_that_is_already_checking() {
        let e = env();
        let mut run = start(&e, "A-1").unwrap().run;
        write_plan(&run);
        run.status = RunStatus::Checking;
        e.db.update_factory_run(&run).unwrap();
        let err = evaluate_decision(&run, true).unwrap_err();
        assert!(err.contains("This run is already being checked."), "{err}");

        let Env {
            db,
            data,
            workspace,
            ..
        } = e;
        let db = shared(db);
        let err = evaluate_station(&db, run.id.clone(), true, "eval-1".to_string())
            .await
            .unwrap_err();
        assert!(err.contains("This run is already being checked."), "{err}");
        let stored = db
            .lock()
            .unwrap()
            .get_factory_run(&run.id)
            .unwrap()
            .unwrap();
        assert_eq!(stored, run);
        drop((data, workspace));
    }

    #[test]
    fn station_with_neither_passes_only_manually() {
        let e = env();
        let mut run = start(&e, "A-1").unwrap().run;
        run.current_step = "S2".to_string();
        assert_eq!(
            evaluate_decision(&run, false).unwrap(),
            EvalDecision::Waiting
        );
        assert_eq!(evaluate_decision(&run, true).unwrap(), EvalDecision::Pass);
    }

    #[test]
    fn finish_evaluation_pass_moves_to_gate_and_logs() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        let step = finish_evaluation(&e.db, &run, CheckOutcome::Pass).unwrap();
        assert_eq!(
            step.action,
            StepAction::AwaitGate {
                step_id: "G1".to_string()
            }
        );
        assert_eq!(kinds(&e.db, &run.id), ["started", "passed"]);
    }

    #[test]
    fn finish_evaluation_fail_restarts_with_output_in_prompt() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        let step = finish_evaluation(
            &e.db,
            &run,
            CheckOutcome::Fail("AC2 is not covered".to_string()),
        )
        .unwrap();
        let (prompt, attempt) = started_prompt(&step);
        assert!(prompt.contains("AC2 is not covered"), "{prompt}");
        assert_eq!(attempt, 2);
        assert_eq!(kinds(&e.db, &run.id), ["started", "failed"]);
    }

    #[test]
    fn reject_restarts_station_with_reason_in_prompt() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        finish_evaluation(&e.db, &run, CheckOutcome::Pass).unwrap();
        let step =
            answer_gate_in(&e.db, &run.id, "G1", false, Some("cover AC2".to_string())).unwrap();
        let (prompt, attempt) = started_prompt(&step);
        assert!(prompt.contains("cover AC2"), "{prompt}");
        assert_eq!(attempt, 1);
        let events = e.db.list_factory_run_events(&run.id).unwrap();
        let last = events.last().unwrap();
        assert_eq!(
            (last.kind.as_str(), last.detail.as_str()),
            ("rejected", "cover AC2")
        );
    }

    #[test]
    fn approve_then_last_station_manual_pass_finishes() {
        let e = env();
        let run = start(&e, "A-1").unwrap().run;
        finish_evaluation(&e.db, &run, CheckOutcome::Pass).unwrap();
        let step = answer_gate_in(&e.db, &run.id, "G1", true, None).unwrap();
        assert!(
            matches!(&step.action, StepAction::StartStation { step_id, .. } if step_id == "S2")
        );
        assert_eq!(
            evaluate_decision(&step.run, true).unwrap(),
            EvalDecision::Pass
        );
        let done = finish_evaluation(&e.db, &step.run, CheckOutcome::Pass).unwrap();
        assert_eq!(done.action, StepAction::Finished);
        assert_eq!(done.run.status, RunStatus::Done);
        assert_eq!(
            e.db.get_factory_run(&run.id).unwrap().unwrap().status,
            RunStatus::Done
        );
    }

    #[test]
    fn cancel_then_line_freed_starts_the_queued_run() {
        let e = env();
        let a = start(&e, "A-1").unwrap().run;
        let b = start(&e, "A-2").unwrap().run;
        let cancelled = control_in(&e.db, &a.id, RunControl::Cancel).unwrap();
        assert_eq!(cancelled.action, StepAction::Cancelled);
        assert_eq!(
            e.db.oldest_queued_factory_run(&e.factory.id).unwrap(),
            Some(b.id.clone())
        );
        let step = control_in(&e.db, &b.id, RunControl::LineFreed).unwrap();
        assert!(
            matches!(&step.action, StepAction::StartStation { step_id, .. } if step_id == "S1")
        );
    }

    #[test]
    fn missing_run_is_a_user_error() {
        let e = env();
        let err = control_in(&e.db, "nope", RunControl::Cancel).unwrap_err();
        assert!(err.contains("This run no longer exists."), "{err}");
    }

    #[test]
    fn read_artifact_cases() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("plan.md"), "the plan").unwrap();
        assert_eq!(
            read_artifact(d.path(), "plan.md").unwrap().as_deref(),
            Some("the plan")
        );
        assert_eq!(read_artifact(d.path(), "missing.md").unwrap(), None);
        let err = read_artifact(d.path(), "../x").unwrap_err();
        assert!(err.contains("Not an artifact name."), "{err}");
        std::fs::write(d.path().join("big.txt"), vec![b'a'; 3 * 1024 * 1024]).unwrap();
        let err = read_artifact(d.path(), "big.txt").unwrap_err();
        assert!(err.contains("too large"), "{err}");
        std::fs::write(d.path().join("bin.dat"), [0xff, 0xfe, 0x00]).unwrap();
        let err = read_artifact(d.path(), "bin.dat").unwrap_err();
        assert!(err.contains("is not a text file"), "{err}");
    }

    #[test]
    fn step_action_wire_shape() {
        let action = StepAction::StartStation {
            step_id: "S1".to_string(),
            step_name: "Plan".to_string(),
            attempt: 1,
            prompt: "p".to_string(),
            agent: AgentKind::Claude,
            cwd: "/w".to_string(),
            task: Some(Box::new(TaskInfo {
                title: "demo A-1".to_string(),
                branch: "agentrium/factory-demo-a-1".to_string(),
                base_branch: "main".to_string(),
                worktree_path: "/w".to_string(),
                repo_path: "/r".to_string(),
                race_id: None,
            })),
        };
        let v = serde_json::to_value(&action).unwrap();
        assert_eq!(v["kind"], "start_station");
        assert_eq!(v["stepId"], "S1");
        assert_eq!(v["stepName"], "Plan");
        assert_eq!(v["agent"], "claude");
        assert_eq!(v["task"]["baseBranch"], "main");
        let gate = serde_json::to_value(StepAction::AwaitGate {
            step_id: "G1".to_string(),
        })
        .unwrap();
        assert_eq!(
            gate,
            serde_json::json!({"kind": "await_gate", "stepId": "G1"})
        );
        assert_eq!(
            serde_json::to_value(StepAction::Waiting).unwrap(),
            serde_json::json!({"kind": "waiting"})
        );
        let op: RunControl = serde_json::from_str("\"allow_retry\"").unwrap();
        assert_eq!(op, RunControl::AllowRetry);
    }

    #[test]
    fn worktree_branch_slugs() {
        assert_eq!(
            worktree_branch("Demo Flow", "WGCP-123 fix!"),
            "agentrium/factory-demo-flow-wgcp-123-fix"
        );
        let long = worktree_branch(&"x".repeat(60), "a");
        assert_eq!(long, format!("agentrium/factory-{}-a", "x".repeat(40)));
    }

    /// One factory with a single check station, started with input `A-1`.
    fn check_env(command: &str) -> (Env, FactoryRun) {
        let mut def = sample();
        station0_mut(&mut def).check.as_mut().unwrap().command = command.to_string();
        let e = env_with(def);
        let run = start(&e, "A-1").unwrap().run;
        write_plan(&run);
        (e, run)
    }

    #[tokio::test]
    async fn check_exit_code_decides_pass_or_fail() {
        // The passing command also proves AGENTRIUM_RUN_DIR reaches the check.
        let (pass_cmd, fail_cmd) = if cfg!(windows) {
            (
                "if defined AGENTRIUM_RUN_DIR (exit 0) else (exit 7)",
                "cmd /C exit 1",
            )
        } else {
            (r#"test -n "$AGENTRIUM_RUN_DIR""#, "sh -c 'exit 1'")
        };

        let (e, run) = check_env(pass_cmd);
        let Env {
            db,
            data,
            workspace,
            ..
        } = e;
        let db = shared(db);
        let step = evaluate_station(&db, run.id.clone(), false, "eval-pass".to_string())
            .await
            .unwrap();
        assert_eq!(
            step.action,
            StepAction::AwaitGate {
                step_id: "G1".to_string()
            }
        );
        assert_eq!(kinds(&db.lock().unwrap(), &run.id), ["started", "passed"]);
        drop((data, workspace));

        let (e, run) = check_env(fail_cmd);
        let Env {
            db,
            data,
            workspace,
            ..
        } = e;
        let db = shared(db);
        let step = evaluate_station(&db, run.id.clone(), false, "eval-fail".to_string())
            .await
            .unwrap();
        assert_eq!(started_prompt(&step).1, 2);
        assert_eq!(kinds(&db.lock().unwrap(), &run.id), ["started", "failed"]);
        drop((data, workspace));
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A git repo with one commit on `main`, inside a temp folder that also
    /// holds the managed worktree root.
    fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        (tmp, repo)
    }

    #[tokio::test]
    async fn a_second_worktree_run_with_the_same_input_gets_a_suffixed_branch() {
        let (_tmp, repo) = temp_repo();
        let repo = repo.to_string_lossy().into_owned();
        let first = create_run_worktree(&repo, "demo", "A-1").await.unwrap();
        let second = create_run_worktree(&repo, "demo", "A-1").await.unwrap();
        assert_eq!(first.branch, "agentrium/factory-demo-a-1");
        assert_eq!(second.branch, "agentrium/factory-demo-a-1-2");
        assert_ne!(first.worktree_path, second.worktree_path);
    }

    #[tokio::test]
    async fn worktree_run_gives_up_after_nine_branches() {
        let (_tmp, repo) = temp_repo();
        git(&repo, &["branch", "agentrium/factory-demo-a-1"]);
        for n in 2..=9 {
            git(
                &repo,
                &["branch", &format!("agentrium/factory-demo-a-1-{n}")],
            );
        }
        let err = create_run_worktree(&repo.to_string_lossy(), "demo", "A-1")
            .await
            .unwrap_err();
        assert_eq!(
            err,
            user_err("A run for this input already has a branch. Finish or remove the earlier runs first.")
        );
    }
}
