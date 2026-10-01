//! "Create Pull Request" flow: commit -> push -> PR, plus PR status for tabs.
//!
//! Auth strategy: Agentrium never stores a forge token. It drives the user's
//! own `gh` / `glab` CLI when one is installed and signed in, and otherwise
//! builds a compare / new-merge-request URL for the browser. Nothing here
//! talks to the agentrium-api broker.
//!
//! Process safety: titles, bodies and branch names are user-controlled, so on
//! Windows the CLIs are spawned directly from their resolved `.exe` path (never
//! through `cmd /C`, see `commands::git_command`) and the PR body travels in a
//! temp file for `gh`. On Unix the login shell wrapper single-quotes every arg.

use crate::commands::{run_git, spawn_err, validate_path_is_trusted, validate_ref_token, wrap_cmd};
use crate::error_reporter::user_err;
use crate::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{command, State};

/// Browsers and forges reject very long request lines (GitHub answers 414
/// around 8 KB). Stay well under so the compare page always opens.
pub const MAX_COMPARE_URL_LEN: usize = 7000;
/// GitHub's own limits for a pull request title and body.
const MAX_TITLE_LEN: usize = 256;
const MAX_BODY_LEN: usize = 65_536;
const TRUNCATION_NOTE: &str = "\n\n_(Description truncated. The full text is on your clipboard.)_";
const CLI_TIMEOUT: Duration = Duration::from_secs(60);
const CLI_CACHE_TTL: Duration = Duration::from_secs(300);
/// Per-run cap for `gh run view --log-failed` output handed to the agent.
const MAX_LOG_CHARS_PER_RUN: usize = 6000;
const MAX_FAILED_RUNS: usize = 3;

// ---------------------------------------------------------------------------
// Remote parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
    Bitbucket,
    Azure,
    Unknown,
}

/// A hosted repository parsed from `git remote get-url`. Holds no user name,
/// password or token: those are dropped during parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemote {
    pub host: String,
    /// Everything between host and repo: `owner`, `group/subgroup`, or
    /// `org/project` for Azure DevOps.
    pub owner: String,
    pub repo: String,
    pub provider: Provider,
    /// Browser URL of the repository, e.g. `https://github.com/o/r`.
    pub web_url: String,
}

fn provider_for_host(host: &str) -> Provider {
    let h = host.to_ascii_lowercase();
    if h.contains("github") {
        Provider::Github
    } else if h.contains("gitlab") {
        Provider::Gitlab
    } else if h.contains("bitbucket") {
        Provider::Bitbucket
    } else if h == "dev.azure.com" || h.ends_with(".dev.azure.com") || h.ends_with("visualstudio.com") {
        Provider::Azure
    } else {
        Provider::Unknown
    }
}

/// Parse SSH (`git@host:o/r.git`, `ssh://git@host:22/o/r`), HTTPS (with or
/// without embedded credentials), GitLab subgroups and Azure DevOps remotes.
/// Returns `None` for local paths and anything without an owner and a repo.
pub fn parse_remote_url(raw: &str) -> Option<ParsedRemote> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    // (web scheme, host, optional web port, path)
    let (web_scheme, host, port, path) = if raw.contains("://") {
        let url = url::Url::parse(raw).ok()?;
        let host = url.host_str()?.to_string();
        let (web_scheme, port) = match url.scheme() {
            "https" => ("https", url.port()),
            "http" => ("http", url.port()),
            // An SSH port says nothing about the web UI's port.
            "ssh" | "git" | "git+ssh" | "ssh+git" => ("https", None),
            _ => return None,
        };
        (web_scheme, host, port, url.path().to_string())
    } else {
        // scp-like `[user@]host:path`. A drive letter (`C:/repo`) or a path
        // with no colon is a local remote, not a hosted one.
        let (host_part, path) = raw.split_once(':')?;
        let host = host_part.rsplit_once('@').map(|(_, h)| h).unwrap_or(host_part);
        if host.len() < 2 || host.contains('/') || host.contains('\\') || path.starts_with("//") {
            return None;
        }
        ("https", host.to_string(), None, path.to_string())
    };
    let host = host.to_ascii_lowercase();
    let segments: Vec<&str> = path
        .trim_matches('/')
        .trim_end_matches(".git")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    let provider = provider_for_host(&host);
    let port_suffix = port.map(|p| format!(":{p}")).unwrap_or_default();

    if provider == Provider::Azure {
        return parse_azure(&host, &segments);
    }
    if segments.len() < 2 {
        return None;
    }
    let repo = segments[segments.len() - 1].to_string();
    let owner = segments[..segments.len() - 1].join("/");
    let web_url = format!("{web_scheme}://{host}{port_suffix}/{owner}/{repo}");
    Some(ParsedRemote { host, owner, repo, provider, web_url })
}

/// Azure DevOps has three remote shapes, all mapped to the same web URL:
/// `https://dev.azure.com/org/project/_git/repo`,
/// `git@ssh.dev.azure.com:v3/org/project/repo`, and the legacy
/// `https://org.visualstudio.com/[DefaultCollection/]project/_git/repo`.
fn parse_azure(host: &str, segments: &[&str]) -> Option<ParsedRemote> {
    let (org, project, repo, web_host) = if host == "ssh.dev.azure.com" || host == "vs-ssh.visualstudio.com" {
        match segments {
            ["v3", org, project, repo] => (org.to_string(), project.to_string(), repo.to_string(), "dev.azure.com".to_string()),
            _ => return None,
        }
    } else if host == "dev.azure.com" {
        match segments {
            [org, project, "_git", repo] => (org.to_string(), project.to_string(), repo.to_string(), host.to_string()),
            _ => return None,
        }
    } else {
        let org = host.strip_suffix(".visualstudio.com")?;
        let rest: Vec<&str> = segments.iter().copied().filter(|s| !s.eq_ignore_ascii_case("DefaultCollection")).collect();
        match rest.as_slice() {
            [project, "_git", repo] => (org.to_string(), project.to_string(), repo.to_string(), host.to_string()),
            _ => return None,
        }
    };
    let web_url = if web_host == "dev.azure.com" {
        format!("https://dev.azure.com/{org}/{project}/_git/{repo}")
    } else {
        format!("https://{web_host}/{project}/_git/{repo}")
    };
    Some(ParsedRemote {
        host: web_host,
        owner: format!("{org}/{project}"),
        repo,
        provider: Provider::Azure,
        web_url,
    })
}

/// Remove `user[:password]@` from every URL in `text`. Applied to CLI and git
/// output before it reaches the UI or telemetry, because remotes configured as
/// `https://<token>@host/...` echo the token back in error messages.
pub fn strip_credentials(text: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.\-]*://)[^/@\s]+@").expect("valid regex"));
    re.replace_all(text, "$1").into_owned()
}

