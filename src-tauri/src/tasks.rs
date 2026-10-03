//! "New Task" flow: every task gets its own git worktree on a fresh
//! `agentrium/<slug>` branch inside a managed folder, and is later merged
//! back (fast-forward or squash), kept, or discarded.
//!
//! Trust model: `start_task` requires the repository to be a trusted root (an
//! open agent terminal, or a folder from session history) and records every
//! worktree it creates in the `tasks` table. Every later command takes only a
//! worktree path and reads repo / branch / base from that registry, so the
//! renderer can never point a merge or a branch deletion at an arbitrary ref.

use crate::commands::{db_op, git_cmd_async, spawn_err, wrap_cmd};
use crate::error_reporter::user_err;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::{command, State};

/// Name of the managed folder created next to the repository.
pub const MANAGED_DIR: &str = ".agentrium-worktrees";
/// Branch namespace for generated task branches.
pub const BRANCH_PREFIX: &str = "agentrium/";
const MAX_SLUG_LEN: usize = 48;
pub(crate) const MAX_SUFFIX: u32 = 99;

/// Task metadata carried on a terminal. Field names are camelCase on the wire
/// because the frontend reads them as `task.baseBranch` etc.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub title: String,
    pub branch: String,
    pub base_branch: String,
    pub worktree_path: String,
    pub repo_path: String,
    /// Set when the task is one contender of a race (see `races.rs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub race_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartTaskRequest {
    pub repo_path: String,
    pub title: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub branch_name: Option<String>,
    /// Settings > Git override for the managed folder. `None` / empty uses
    /// `<repo-parent>/.agentrium-worktrees`.
    #[serde(default)]
    pub worktree_root: Option<String>,
    /// Repo-relative gitignored files to copy into the new worktree.
    #[serde(default)]
    pub setup_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartTaskResult {
    pub worktree_path: String,
    pub branch: String,
    pub base_branch: String,
    pub repo_path: String,
    pub copied_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct TaskFileChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct TaskStatus {
    pub task: TaskInfo,
    /// False when the worktree folder is gone (deleted by hand, pruned).
    pub exists: bool,
    pub uncommitted: Vec<TaskFileChange>,
    /// Commits on the task branch that the base branch does not have.
    pub ahead: u32,
    /// Commits on the base branch that the task branch does not have.
    pub behind: u32,
    /// Files changed between the merge base and the task branch tip.
    pub changed_files: Vec<String>,
    /// Worktree that has the base branch checked out, if any.
    pub base_worktree: Option<String>,
    /// Tracked changes in `base_worktree` - a merge must refuse while set.
    pub base_dirty: bool,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MergeMode {
    FastForward,
    Squash,
}

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FinishAction {
    /// Merge into the base branch, then remove the worktree and branch.
    Merge {
        mode: MergeMode,
        message: Option<String>,
    },
    /// Remove the worktree, keep the branch.
    Keep,
    /// Remove the worktree and delete the branch. `confirm_unmerged` must be
    /// set when the branch has commits the base lacks.
    Discard {
        #[serde(default)]
        confirm_unmerged: bool,
    },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FinishTaskResult {
    pub merged: bool,
    pub worktree_removed: bool,
    pub branch_deleted: bool,
    /// Non-fatal follow-up problem (e.g. merge succeeded but the worktree
    /// still had untracked files and could not be removed).
    pub warning: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ManagedTaskWorktree {
    pub task: TaskInfo,
    pub exists: bool,
    /// True when no open terminal is working in this worktree.
    pub orphaned: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Lowercase ASCII slug: runs of anything but `[a-z0-9]` collapse to `-`,
/// trimmed, capped at 48 chars. Never empty.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in title.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    let mut s = out.trim_matches('-').to_string();
    if s.len() > MAX_SLUG_LEN {
        s.truncate(MAX_SLUG_LEN);
        s = s.trim_end_matches('-').to_string();
    }
    if s.is_empty() {
        "task".to_string()
    } else {
        s
    }
}

/// `slug`, then `slug-2`, `slug-3`, ... until `taken` says no.
pub fn unique_slug(slug: &str, taken: impl Fn(&str) -> bool) -> Result<String, String> {
    if !taken(slug) {
        return Ok(slug.to_string());
    }
    for n in 2..=MAX_SUFFIX {
        let candidate = format!("{slug}-{n}");
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(user_err(format!(
        "Too many tasks named '{slug}'. Finish or discard some first."
    )))
}

/// Conservative subset of `git check-ref-format`: refuses anything git would
/// reject plus anything that could be parsed as an option.
pub fn validate_branch_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name == "@"
        || name
            .split('/')
            .any(|seg| seg.is_empty() || seg.starts_with('.'))
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'));
    if bad {
        return Err(user_err(format!(
            "Invalid branch name '{name}'. Use letters, numbers, '.', '_', '-' and '/'."
        )));
    }
    Ok(())
}

/// Validate one setup-file entry. Only plain relative paths made of normal
/// components are allowed: no absolute paths, drive prefixes, `..`, `.`,
/// glob characters or NULs.
pub fn validate_setup_entry(entry: &str) -> Result<PathBuf, String> {
    let reject = || {
        user_err(format!(
            "Setup file '{entry}' must be a plain path inside the repository."
        ))
    };
    if entry.trim().is_empty()
        || entry.contains('\0')
        || entry.chars().any(|c| matches!(c, '*' | '?' | '[' | ']'))
    {
        return Err(reject());
    }
    let p = Path::new(entry);
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            _ => return Err(reject()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(reject());
    }
    Ok(out)
}

/// Copy allow-listed setup files from `src_root` into `dst_root`. Every entry
/// is validated before anything is copied (fail closed). Missing sources and
/// existing destinations are skipped; a source that resolves outside
/// `src_root` (symlink escape) aborts the copy.
pub fn copy_setup_files(
    src_root: &Path,
    dst_root: &Path,
    entries: &[String],
) -> Result<Vec<String>, String> {
    let rels = entries
        .iter()
        .map(|e| validate_setup_entry(e))
        .collect::<Result<Vec<_>, _>>()?;
    let src_canon = src_root.canonicalize().map_err(|e| e.to_string())?;
    let mut copied = Vec::new();
    for rel in rels {
        let src = src_root.join(&rel);
        if std::fs::symlink_metadata(&src).is_err() {
            continue;
        }
        let real = src.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(&src_canon) {
            return Err(user_err(format!(
                "Setup file '{}' resolves outside the repository.",
                rel.display()
            )));
        }
        if !real.is_file() {
            continue;
        }
        let dst = dst_root.join(&rel);
        if dst.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&real, &dst).map_err(|e| e.to_string())?;
        copied.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(copied)
}

/// Git prints forward slashes on Windows; normalize so paths handed to the
/// frontend (and later to `create_terminal` as a cwd) look native.
pub fn native_path(p: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(p.replace('/', "\\"))
    } else {
        PathBuf::from(p)
    }
}

/// Managed folder for this repo's task worktrees.
pub fn managed_root(repo_root: &Path, override_root: Option<&str>) -> Result<PathBuf, String> {
    let repo_name = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| user_err("Cannot determine the repository folder name."))?;
    let base = match override_root.map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => {
            let p = native_path(custom);
            if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(user_err(
                    "The task worktree folder must be an absolute path without '..'.",
                ));
            }
            p
        }
        None => repo_root
            .parent()
            .ok_or_else(|| user_err("The repository has no parent folder for task worktrees."))?
            .join(MANAGED_DIR),
    };
    if base.starts_with(repo_root) {
        return Err(user_err(
            "The task worktree folder cannot be inside the repository.",
        ));
    }
    Ok(base.join(repo_name))
}

