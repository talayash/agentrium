//! Race mode (best-of-N): one task prompt goes to 2-4 agent/model
//! contenders at once, each in its own task worktree created from the same
//! base commit. The user compares the results, merges the winner through the
//! normal task finish path and discards the rest.
//!
//! Trust model: same as `tasks.rs`. `start_race` requires a trusted repo and
//! records every worktree in both the `tasks` registry (with `race_id`) and
//! `race_contenders`. Every later command takes a race id plus worktree paths
//! and only acts on worktrees recorded for that race. `run_race_check` runs
//! only the check command stored on the race row (typed by the user in the
//! New Race modal or settings), never a command from the renderer at check
//! time, from repo files or from agent output.

use crate::commands::{db_op, wrap_cmd};
use crate::config::AgentKind;
use crate::error_reporter::user_err;
use crate::tasks::{
    self, branch_exists, git, git_ok, git_user, managed_root, native_path, same_path, slugify,
    unique_slug, validate_branch_name, FinishAction, FinishTaskResult, MergeMode, TaskInfo,
    BRANCH_PREFIX, MAX_SUFFIX,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{command, State};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

pub const MIN_CONTENDERS: usize = 2;
pub const MAX_CONTENDERS: usize = 4;
const MAX_PROMPT_CHARS: usize = 100_000;
const MAX_CHECK_COMMAND_LEN: usize = 2_000;
const TITLE_SLUG_LEN: usize = 24;
const PART_SLUG_LEN: usize = 20;
/// Bytes of check output kept (the tail is what matters for a failing test).
const CHECK_TAIL_BYTES: usize = 16 * 1024;
pub const DEFAULT_CHECK_TIMEOUT_SECS: u64 = 600;
const MAX_CHECK_TIMEOUT_SECS: u64 = 3 * 60 * 60;
/// Files bigger than this are not loaded into the compare view.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RaceStatus {
    Running,
    Judging,
    Decided,
    Abandoned,
}

impl RaceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RaceStatus::Running => "running",
            RaceStatus::Judging => "judging",
            RaceStatus::Decided => "decided",
            RaceStatus::Abandoned => "abandoned",
        }
    }

    /// Unknown values (a row written by a newer build) read as decided so
    /// nothing tries to act on them.
    pub fn parse(s: &str) -> Self {
        match s {
            "running" => RaceStatus::Running,
            "judging" => RaceStatus::Judging,
            "abandoned" => RaceStatus::Abandoned,
            _ => RaceStatus::Decided,
        }
    }

    pub fn is_open(self) -> bool {
        matches!(self, RaceStatus::Running | RaceStatus::Judging)
    }
}

/// One contender. `outcome` is `pending` until the race is decided, then
/// `winner`, `discarded`, `kept` (branch kept) or `left` (cleanup failed;
/// the worktree is still a normal task).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaceContender {
    pub idx: u32,
    pub agent: AgentKind,
    pub model: Option<String>,
    pub args: Vec<String>,
    pub label: String,
    pub branch: String,
    pub worktree_path: String,
    pub terminal_id: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub outcome: String,
    /// Frontend snapshot for history (time, cost, files, +/-, check).
    pub stats: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Race {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub repo_path: String,
    pub base_branch: String,
    /// The base branch resolved once at start: every contender starts here.
    pub base_sha: String,
    pub created_at: String,
    pub status: RaceStatus,
    /// Worktree path of the winning contender.
    pub winner_task: Option<String>,
    pub decided_at: Option<String>,
    pub check_command: Option<String>,
    pub contenders: Vec<RaceContender>,
}