// ---------------------------------------------------------------------------
// Browser fallback URL
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyInUrl {
    /// The whole body is in the URL.
    Full,
    /// The body was cut to fit; the UI copies the full text to the clipboard.
    Truncated,
    /// This forge's create page takes no description parameter.
    Omitted,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompareUrl {
    pub url: String,
    pub body: BodyInUrl,
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Encode a branch for a URL path, keeping `/` so `feature/x` stays readable.
fn enc_branch_path(branch: &str) -> String {
    branch.split('/').map(enc).collect::<Vec<_>>().join("/")
}

fn compare_url_with(remote: &ParsedRemote, base: &str, head: &str, title: &str, body: Option<&str>) -> String {
    let web = &remote.web_url;
    match remote.provider {
        Provider::Gitlab => {
            let mut url = format!(
                "{web}/-/merge_requests/new?merge_request%5Bsource_branch%5D={}&merge_request%5Btarget_branch%5D={}&merge_request%5Btitle%5D={}",
                enc(head), enc(base), enc(title)
            );
            if let Some(b) = body {
                url.push_str(&format!("&merge_request%5Bdescription%5D={}", enc(b)));
            }
            url
        }
        Provider::Bitbucket => format!("{web}/pull-requests/new?source={}&dest={}", enc(head), enc(base)),
        Provider::Azure => format!("{web}/pullrequestcreate?sourceRef={}&targetRef={}", enc(head), enc(base)),
        // GitHub, GitHub Enterprise, and Gitea/Forgejo share the compare route.
        Provider::Github | Provider::Unknown => {
            let mut url = format!(
                "{web}/compare/{}...{}?expand=1&title={}",
                enc_branch_path(base), enc_branch_path(head), enc(title)
            );
            if let Some(b) = body {
                url.push_str(&format!("&body={}", enc(b)));
            }
            url
        }
    }
}

/// Build the "open a PR in the browser" URL. The body is cut at a char
/// boundary (binary search on the encoded length) so the URL stays under
/// `max_len`; the caller copies the full body to the clipboard.
pub fn build_compare_url(remote: &ParsedRemote, base: &str, head: &str, title: &str, body: &str, max_len: usize) -> CompareUrl {
    let title: String = title.chars().take(MAX_TITLE_LEN).collect();
    if matches!(remote.provider, Provider::Bitbucket | Provider::Azure) {
        return CompareUrl {
            url: compare_url_with(remote, base, head, &title, None),
            body: if body.is_empty() { BodyInUrl::Full } else { BodyInUrl::Omitted },
        };
    }
    let full = compare_url_with(remote, base, head, &title, Some(body));
    if full.len() <= max_len {
        return CompareUrl { url: full, body: BodyInUrl::Full };
    }
    let chars: Vec<char> = body.chars().collect();
    let fits = |n: usize| {
        let cut: String = chars[..n].iter().collect::<String>() + TRUNCATION_NOTE;
        compare_url_with(remote, base, head, &title, Some(&cut)).len() <= max_len
    };
    let (mut lo, mut hi) = (0usize, chars.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(mid) { lo = mid } else { hi = mid - 1 }
    }
    let url = if fits(lo) {
        let cut: String = chars[..lo].iter().collect::<String>() + TRUNCATION_NOTE;
        compare_url_with(remote, base, head, &title, Some(&cut))
    } else {
        compare_url_with(remote, base, head, &title, None)
    };
    CompareUrl { url, body: BodyInUrl::Truncated }
}

// ---------------------------------------------------------------------------
// Status parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeState {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    /// No checks reported (yet).
    None,
    Pending,
    Success,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FailingCheck {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CiRollup {
    pub state: CiState,
    pub total: usize,
    pub failing: Vec<FailingCheck>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequestStatus {
    pub number: u64,
    pub url: String,
    pub provider: Provider,
    pub state: PrState,
    pub draft: bool,
    pub review_decision: Option<ReviewDecision>,
    pub mergeable: Option<MergeState>,
    pub ci: CiRollup,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrView {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    status_check_rollup: Option<Vec<serde_json::Value>>,
}

enum CheckOutcome {
    Pending,
    Success,
    Failure,
}

/// One entry of `statusCheckRollup`: a `CheckRun` (Actions and apps) or a
/// `StatusContext` (legacy commit statuses).
fn classify_check(v: &serde_json::Value) -> (String, Option<String>, CheckOutcome) {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    if v.get("__typename").and_then(|x| x.as_str()) == Some("StatusContext") || v.get("context").is_some() {
        let url = Some(s("targetUrl")).filter(|u| !u.is_empty());
        let outcome = match s("state").to_ascii_uppercase().as_str() {
            "SUCCESS" => CheckOutcome::Success,
            "FAILURE" | "ERROR" => CheckOutcome::Failure,
            _ => CheckOutcome::Pending,
        };
        return (s("context"), url, outcome);
    }
    let url = Some(s("detailsUrl")).filter(|u| !u.is_empty());
    let outcome = if !s("status").eq_ignore_ascii_case("COMPLETED") {
        CheckOutcome::Pending
    } else {
        match s("conclusion").to_ascii_uppercase().as_str() {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => CheckOutcome::Success,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => CheckOutcome::Failure,
            _ => CheckOutcome::Pending,
        }
    };
    (s("name"), url, outcome)
}

/// Fold check entries into one CI state: any failure wins, then any pending,
/// then success. An empty list is `None` (no CI configured or not started).
pub fn rollup_checks(entries: &[serde_json::Value]) -> CiRollup {
    let mut failing = Vec::new();
    let mut pending = false;
    for e in entries {
        let (name, url, outcome) = classify_check(e);
        match outcome {
            CheckOutcome::Failure => failing.push(FailingCheck { name, url }),
            CheckOutcome::Pending => pending = true,
            CheckOutcome::Success => {}
        }
    }
    let state = if !failing.is_empty() {
        CiState::Failure
    } else if pending {
        CiState::Pending
    } else if entries.is_empty() {
        CiState::None
    } else {
        CiState::Success
    };
    CiRollup { state, total: entries.len(), failing }
}

/// CLIs that print through a login shell can be preceded by rc-file noise on
/// Unix, so parse from the first `{` to the last `}`.
fn json_slice(stdout: &str) -> Option<&str> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    (end > start).then(|| &stdout[start..=end])
}

pub fn parse_gh_status(stdout: &str) -> Result<PullRequestStatus, String> {
    let json = json_slice(stdout).ok_or_else(|| "gh returned no JSON".to_string())?;
    let v: GhPrView = serde_json::from_str(json).map_err(|e| format!("Unexpected gh output: {e}"))?;
    let state = match v.state.to_ascii_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    };
    let review_decision = match v.review_decision.as_deref().unwrap_or("").to_ascii_uppercase().as_str() {
        "APPROVED" => Some(ReviewDecision::Approved),
        "CHANGES_REQUESTED" => Some(ReviewDecision::ChangesRequested),
        "REVIEW_REQUIRED" => Some(ReviewDecision::ReviewRequired),
        _ => None,
    };
    let mergeable = match v.mergeable.as_deref().unwrap_or("").to_ascii_uppercase().as_str() {
        "MERGEABLE" => Some(MergeState::Mergeable),
        "CONFLICTING" => Some(MergeState::Conflicting),
        "UNKNOWN" => Some(MergeState::Unknown),
        _ => None,
    };
    Ok(PullRequestStatus {
        number: v.number,
        url: v.url,
        provider: Provider::Github,
        state,
        draft: v.is_draft,
        review_decision,
        mergeable,
        ci: rollup_checks(v.status_check_rollup.as_deref().unwrap_or(&[])),
    })
}

/// `glab mr view --output json` is the GitLab REST merge-request object. It
/// carries the head pipeline's status but not per-job results, so a failing
/// pipeline is reported as one failing check linking to the pipeline.
pub fn parse_glab_status(stdout: &str) -> Result<PullRequestStatus, String> {
    let json = json_slice(stdout).ok_or_else(|| "glab returned no JSON".to_string())?;
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("Unexpected glab output: {e}"))?;
    let number = v.get("iid").and_then(|x| x.as_u64()).ok_or_else(|| "glab output has no iid".to_string())?;
    let url = v.get("web_url").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let state = match v.get("state").and_then(|x| x.as_str()).unwrap_or("") {
        "merged" => PrState::Merged,
        "closed" | "locked" => PrState::Closed,
        _ => PrState::Open,
    };
    let draft = v.get("draft").and_then(|x| x.as_bool())
        .or_else(|| v.get("work_in_progress").and_then(|x| x.as_bool()))
        .unwrap_or(false);
    let mergeable = if v.get("has_conflicts").and_then(|x| x.as_bool()) == Some(true) {
        Some(MergeState::Conflicting)
    } else {
        match v.get("merge_status").and_then(|x| x.as_str()).unwrap_or("") {
            "can_be_merged" => Some(MergeState::Mergeable),
            "cannot_be_merged" => Some(MergeState::Conflicting),
            "" => None,
            _ => Some(MergeState::Unknown),
        }
    };
    let pipeline = v.get("head_pipeline").filter(|p| p.is_object()).or_else(|| v.get("pipeline").filter(|p| p.is_object()));
    let ci = match pipeline {
        None => CiRollup { state: CiState::None, total: 0, failing: vec![] },
        Some(p) => {
            let purl = p.get("web_url").and_then(|x| x.as_str()).map(str::to_string);
            match p.get("status").and_then(|x| x.as_str()).unwrap_or("") {
                "success" | "skipped" | "manual" => CiRollup { state: CiState::Success, total: 1, failing: vec![] },
                "failed" | "canceled" => CiRollup {
                    state: CiState::Failure,
                    total: 1,
                    failing: vec![FailingCheck { name: "Pipeline".into(), url: purl }],
                },
                _ => CiRollup { state: CiState::Pending, total: 1, failing: vec![] },
            }
        }
    };
    Ok(PullRequestStatus { number, url, provider: Provider::Gitlab, state, draft, review_decision: None, mergeable, ci })
}

fn find_pr_url(text: &str) -> Option<(String, u64)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"https?://\S+?/(?:pull|merge_requests)/(\d+)").expect("valid regex")
    });
    let caps = re.captures_iter(text).last()?;
    let number = caps.get(1)?.as_str().parse().ok()?;
    Some((caps.get(0)?.as_str().to_string(), number))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliFailure {
    Auth,
    NotPushed,
    NoCommits,
    AlreadyExists,
    NotFound,
    Other,
}