/// Path equality that tolerates `\\?\` prefixes, separator style and (on
/// Windows) case.
pub fn same_path(a: &str, b: &str) -> bool {
    if let (Ok(x), Ok(y)) = (Path::new(a).canonicalize(), Path::new(b).canonicalize()) {
        return x == y;
    }
    let norm = |s: &str| {
        let s = s.replace('\\', "/").trim_end_matches('/').to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn squash_message_default(title: &str, files: &[String]) -> String {
    let mut msg = title.trim().to_string();
    if !files.is_empty() {
        msg.push_str("\n\n");
        let shown: Vec<String> = files.iter().take(50).map(|f| format!("- {f}")).collect();
        msg.push_str(&shown.join("\n"));
        if files.len() > 50 {
            msg.push_str(&format!("\n- ...and {} more", files.len() - 50));
        }
    }
    msg
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

pub(crate) async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd_async(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| spawn_err(&format!("git {}", args.first().unwrap_or(&"")), e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Git failures in this flow are almost always repo state (conflicts, dirty
/// trees, missing refs), so they surface to the UI without telemetry.
pub(crate) async fn git_user(dir: &Path, args: &[&str]) -> Result<String, String> {
    git(dir, args).await.map_err(user_err)
}

pub(crate) async fn git_ok(dir: &Path, args: &[&str]) -> bool {
    git(dir, args).await.is_ok()
}

pub(crate) async fn branch_exists(repo: &Path, branch: &str) -> bool {
    git_ok(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .await
}

/// Main repository root for any path inside a repo or one of its worktrees.
pub async fn main_repo_root(path: &Path) -> Result<PathBuf, String> {
    let inside = git(path, &["rev-parse", "--is-inside-work-tree"]).await;
    if !matches!(inside.as_deref().map(str::trim), Ok("true")) {
        return Err(user_err(format!(
            "'{}' is not a git repository.",
            path.display()
        )));
    }
    if let Ok(common) = git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await
    {
        let common = native_path(common.trim());
        if common.file_name().map(|n| n == ".git").unwrap_or(false) {
            if let Some(parent) = common.parent() {
                return Ok(parent.to_path_buf());
            }
        }
    }
    let top = git(path, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(user_err)?;
    Ok(native_path(top.trim()))
}

/// `git worktree list --porcelain` → (path, branch) pairs.
async fn worktrees(repo: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    let out = git_user(repo, &["worktree", "list", "--porcelain"]).await?;
    let mut list = Vec::new();
    for block in out.replace("\r\n", "\n").split("\n\n") {
        let mut path = None;
        let mut branch = None;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
        if let Some(p) = path {
            list.push((p, branch));
        }
    }
    Ok(list)
}

async fn worktree_for_branch(repo: &Path, branch: &str) -> Result<Option<PathBuf>, String> {
    Ok(worktrees(repo)
        .await?
        .into_iter()
        .find(|(_, b)| b.as_deref() == Some(branch))
        .map(|(p, _)| native_path(&p)))
}

async fn tracked_dirty(dir: &Path) -> Result<bool, String> {
    let out = git_user(dir, &["status", "--porcelain", "--untracked-files=no"]).await?;
    Ok(!out.trim().is_empty())
}

pub(crate) async fn uncommitted(dir: &Path) -> Result<Vec<TaskFileChange>, String> {
    let out = git_user(
        dir,
        &["-c", "core.quotepath=off", "status", "--porcelain=v1"],
    )
    .await?;
    Ok(out
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| TaskFileChange {
            status: l[..2].trim().to_string(),
            path: l[3..].to_string(),
        })
        .collect())
}

/// (ahead, behind) of `branch` relative to `base`.
async fn divergence(repo: &Path, base: &str, branch: &str) -> Result<(u32, u32), String> {
    let out = git_user(
        repo,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...{branch}"),
        ],
    )
    .await?;
    let mut parts = out
        .split_whitespace()
        .map(|n| n.parse::<u32>().unwrap_or(0));
    let behind = parts.next().unwrap_or(0);
    let ahead = parts.next().unwrap_or(0);
    Ok((ahead, behind))
}

// ---------------------------------------------------------------------------
// Core operations (tested against temp repos; no Tauri state)
// ---------------------------------------------------------------------------

/// Base-branch choices for the New Task modal.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TaskBaseBranches {
    /// Checked-out branch, `None` on a detached HEAD.
    pub current: Option<String>,
    /// Local branches, minus generated `agentrium/*` task branches.
    pub branches: Vec<String>,
}

pub async fn task_base_branches_impl(repo: &Path) -> Result<TaskBaseBranches, String> {
    let out = git_user(repo, &["branch", "--format=%(refname:short)"]).await?;
    let branches = out
        .lines()
        .map(str::trim)
        .filter(|b| !b.is_empty() && !b.starts_with(BRANCH_PREFIX))
        .map(String::from)
        .collect();
    let current = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(TaskBaseBranches { current, branches })
}

pub async fn start_task_impl(
    req: &StartTaskRequest,
) -> Result<(StartTaskResult, TaskInfo), String> {
    let title = req.title.trim();
    if title.is_empty() {
        return Err(user_err("Give the task a title."));
    }
    let repo = main_repo_root(Path::new(&req.repo_path)).await?;

    let base = match req
        .base_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(b) => b.to_string(),
        None => {
            let head = git_user(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
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
    if !git_ok(
        &repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
    )
    .await
    {
        return Err(user_err(format!("Base branch '{base}' does not exist.")));
    }

    let root = managed_root(&repo, req.worktree_root.as_deref())?;
    let override_branch = req
        .branch_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (branch, slug) = match override_branch {
        Some(b) => {
            validate_branch_name(b)?;
            if branch_exists(&repo, b).await {
                return Err(user_err(format!("Branch '{b}' already exists.")));
            }
            let slug = unique_slug(&slugify(&b.replace('/', "-")), |s| root.join(s).exists())?;
            (b.to_string(), slug)
        }
        None => {
            // Collect taken names up front: `unique_slug` takes a sync closure.
            let base_slug = slugify(title);
            let mut taken = std::collections::HashSet::new();
            for n in 1..=MAX_SUFFIX {
                let s = if n == 1 {
                    base_slug.clone()
                } else {
                    format!("{base_slug}-{n}")
                };
                if root.join(&s).exists()
                    || branch_exists(&repo, &format!("{BRANCH_PREFIX}{s}")).await
                {
                    taken.insert(s);
                } else {
                    break;
                }
            }
            let slug = unique_slug(&base_slug, |s| taken.contains(s))?;
            (format!("{BRANCH_PREFIX}{slug}"), slug)
        }
    };

    let worktree = root.join(&slug);
    std::fs::create_dir_all(&root)
        .map_err(|e| user_err(format!("Cannot create '{}': {e}", root.display())))?;
    let wt_str = worktree.to_string_lossy().to_string();
    git_user(&repo, &["worktree", "add", "-b", &branch, &wt_str, &base]).await?;

    let copied = match copy_setup_files(&repo, &worktree, &req.setup_files) {
        Ok(c) => c,
        Err(e) => {
            // Fail closed: do not leave a half-provisioned task behind.
            let _ = git(&repo, &["worktree", "remove", "--force", &wt_str]).await;
            let _ = git(&repo, &["branch", "-D", &branch]).await;
            return Err(e);
        }
    };

    let repo_str = repo.to_string_lossy().to_string();
    let info = TaskInfo {
        title: title.to_string(),
        branch: branch.clone(),
        base_branch: base.clone(),
        worktree_path: wt_str.clone(),
        repo_path: repo_str.clone(),
        race_id: None,
    };
    Ok((
        StartTaskResult {
            worktree_path: wt_str,
            branch,
            base_branch: base,
            repo_path: repo_str,
            copied_files: copied,
        },
        info,
    ))
}

pub async fn task_status_impl(task: &TaskInfo) -> Result<TaskStatus, String> {
    let repo = PathBuf::from(&task.repo_path);
    let wt = PathBuf::from(&task.worktree_path);
    let exists = wt.is_dir();
    let uncommitted = if exists {
        uncommitted(&wt).await?
    } else {
        Vec::new()
    };
    let (ahead, behind) = if branch_exists(&repo, &task.branch).await {
        divergence(&repo, &task.base_branch, &task.branch).await?
    } else {
        (0, 0)
    };
    let changed_files = if ahead > 0 {
        git_user(
            &repo,
            &[
                "-c",
                "core.quotepath=off",
                "diff",
                "--name-only",
                &format!("{}...{}", task.base_branch, task.branch),
            ],
        )
        .await?
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
    } else {
        Vec::new()
    };
    let base_worktree = worktree_for_branch(&repo, &task.base_branch).await?;
    let base_dirty = match &base_worktree {
        Some(p) => tracked_dirty(p).await?,
        None => false,
    };
    Ok(TaskStatus {
        task: task.clone(),
        exists,
        uncommitted,
        ahead,
        behind,
        changed_files,
        base_worktree: base_worktree.map(|p| p.to_string_lossy().to_string()),
        base_dirty,
    })
}

pub async fn commit_task_impl(task: &TaskInfo, message: &str) -> Result<(), String> {
    let message = message.trim();
    if message.is_empty() {
        return Err(user_err("Enter a commit message."));
    }
    let wt = PathBuf::from(&task.worktree_path);
    git_user(&wt, &["add", "-A"]).await?;
    git_user(&wt, &["commit", "-m", message]).await?;
    Ok(())
}

async fn remove_worktree(repo: &Path, task: &TaskInfo, force: bool) -> Result<(), String> {
    if !Path::new(&task.worktree_path).exists() {
        // Already gone: drop git's stale record so the branch can be deleted.
        let _ = git(repo, &["worktree", "prune"]).await;
        return Ok(());
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&task.worktree_path);
    git_user(repo, &args).await.map(|_| ())
}

pub async fn finish_task_impl(
    task: &TaskInfo,
    action: &FinishAction,
) -> Result<FinishTaskResult, String> {
    let repo = PathBuf::from(&task.repo_path);
    match action {
        FinishAction::Keep => {
            remove_worktree(&repo, task, false).await?;
            Ok(FinishTaskResult {
                merged: false,
                worktree_removed: true,
                branch_deleted: false,
                warning: None,
            })
        }
        FinishAction::Discard { confirm_unmerged } => {
            let (ahead, _) = if branch_exists(&repo, &task.branch).await {
                divergence(&repo, &task.base_branch, &task.branch).await?
            } else {
                (0, 0)
            };
            if ahead > 0 && !confirm_unmerged {
                return Err(user_err(format!(
                    "'{}' has {ahead} commit(s) not in '{}'. Confirm to discard them.",
                    task.branch, task.base_branch
                )));
            }
            remove_worktree(&repo, task, true).await?;
            let deleted = if branch_exists(&repo, &task.branch).await {
                git_user(&repo, &["branch", "-D", &task.branch]).await?;
                true
            } else {
                false
            };
            Ok(FinishTaskResult {
                merged: false,
                worktree_removed: true,
                branch_deleted: deleted,
                warning: None,
            })
        }
        FinishAction::Merge { mode, message } => {
            if !branch_exists(&repo, &task.branch).await {
                return Err(user_err(format!(
                    "Branch '{}' no longer exists.",
                    task.branch
                )));
            }
            let (ahead, behind) = divergence(&repo, &task.base_branch, &task.branch).await?;
            if ahead == 0 {
                return Err(user_err(format!(
                    "'{}' has no commits to merge. Commit your changes first, or discard the task.",
                    task.branch
                )));
            }
            let base_wt = worktree_for_branch(&repo, &task.base_branch).await?;
            if let Some(p) = &base_wt {
                if tracked_dirty(p).await? {
                    return Err(user_err(format!(
                        "'{}' has uncommitted changes in {}. Commit or stash them, then merge.",
                        task.base_branch,
                        p.display()
                    )));
                }
            }
            match mode {
                MergeMode::FastForward => {
                    if behind > 0 {
                        return Err(user_err(format!(
                            "'{}' moved on by {behind} commit(s), so a fast-forward is impossible. Use squash, or rebase the task branch.",
                            task.base_branch
                        )));
                    }
                    match &base_wt {
                        Some(p) => git_user(p, &["merge", "--ff-only", &task.branch]).await?,
                        // Base not checked out anywhere: fetch-to-self updates
                        // the ref and refuses non-fast-forward moves.
                        None => {
                            git_user(
                                &repo,
                                &[
                                    "fetch",
                                    ".",
                                    &format!("{}:{}", task.branch, task.base_branch),
                                ],
                            )
                            .await?
                        }
                    };
                }
                MergeMode::Squash => {
                    let p = base_wt.as_ref().ok_or_else(|| {
                        user_err(format!(
                            "Check out '{}' in a worktree to squash-merge into it.",
                            task.base_branch
                        ))
                    })?;
                    if let Err(e) = git(p, &["merge", "--squash", &task.branch]).await {
                        // A failed squash leaves a half-applied index with no
                        // MERGE_HEAD, so `merge --abort` cannot undo it.
                        let _ = git(p, &["reset", "--merge"]).await;
                        return Err(user_err(format!(
                            "Squash merge failed and was rolled back:\n\n{e}"
                        )));
                    }
                    let msg = message
                        .as_deref()
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| task.title.clone());
                    if let Err(e) = git(p, &["commit", "-m", &msg]).await {
                        let _ = git(p, &["reset", "--merge"]).await;
                        return Err(user_err(format!(
                            "Commit failed and the squash was rolled back:\n\n{e}"
                        )));
                    }
                }
            }
            // The work is in the base branch now. Cleanup problems are
            // warnings, not failures: the merge itself must not be reported
            // as failed.
            let mut warning = None;
            let removed = match remove_worktree(&repo, task, false).await {
                Ok(()) => true,
                Err(e) => {
                    warning = Some(format!(
                        "Merged, but the worktree was kept: {}",
                        crate::error_reporter::strip_user_prefix(&e)
                    ));
                    false
                }
            };
            let deleted = removed && git(&repo, &["branch", "-D", &task.branch]).await.is_ok();
            Ok(FinishTaskResult {
                merged: true,
                worktree_removed: removed,
                branch_deleted: deleted,
                warning,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

pub(crate) async fn ensure_repo_trusted(
    state: &State<'_, AppState>,
    repo_path: &str,
) -> Result<(), String> {
    if crate::commands::validate_path_is_trusted(state, repo_path)
        .await
        .is_ok()
    {
        return Ok(());
    }
    let canon = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| user_err(format!("Invalid path '{repo_path}': {e}")))?;
    // Saved profile folders are user-chosen config read from our own DB (not
    // from the renderer), so they are as trustworthy as session history.
    let folders = db_op(&state.db, |db| {
        let mut f = db.get_session_history_folders()?;
        f.extend(
            db.get_profiles()?
                .into_iter()
                .map(|p| p.working_directory)
                .filter(|d| !d.trim().is_empty()),
        );
        Ok(f)
    })
    .await?;
    let known = folders.iter().any(|f| {
        Path::new(f)
            .canonicalize()
            .map(|k| canon.starts_with(&k) || k.starts_with(&canon))
            .unwrap_or(false)
    });
    if known {
        Ok(())
    } else {
        Err(user_err(format!(
            "Open a session in '{}' first, then start a task there.",
            canon.display()
        )))
    }
}

/// Look up a registered task by worktree path. Unknown paths are refused.
async fn registered_task(
    state: &State<'_, AppState>,
    worktree_path: &str,
) -> Result<TaskInfo, String> {
    let tasks = db_op(&state.db, |db| db.list_tasks()).await?;
    tasks
        .into_iter()
        .find(|t| same_path(&t.worktree_path, worktree_path))
        .ok_or_else(|| user_err("This worktree is not a task managed by Agentrium."))
}

#[command]
pub async fn start_task(
    state: State<'_, AppState>,
    request: StartTaskRequest,
) -> Result<StartTaskResult, String> {
    wrap_cmd("start_task", async move {
        ensure_repo_trusted(&state, &request.repo_path).await?;
        let (result, info) = start_task_impl(&request).await?;
        db_op(&state.db, move |db| db.insert_task(&info)).await?;
        Ok(result)
    })
    .await
}

/// Same trust rule as `start_task`, so every repo the modal can launch in
/// also gets its branch list (a saved profile with no open session included).
#[command]
pub async fn list_task_base_branches(
    state: State<'_, AppState>,
    repo_path: String,
) -> Result<TaskBaseBranches, String> {
    wrap_cmd("list_task_base_branches", async move {
        ensure_repo_trusted(&state, &repo_path).await?;
        task_base_branches_impl(&native_path(&repo_path)).await
    })
    .await
}

#[command]
pub async fn get_task_status(
    state: State<'_, AppState>,
    worktree_path: String,
) -> Result<TaskStatus, String> {
    wrap_cmd("get_task_status", async move {
        let task = registered_task(&state, &worktree_path).await?;
        task_status_impl(&task).await
    })
    .await
}

#[command]
pub async fn commit_task_changes(
    state: State<'_, AppState>,
    worktree_path: String,
    message: String,
) -> Result<(), String> {
    wrap_cmd("commit_task_changes", async move {
        let task = registered_task(&state, &worktree_path).await?;
        commit_task_impl(&task, &message).await
    })
    .await
}

#[command]
pub async fn finish_task(
    state: State<'_, AppState>,
    worktree_path: String,
    action: FinishAction,
) -> Result<FinishTaskResult, String> {
    wrap_cmd("finish_task", async move {
        let task = registered_task(&state, &worktree_path).await?;
        let result = finish_task_impl(&task, &action).await?;
        if result.worktree_removed {
            let key = task.worktree_path.clone();
            db_op(&state.db, move |db| db.delete_task(&key)).await?;
        }
        Ok(result)
    })
    .await
}

#[command]
pub async fn list_task_worktrees(
    state: State<'_, AppState>,
) -> Result<Vec<ManagedTaskWorktree>, String> {
    wrap_cmd("list_task_worktrees", async move {
        let tasks = db_op(&state.db, |db| db.list_tasks()).await?;
        let open_dirs: Vec<String> = {
            let terminals = state.terminals.lock().await;
            terminals
                .get_all_configs()
                .into_iter()
                .map(|c| c.working_directory)
                .collect()
        };
        Ok(tasks
            .into_iter()
            .map(|task| {
                let exists = Path::new(&task.worktree_path).is_dir();
                let orphaned = !open_dirs.iter().any(|d| same_path(d, &task.worktree_path));
                ManagedTaskWorktree {
                    task,
                    exists,
                    orphaned,
                }
            })
            .collect())
    })
    .await
}

/// Startup cleanup: `git worktree prune` in every repo that has tasks, and
/// forget registry rows whose folder no longer exists. Returns rows dropped.
#[command]
pub async fn prune_task_worktrees(state: State<'_, AppState>) -> Result<u32, String> {
    wrap_cmd("prune_task_worktrees", async move {
        let tasks = db_op(&state.db, |db| db.list_tasks()).await?;
        let mut repos: Vec<String> = Vec::new();
        for t in &tasks {
            if !repos.iter().any(|r| same_path(r, &t.repo_path)) {
                repos.push(t.repo_path.clone());
            }
        }
        for repo in &repos {
            if Path::new(repo).is_dir() {
                // Best-effort: a repo that moved or broke must not block startup.
                let _ = git(Path::new(repo), &["worktree", "prune"]).await;
            }
        }
        let gone: Vec<String> = tasks
            .into_iter()
            .filter(|t| !Path::new(&t.worktree_path).is_dir())
            .map(|t| t.worktree_path)
            .collect();
        let count = gone.len() as u32;
        if count > 0 {
            db_op(&state.db, move |db| {
                for p in &gone {
                    db.delete_task(p)?;
                }
                Ok(())
            })
            .await?;
        }
        Ok(count)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn slugify_basic_and_edge_cases() {
        assert_eq!(slugify("Fix login bug"), "fix-login-bug");
        assert_eq!(slugify("  --Add   OAuth!! (v2)  "), "add-oauth-v2");
        assert_eq!(slugify("שלום"), "task");
        assert_eq!(slugify(""), "task");
        let long = slugify(&"word ".repeat(30));
        assert!(long.len() <= MAX_SLUG_LEN);
        assert!(!long.ends_with('-'));
    }

    #[test]
    fn unique_slug_suffixes_collisions() {
        assert_eq!(unique_slug("a", |_| false).unwrap(), "a");
        assert_eq!(unique_slug("a", |s| s == "a").unwrap(), "a-2");
        assert_eq!(unique_slug("a", |s| s == "a" || s == "a-2").unwrap(), "a-3");
        assert!(unique_slug("a", |_| true).is_err());
    }

    #[test]
    fn branch_name_validation() {
        for ok in ["agentrium/fix-bug", "feature/x.y", "a_b-c"] {
            assert!(validate_branch_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-x",
            "a..b",
            "a//b",
            "a/",
            "/a",
            "a.lock",
            "a b",
            "a~1",
            "a^",
            "x:y",
            "a@{1}",
            "a/.hidden",
            "a\\b",
            "a.",
        ] {
            assert!(validate_branch_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn setup_entry_rejects_traversal_and_globs() {
        assert!(validate_setup_entry(".env").is_ok());
        assert!(validate_setup_entry("config/.env.local").is_ok());
        for bad in [
            "",
            "../.env",
            "a/../../b",
            "/etc/passwd",
            "*.env",
            "a/?",
            "./.env",
            "a\0b",
        ] {
            assert!(validate_setup_entry(bad).is_err(), "{bad:?}");
        }
        #[cfg(windows)]
        {
            assert!(validate_setup_entry("C:\\Windows\\win.ini").is_err());
            assert!(validate_setup_entry("..\\x").is_err());
        }
    }

    #[test]
    fn copy_setup_files_allow_list_only() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join(".env"), "A=1").unwrap();
        std::fs::write(src.path().join("secret.txt"), "no").unwrap();
        std::fs::create_dir_all(src.path().join("cfg")).unwrap();
        std::fs::write(src.path().join("cfg/.env.local"), "B=2").unwrap();
        std::fs::write(dst.path().join("existing"), "keep").unwrap();
        std::fs::write(src.path().join("existing"), "overwrite?").unwrap();

        let copied = copy_setup_files(
            src.path(),
            dst.path(),
            &[
                ".env".into(),
                "cfg/.env.local".into(),
                "missing".into(),
                "existing".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            copied,
            vec![".env".to_string(), "cfg/.env.local".to_string()]
        );
        assert!(!dst.path().join("secret.txt").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("existing")).unwrap(),
            "keep"
        );

        // One bad entry fails the whole batch before anything is copied.
        let dst2 = tempfile::tempdir().unwrap();
        assert!(
            copy_setup_files(src.path(), dst2.path(), &[".env".into(), "../x".into()]).is_err()
        );
        assert!(!dst2.path().join(".env").exists());
    }

    #[test]
    fn managed_root_default_and_override() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("myrepo");
        assert_eq!(
            managed_root(&repo, None).unwrap(),
            parent.path().join(MANAGED_DIR).join("myrepo")
        );
        let custom = parent.path().join("wts");
        assert_eq!(
            managed_root(&repo, Some(custom.to_str().unwrap())).unwrap(),
            custom.join("myrepo")
        );
        assert!(managed_root(&repo, Some("relative/dir")).is_err());
        assert!(managed_root(&repo, Some(repo.join("inside").to_str().unwrap())).is_err());
        let traversal = format!(
            "{}{}..{}x",
            parent.path().display(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert!(managed_root(&repo, Some(&traversal)).is_err());
    }

    #[test]
    fn squash_message_lists_files() {
        assert_eq!(squash_message_default("Title", &[]), "Title");
        assert_eq!(
            squash_message_default("T", &["a.rs".into(), "b.rs".into()]),
            "T\n\n- a.rs\n- b.rs"
        );
    }

    // --- temp-repo integration ---------------------------------------------

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

    /// `<tmp>/repo` with one commit on `main` and a gitignored `.env`.
    fn temp_repo() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.com"]);
        sh(&repo, &["config", "user.name", "Test"]);
        sh(&repo, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("README.md"), "hello\n").unwrap();
        std::fs::write(repo.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(repo.join(".env"), "SECRET=1\n").unwrap();
        sh(&repo, &["add", "README.md", ".gitignore"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        (tmp, repo)
    }

    fn req(repo: &Path, title: &str) -> StartTaskRequest {
        StartTaskRequest {
            repo_path: repo.to_string_lossy().to_string(),
            title: title.into(),
            base_branch: None,
            branch_name: None,
            worktree_root: None,
            setup_files: vec![".env".into(), ".env.local".into()],
        }
    }

    #[tokio::test]
    async fn base_branches_lists_local_and_hides_task_branches() {
        let (_tmp, repo) = temp_repo();
        sh(&repo, &["branch", "develop"]);
        sh(&repo, &["branch", "agentrium/old-task"]);
        let b = task_base_branches_impl(&repo).await.unwrap();
        assert_eq!(b.current.as_deref(), Some("main"));
        assert_eq!(b.branches, vec!["develop".to_string(), "main".to_string()]);

        // Detached HEAD has no current branch name.
        sh(&repo, &["checkout", "-q", "--detach"]);
        let b = task_base_branches_impl(&repo).await.unwrap();
        assert_eq!(b.current, None);
    }

    fn commit_in(wt: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(wt.join(file), body).unwrap();
        sh(wt, &["add", file]);
        sh(wt, &["commit", "-q", "-m", msg]);
    }

    #[tokio::test]
    async fn start_task_creates_worktree_branch_and_copies_setup_files() {
        let (tmp, repo) = temp_repo();
        let (res, info) = start_task_impl(&req(&repo, "Fix login bug")).await.unwrap();
        assert_eq!(res.branch, "agentrium/fix-login-bug");
        assert_eq!(res.base_branch, "main");
        let wt = PathBuf::from(&res.worktree_path);
        assert!(wt.starts_with(tmp.path().join(MANAGED_DIR).join("repo")));
        assert!(wt.join("README.md").is_file());
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(res.copied_files, vec![".env".to_string()]);
        assert_eq!(info.branch, res.branch);

        // Same title again → suffixed branch and folder.
        let (res2, _) = start_task_impl(&req(&repo, "Fix login bug")).await.unwrap();
        assert_eq!(res2.branch, "agentrium/fix-login-bug-2");
        assert!(res2.worktree_path.ends_with("fix-login-bug-2"));
    }

    #[tokio::test]
    async fn start_task_user_errors() {
        let (_tmp, repo) = temp_repo();
        let not_repo = tempfile::tempdir().unwrap();
        let mut r = req(not_repo.path(), "x");
        let e = start_task_impl(&r).await.unwrap_err();
        assert!(!crate::error_reporter::should_report(&e), "{e}");

        r = req(&repo, "x");
        r.base_branch = Some("nope".into());
        let e = start_task_impl(&r).await.unwrap_err();
        assert!(
            !crate::error_reporter::should_report(&e) && e.contains("does not exist"),
            "{e}"
        );

        r = req(&repo, "x");
        r.branch_name = Some("main".into());
        let e = start_task_impl(&r).await.unwrap_err();
        assert!(e.contains("already exists"), "{e}");

        r = req(&repo, "x");
        r.setup_files = vec!["../../etc/passwd".into()];
        assert!(start_task_impl(&r).await.is_err());
        // Fail closed: nothing left behind.
        assert!(!branch_exists(&repo, "agentrium/x").await);
    }

    #[tokio::test]
    async fn finish_squash_merges_into_base_and_cleans_up() {
        let (_tmp, repo) = temp_repo();
        let (res, task) = start_task_impl(&req(&repo, "Add feature")).await.unwrap();
        let wt = PathBuf::from(&res.worktree_path);
        commit_in(&wt, "a.txt", "a\n", "wip 1");
        commit_in(&wt, "b.txt", "b\n", "wip 2");

        let status = task_status_impl(&task).await.unwrap();
        assert_eq!((status.ahead, status.behind), (2, 0));
        assert_eq!(
            status.changed_files,
            vec!["a.txt".to_string(), "b.txt".to_string()]
        );
        assert!(!status.base_dirty);

        // Dirty base refuses the merge.
        std::fs::write(repo.join("README.md"), "dirty\n").unwrap();
        let e = finish_task_impl(
            &task,
            &FinishAction::Merge {
                mode: MergeMode::Squash,
                message: None,
            },
        )
        .await
        .unwrap_err();
        assert!(e.contains("uncommitted changes"), "{e}");
        sh(&repo, &["checkout", "--", "README.md"]);

        let result = finish_task_impl(
            &task,
            &FinishAction::Merge {
                mode: MergeMode::Squash,
                message: Some("Add feature\n\n- a.txt".into()),
            },
        )
        .await
        .unwrap();
        assert!(
            result.merged && result.worktree_removed && result.branch_deleted,
            "{result:?}"
        );
        assert!(repo.join("a.txt").is_file() && repo.join("b.txt").is_file());
        let log = git(&repo, &["log", "--format=%s", "-n", "2"])
            .await
            .unwrap();
        assert_eq!(log.lines().collect::<Vec<_>>(), vec!["Add feature", "init"]);
        assert!(!wt.exists());
        assert!(!branch_exists(&repo, &task.branch).await);
    }

    #[tokio::test]
    async fn finish_fast_forward_and_refuses_when_diverged() {
        let (_tmp, repo) = temp_repo();
        let (res, task) = start_task_impl(&req(&repo, "ff")).await.unwrap();
        commit_in(Path::new(&res.worktree_path), "f.txt", "f\n", "ff commit");
        let r = finish_task_impl(
            &task,
            &FinishAction::Merge {
                mode: MergeMode::FastForward,
                message: None,
            },
        )
        .await
        .unwrap();
        assert!(r.merged);
        let head = git(&repo, &["log", "--format=%s", "-n", "1"])
            .await
            .unwrap();
        assert_eq!(head.trim(), "ff commit");

        let (res2, task2) = start_task_impl(&req(&repo, "diverged")).await.unwrap();
        commit_in(Path::new(&res2.worktree_path), "g.txt", "g\n", "task");
        commit_in(&repo, "h.txt", "h\n", "base moved");
        let e = finish_task_impl(
            &task2,
            &FinishAction::Merge {
                mode: MergeMode::FastForward,
                message: None,
            },
        )
        .await
        .unwrap_err();
        assert!(e.contains("fast-forward is impossible"), "{e}");
    }

    #[tokio::test]
    async fn discard_requires_confirmation_for_unmerged_commits() {
        let (_tmp, repo) = temp_repo();
        let (res, task) = start_task_impl(&req(&repo, "throwaway")).await.unwrap();
        let wt = PathBuf::from(&res.worktree_path);
        commit_in(&wt, "x.txt", "x\n", "unmerged");
        std::fs::write(wt.join("dirty.txt"), "uncommitted").unwrap();

        let e = finish_task_impl(
            &task,
            &FinishAction::Discard {
                confirm_unmerged: false,
            },
        )
        .await
        .unwrap_err();
        assert!(e.contains("Confirm"), "{e}");
        assert!(wt.exists());

        let r = finish_task_impl(
            &task,
            &FinishAction::Discard {
                confirm_unmerged: true,
            },
        )
        .await
        .unwrap();
        assert!(r.worktree_removed && r.branch_deleted);
        assert!(!wt.exists());
        assert!(!branch_exists(&repo, &task.branch).await);
    }

    #[tokio::test]
    async fn keep_removes_worktree_but_keeps_branch() {
        let (_tmp, repo) = temp_repo();
        let (res, task) = start_task_impl(&req(&repo, "keep me")).await.unwrap();
        commit_in(Path::new(&res.worktree_path), "k.txt", "k\n", "kept");
        let r = finish_task_impl(&task, &FinishAction::Keep).await.unwrap();
        assert!(r.worktree_removed && !r.branch_deleted);
        assert!(branch_exists(&repo, &task.branch).await);
    }

    #[tokio::test]
    async fn commit_task_changes_commits_everything() {
        let (_tmp, repo) = temp_repo();
        let (res, task) = start_task_impl(&req(&repo, "commit")).await.unwrap();
        std::fs::write(Path::new(&res.worktree_path).join("new.txt"), "n").unwrap();
        assert_eq!(task_status_impl(&task).await.unwrap().uncommitted.len(), 1);
        commit_task_impl(&task, "save work").await.unwrap();
        let s = task_status_impl(&task).await.unwrap();
        assert!(s.uncommitted.is_empty());
        assert_eq!(s.ahead, 1);
        let _ = repo;
    }
}