impl Race {
    pub fn contender(&self, worktree_path: &str) -> Option<&RaceContender> {
        self.contenders
            .iter()
            .find(|c| same_path(&c.worktree_path, worktree_path))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ContenderSpec {
    pub agent: AgentKind,
    #[serde(default)]
    pub model: Option<String>,
    /// Final launch args (profile/defaults plus the model flag).
    #[serde(default)]
    pub args: Vec<String>,
    /// Display label, e.g. "Codex · gpt-5.6-sol".
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartRaceRequest {
    pub repo_path: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    pub contenders: Vec<ContenderSpec>,
    #[serde(default)]
    pub worktree_root: Option<String>,
    #[serde(default)]
    pub setup_files: Vec<String>,
    #[serde(default)]
    pub check_command: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn capped_slug(text: &str, max: usize) -> String {
    let mut s = slugify(text);
    if s.len() > max {
        s.truncate(max);
        s = s.trim_end_matches('-').to_string();
    }
    s
}

/// `race-<title>-<model or agent label>`, the folder and the branch name
/// minus the `agentrium/` prefix (collisions get the usual `-2` suffix).
pub fn contender_slug(title: &str, spec: &ContenderSpec) -> String {
    let part = spec
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(&spec.label);
    format!(
        "race-{}-{}",
        capped_slug(title, TITLE_SLUG_LEN),
        capped_slug(part, PART_SLUG_LEN)
    )
}

pub fn validate_check_command(command: &str) -> Result<(), String> {
    if command.len() > MAX_CHECK_COMMAND_LEN {
        return Err(user_err("The check command is too long."));
    }
    if command.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(user_err("The check command must be a single line."));
    }
    Ok(())
}

fn validate_start(req: &StartRaceRequest) -> Result<(), String> {
    if req.title.trim().is_empty() {
        return Err(user_err("Give the race a title."));
    }
    if req.prompt.trim().is_empty() {
        return Err(user_err("Enter the task prompt."));
    }
    if req.prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(user_err("The task prompt is too long."));
    }
    if req.contenders.len() < MIN_CONTENDERS || req.contenders.len() > MAX_CONTENDERS {
        return Err(user_err(format!(
            "A race needs {MIN_CONTENDERS} to {MAX_CONTENDERS} contenders."
        )));
    }
    for c in &req.contenders {
        let label = c.label.trim();
        if label.is_empty() || label.chars().count() > 80 {
            return Err(user_err("Every contender needs a short label."));
        }
        if let Some(m) = c.model.as_deref() {
            // `[`/`]` are allowed for Claude's `sonnet[1m]` style aliases; the
            // spawn path re-validates the final args anyway.
            let bad = m.chars().any(|ch| {
                ch != '['
                    && ch != ']'
                    && crate::terminal::TerminalManager::SHELL_METACHARACTERS.contains(&ch)
            });
            if bad || m.len() > 120 {
                return Err(user_err(format!("Invalid model name '{m}'.")));
            }
        }
    }
    if let Some(cmd) = req.check_command.as_deref() {
        validate_check_command(cmd)?;
    }
    Ok(())
}

/// Plain repo-relative path (normal components only), as git prints it.
pub fn validate_rel_path(rel: &str) -> Result<PathBuf, String> {
    let reject = || user_err(format!("'{rel}' is not a path inside the repository."));
    if rel.trim().is_empty() || rel.contains('\0') {
        return Err(reject());
    }
    let mut out = PathBuf::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            _ => return Err(reject()),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/// Name of the operation the checkout is in the middle of, if any.
pub async fn in_progress_operation(repo: &Path) -> Option<&'static str> {
    for (marker, what) in [
        ("MERGE_HEAD", "a merge"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
    ] {
        if let Ok(p) = git(repo, &["rev-parse", "--git-path", marker]).await {
            let p = native_path(p.trim());
            let full = if p.is_absolute() { p } else { repo.join(p) };
            if full.exists() {
                return Some(what);
            }
        }
    }
    None
}

async fn resolve_base(repo: &Path, requested: Option<&str>) -> Result<(String, String), String> {
    let base = match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            let head = git_user(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
            let head = head.trim().to_string();
            if head == "HEAD" || head.is_empty() {
                return Err(user_err(
                    "The repository is on a detached HEAD. Pick a base branch.",
                ));
            }
            head
        }
    };
    validate_branch_name(&base)?;
    let sha = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
    )
    .await
    .map_err(|_| user_err(format!("Base branch '{base}' does not exist.")))?;
    Ok((base, sha.trim().to_string()))
}

async fn pick_slug(
    repo: &Path,
    root: &Path,
    base_slug: &str,
    reserved: &HashSet<String>,
) -> Result<String, String> {
    // Collect taken names up front: `unique_slug` takes a sync closure.
    let mut taken = HashSet::new();
    for n in 1..=MAX_SUFFIX {
        let s = if n == 1 {
            base_slug.to_string()
        } else {
            format!("{base_slug}-{n}")
        };
        if reserved.contains(&s)
            || root.join(&s).exists()
            || branch_exists(repo, &format!("{BRANCH_PREFIX}{s}")).await
        {
            taken.insert(s);
        } else {
            break;
        }
    }
    unique_slug(base_slug, |s| taken.contains(s))
}

/// Remove worktrees and branches created by a failed start. Best-effort:
/// every step runs even if an earlier one fails.
async fn rollback(repo: &Path, created: &[(String, String)]) {
    for (wt, branch) in created.iter().rev() {
        if Path::new(wt).exists() {
            let _ = git(repo, &["worktree", "remove", "--force", wt]).await;
        }
        if branch_exists(repo, branch).await {
            let _ = git(repo, &["branch", "-D", branch]).await;
        }
    }
    let _ = git(repo, &["worktree", "prune"]).await;
}

/// Create one worktree per contender, all from the same base commit. If any
/// contender fails, the ones already created are removed and the error is a
/// user error naming the contender.
pub async fn start_race_impl(req: &StartRaceRequest) -> Result<(Race, Vec<TaskInfo>), String> {
    validate_start(req)?;
    let repo = tasks::main_repo_root(Path::new(&req.repo_path)).await?;
    if let Some(what) = in_progress_operation(&repo).await {
        return Err(user_err(format!(
            "'{}' is in the middle of {what}. Finish or abort it, then start the race.",
            repo.display()
        )));
    }
    let (base, base_sha) = resolve_base(&repo, req.base_branch.as_deref()).await?;
    let root = managed_root(&repo, req.worktree_root.as_deref())?;
    std::fs::create_dir_all(&root)
        .map_err(|e| user_err(format!("Cannot create '{}': {e}", root.display())))?;

    let race_id = uuid::Uuid::new_v4().to_string();
    let title = req.title.trim().to_string();
    let repo_str = repo.to_string_lossy().to_string();
    let mut created: Vec<(String, String)> = Vec::new();
    let mut reserved = HashSet::new();
    let mut contenders = Vec::new();
    let mut infos = Vec::new();

    for (i, spec) in req.contenders.iter().enumerate() {
        let attempt: Result<(String, String), String> = async {
            let slug = pick_slug(&repo, &root, &contender_slug(&title, spec), &reserved).await?;
            reserved.insert(slug.clone());
            let branch = format!("{BRANCH_PREFIX}{slug}");
            validate_branch_name(&branch)?;
            let wt = root.join(&slug).to_string_lossy().to_string();
            if let Err(e) = git(&repo, &["worktree", "add", "-b", &branch, &wt, &base_sha]).await {
                // A half-created worktree/branch from this attempt is ours too.
                rollback(&repo, &[(wt.clone(), branch.clone())]).await;
                return Err(e);
            }
            created.push((wt.clone(), branch.clone()));
            tasks::copy_setup_files(&repo, Path::new(&wt), &req.setup_files)?;
            Ok((wt, branch))
        }
        .await;
        let (wt, branch) = match attempt {
            Ok(v) => v,
            Err(e) => {
                rollback(&repo, &created).await;
                return Err(user_err(format!(
                    "Could not create the worktree for contender {} ({}), so the race was not started:\n\n{}",
                    i + 1,
                    spec.label.trim(),
                    crate::error_reporter::strip_user_prefix(&e)
                )));
            }
        };
        contenders.push(RaceContender {
            idx: i as u32,
            agent: spec.agent.clone(),
            model: spec.model.clone().filter(|m| !m.trim().is_empty()),
            args: spec.args.clone(),
            label: spec.label.trim().to_string(),
            branch: branch.clone(),
            worktree_path: wt.clone(),
            terminal_id: None,
            started_at: None,
            finished_at: None,
            outcome: "pending".into(),
            stats: None,
        });
        infos.push(TaskInfo {
            title: title.clone(),
            branch,
            base_branch: base.clone(),
            worktree_path: wt,
            repo_path: repo_str.clone(),
            race_id: Some(race_id.clone()),
        });
    }

    let race = Race {
        id: race_id,
        title,
        prompt: req.prompt.clone(),
        repo_path: repo_str,
        base_branch: base,
        base_sha,
        created_at: chrono::Utc::now().to_rfc3339(),
        status: RaceStatus::Running,
        winner_task: None,
        decided_at: None,
        check_command: req
            .check_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_string),
        contenders,
    };
    Ok((race, infos))
}

/// Undo a started race whose registration failed (DB error).
pub async fn discard_started(race: &Race) {
    let created: Vec<(String, String)> = race
        .contenders
        .iter()
        .map(|c| (c.worktree_path.clone(), c.branch.clone()))
        .collect();
    rollback(Path::new(&race.repo_path), &created).await;
}

// ---------------------------------------------------------------------------
// Diff stats and file versions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RaceFileStat {
    pub path: String,
    /// `A`, `M`, `D`, `T` from git, or `??` for an untracked new file.
    pub status: String,
    /// `None` for binary files.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContenderDiff {
    pub worktree_path: String,
    pub exists: bool,
    pub files: Vec<RaceFileStat>,
    pub added: u32,
    pub removed: u32,
    pub commits_ahead: u32,
    pub uncommitted: u32,
}

fn count_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let n = bytes.iter().filter(|b| **b == b'\n').count();
    let trailing = !bytes.is_empty() && *bytes.last().unwrap_or(&b'\n') != b'\n';
    Some((n + usize::from(trailing)) as u32)
}