fn classify_cli_failure(stderr: &str) -> CliFailure {
    let s = stderr.to_ascii_lowercase();
    if s.contains("already exists") {
        CliFailure::AlreadyExists
    } else if s.contains("no pull requests found") || s.contains("no merge request") || s.contains("no open merge request")
        || (s.contains("404 not found") && s.contains("merge request"))
    {
        CliFailure::NotFound
    } else if s.contains("gh auth login") || s.contains("glab auth login") || s.contains("not logged")
        || s.contains("authentication") || s.contains("http 401") || s.contains("401 unauthorized")
    {
        CliFailure::Auth
    } else if s.contains("no commits between") {
        CliFailure::NoCommits
    } else if s.contains("must first push") || s.contains("head ref must be a branch")
        || s.contains("head sha can't be blank") || (s.contains("source branch") && s.contains("does not exist"))
    {
        CliFailure::NotPushed
    } else {
        CliFailure::Other
    }
}

// ---------------------------------------------------------------------------
// CLI resolution and execution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Gh,
    Glab,
}

impl Cli {
    fn binary(self) -> &'static str {
        match self {
            Cli::Gh => "gh",
            Cli::Glab => "glab",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct CliStatus {
    pub installed: bool,
    pub authenticated: bool,
}

type CacheMap<K, V> = Mutex<HashMap<K, (V, Instant)>>;

fn path_cache() -> &'static CacheMap<Cli, Option<String>> {
    static C: OnceLock<CacheMap<Cli, Option<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn auth_cache() -> &'static CacheMap<(Cli, String), bool> {
    static C: OnceLock<CacheMap<(Cli, String), bool>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached<K: std::hash::Hash + Eq + Clone, V: Clone>(cache: &CacheMap<K, V>, key: &K) -> Option<V> {
    let guard = cache.lock().ok()?;
    guard.get(key).filter(|(_, at)| at.elapsed() < CLI_CACHE_TTL).map(|(v, _)| v.clone())
}

fn remember<K: std::hash::Hash + Eq, V>(cache: &CacheMap<K, V>, key: K, value: V) {
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, (value, Instant::now()));
    }
}

/// From `where` output, the first real `.exe`. A `.cmd`/`.bat` shim would
/// have to run through cmd.exe, which re-parses its args, so it is refused.
pub fn pick_windows_exe(where_output: &str) -> Option<String> {
    where_output
        .lines()
        .map(str::trim)
        .find(|l| l.to_ascii_lowercase().ends_with(".exe"))
        .map(str::to_string)
}

/// Absolute `.exe` path on Windows; on Unix the bare name, resolved later by
/// the login shell (`probe_binary_impl` proves it is on that PATH).
async fn resolve_cli(cli: Cli) -> Option<String> {
    if let Some(hit) = cached(path_cache(), &cli) {
        return hit;
    }
    let resolved = if cfg!(target_os = "windows") {
        // `where.exe` is spawned directly and the name is a constant.
        let mut cmd = tokio::process::Command::new("where");
        cmd.arg(cli.binary()).kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        match cmd.output().await {
            Ok(o) if o.status.success() => pick_windows_exe(&String::from_utf8_lossy(&o.stdout)),
            _ => None,
        }
    } else {
        crate::commands::probe_binary_impl(cli.binary())
            .await
            .found
            .then(|| cli.binary().to_string())
    };
    remember(path_cache(), cli, resolved.clone());
    resolved
}