/// Everything the contender changed relative to the race's base commit:
/// commits, staged and unstaged edits, and untracked new files.
pub async fn contender_diff_impl(base_sha: &str, worktree: &Path) -> Result<ContenderDiff, String> {
    let wt_str = worktree.to_string_lossy().to_string();
    if !worktree.is_dir() {
        return Ok(ContenderDiff {
            worktree_path: wt_str,
            exists: false,
            files: Vec::new(),
            added: 0,
            removed: 0,
            commits_ahead: 0,
            uncommitted: 0,
        });
    }
    let q = ["-c", "core.quotepath=off"];
    let numstat = git_user(
        worktree,
        &[
            q[0],
            q[1],
            "diff",
            "--numstat",
            "--no-renames",
            "-z",
            base_sha,
        ],
    )
    .await?;
    let name_status = git_user(
        worktree,
        &[
            q[0],
            q[1],
            "diff",
            "--name-status",
            "--no-renames",
            "-z",
            base_sha,
        ],
    )
    .await?;
    let mut status_of: HashMap<String, String> = HashMap::new();
    let mut parts = name_status.split('\0').filter(|s| !s.is_empty());
    while let (Some(st), Some(path)) = (parts.next(), parts.next()) {
        status_of.insert(
            path.to_string(),
            st.chars().next().unwrap_or('M').to_string(),
        );
    }
    let mut files = Vec::new();
    for rec in numstat.split('\0').filter(|s| !s.is_empty()) {
        let mut cols = rec.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        files.push(RaceFileStat {
            status: status_of.get(path).cloned().unwrap_or_else(|| "M".into()),
            path: path.to_string(),
            added: a.parse().ok(),
            removed: r.parse().ok(),
        });
    }
    let untracked = git_user(
        worktree,
        &[
            q[0],
            q[1],
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )
    .await?;
    for path in untracked.split('\0').filter(|s| !s.is_empty()) {
        files.push(RaceFileStat {
            path: path.to_string(),
            status: "??".into(),
            added: count_lines(&worktree.join(native_path(path))),
            removed: Some(0),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let commits_ahead = git_user(
        worktree,
        &["rev-list", "--count", &format!("{base_sha}..HEAD")],
    )
    .await?
    .trim()
    .parse()
    .unwrap_or(0);
    let uncommitted = tasks::uncommitted(worktree).await?.len() as u32;
    Ok(ContenderDiff {
        worktree_path: wt_str,
        exists: true,
        added: files.iter().filter_map(|f| f.added).sum(),
        removed: files.iter().filter_map(|f| f.removed).sum(),
        files,
        commits_ahead,
        uncommitted,
    })
}

fn decode_text(bytes: Vec<u8>, rel: &str) -> Result<String, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(user_err(format!("'{rel}' is too large to compare here.")));
    }
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(user_err(format!("'{rel}' is a binary file.")));
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// A file's text in the base commit (`source == "base"`) or in a contender's
/// worktree (`source` = that worktree path). `None` when it does not exist
/// there (added or deleted by the contender).
pub async fn race_file_impl(
    race: &Race,
    source: &str,
    rel: &str,
) -> Result<Option<String>, String> {
    let rel_path = validate_rel_path(rel)?;
    let git_rel = rel_path.to_string_lossy().replace('\\', "/");
    if source == "base" {
        let repo = Path::new(&race.repo_path);
        let spec = format!("{}:{git_rel}", race.base_sha);
        if !git_ok(repo, &["cat-file", "-e", &spec]).await {
            return Ok(None);
        }
        let out = crate::commands::git_cmd_async(&["show", &spec])
            .current_dir(repo)
            .output()
            .await
            .map_err(|e| crate::commands::spawn_err("git show", e))?;
        if !out.status.success() {
            return Err(user_err(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        return decode_text(out.stdout, rel).map(Some);
    }
    let contender = race
        .contender(source)
        .ok_or_else(|| user_err("That worktree is not part of this race."))?;
    let root = PathBuf::from(&contender.worktree_path);
    let file = root.join(&rel_path);
    if !file.is_file() {
        return Ok(None);
    }
    // Refuse symlinks that leave the worktree.
    let (Ok(real), Ok(root_real)) = (file.canonicalize(), root.canonicalize()) else {
        return Ok(None);
    };
    if !real.starts_with(&root_real) {
        return Err(user_err(format!("'{rel}' points outside the worktree.")));
    }
    let bytes = std::fs::read(&real).map_err(|e| user_err(format!("Cannot read '{rel}': {e}")))?;
    decode_text(bytes, rel).map(Some)
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RaceCheckResult {
    /// `None` when the process was killed (timeout, cancel, signal).
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    /// Last `CHECK_TAIL_BYTES` of stdout+stderr, ANSI stripped.
    pub output_tail: String,
    pub truncated: bool,
}

#[derive(Default)]
struct Tail {
    buf: VecDeque<u8>,
    truncated: bool,
}

impl Tail {
    fn push(&mut self, data: &[u8]) {
        self.buf.extend(data);
        while self.buf.len() > CHECK_TAIL_BYTES {
            self.buf.pop_front();
            self.truncated = true;
        }
    }
}

fn check_command_for(command: &str) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = tokio::process::Command::new(comspec);
        // `/S /C "<cmd>"`: cmd strips exactly the outer quotes and runs the
        // user's command line verbatim; `/D` skips AutoRun registry hooks.
        c.raw_arg(format!("/D /S /C \"{command}\""));
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        const VALID_SHELLS: &[&str] = &[
            "/bin/bash",
            "/bin/sh",
            "/bin/zsh",
            "/usr/bin/bash",
            "/usr/bin/sh",
            "/usr/bin/zsh",
            "/usr/local/bin/bash",
            "/usr/local/bin/zsh",
            "/opt/homebrew/bin/bash",
            "/opt/homebrew/bin/zsh",
        ];
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| VALID_SHELLS.contains(&s.as_str()))
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut c = tokio::process::Command::new(shell);
        // Login shell so a GUI-launched app still sees the user's PATH (npm,
        // cargo); own process group so the whole tree can be killed.
        c.arg("-lc").arg(command);
        c.process_group(0);
        c
    }
}

/// Windows Job Object holding a check's process tree. Every process the
/// check starts joins the job automatically, so terminating the job also
/// reaches a child created while the kill is in progress, which a
/// `taskkill /T` tree snapshot can miss.
#[cfg(windows)]
struct CheckJob(windows_sys::Win32::Foundation::HANDLE);

// The handle is only used through thread-safe Win32 job calls.
#[cfg(windows)]
unsafe impl Send for CheckJob {}
#[cfg(windows)]
unsafe impl Sync for CheckJob {}

#[cfg(windows)]
impl CheckJob {
    fn for_child(child: &tokio::process::Child) -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        let process = child.raw_handle()?;
        // SAFETY: plain Win32 calls on a fresh job handle and the live child's
        // process handle; failure is reported through the return values.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = CheckJob(job);
            if AssignProcessToJobObject(job.0, process as _) == 0 {
                return None;
            }
            Some(job)
        }
    }

    fn terminate(&self) {
        // SAFETY: `self.0` is a valid job handle until Drop.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for CheckJob {
    fn drop(&mut self) {
        // SAFETY: closing our own handle once. Processes are not killed by
        // this (no KILL_ON_JOB_CLOSE): a check that exits normally may leave
        // a daemon (build server) running, as it would in a terminal.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Kill the process and everything it started. Scoped to this PID (Windows:
/// its process tree; Unix: its process group), never by image name.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", "--", &format!("-{pid}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    tail: Arc<std::sync::Mutex<Tail>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut t) = tail.lock() {
                        t.push(&buf[..n]);
                    }
                }
            }
        }
    })
}

/// Run `command` in `cwd`. A non-zero exit, a timeout and a cancel are all
/// results (data), not errors; only a failure to spawn is an error.
pub async fn run_check(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    cancel: Arc<Notify>,
) -> Result<RaceCheckResult, String> {
    let started = Instant::now();
    let mut cmd = check_command_for(command);
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| crate::commands::spawn_err("check command", e))?;
    let pid = child.id();
    #[cfg(windows)]
    let job = CheckJob::for_child(&child);
    let tail = Arc::new(std::sync::Mutex::new(Tail::default()));
    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        pumps.push(pump(out, tail.clone()));
    }
    if let Some(err) = child.stderr.take() {
        pumps.push(pump(err, tail.clone()));
    }

    enum End {
        Exited(Option<i32>),
        TimedOut,
        Cancelled,
    }
    let end = tokio::select! {
        status = child.wait() => End::Exited(status.ok().and_then(|s| s.code())),
        _ = tokio::time::sleep(timeout) => End::TimedOut,
        _ = cancel.notified() => End::Cancelled,
    };
    if !matches!(end, End::Exited(_)) {
        #[cfg(windows)]
        if let Some(job) = &job {
            job.terminate();
        }
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    // Grandchildren that inherited the pipes are gone after a tree kill; a
    // clean exit can still leave a detached one holding them, so cap the wait.
    for p in pumps {
        let _ = tokio::time::timeout(Duration::from_secs(3), p).await;
    }
    let (bytes, truncated) = match tail.lock() {
        Ok(t) => (t.buf.iter().copied().collect::<Vec<u8>>(), t.truncated),
        Err(_) => (Vec::new(), false),
    };
    let output_tail = String::from_utf8_lossy(&strip_ansi_escapes::strip(&bytes)).to_string();
    Ok(RaceCheckResult {
        exit_code: match end {
            End::Exited(code) => code,
            _ => None,
        },
        timed_out: matches!(end, End::TimedOut),
        cancelled: matches!(end, End::Cancelled),
        duration_ms: started.elapsed().as_millis() as u64,
        output_tail,
        truncated,
    })
}

fn running_checks() -> &'static std::sync::Mutex<HashMap<String, Arc<Notify>>> {
    static RUNNING: OnceLock<std::sync::Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Races with a decide/abandon in flight. A second request for the same race
/// (double click, two windows) is refused instead of running two merges and
/// two discards against the same worktrees.
fn deciding() -> &'static std::sync::Mutex<HashSet<String>> {
    static DECIDING: OnceLock<std::sync::Mutex<HashSet<String>>> = OnceLock::new();
    DECIDING.get_or_init(Default::default)
}

struct DecideGuard(String);

impl DecideGuard {
    fn acquire(race_id: &str) -> Result<Self, String> {
        let mut set = deciding().lock().map_err(|e| e.to_string())?;
        if !set.insert(race_id.to_string()) {
            return Err(user_err("This race is already being finished."));
        }
        Ok(DecideGuard(race_id.to_string()))
    }
}

impl Drop for DecideGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = deciding().lock() {
            set.remove(&self.0);
        }
    }
}

/// Removes the cancel handle when the check finishes, however it finishes.
struct CheckGuard(String);

impl Drop for CheckGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = running_checks().lock() {
            m.remove(&self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Decide / abandon
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WinnerAction {
    /// Merge into the base through the normal task finish path.
    Merge {
        mode: MergeMode,
        message: Option<String>,
    },
    /// Leave the winner's worktree and branch in place for the Create PR flow.
    PullRequest,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoserChoice {
    pub worktree_path: String,
    /// Remove the worktree but keep the branch.
    #[serde(default)]
    pub keep_branch: bool,
    /// Required to discard a branch with commits the base lacks.
    #[serde(default)]
    pub confirm_unmerged: bool,
    /// Required to discard a worktree with uncommitted changes. Checked
    /// against the worktree at discard time, so work an agent wrote after
    /// the dialog looked is never deleted unconfirmed.
    #[serde(default)]
    pub confirm_uncommitted: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DecideRaceRequest {
    pub race_id: String,
    pub winner_worktree: String,
    pub winner_action: WinnerAction,
    pub losers: Vec<LoserChoice>,
    /// Per-worktree stats snapshot recorded for history.
    #[serde(default)]
    pub stats: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ContenderFinish {
    pub worktree_path: String,
    pub result: Option<FinishTaskResult>,
    /// Why this contender could not be finished; its worktree stays a task.
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DecideRaceResult {
    pub winner: Option<FinishTaskResult>,
    pub losers: Vec<ContenderFinish>,
}

fn task_for<'a>(tasks: &'a [TaskInfo], worktree: &str) -> Option<&'a TaskInfo> {
    tasks.iter().find(|t| same_path(&t.worktree_path, worktree))
}

/// Every contender except `except` must have exactly one choice, and no
/// choice may name a worktree outside the race.
fn check_choices(race: &Race, choices: &[LoserChoice], except: Option<&str>) -> Result<(), String> {
    for ch in choices {
        if race.contender(&ch.worktree_path).is_none() {
            return Err(user_err(
                "A worktree in the request is not part of this race.",
            ));
        }
        if except.is_some_and(|w| same_path(w, &ch.worktree_path)) {
            return Err(user_err("The winner cannot also be discarded."));
        }
    }
    for c in &race.contenders {
        if except.is_some_and(|w| same_path(w, &c.worktree_path)) {
            continue;
        }
        let n = choices
            .iter()
            .filter(|ch| same_path(&ch.worktree_path, &c.worktree_path))
            .count();
        if n != 1 {
            return Err(user_err(format!(
                "Choose what happens to {} ({}).",
                c.label, c.branch
            )));
        }
    }
    Ok(())
}

async fn finish_losers(tasks: &[TaskInfo], choices: &[LoserChoice]) -> Vec<ContenderFinish> {
    let mut out = Vec::new();
    for ch in choices {
        let Some(task) = task_for(tasks, &ch.worktree_path) else {
            // Already finished by hand: nothing left to clean up.
            out.push(ContenderFinish {
                worktree_path: ch.worktree_path.clone(),
                result: None,
                error: None,
            });
            continue;
        };
        if !ch.keep_branch && !ch.confirm_uncommitted && Path::new(&task.worktree_path).is_dir() {
            match tasks::uncommitted(Path::new(&task.worktree_path)).await {
                Ok(changes) if !changes.is_empty() => {
                    out.push(ContenderFinish {
                        worktree_path: ch.worktree_path.clone(),
                        result: None,
                        error: Some(format!(
                            "{} has {} uncommitted change(s). Confirm to discard them.",
                            task.branch,
                            changes.len()
                        )),
                    });
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    out.push(ContenderFinish {
                        worktree_path: ch.worktree_path.clone(),
                        result: None,
                        error: Some(crate::error_reporter::strip_user_prefix(&e).to_string()),
                    });
                    continue;
                }
            }
        }
        let action = if ch.keep_branch {
            FinishAction::Keep
        } else {
            FinishAction::Discard {
                confirm_unmerged: ch.confirm_unmerged,
            }
        };
        match tasks::finish_task_impl(task, &action).await {
            Ok(r) => out.push(ContenderFinish {
                worktree_path: ch.worktree_path.clone(),
                result: Some(r),
                error: None,
            }),
            Err(e) => out.push(ContenderFinish {
                worktree_path: ch.worktree_path.clone(),
                result: None,
                error: Some(crate::error_reporter::strip_user_prefix(&e).to_string()),
            }),
        }
    }
    out
}

/// Merge the winner (or leave it for a PR), then discard or keep the losers.
/// A refused merge stops before any loser is touched.
pub async fn decide_race_impl(
    race: &Race,
    tasks: &[TaskInfo],
    req: &DecideRaceRequest,
) -> Result<DecideRaceResult, String> {
    if !race.status.is_open() {
        return Err(user_err("This race is already finished."));
    }
    if race.contender(&req.winner_worktree).is_none() {
        return Err(user_err("The winner is not part of this race."));
    }
    check_choices(race, &req.losers, Some(&req.winner_worktree))?;
    let winner = match &req.winner_action {
        WinnerAction::Merge { mode, message } => {
            let task = task_for(tasks, &req.winner_worktree)
                .ok_or_else(|| user_err("The winner's worktree is no longer registered."))?;
            Some(
                tasks::finish_task_impl(
                    task,
                    &FinishAction::Merge {
                        mode: *mode,
                        message: message.clone(),
                    },
                )
                .await?,
            )
        }
        WinnerAction::PullRequest => None,
    };
    let losers = finish_losers(tasks, &req.losers).await;
    Ok(DecideRaceResult { winner, losers })
}

pub async fn abandon_race_impl(
    race: &Race,
    tasks: &[TaskInfo],
    choices: &[LoserChoice],
) -> Result<Vec<ContenderFinish>, String> {
    if !race.status.is_open() {
        return Err(user_err("This race is already finished."));
    }
    check_choices(race, choices, None)?;
    Ok(finish_losers(tasks, choices).await)
}

fn loser_outcome(f: &ContenderFinish, choice: Option<&LoserChoice>) -> &'static str {
    match (&f.result, &f.error) {
        (_, Some(_)) => "left",
        (Some(r), None) if !r.worktree_removed => "left",
        _ if choice.is_some_and(|c| c.keep_branch) => "kept",
        _ => "discarded",
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

async fn load_race(state: &State<'_, AppState>, race_id: &str) -> Result<Race, String> {
    let id = race_id.to_string();
    db_op(&state.db, move |db| db.get_race(&id))
        .await?
        .ok_or_else(|| user_err("This race no longer exists."))
}

async fn race_tasks(state: &State<'_, AppState>, race_id: &str) -> Result<Vec<TaskInfo>, String> {
    let id = race_id.to_string();
    let all = db_op(&state.db, |db| db.list_tasks()).await?;
    Ok(all
        .into_iter()
        .filter(|t| t.race_id.as_deref() == Some(id.as_str()))
        .collect())
}

#[command]
pub async fn start_race(
    state: State<'_, AppState>,
    request: StartRaceRequest,
) -> Result<Race, String> {
    wrap_cmd("start_race", async move {
        tasks::ensure_repo_trusted(&state, &request.repo_path).await?;
        let (race, infos) = start_race_impl(&request).await?;
        let to_store = race.clone();
        if let Err(e) = db_op(&state.db, move |db| db.insert_race(&to_store, &infos)).await {
            discard_started(&race).await;
            return Err(e);
        }
        Ok(race)
    })
    .await
}

#[command]
pub async fn get_race(state: State<'_, AppState>, race_id: String) -> Result<Race, String> {
    wrap_cmd("get_race", async move { load_race(&state, &race_id).await }).await
}

#[command]
pub async fn list_races(state: State<'_, AppState>) -> Result<Vec<Race>, String> {
    wrap_cmd("list_races", async move {
        db_op(&state.db, |db| db.list_races(200)).await
    })
    .await
}

/// Patch a contender's runtime fields (terminal id, timing). `None` leaves a
/// field unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ContenderPatch {
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
}

#[command]
pub async fn update_race_contender(
    state: State<'_, AppState>,
    race_id: String,
    worktree_path: String,
    patch: ContenderPatch,
) -> Result<(), String> {
    wrap_cmd("update_race_contender", async move {
        let race = load_race(&state, &race_id).await?;
        let idx = race
            .contender(&worktree_path)
            .ok_or_else(|| user_err("That worktree is not part of this race."))?
            .idx;
        db_op(&state.db, move |db| {
            db.update_race_contender(&race_id, idx, &patch)
        })
        .await
    })
    .await
}

/// `running` <-> `judging` only; decided/abandoned go through their commands.
#[command]
pub async fn set_race_status(
    state: State<'_, AppState>,
    race_id: String,
    status: RaceStatus,
) -> Result<(), String> {
    wrap_cmd("set_race_status", async move {
        if !status.is_open() {
            return Err(user_err(
                "Use Pick winner or Abandon race to finish a race.",
            ));
        }
        let race = load_race(&state, &race_id).await?;
        if !race.status.is_open() {
            return Err(user_err("This race is already finished."));
        }
        db_op(&state.db, move |db| db.set_race_status(&race_id, status)).await
    })
    .await
}

#[command]
pub async fn set_race_check_command(
    state: State<'_, AppState>,
    race_id: String,
    command: Option<String>,
) -> Result<(), String> {
    wrap_cmd("set_race_check_command", async move {
        let command = command
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        if let Some(c) = command.as_deref() {
            validate_check_command(c)?;
        }
        load_race(&state, &race_id).await?;
        db_op(&state.db, move |db| {
            db.set_race_check_command(&race_id, command.as_deref())
        })
        .await
    })
    .await
}

#[command]
pub async fn get_race_diffstat(
    state: State<'_, AppState>,
    race_id: String,
) -> Result<Vec<ContenderDiff>, String> {
    wrap_cmd("get_race_diffstat", async move {
        let race = load_race(&state, &race_id).await?;
        let mut out = Vec::new();
        for c in &race.contenders {
            out.push(contender_diff_impl(&race.base_sha, Path::new(&c.worktree_path)).await?);
        }
        Ok(out)
    })
    .await
}

#[command]
pub async fn get_race_file(
    state: State<'_, AppState>,
    race_id: String,
    source: String,
    path: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_race_file", async move {
        let race = load_race(&state, &race_id).await?;
        race_file_impl(&race, &source, &path).await
    })
    .await
}

#[command]
pub async fn run_race_check(
    state: State<'_, AppState>,
    race_id: String,
    worktree_path: String,
    run_id: String,
    timeout_secs: Option<u64>,
) -> Result<RaceCheckResult, String> {
    wrap_cmd("run_race_check", async move {
        let race = load_race(&state, &race_id).await?;
        let command = race
            .check_command
            .clone()
            .ok_or_else(|| user_err("Set a check command for this race first."))?;
        let contender = race
            .contender(&worktree_path)
            .ok_or_else(|| user_err("That worktree is not part of this race."))?;
        let cwd = PathBuf::from(&contender.worktree_path);
        if !cwd.is_dir() {
            return Err(user_err("The contender's worktree no longer exists."));
        }
        let timeout = Duration::from_secs(
            timeout_secs
                .unwrap_or(DEFAULT_CHECK_TIMEOUT_SECS)
                .clamp(5, MAX_CHECK_TIMEOUT_SECS),
        );
        let cancel = Arc::new(Notify::new());
        {
            let mut running = running_checks().lock().map_err(|e| e.to_string())?;
            if running.contains_key(&run_id) {
                return Err(user_err("That check is already running."));
            }
            running.insert(run_id.clone(), cancel.clone());
        }
        let _guard = CheckGuard(run_id);
        run_check(&command, &cwd, timeout, cancel).await
    })
    .await
}

/// Returns false when no check with that id is running (already finished).
#[command]
pub async fn cancel_race_check(run_id: String) -> Result<bool, String> {
    wrap_cmd("cancel_race_check", async move {
        let handle = running_checks()
            .lock()
            .map_err(|e| e.to_string())?
            .get(&run_id)
            .cloned();
        Ok(match handle {
            Some(n) => {
                n.notify_one();
                true
            }
            None => false,
        })
    })
    .await
}

#[command]
pub async fn decide_race(
    state: State<'_, AppState>,
    request: DecideRaceRequest,
) -> Result<DecideRaceResult, String> {
    wrap_cmd("decide_race", async move {
        let _guard = DecideGuard::acquire(&request.race_id)?;
        let race = load_race(&state, &request.race_id).await?;
        let tasks = race_tasks(&state, &race.id).await?;
        let result = decide_race_impl(&race, &tasks, &request).await?;

        let mut removed = Vec::new();
        let mut outcomes: Vec<(String, String)> = Vec::new();
        if result.winner.as_ref().is_some_and(|w| w.worktree_removed) {
            removed.push(request.winner_worktree.clone());
        }
        outcomes.push((request.winner_worktree.clone(), "winner".into()));
        for f in &result.losers {
            if f.result.as_ref().is_some_and(|r| r.worktree_removed) {
                removed.push(f.worktree_path.clone());
            }
            let choice = request
                .losers
                .iter()
                .find(|c| same_path(&c.worktree_path, &f.worktree_path));
            outcomes.push((f.worktree_path.clone(), loser_outcome(f, choice).into()));
        }
        let race_for_db = race.clone();
        let winner = request.winner_worktree.clone();
        let stats = request.stats.clone();
        db_op(&state.db, move |db| {
            for p in &removed {
                if let Some(t) = task_for(&tasks, p) {
                    db.delete_task(&t.worktree_path)?;
                }
            }
            db.record_race_result(
                &race_for_db,
                RaceStatus::Decided,
                Some(&winner),
                &outcomes,
                &stats,
            )
        })
        .await?;
        Ok(result)
    })
    .await
}

#[derive(Debug, Clone, Deserialize)]
pub struct AbandonRaceRequest {
    pub race_id: String,
    pub contenders: Vec<LoserChoice>,
    #[serde(default)]
    pub stats: HashMap<String, serde_json::Value>,
}

#[command]
pub async fn abandon_race(
    state: State<'_, AppState>,
    request: AbandonRaceRequest,
) -> Result<Vec<ContenderFinish>, String> {
    wrap_cmd("abandon_race", async move {
        let _guard = DecideGuard::acquire(&request.race_id)?;
        let race = load_race(&state, &request.race_id).await?;
        let tasks = race_tasks(&state, &race.id).await?;
        let results = abandon_race_impl(&race, &tasks, &request.contenders).await?;
        let mut removed = Vec::new();
        let mut outcomes = Vec::new();
        for f in &results {
            if f.result.as_ref().is_some_and(|r| r.worktree_removed) {
                removed.push(f.worktree_path.clone());
            }
            let choice = request
                .contenders
                .iter()
                .find(|c| same_path(&c.worktree_path, &f.worktree_path));
            outcomes.push((
                f.worktree_path.clone(),
                loser_outcome(f, choice).to_string(),
            ));
        }
        let race_for_db = race.clone();
        let stats = request.stats.clone();
        db_op(&state.db, move |db| {
            for p in &removed {
                if let Some(t) = task_for(&tasks, p) {
                    db.delete_task(&t.worktree_path)?;
                }
            }
            db.record_race_result(&race_for_db, RaceStatus::Abandoned, None, &outcomes, &stats)
        })
        .await?;
        Ok(results)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
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

    fn sh_out(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.com"]);
        sh(&repo, &["config", "user.name", "Test"]);
        sh(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        sh(&repo, &["add", "README.md"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        (tmp, repo)
    }

    fn contender(agent: AgentKind, model: Option<&str>, label: &str) -> ContenderSpec {
        ContenderSpec {
            agent,
            model: model.map(str::to_string),
            args: vec![],
            label: label.into(),
        }
    }

    fn req(repo: &Path, title: &str, contenders: Vec<ContenderSpec>) -> StartRaceRequest {
        StartRaceRequest {
            repo_path: repo.to_string_lossy().to_string(),
            title: title.into(),
            prompt: "Fix the bug".into(),
            base_branch: None,
            contenders,
            worktree_root: None,
            setup_files: vec![],
            check_command: Some("npm test".into()),
        }
    }

    fn claude_vs_codex() -> Vec<ContenderSpec> {
        vec![
            contender(AgentKind::Claude, None, "Claude"),
            contender(AgentKind::Codex, None, "Codex"),
        ]
    }

    fn commit_in(wt: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(wt.join(file), body).unwrap();
        sh(wt, &["add", file]);
        sh(wt, &["commit", "-q", "-m", msg]);
    }

    #[test]
    fn contender_slug_uses_model_then_label() {
        let c = contender(AgentKind::Codex, Some("gpt-5.6-sol"), "Codex");
        assert_eq!(
            contender_slug("Fix login bug", &c),
            "race-fix-login-bug-gpt-5-6-sol"
        );
        let c = contender(AgentKind::Claude, None, "Claude Code");
        assert_eq!(
            contender_slug("Fix login bug", &c),
            "race-fix-login-bug-claude-code"
        );
        let long = contender_slug(
            &"word ".repeat(20),
            &contender(AgentKind::Claude, Some(&"m".repeat(40)), "x"),
        );
        assert!(
            long.len() <= 5 + TITLE_SLUG_LEN + 1 + PART_SLUG_LEN,
            "{long}"
        );
        assert!(validate_branch_name(&format!("{BRANCH_PREFIX}{long}")).is_ok());
    }

    #[test]
    fn start_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let mut r = req(tmp.path(), "t", claude_vs_codex());
        r.contenders.truncate(1);
        assert!(validate_start(&r).unwrap_err().contains("2 to 4"));
        r.contenders = (0..5)
            .map(|_| contender(AgentKind::Claude, None, "c"))
            .collect();
        assert!(validate_start(&r).is_err());
        r = req(tmp.path(), "t", claude_vs_codex());
        r.prompt = "  ".into();
        assert!(validate_start(&r).is_err());
        r = req(tmp.path(), "t", claude_vs_codex());
        r.contenders[0].model = Some("x;rm".into());
        assert!(validate_start(&r).is_err());
        r.contenders[0].model = Some("sonnet[1m]".into());
        assert!(validate_start(&r).is_ok());
        r.check_command = Some("npm test\nrm -rf /".into());
        assert!(validate_start(&r).is_err());
    }

    #[tokio::test]
    async fn start_race_creates_n_worktrees_from_one_base_sha() {
        let (tmp, repo) = temp_repo();
        let base = sh_out(&repo, &["rev-parse", "HEAD"]);
        let mut r = req(
            &repo,
            "Fix bug",
            vec![
                contender(AgentKind::Claude, Some("opus"), "Claude · opus"),
                contender(AgentKind::Claude, Some("sonnet"), "Claude · sonnet"),
                contender(AgentKind::Codex, None, "Codex"),
            ],
        );
        r.base_branch = Some("main".into());
        let (race, infos) = start_race_impl(&r).await.unwrap();
        assert_eq!(race.base_sha, base);
        assert_eq!(race.status, RaceStatus::Running);
        assert_eq!(race.contenders.len(), 3);
        assert_eq!(infos.len(), 3);
        let branches: Vec<&str> = race.contenders.iter().map(|c| c.branch.as_str()).collect();
        assert_eq!(
            branches,
            vec![
                "agentrium/race-fix-bug-opus",
                "agentrium/race-fix-bug-sonnet",
                "agentrium/race-fix-bug-codex",
            ]
        );
        for (c, t) in race.contenders.iter().zip(&infos) {
            let wt = Path::new(&c.worktree_path);
            assert!(wt.starts_with(tmp.path().join(tasks::MANAGED_DIR).join("repo")));
            assert_eq!(sh_out(wt, &["rev-parse", "HEAD"]), base);
            assert_eq!(t.race_id.as_deref(), Some(race.id.as_str()));
            assert_eq!(t.base_branch, "main");
        }
        // The base moving after the start does not change the recorded SHA.
        commit_in(&repo, "later.txt", "x\n", "later");
        assert_ne!(sh_out(&repo, &["rev-parse", "HEAD"]), race.base_sha);
    }

    #[tokio::test]
    async fn same_contender_twice_and_existing_branches_get_suffixes() {
        let (_tmp, repo) = temp_repo();
        sh(&repo, &["branch", "agentrium/race-fix-claude"]);
        let r = req(
            &repo,
            "Fix",
            vec![
                contender(AgentKind::Claude, None, "Claude"),
                contender(AgentKind::Claude, None, "Claude"),
            ],
        );
        let (race, _) = start_race_impl(&r).await.unwrap();
        assert_eq!(race.contenders[0].branch, "agentrium/race-fix-claude-2");
        assert_eq!(race.contenders[1].branch, "agentrium/race-fix-claude-3");
    }

    #[tokio::test]
    async fn rollback_when_a_later_contender_fails() {
        let (_tmp, repo) = temp_repo();
        // A branch "below" the codex contender's name makes `git branch` of
        // that name fail (ref directory/file conflict) after claude's
        // worktree was already created.
        sh(&repo, &["branch", "agentrium/race-fix-bug-codex/x"]);
        let r = req(&repo, "Fix bug", claude_vs_codex());
        let e = start_race_impl(&r).await.unwrap_err();
        assert!(!crate::error_reporter::should_report(&e), "{e}");
        assert!(e.contains("contender 2 (Codex)"), "{e}");
        assert!(!branch_exists(&repo, "agentrium/race-fix-bug-claude").await);
        assert!(!branch_exists(&repo, "agentrium/race-fix-bug-codex").await);
        let wts = sh_out(&repo, &["worktree", "list", "--porcelain"]);
        assert_eq!(wts.matches("worktree ").count(), 1, "{wts}");
        let managed = repo.parent().unwrap().join(tasks::MANAGED_DIR).join("repo");
        let left: Vec<_> = std::fs::read_dir(&managed)
            .map(|d| d.flatten().collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "{left:?}");
    }

    #[tokio::test]
    async fn refuses_mid_merge_and_detached_head() {
        let (_tmp, repo) = temp_repo();
        let git_dir = repo.join(".git");
        std::fs::write(
            git_dir.join("MERGE_HEAD"),
            sh_out(&repo, &["rev-parse", "HEAD"]),
        )
        .unwrap();
        let e = start_race_impl(&req(&repo, "x", claude_vs_codex()))
            .await
            .unwrap_err();
        assert!(e.contains("middle of a merge"), "{e}");
        std::fs::remove_file(git_dir.join("MERGE_HEAD")).unwrap();
        std::fs::create_dir_all(git_dir.join("rebase-merge")).unwrap();
        let e = start_race_impl(&req(&repo, "x", claude_vs_codex()))
            .await
            .unwrap_err();
        assert!(e.contains("middle of a rebase"), "{e}");
        std::fs::remove_dir_all(git_dir.join("rebase-merge")).unwrap();
        sh(&repo, &["checkout", "-q", "--detach"]);
        let e = start_race_impl(&req(&repo, "x", claude_vs_codex()))
            .await
            .unwrap_err();
        assert!(e.contains("detached HEAD"), "{e}");
    }

    #[tokio::test]
    async fn diffstat_counts_commits_edits_and_untracked_files() {
        let (_tmp, repo) = temp_repo();
        let (race, _) = start_race_impl(&req(&repo, "Diff", claude_vs_codex()))
            .await
            .unwrap();
        let wt = PathBuf::from(&race.contenders[0].worktree_path);
        commit_in(&wt, "a.txt", "1\n2\n3\n", "add a");
        std::fs::write(wt.join("README.md"), "hello\nworld\n").unwrap();
        std::fs::write(wt.join("new.txt"), "x\ny").unwrap();
        let d = contender_diff_impl(&race.base_sha, &wt).await.unwrap();
        assert!(d.exists);
        assert_eq!(d.commits_ahead, 1);
        assert_eq!(d.uncommitted, 2);
        let summary: Vec<(String, String, Option<u32>, Option<u32>)> = d
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status.clone(), f.added, f.removed))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("README.md".into(), "M".into(), Some(1), Some(0)),
                ("a.txt".into(), "A".into(), Some(3), Some(0)),
                ("new.txt".into(), "??".into(), Some(2), Some(0)),
            ]
        );
        assert_eq!((d.added, d.removed), (6, 0));

        let other = PathBuf::from(&race.contenders[1].worktree_path);
        let d2 = contender_diff_impl(&race.base_sha, &other).await.unwrap();
        assert!(d2.files.is_empty() && d2.commits_ahead == 0);
        let gone = contender_diff_impl(&race.base_sha, Path::new("/no/such/dir"))
            .await
            .unwrap();
        assert!(!gone.exists);
    }

    #[tokio::test]
    async fn race_file_reads_base_and_contender_versions() {
        let (_tmp, repo) = temp_repo();
        let (race, _) = start_race_impl(&req(&repo, "Files", claude_vs_codex()))
            .await
            .unwrap();
        let wt = race.contenders[0].worktree_path.clone();
        std::fs::write(Path::new(&wt).join("README.md"), "changed\n").unwrap();
        assert_eq!(
            race_file_impl(&race, "base", "README.md")
                .await
                .unwrap()
                .as_deref(),
            Some("hello\n")
        );
        assert_eq!(
            race_file_impl(&race, &wt, "README.md")
                .await
                .unwrap()
                .as_deref(),
            Some("changed\n")
        );
        assert_eq!(
            race_file_impl(&race, "base", "missing.txt").await.unwrap(),
            None
        );
        assert!(race_file_impl(&race, &wt, "../repo/README.md")
            .await
            .is_err());
        assert!(race_file_impl(&race, "/etc", "passwd").await.is_err());
    }

    #[tokio::test]
    async fn decide_race_merges_winner_and_discards_losers() {
        let (_tmp, repo) = temp_repo();
        let (race, tasks) = start_race_impl(&req(
            &repo,
            "Pick one",
            vec![
                contender(AgentKind::Claude, None, "Claude"),
                contender(AgentKind::Codex, None, "Codex"),
                contender(AgentKind::Cursor, None, "Cursor"),
            ],
        ))
        .await
        .unwrap();
        let [a, b, c] = [0, 1, 2].map(|i| race.contenders[i].clone());
        commit_in(Path::new(&a.worktree_path), "a.txt", "a\n", "a work");
        commit_in(Path::new(&b.worktree_path), "b.txt", "b\n", "b work");
        commit_in(Path::new(&c.worktree_path), "c.txt", "c\n", "c work");

        // Every loser needs a choice.
        let mut request = DecideRaceRequest {
            race_id: race.id.clone(),
            winner_worktree: b.worktree_path.clone(),
            winner_action: WinnerAction::Merge {
                mode: MergeMode::Squash,
                message: Some("Pick one".into()),
            },
            losers: vec![LoserChoice {
                worktree_path: a.worktree_path.clone(),
                keep_branch: false,
                confirm_unmerged: true,
                confirm_uncommitted: false,
            }],
            stats: HashMap::new(),
        };
        let e = decide_race_impl(&race, &tasks, &request).await.unwrap_err();
        assert!(e.contains("Cursor"), "{e}");
        // The winner cannot also be a loser.
        request.losers.push(LoserChoice {
            worktree_path: b.worktree_path.clone(),
            keep_branch: false,
            confirm_unmerged: true,
            confirm_uncommitted: false,
        });
        assert!(decide_race_impl(&race, &tasks, &request).await.is_err());
        request.losers.pop();

        // Unconfirmed discard of unmerged work is refused per loser, while
        // keep_branch keeps the branch.
        request.losers.push(LoserChoice {
            worktree_path: c.worktree_path.clone(),
            keep_branch: true,
            confirm_unmerged: false,
            confirm_uncommitted: false,
        });
        let result = decide_race_impl(&race, &tasks, &request).await.unwrap();
        let w = result.winner.unwrap();
        assert!(w.merged && w.worktree_removed && w.branch_deleted, "{w:?}");
        assert!(repo.join("b.txt").is_file());
        assert!(!repo.join("a.txt").exists() && !repo.join("c.txt").exists());
        assert_eq!(
            sh_out(&repo, &["log", "--format=%s", "-n", "1"]),
            "Pick one"
        );
        assert!(
            result.losers.iter().all(|l| l.error.is_none()),
            "{:?}",
            result.losers
        );
        assert!(!Path::new(&a.worktree_path).exists() && !branch_exists(&repo, &a.branch).await);
        assert!(!Path::new(&c.worktree_path).exists() && branch_exists(&repo, &c.branch).await);
        let outcomes: Vec<&str> = result
            .losers
            .iter()
            .map(|f| {
                loser_outcome(
                    f,
                    request
                        .losers
                        .iter()
                        .find(|l| same_path(&l.worktree_path, &f.worktree_path)),
                )
            })
            .collect();
        assert_eq!(outcomes, vec!["discarded", "kept"]);
    }

    #[tokio::test]
    async fn decide_race_refused_merge_leaves_losers_alone() {
        let (_tmp, repo) = temp_repo();
        let (race, tasks) = start_race_impl(&req(&repo, "Dirty", claude_vs_codex()))
            .await
            .unwrap();
        let [a, b] = [0, 1].map(|i| race.contenders[i].clone());
        commit_in(Path::new(&a.worktree_path), "a.txt", "a\n", "a");
        std::fs::write(repo.join("README.md"), "dirty base\n").unwrap();
        let request = DecideRaceRequest {
            race_id: race.id.clone(),
            winner_worktree: a.worktree_path.clone(),
            winner_action: WinnerAction::Merge {
                mode: MergeMode::Squash,
                message: None,
            },
            losers: vec![LoserChoice {
                worktree_path: b.worktree_path.clone(),
                keep_branch: false,
                confirm_unmerged: true,
                confirm_uncommitted: false,
            }],
            stats: HashMap::new(),
        };
        let e = decide_race_impl(&race, &tasks, &request).await.unwrap_err();
        assert!(e.contains("uncommitted changes"), "{e}");
        assert!(Path::new(&b.worktree_path).exists());

        // A discard without confirmation is a per-loser error, not a failure.
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        commit_in(Path::new(&b.worktree_path), "b.txt", "b\n", "b");
        let request = DecideRaceRequest {
            winner_action: WinnerAction::PullRequest,
            losers: vec![LoserChoice {
                worktree_path: b.worktree_path.clone(),
                keep_branch: false,
                confirm_unmerged: false,
                confirm_uncommitted: false,
            }],
            ..request
        };
        let result = decide_race_impl(&race, &tasks, &request).await.unwrap();
        assert!(result.winner.is_none());
        assert!(
            Path::new(&a.worktree_path).exists(),
            "PR winner keeps its worktree"
        );
        assert!(result.losers[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Confirm"));
        assert_eq!(
            loser_outcome(&result.losers[0], Some(&request.losers[0])),
            "left"
        );
    }

    #[tokio::test]
    async fn abandon_discards_everything() {
        let (_tmp, repo) = temp_repo();
        let (race, tasks) = start_race_impl(&req(&repo, "Abandon", claude_vs_codex()))
            .await
            .unwrap();
        let choices: Vec<LoserChoice> = race
            .contenders
            .iter()
            .map(|c| LoserChoice {
                worktree_path: c.worktree_path.clone(),
                keep_branch: false,
                confirm_unmerged: true,
                confirm_uncommitted: false,
            })
            .collect();
        let results = abandon_race_impl(&race, &tasks, &choices).await.unwrap();
        assert!(results.iter().all(|r| r
            .result
            .as_ref()
            .is_some_and(|x| x.worktree_removed && x.branch_deleted)));
        for c in &race.contenders {
            assert!(!branch_exists(&repo, &c.branch).await);
        }
        let mut done = race.clone();
        done.status = RaceStatus::Abandoned;
        assert!(abandon_race_impl(&done, &tasks, &choices).await.is_err());
    }

    // --- checks --------------------------------------------------------------

    #[cfg(windows)]
    const FAIL_CMD: &str = "echo checking & echo boom 1>&2 & exit 3";
    #[cfg(not(windows))]
    const FAIL_CMD: &str = "echo checking; echo boom 1>&2; exit 3";

    /// A grandchild that writes `marker` after ~3s, while the shell itself
    /// keeps running. If only the shell were killed, the marker would appear.
    fn slow_tree_cmd(marker: &Path) -> String {
        #[cfg(windows)]
        {
            format!(
                "start /b cmd /c \"ping -n 4 127.0.0.1 >nul & echo late> \"{}\"\" & ping -n 30 127.0.0.1 >nul",
                marker.display()
            )
        }
        #[cfg(not(windows))]
        {
            format!("(sleep 3; echo late > '{}') & sleep 30", marker.display())
        }
    }

    #[tokio::test]
    async fn check_non_zero_exit_is_data() {
        let dir = tempfile::tempdir().unwrap();
        let r = run_check(
            FAIL_CMD,
            dir.path(),
            Duration::from_secs(30),
            Arc::new(Notify::new()),
        )
        .await
        .unwrap();
        assert_eq!(r.exit_code, Some(3));
        assert!(!r.timed_out && !r.cancelled);
        assert!(
            r.output_tail.contains("checking") && r.output_tail.contains("boom"),
            "{}",
            r.output_tail
        );
    }

    #[tokio::test]
    async fn check_output_tail_is_truncated() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let cmd = "for /L %i in (1,1,3000) do @echo line %i";
        #[cfg(not(windows))]
        let cmd = "i=1; while [ $i -le 3000 ]; do echo line $i; i=$((i+1)); done";
        let r = run_check(
            cmd,
            dir.path(),
            Duration::from_secs(60),
            Arc::new(Notify::new()),
        )
        .await
        .unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(r.truncated);
        assert!(r.output_tail.len() <= CHECK_TAIL_BYTES);
        assert!(
            r.output_tail.trim_end().ends_with("line 3000"),
            "{}",
            &r.output_tail[r.output_tail.len().saturating_sub(40)..]
        );
    }

    #[tokio::test]
    async fn check_timeout_kills_the_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker.txt");
        let r = run_check(
            &slow_tree_cmd(&marker),
            dir.path(),
            Duration::from_secs(1),
            Arc::new(Notify::new()),
        )
        .await
        .unwrap();
        assert!(r.timed_out && !r.cancelled);
        assert_eq!(r.exit_code, None);
        assert!(r.duration_ms < 10_000, "{}", r.duration_ms);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!marker.exists(), "grandchild survived the timeout kill");
    }

    #[tokio::test]
    async fn check_cancel_kills_the_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker.txt");
        let cancel = Arc::new(Notify::new());
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            c2.notify_one();
        });
        let r = run_check(
            &slow_tree_cmd(&marker),
            dir.path(),
            Duration::from_secs(60),
            cancel,
        )
        .await
        .unwrap();
        assert!(r.cancelled && !r.timed_out);
        assert!(r.duration_ms < 10_000, "{}", r.duration_ms);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!marker.exists(), "grandchild survived the cancel kill");
    }

    #[test]
    fn check_command_validation() {
        assert!(validate_check_command("npm test -- --grep \"x\"").is_ok());
        assert!(validate_check_command("a\nb").is_err());
        assert!(validate_check_command(&"x".repeat(MAX_CHECK_COMMAND_LEN + 1)).is_err());
    }

    #[tokio::test]
    async fn discarding_uncommitted_work_needs_its_own_confirmation() {
        let (_tmp, repo) = temp_repo();
        let (race, tasks) = start_race_impl(&req(&repo, "Dirty loser", claude_vs_codex()))
            .await
            .unwrap();
        let [a, b] = [0, 1].map(|i| race.contenders[i].clone());
        commit_in(
            Path::new(&a.worktree_path),
            "a.txt",
            "a
",
            "a",
        );
        // The loser has no commits, only work written after any dialog looked.
        std::fs::write(Path::new(&b.worktree_path).join("late.txt"), "late").unwrap();
        let mut request = DecideRaceRequest {
            race_id: race.id.clone(),
            winner_worktree: a.worktree_path.clone(),
            winner_action: WinnerAction::PullRequest,
            losers: vec![LoserChoice {
                worktree_path: b.worktree_path.clone(),
                keep_branch: false,
                confirm_unmerged: false,
                confirm_uncommitted: false,
            }],
            stats: HashMap::new(),
        };
        let result = decide_race_impl(&race, &tasks, &request).await.unwrap();
        let err = result.losers[0].error.clone().unwrap_or_default();
        assert!(err.contains("1 uncommitted change"), "{err}");
        assert!(Path::new(&b.worktree_path).join("late.txt").exists());

        request.losers[0].confirm_uncommitted = true;
        let result = decide_race_impl(&race, &tasks, &request).await.unwrap();
        assert!(result.losers[0].error.is_none(), "{:?}", result.losers[0]);
        assert!(!Path::new(&b.worktree_path).exists());
    }

    #[test]
    fn a_race_can_only_be_finished_once_at_a_time() {
        let g = DecideGuard::acquire("race-1").unwrap();
        let e = DecideGuard::acquire("race-1").err().unwrap();
        assert!(e.contains("already being finished"), "{e}");
        assert!(DecideGuard::acquire("race-2").is_ok());
        drop(g);
        assert!(DecideGuard::acquire("race-1").is_ok());
    }
}