fn cli_command(program: &str, args: &[&str]) -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new(program);
        c.args(args);
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = crate::commands::shell_command(program, args);
    // Never block on an interactive prompt, pager, or update banner.
    for (k, v) in [
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
        ("GH_SPINNER_DISABLED", "1"),
        ("GH_PAGER", ""),
        ("NO_PROMPT", "1"),
        ("GLAB_CHECK_UPDATE", "false"),
        ("NO_COLOR", "1"),
        ("CLICOLOR", "0"),
    ] {
        cmd.env(k, v);
    }
    let mut cmd: tokio::process::Command = cmd.into();
    cmd.kill_on_drop(true);
    cmd
}

struct CliOutput {
    success: bool,
    stdout: String,
    /// Credential-stripped.
    stderr: String,
}

async fn run_cli(program: &str, cwd: &str, args: &[&str]) -> Result<CliOutput, String> {
    let mut cmd = cli_command(program, args);
    cmd.current_dir(cwd);
    let name = std::path::Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(program)
        .to_string();
    let out = tokio::time::timeout(CLI_TIMEOUT, cmd.output())
        .await
        .map_err(|_| user_err(format!("{name} did not answer within {} seconds", CLI_TIMEOUT.as_secs())))?
        .map_err(|e| spawn_err(&name, e))?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = strip_credentials(if stderr.is_empty() { stdout.trim() } else { &stderr });
    Ok(CliOutput { success: out.status.success(), stdout, stderr })
}

async fn cli_authenticated(cli: Cli, program: &str, cwd: &str, host: &str) -> bool {
    let key = (cli, host.to_string());
    if let Some(hit) = cached(auth_cache(), &key) {
        return hit;
    }
    let ok = run_cli(program, cwd, &["auth", "status", "--hostname", host])
        .await
        .map(|o| o.success)
        .unwrap_or(false);
    remember(auth_cache(), key, ok);
    ok
}

// ---------------------------------------------------------------------------
// Repository context
// ---------------------------------------------------------------------------

/// Upstream remote of the current branch, else `origin`, else the first one.
async fn pick_remote(path: &str) -> Result<String, String> {
    let remotes_raw = run_git(path, &["remote"]).await.map_err(|e| user_err(strip_credentials(&e)))?;
    let remotes: Vec<&str> = remotes_raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if remotes.is_empty() {
        return Err(user_err("Repository has no remotes configured"));
    }
    if let Ok(up) = run_git(path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await {
        let up = up.trim();
        // Remote names may contain '/', so take the longest matching prefix.
        if let Some(r) = remotes.iter().filter(|r| up.starts_with(&format!("{r}/"))).max_by_key(|r| r.len()) {
            return Ok(r.to_string());
        }
    }
    Ok(if remotes.contains(&"origin") { "origin" } else { remotes[0] }.to_string())
}

struct RepoContext {
    remote_name: String,
    parsed: ParsedRemote,
    /// The CLI `create_pull_request` / status will use, with its program path.
    cli: Option<(Cli, String)>,
    gh: CliStatus,
    glab: CliStatus,
}

async fn repo_context(path: &str) -> Result<RepoContext, String> {
    let remote_name = pick_remote(path).await?;
    let raw = run_git(path, &["remote", "get-url", &remote_name])
        .await
        .map_err(|e| user_err(strip_credentials(&e)))?;
    let mut parsed = parse_remote_url(&raw).ok_or_else(|| {
        user_err(format!("Remote '{remote_name}' is not a hosted repository URL"))
    })?;

    let mut gh = CliStatus::default();
    let mut glab = CliStatus::default();
    let mut cli = None;
    let wants_gh = matches!(parsed.provider, Provider::Github | Provider::Unknown);
    let wants_glab = matches!(parsed.provider, Provider::Gitlab | Provider::Unknown);
    if wants_gh {
        if let Some(p) = resolve_cli(Cli::Gh).await {
            gh.installed = true;
            gh.authenticated = cli_authenticated(Cli::Gh, &p, path, &parsed.host).await;
            if gh.authenticated {
                cli = Some((Cli::Gh, p));
            }
        }
    }
    if wants_glab && cli.is_none() {
        if let Some(p) = resolve_cli(Cli::Glab).await {
            glab.installed = true;
            glab.authenticated = cli_authenticated(Cli::Glab, &p, path, &parsed.host).await;
            if glab.authenticated {
                cli = Some((Cli::Glab, p));
            }
        }
    }
    // An enterprise host the user's CLI is signed in to tells us the forge.
    if parsed.provider == Provider::Unknown {
        match cli {
            Some((Cli::Gh, _)) => parsed.provider = Provider::Github,
            Some((Cli::Glab, _)) => parsed.provider = Provider::Gitlab,
            None => {}
        }
    }
    Ok(RepoContext { remote_name, parsed, cli, gh, glab })
}

fn gh_repo_slug(p: &ParsedRemote) -> String {
    format!("{}/{}/{}", p.host, p.owner, p.repo)
}

fn validate_branch(value: &str, label: &str) -> Result<String, String> {
    validate_ref_token(value, label).map_err(user_err)?;
    Ok(value.trim().to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RemoteInfo {
    pub remote: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub provider: Provider,
    pub web_url: String,
    pub gh: CliStatus,
    pub glab: CliStatus,
    /// The CLI `create_pull_request` will use. `None` means browser only.
    pub cli: Option<Cli>,
}

#[command]
pub async fn get_remote_info(state: State<'_, AppState>, path: String) -> Result<RemoteInfo, String> {
    wrap_cmd("get_remote_info", async move {
        validate_path_is_trusted(&state, &path).await?;
        let ctx = repo_context(&path).await?;
        Ok(RemoteInfo {
            remote: ctx.remote_name,
            host: ctx.parsed.host,
            owner: ctx.parsed.owner,
            repo: ctx.parsed.repo,
            provider: ctx.parsed.provider,
            web_url: ctx.parsed.web_url,
            gh: ctx.gh,
            glab: ctx.glab,
            cli: ctx.cli.map(|(c, _)| c),
        })
    })
    .await
}

/// The remote's default branch from `refs/remotes/<remote>/HEAD`, falling
/// back to `main` / `master` on the remote and then locally.
#[command]
pub async fn get_default_branch(state: State<'_, AppState>, path: String) -> Result<Option<String>, String> {
    wrap_cmd("get_default_branch", async move {
        validate_path_is_trusted(&state, &path).await?;
        let remote = pick_remote(&path).await.unwrap_or_else(|_| "origin".to_string());
        let head_ref = format!("refs/remotes/{remote}/HEAD");
        if let Ok(out) = run_git(&path, &["symbolic-ref", "--quiet", "--short", &head_ref]).await {
            let short = out.trim();
            if let Some(branch) = short.strip_prefix(&format!("{remote}/")) {
                if !branch.is_empty() {
                    return Ok(Some(branch.to_string()));
                }
            }
        }
        for candidate in ["main", "master"] {
            for r in [format!("refs/remotes/{remote}/{candidate}"), format!("refs/heads/{candidate}")] {
                if run_git(&path, &["rev-parse", "--verify", "--quiet", &r]).await.is_ok() {
                    return Ok(Some(candidate.to_string()));
                }
            }
        }
        Ok(None)
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct PrCommit {
    pub short_sha: String,
    pub subject: String,
}

#[derive(Debug, Serialize)]
pub struct PrFile {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct PrContext {
    /// Newest first, like `git log base..HEAD --oneline`.
    pub commits: Vec<PrCommit>,
    pub files: Vec<PrFile>,
    /// The ref the range was computed against (`origin/main` or `main`).
    pub base_ref: String,
}

/// Commits and changed files between `base` and the current HEAD, used to
/// prefill the PR body. Prefers the remote-tracking base so a stale local
/// `main` does not inflate the list.
#[command]
pub async fn get_pr_context(state: State<'_, AppState>, path: String, base: String) -> Result<PrContext, String> {
    wrap_cmd("get_pr_context", async move {
        validate_path_is_trusted(&state, &path).await?;
        let base = validate_branch(&base, "Base branch")?;
        let remote = pick_remote(&path).await.unwrap_or_else(|_| "origin".to_string());
        let remote_base = format!("refs/remotes/{remote}/{base}");
        let base_ref = if run_git(&path, &["rev-parse", "--verify", "--quiet", &remote_base]).await.is_ok() {
            format!("{remote}/{base}")
        } else if run_git(&path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{base}")]).await.is_ok() {
            base.clone()
        } else {
            return Err(user_err(format!("Base branch '{base}' was not found locally or on {remote}")));
        };
        let range = format!("{base_ref}..HEAD");
        let log = run_git(&path, &["log", "--max-count=200", "--format=%h\x1f%s", &range]).await?;
        let commits = log
            .lines()
            .filter_map(|l| l.split_once('\x1f'))
            .map(|(sha, subject)| PrCommit { short_sha: sha.to_string(), subject: subject.to_string() })
            .collect();
        let three_dot = format!("{base_ref}...HEAD");
        let diff = run_git(&path, &["diff", "--name-status", "--no-renames", &three_dot]).await?;
        let files = diff
            .lines()
            .filter_map(|l| l.split_once('\t'))
            .map(|(status, p)| PrFile { status: status.trim().to_string(), path: p.trim().to_string() })
            .collect();
        Ok(PrContext { commits, files, base_ref })
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct CreatedPullRequest {
    pub url: String,
    pub number: u64,
    pub provider: Provider,
    /// True when the forge already had a PR for this head; `url` points at it.
    pub already_existed: bool,
}

/// Temp file holding the PR body for `gh --body-file`; removed on drop.
struct TempBody(std::path::PathBuf);

impl TempBody {
    fn write(body: &str) -> Result<Self, String> {
        let p = std::env::temp_dir().join(format!("agentrium-pr-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&p, body).map_err(|e| format!("Could not write the PR body to a temp file: {e}"))?;
        Ok(TempBody(p))
    }
}

impl Drop for TempBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cli_failure_message(cli: Cli, host: &str, base: &str, head: &str, remote: &str, stderr: &str) -> String {
    match classify_cli_failure(stderr) {
        CliFailure::Auth => user_err(format!(
            "{} is not signed in to {host}. Run `{} auth login`, or create the PR in the browser.",
            cli.binary(), cli.binary()
        )),
        CliFailure::NotPushed => user_err(format!("Branch '{head}' is not on {remote} yet. Push it first.")),
        CliFailure::NoCommits => user_err(format!("There are no commits between {base} and {head}.")),
        _ => user_err(if stderr.is_empty() { format!("{} failed", cli.binary()) } else { stderr.to_string() }),
    }
}

#[command]
pub async fn create_pull_request(
    state: State<'_, AppState>,
    path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<CreatedPullRequest, String> {
    wrap_cmd("create_pull_request", async move {
        validate_path_is_trusted(&state, &path).await?;
        let base = validate_branch(&base, "Base branch")?;
        let head = validate_branch(&head, "Head branch")?;
        if base == head {
            return Err(user_err("Base and head are the same branch"));
        }
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() {
            return Err(user_err("Add a title for the pull request"));
        }
        if title.chars().count() > MAX_TITLE_LEN {
            return Err(user_err(format!("The title is longer than {MAX_TITLE_LEN} characters")));
        }
        if body.chars().count() > MAX_BODY_LEN {
            return Err(user_err(format!("The description is longer than {MAX_BODY_LEN} characters")));
        }

        let ctx = repo_context(&path).await?;
        let (cli, program) = ctx.cli.clone().ok_or_else(|| {
            user_err(format!("No signed-in gh or glab CLI for {}. Create the PR in the browser instead.", ctx.parsed.host))
        })?;
        let tracking = format!("refs/remotes/{}/{}", ctx.remote_name, head);
        if run_git(&path, &["rev-parse", "--verify", "--quiet", &tracking]).await.is_err() {
            return Err(user_err(format!("Branch '{head}' is not on {} yet. Push it first.", ctx.remote_name)));
        }

        let out = match cli {
            Cli::Gh => {
                let body_file = TempBody::write(&body)?;
                let body_path = body_file.0.to_string_lossy().to_string();
                let slug = gh_repo_slug(&ctx.parsed);
                let mut args = vec![
                    "pr", "create", "--repo", &slug, "--base", &base, "--head", &head,
                    "--title", &title, "--body-file", &body_path,
                ];
                if draft {
                    args.push("--draft");
                }
                run_cli(&program, &path, &args).await?
            }
            Cli::Glab => {
                // glab has no description-file flag. The body is one argv
                // element (no shell on Windows, single-quoted on Unix).
                let mut args = vec![
                    "mr", "create", "--repo", &ctx.parsed.web_url, "--source-branch", &head,
                    "--target-branch", &base, "--title", &title, "--description", &body, "--yes",
                ];
                if draft {
                    args.push("--draft");
                }
                run_cli(&program, &path, &args).await?
            }
        };

        if out.success {
            let (url, number) = find_pr_url(&out.stdout)
                .ok_or_else(|| format!("{} created the PR but printed no URL", cli.binary()))?;
            return Ok(CreatedPullRequest { url, number, provider: ctx.parsed.provider, already_existed: false });
        }
        if classify_cli_failure(&out.stderr) == CliFailure::AlreadyExists {
            if let Some((url, number)) = find_pr_url(&out.stderr) {
                return Ok(CreatedPullRequest { url, number, provider: ctx.parsed.provider, already_existed: true });
            }
        }
        Err(cli_failure_message(cli, &ctx.parsed.host, &base, &head, &ctx.remote_name, &out.stderr))
    })
    .await
}

const GH_STATUS_FIELDS: &str = "number,url,state,isDraft,reviewDecision,statusCheckRollup,mergeable";

async fn fetch_status(path: &str, ctx: &RepoContext, branch: &str) -> Result<Option<PullRequestStatus>, String> {
    let Some((cli, program)) = ctx.cli.as_ref() else { return Ok(None) };
    let out = match cli {
        Cli::Gh => {
            let slug = gh_repo_slug(&ctx.parsed);
            run_cli(program, path, &["pr", "view", branch, "--repo", &slug, "--json", GH_STATUS_FIELDS]).await?
        }
        Cli::Glab => run_cli(program, path, &["mr", "view", branch, "--repo", &ctx.parsed.web_url, "--output", "json"]).await?,
    };
    if !out.success {
        return match classify_cli_failure(&out.stderr) {
            CliFailure::NotFound => Ok(None),
            _ => Err(cli_failure_message(*cli, &ctx.parsed.host, "", branch, &ctx.remote_name, &out.stderr)),
        };
    }
    let mut status = match cli {
        Cli::Gh => parse_gh_status(&out.stdout)?,
        Cli::Glab => parse_glab_status(&out.stdout)?,
    };
    status.provider = ctx.parsed.provider;
    Ok(Some(status))
}

/// Status of the PR whose head is `branch`. `None` when no signed-in CLI can
/// answer for this remote, or when no PR exists for the branch.
#[command]
pub async fn get_pull_request_status(
    state: State<'_, AppState>,
    path: String,
    branch: String,
) -> Result<Option<PullRequestStatus>, String> {
    wrap_cmd("get_pull_request_status", async move {
        validate_path_is_trusted(&state, &path).await?;
        let branch = validate_branch(&branch, "Branch")?;
        let ctx = repo_context(&path).await?;
        fetch_status(&path, &ctx, &branch).await
    })
    .await
}

/// Unique GitHub Actions run ids from failing check URLs, in order.
pub fn actions_run_ids(failing: &[FailingCheck]) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"/actions/runs/(\d+)").expect("valid regex"));
    let mut ids: Vec<String> = Vec::new();
    for c in failing {
        if let Some(id) = c.url.as_deref().and_then(|u| re.captures(u)).and_then(|m| m.get(1)) {
            let id = id.as_str().to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Keep the end of a log (failures print last), cut at a char boundary.
pub fn tail_chars(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    (text.chars().skip(count - max).collect(), true)
}

/// `gh run view --log-failed` for up to three failing Actions runs, ANSI
/// stripped and tail-truncated. `None` when gh is unavailable, the PR has no
/// failing Actions runs, or no log could be read.
#[command]
pub async fn get_failing_check_logs(
    state: State<'_, AppState>,
    path: String,
    branch: String,
) -> Result<Option<String>, String> {
    wrap_cmd("get_failing_check_logs", async move {
        validate_path_is_trusted(&state, &path).await?;
        let branch = validate_branch(&branch, "Branch")?;
        let ctx = repo_context(&path).await?;
        let Some((Cli::Gh, program)) = ctx.cli.as_ref() else { return Ok(None) };
        let Some(status) = fetch_status(&path, &ctx, &branch).await? else { return Ok(None) };
        let slug = gh_repo_slug(&ctx.parsed);
        let mut sections = Vec::new();
        for id in actions_run_ids(&status.ci.failing).into_iter().take(MAX_FAILED_RUNS) {
            let out = run_cli(program, &path, &["run", "view", &id, "--log-failed", "--repo", &slug]).await?;
            if !out.success || out.stdout.trim().is_empty() {
                continue;
            }
            let plain = String::from_utf8_lossy(&strip_ansi_escapes::strip(out.stdout.as_bytes())).to_string();
            let (tail, cut) = tail_chars(plain.trim(), MAX_LOG_CHARS_PER_RUN);
            sections.push(format!(
                "### Run {id}{}\n```\n{}\n```",
                if cut { " (last lines)" } else { "" },
                strip_credentials(&tail)
            ));
        }
        Ok((!sections.is_empty()).then(|| sections.join("\n\n")))
    })
    .await
}

#[command]
pub async fn build_pr_compare_url(
    state: State<'_, AppState>,
    path: String,
    base: String,
    head: String,
    title: String,
    body: String,
) -> Result<CompareUrl, String> {
    wrap_cmd("build_pr_compare_url", async move {
        validate_path_is_trusted(&state, &path).await?;
        let base = validate_branch(&base, "Base branch")?;
        let head = validate_branch(&head, "Head branch")?;
        let remote = pick_remote(&path).await?;
        let raw = run_git(&path, &["remote", "get-url", &remote])
            .await
            .map_err(|e| user_err(strip_credentials(&e)))?;
        let parsed = parse_remote_url(&raw)
            .ok_or_else(|| user_err(format!("Remote '{remote}' is not a hosted repository URL")))?;
        Ok(build_compare_url(&parsed, &base, &head, title.trim(), &body, MAX_COMPARE_URL_LEN))
    })
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remote(url: &str) -> ParsedRemote {
        parse_remote_url(url).unwrap_or_else(|| panic!("should parse {url}"))
    }

    #[test]
    fn parses_github_ssh_and_https() {
        for url in [
            "git@github.com:talayash/agentrium.git",
            "git@github.com:talayash/agentrium",
            "ssh://git@github.com/talayash/agentrium.git",
            "ssh://git@github.com:22/talayash/agentrium.git",
            "https://github.com/talayash/agentrium.git",
            "https://github.com/talayash/agentrium/",
            "https://GitHub.com/talayash/agentrium",
        ] {
            let r = remote(url);
            assert_eq!(r.host, "github.com", "{url}");
            assert_eq!(r.owner, "talayash", "{url}");
            assert_eq!(r.repo, "agentrium", "{url}");
            assert_eq!(r.provider, Provider::Github, "{url}");
            assert_eq!(r.web_url, "https://github.com/talayash/agentrium", "{url}");
        }
    }

    #[test]
    fn parses_enterprise_hosts_and_keeps_https_port() {
        let r = remote("https://git.corp.example:8443/platform/api.git");
        assert_eq!(r.provider, Provider::Unknown);
        assert_eq!(r.web_url, "https://git.corp.example:8443/platform/api");
        let r = remote("git@github.corp.example:platform/api.git");
        assert_eq!(r.provider, Provider::Github);
        assert_eq!(r.web_url, "https://github.corp.example/platform/api");
        // An SSH port is not the web UI port.
        let r = remote("ssh://git@git.corp.example:7999/platform/api.git");
        assert_eq!(r.web_url, "https://git.corp.example/platform/api");
    }

    #[test]
    fn parses_gitlab_subgroups() {
        let r = remote("git@gitlab.com:acme/backend/services/billing.git");
        assert_eq!(r.provider, Provider::Gitlab);
        assert_eq!(r.owner, "acme/backend/services");
        assert_eq!(r.repo, "billing");
        assert_eq!(r.web_url, "https://gitlab.com/acme/backend/services/billing");
        let r = remote("https://gitlab.example.org/group/sub/repo.git");
        assert_eq!(r.provider, Provider::Gitlab);
        assert_eq!(r.owner, "group/sub");
    }

    #[test]
    fn parses_azure_devops_shapes() {
        for url in [
            "https://dev.azure.com/contoso/Fabrikam/_git/web",
            "https://contoso@dev.azure.com/contoso/Fabrikam/_git/web",
            "git@ssh.dev.azure.com:v3/contoso/Fabrikam/web",
        ] {
            let r = remote(url);
            assert_eq!(r.provider, Provider::Azure, "{url}");
            assert_eq!(r.owner, "contoso/Fabrikam", "{url}");
            assert_eq!(r.repo, "web", "{url}");
            assert_eq!(r.web_url, "https://dev.azure.com/contoso/Fabrikam/_git/web", "{url}");
        }
        let r = remote("https://contoso.visualstudio.com/DefaultCollection/Fabrikam/_git/web");
        assert_eq!(r.web_url, "https://contoso.visualstudio.com/Fabrikam/_git/web");
        assert_eq!(r.owner, "contoso/Fabrikam");
    }

    #[test]
    fn parses_bitbucket() {
        let r = remote("git@bitbucket.org:team/app.git");
        assert_eq!(r.provider, Provider::Bitbucket);
        assert_eq!(r.web_url, "https://bitbucket.org/team/app");
    }

    #[test]
    fn rejects_local_and_malformed_remotes() {
        for url in ["", "/srv/git/repo.git", "C:/repos/app", "C:\\repos\\app", "../other", "file:///srv/repo.git",
            "https://github.com/only-owner", "git@github.com:", "https://github.com/o/r with space"] {
            assert!(parse_remote_url(url).is_none(), "{url} should not parse");
        }
    }

    #[test]
    fn credentials_never_reach_the_parsed_remote() {
        let r = remote("https://x-access-token:ghp_SECRET123@github.com/o/r.git");
        let debug = format!("{r:?}");
        assert!(!debug.contains("SECRET"), "{debug}");
        assert!(!debug.contains("x-access-token"), "{debug}");
        assert_eq!(r.web_url, "https://github.com/o/r");
    }

    #[test]
    fn strips_credentials_from_free_text() {
        let msg = "fatal: unable to access 'https://user:ghp_abc@github.com/o/r.git/': 403\n\
                   remote: see https://oauth2:glpat-xyz@gitlab.com/g/r and ssh://git@host/x";
        let clean = strip_credentials(msg);
        assert!(!clean.contains("ghp_abc"));
        assert!(!clean.contains("glpat-xyz"));
        assert!(!clean.contains("oauth2"));
        assert!(clean.contains("https://github.com/o/r.git/"));
        assert!(clean.contains("ssh://host/x"));
        assert_eq!(strip_credentials("no urls here"), "no urls here");
    }

    #[test]
    fn github_compare_url_encodes_branches_title_and_body() {
        let r = remote("git@github.com:o/r.git");
        let c = build_compare_url(&r, "main", "feature/a b&c", "Fix #12 & more", "line 1\nline 2 = ok?", MAX_COMPARE_URL_LEN);
        assert_eq!(c.body, BodyInUrl::Full);
        assert_eq!(
            c.url,
            "https://github.com/o/r/compare/main...feature/a%20b%26c?expand=1&title=Fix%20%2312%20%26%20more&body=line%201%0Aline%202%20%3D%20ok%3F"
        );
    }

    #[test]
    fn gitlab_bitbucket_and_azure_create_urls() {
        let g = build_compare_url(&remote("git@gitlab.com:g/sub/r.git"), "main", "feat/x", "T", "B", MAX_COMPARE_URL_LEN);
        assert_eq!(
            g.url,
            "https://gitlab.com/g/sub/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fx&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=T&merge_request%5Bdescription%5D=B"
        );
        let b = build_compare_url(&remote("git@bitbucket.org:t/app.git"), "main", "feat/x", "T", "B", MAX_COMPARE_URL_LEN);
        assert_eq!(b.url, "https://bitbucket.org/t/app/pull-requests/new?source=feat%2Fx&dest=main");
        assert_eq!(b.body, BodyInUrl::Omitted);
        let a = build_compare_url(&remote("https://dev.azure.com/o/p/_git/r"), "main", "feat/x", "T", "", MAX_COMPARE_URL_LEN);
        assert_eq!(a.url, "https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=feat%2Fx&targetRef=main");
        assert_eq!(a.body, BodyInUrl::Full);
    }

    #[test]
    fn long_bodies_are_truncated_to_fit_the_url_limit() {
        let r = remote("git@github.com:o/r.git");
        // Multi-byte chars expand to 9 encoded bytes each; cut must stay on a char boundary.
        let body = "é".repeat(5000);
        let c = build_compare_url(&r, "main", "x", "Title", &body, 2000);
        assert_eq!(c.body, BodyInUrl::Truncated);
        assert!(c.url.len() <= 2000, "len {}", c.url.len());
        assert!(c.url.contains(&enc(TRUNCATION_NOTE)));
        // As much body as fits: one more char would overflow.
        let kept = c.url.matches("%C3%A9").count();
        assert!(kept > 100);
        let one_more = "é".repeat(kept + 1) + TRUNCATION_NOTE;
        assert!(compare_url_with(&r, "main", "x", "Title", Some(&one_more)).len() > 2000);
    }

    #[test]
    fn rollup_failure_beats_pending_beats_success() {
        let ok = json!({"__typename":"CheckRun","name":"build","status":"COMPLETED","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/1/job/2"});
        let skipped = json!({"__typename":"CheckRun","name":"docs","status":"COMPLETED","conclusion":"SKIPPED"});
        let running = json!({"__typename":"CheckRun","name":"e2e","status":"IN_PROGRESS","conclusion":""});
        let failed = json!({"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/9/job/3"});
        let status_err = json!({"__typename":"StatusContext","context":"ci/jenkins","state":"ERROR","targetUrl":"https://ci.example/1"});
        let status_pending = json!({"__typename":"StatusContext","context":"vercel","state":"PENDING"});

        assert_eq!(rollup_checks(&[]).state, CiState::None);
        assert_eq!(rollup_checks(&[ok.clone(), skipped.clone()]).state, CiState::Success);
        assert_eq!(rollup_checks(&[ok.clone(), running.clone()]).state, CiState::Pending);
        assert_eq!(rollup_checks(&[ok.clone(), status_pending]).state, CiState::Pending);
        let r = rollup_checks(&[ok, running, failed, status_err]);
        assert_eq!(r.state, CiState::Failure);
        assert_eq!(r.total, 4);
        assert_eq!(r.failing, vec![
            FailingCheck { name: "lint".into(), url: Some("https://github.com/o/r/actions/runs/9/job/3".into()) },
            FailingCheck { name: "ci/jenkins".into(), url: Some("https://ci.example/1".into()) },
        ]);
    }

    #[test]
    fn parses_real_gh_pr_view_output() {
        // Captured from `gh pr view --json number,url,state,isDraft,reviewDecision,statusCheckRollup,mergeable`.
        let out = r#"{"isDraft":false,"mergeable":"MERGEABLE","number":84,"reviewDecision":"","state":"OPEN","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-10-01T12:27:14Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/talayash/agentrium/actions/runs/36861695269/job/110367199549","name":"Frontend (typecheck + vitest)","startedAt":"2026-10-01T12:25:55Z","status":"COMPLETED","workflowName":"CI"}],"url":"https://github.com/talayash/agentrium/pull/84"}"#;
        let s = parse_gh_status(out).unwrap();
        assert_eq!(s.number, 84);
        assert_eq!(s.state, PrState::Open);
        assert!(!s.draft);
        assert_eq!(s.review_decision, None);
        assert_eq!(s.mergeable, Some(MergeState::Mergeable));
        assert_eq!(s.ci.state, CiState::Success);

        let merged = r#"login banner noise
{"isDraft":true,"mergeable":"CONFLICTING","number":7,"reviewDecision":"CHANGES_REQUESTED","state":"MERGED","statusCheckRollup":null,"url":"https://ghe.corp/o/r/pull/7"}"#;
        let s = parse_gh_status(merged).unwrap();
        assert_eq!(s.state, PrState::Merged);
        assert!(s.draft);
        assert_eq!(s.review_decision, Some(ReviewDecision::ChangesRequested));
        assert_eq!(s.mergeable, Some(MergeState::Conflicting));
        assert_eq!(s.ci.state, CiState::None);
        assert!(parse_gh_status("not json").is_err());
    }

    #[test]
    fn parses_glab_mr_view_output() {
        let out = json!({
            "iid": 42, "web_url": "https://gitlab.com/g/r/-/merge_requests/42", "state": "opened",
            "draft": true, "merge_status": "can_be_merged", "has_conflicts": false,
            "head_pipeline": {"status": "failed", "web_url": "https://gitlab.com/g/r/-/pipelines/5"}
        }).to_string();
        let s = parse_glab_status(&out).unwrap();
        assert_eq!(s.number, 42);
        assert_eq!(s.state, PrState::Open);
        assert!(s.draft);
        assert_eq!(s.mergeable, Some(MergeState::Mergeable));
        assert_eq!(s.ci.state, CiState::Failure);
        assert_eq!(s.ci.failing[0].url.as_deref(), Some("https://gitlab.com/g/r/-/pipelines/5"));

        let merged = json!({"iid": 3, "web_url": "u", "state": "merged", "head_pipeline": null}).to_string();
        let s = parse_glab_status(&merged).unwrap();
        assert_eq!(s.state, PrState::Merged);
        assert_eq!(s.ci.state, CiState::None);
    }

    #[test]
    fn finds_created_and_existing_pr_urls() {
        assert_eq!(
            find_pr_url("Creating pull request for x into main in o/r\n\nhttps://github.com/o/r/pull/123\n"),
            Some(("https://github.com/o/r/pull/123".into(), 123))
        );
        let exists = "a pull request for branch \"x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/77";
        assert_eq!(classify_cli_failure(exists), CliFailure::AlreadyExists);
        assert_eq!(find_pr_url(exists).map(|(_, n)| n), Some(77));
        assert_eq!(
            find_pr_url("!42 Title (feat) https://gitlab.com/g/r/-/merge_requests/42").map(|(_, n)| n),
            Some(42)
        );
        assert_eq!(find_pr_url("nothing"), None);
    }

    #[test]
    fn classifies_cli_failures() {
        assert_eq!(classify_cli_failure("To get started with GitHub CLI, please run:  gh auth login"), CliFailure::Auth);
        assert_eq!(classify_cli_failure("HTTP 401: Bad credentials"), CliFailure::Auth);
        assert_eq!(classify_cli_failure("no pull requests found for branch \"x\""), CliFailure::NotFound);
        assert_eq!(classify_cli_failure("aborted: you must first push the current branch to a remote"), CliFailure::NotPushed);
        assert_eq!(classify_cli_failure("GraphQL: Head sha can't be blank, Base sha can't be blank"), CliFailure::NotPushed);
        assert_eq!(classify_cli_failure("pull request create failed: GraphQL: No commits between main and x"), CliFailure::NoCommits);
        assert_eq!(classify_cli_failure("something else"), CliFailure::Other);
        let msg = cli_failure_message(Cli::Gh, "github.com", "main", "x", "origin", "HTTP 401");
        assert!(crate::error_reporter::is_user_error(&msg));
        assert!(msg.contains("gh auth login"));
    }

    #[test]
    fn picks_only_real_exes_on_windows() {
        assert_eq!(
            pick_windows_exe("C:\\tools\\gh.cmd\r\nC:\\Program Files\\GitHub CLI\\gh.exe\r\n"),
            Some("C:\\Program Files\\GitHub CLI\\gh.exe".into())
        );
        assert_eq!(pick_windows_exe("C:\\npm\\glab.cmd\r\n"), None);
        assert_eq!(pick_windows_exe(""), None);
    }

    #[test]
    fn extracts_actions_run_ids_and_tails_logs() {
        let failing = vec![
            FailingCheck { name: "a".into(), url: Some("https://github.com/o/r/actions/runs/11/job/1".into()) },
            FailingCheck { name: "b".into(), url: Some("https://github.com/o/r/actions/runs/11/job/2".into()) },
            FailingCheck { name: "c".into(), url: Some("https://ci.example/9".into()) },
            FailingCheck { name: "d".into(), url: Some("https://github.com/o/r/actions/runs/12/job/3".into()) },
            FailingCheck { name: "e".into(), url: None },
        ];
        assert_eq!(actions_run_ids(&failing), vec!["11".to_string(), "12".to_string()]);
        assert_eq!(tail_chars("abcdef", 10), ("abcdef".into(), false));
        assert_eq!(tail_chars("abcdéf", 3), ("déf".into(), true));
    }
}
