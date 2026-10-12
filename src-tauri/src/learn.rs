//! Learn Cards: turn a session's git diff into 1-3 short, verified lessons.
//! Pure logic lives here; IPC commands live in the same file.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{command, State};

use crate::commands::{
    db_op, git_cmd_async, resolve_repo_root, shell_command, validate_git_pathspec, wrap_cmd,
};
use crate::AppState;

pub const MAX_DIFF_BYTES: usize = 24 * 1024;
pub const MAX_CARDS: usize = 3;
pub const CONSENT_KEY: &str = "learn_ai_consent";
const MAX_QUOTE_LINES: usize = 12;
const KINDS: [&str; 4] = ["pattern", "system_design", "syntax", "concept"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonCard {
    pub id: String,
    pub terminal_id: String,
    pub created_at: String,
    pub kind: String,
    pub title: String,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub quote: Vec<String>,
    pub highlight: Vec<u32>,
    pub why: [String; 3],
    pub question: String,
    pub options: [String; 3],
    pub answer_index: u8,
    pub explain: String,
    pub saved: bool,
    pub answered_index: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCard {
    pub kind: String,
    pub title: String,
    pub file: String,
    pub quote: Vec<String>,
    pub why: Vec<String>,
    pub question: String,
    pub options: Vec<String>,
    pub answer_index: u8,
    pub explain: String,
}

#[derive(Deserialize)]
struct RawEnvelope {
    cards: Vec<RawCard>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiffFile {
    pub path: String,
    /// Trimmed lines that exist in the new version (added + context).
    pub visible: Vec<String>,
    /// Trimmed added lines only.
    pub added: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DiffBundle {
    pub files: Vec<DiffFile>,
    pub text: String,
    pub truncated: bool,
}

impl DiffBundle {
    pub fn is_empty(&self) -> bool {
        self.files.iter().all(|f| f.added.is_empty())
    }
}

pub fn parse_unified_diff(text: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    // None while inside a deleted file (+++ /dev/null) so its lines attach nowhere.
    let mut current: Option<usize> = None;
    let mut in_hunk = false;
    for line in text.lines() {
        if line.starts_with("diff --git ") {
            in_hunk = false;
            current = None;
            continue;
        }
        if !in_hunk {
            if let Some(p) = line.strip_prefix("+++ ") {
                let p = p.trim_end();
                if p == "/dev/null" {
                    current = None;
                } else {
                    files.push(DiffFile {
                        path: p.strip_prefix("b/").unwrap_or(p).to_string(),
                        ..Default::default()
                    });
                    current = Some(files.len() - 1);
                }
                continue;
            }
            if line.starts_with("--- ") {
                continue;
            }
        }
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        let (Some(i), true) = (current, in_hunk) else {
            continue;
        };
        if let Some(rest) = line.strip_prefix('+') {
            files[i].added.push(rest.trim().to_string());
            files[i].visible.push(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix(' ') {
            files[i].visible.push(rest.trim().to_string());
        }
    }
    files
}

pub fn parse_cards(stdout: &str) -> Result<Vec<RawCard>, String> {
    let start = stdout.find('{').ok_or("no JSON object in model output")?;
    let end = stdout.rfind('}').ok_or("no JSON object in model output")?;
    if end < start {
        return Err("no JSON object in model output".into());
    }
    let env: RawEnvelope = serde_json::from_str(&stdout[start..=end])
        .map_err(|e| format!("invalid lesson JSON: {e}"))?;
    Ok(env.cards)
}

fn find_block(lines: &[&str], quote: &[String]) -> Option<usize> {
    if quote.is_empty() || quote.len() > lines.len() {
        return None;
    }
    (0..=lines.len() - quote.len()).find(|&i| {
        quote
            .iter()
            .enumerate()
            .all(|(j, q)| lines[i + j].trim() == q.trim())
    })
}

pub fn verify_cards<F: Fn(&str) -> Option<String>>(
    raw: Vec<RawCard>,
    bundle: &DiffBundle,
    terminal_id: &str,
    read_file: F,
) -> Vec<LessonCard> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut out = Vec::new();
    for r in raw {
        if out.len() >= MAX_CARDS {
            break;
        }
        if r.title.trim().is_empty()
            || r.why.len() != 3
            || r.options.len() != 3
            || r.answer_index > 2
        {
            continue;
        }
        let mut quote: Vec<String> = r.quote.iter().map(|l| l.trim_end().to_string()).collect();
        while quote.first().is_some_and(|l| l.trim().is_empty()) {
            quote.remove(0);
        }
        while quote.last().is_some_and(|l| l.trim().is_empty()) {
            quote.pop();
        }
        if quote.is_empty() || quote.len() > MAX_QUOTE_LINES {
            continue;
        }
        let Some(file) = bundle.files.iter().find(|f| f.path == r.file) else {
            continue;
        };
        let visible: HashSet<&str> = file.visible.iter().map(String::as_str).collect();
        let added: HashSet<&str> = file.added.iter().map(String::as_str).collect();
        let nonblank: Vec<&str> = quote
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if !nonblank.iter().all(|l| visible.contains(l))
            || !nonblank.iter().any(|l| added.contains(l))
        {
            continue;
        }
        let Some(content) = read_file(&file.path) else {
            continue;
        };
        let lines: Vec<&str> = content.lines().collect();
        let Some(start) = find_block(&lines, &quote) else {
            continue;
        };
        let real: Vec<String> = lines[start..start + quote.len()]
            .iter()
            .map(|l| l.trim_end_matches('\r').to_string())
            .collect();
        let start_line = start as u32 + 1;
        let highlight = real
            .iter()
            .enumerate()
            .filter(|(_, l)| {
                let t = l.trim();
                !t.is_empty() && added.contains(t)
            })
            .map(|(i, _)| start_line + i as u32)
            .collect();
        let kind = if KINDS.contains(&r.kind.as_str()) {
            r.kind
        } else {
            "concept".to_string()
        };
        out.push(LessonCard {
            id: uuid::Uuid::new_v4().to_string(),
            terminal_id: terminal_id.to_string(),
            created_at: now.clone(),
            kind,
            title: r.title.trim().to_string(),
            file_path: file.path.clone(),
            start_line,
            end_line: start_line + real.len() as u32 - 1,
            quote: real,
            highlight,
            why: [r.why[0].clone(), r.why[1].clone(), r.why[2].clone()],
            question: r.question,
            options: [
                r.options[0].clone(),
                r.options[1].clone(),
                r.options[2].clone(),
            ],
            answer_index: r.answer_index,
            explain: r.explain,
            saved: false,
            answered_index: None,
        });
    }
    out
}

pub fn build_prompt(goal: Option<&str>, truncated: bool) -> String {
    let mut p = String::from(
        "You are a senior engineer teaching a developer about code an AI coding agent just wrote. \
The unified git diff of the change is on stdin.\n",
    );
    if let Some(g) = goal.filter(|g| !g.trim().is_empty()) {
        p.push_str(&format!("The developer's request was: {}\n", g.trim()));
    }
    if truncated {
        p.push_str("The diff was truncated to fit; only teach from what you can see.\n");
    }
    p.push_str(
        "Pick 1 to 3 concepts this diff actually uses that are worth learning: a design pattern, \
a system design idea, or a language syntax feature. Skip trivial things.\n\
Reply with JSON only, no prose, exactly this shape:\n\
{\"cards\":[{\"kind\":\"pattern|system_design|syntax|concept\",\
\"title\":\"max 60 chars\",\
\"file\":\"repo-relative path exactly as in the diff\",\
\"quote\":[\"2 to 8 contiguous lines copied exactly from the new version of that file, including at least one added line\"],\
\"why\":[\"beginner explanation\",\"intermediate explanation\",\"expert explanation\"],\
\"question\":\"one question the developer can answer by reading the quote\",\
\"options\":[\"short option\",\"short option\",\"short option\"],\
\"answerIndex\":0,\
\"explain\":\"one or two sentences explaining the answer using the quoted code\"}]}\n\
Each why entry is at most 2 sentences and about THIS code, not generic theory. \
Never invent code that is not in the diff.",
    );
    p
}

fn in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(Default::default)
}

/// Removes the terminal id from the in-flight set when dropped.
pub struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub fn try_begin(terminal_id: &str) -> Option<InFlightGuard> {
    let mut set = in_flight().lock().unwrap_or_else(|e| e.into_inner());
    if !set.insert(terminal_id.to_string()) {
        return None;
    }
    Some(InFlightGuard(terminal_id.to_string()))
}

const MAX_UNTRACKED_FILE_BYTES: u64 = 256 * 1024;
const CLAUDE_TIMEOUT_SECS: u64 = 60;

fn cut_at_char_boundary(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s
}

async fn untracked_patch(full: &Path, rel: &str) -> Option<String> {
    let meta = tokio::fs::metadata(full).await.ok()?;
    if !meta.is_file() || meta.len() > MAX_UNTRACKED_FILE_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(full).await.ok()?;
    if bytes[..bytes.len().min(8192)].contains(&0u8) {
        return None;
    }
    let content = String::from_utf8(bytes).ok()?;
    let lines: Vec<String> = content.lines().map(|l| format!("+{l}")).collect();
    Some(format!(
        "diff --git a/{rel} b/{rel}\n--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n{}\n",
        lines.len(),
        lines.join("\n")
    ))
}

/// Working tree vs HEAD (tracked) plus untracked files, capped at MAX_DIFF_BYTES.
/// Any git failure (not a repo, no HEAD yet) yields fewer files, never an error.
pub async fn collect_diff(repo_root: &str) -> DiffBundle {
    let mut text = String::new();
    let mut truncated = false;
    if let Ok(o) = git_cmd_async(&["diff", "HEAD", "--no-color", "--no-ext-diff", "--unified=3"])
        .current_dir(repo_root)
        .output()
        .await
    {
        if o.status.success() {
            text.push_str(&String::from_utf8_lossy(&o.stdout));
        }
    }
    if let Ok(o) = git_cmd_async(&["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(repo_root)
        .output()
        .await
    {
        if o.status.success() {
            for raw in o.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                if text.len() >= MAX_DIFF_BYTES {
                    truncated = true;
                    break;
                }
                let rel = String::from_utf8_lossy(raw).to_string();
                if validate_git_pathspec(&rel).is_err() {
                    continue;
                }
                if let Some(patch) = untracked_patch(&Path::new(repo_root).join(&rel), &rel).await {
                    text.push_str(&patch);
                }
            }
        }
    }
    if text.len() > MAX_DIFF_BYTES {
        text = cut_at_char_boundary(text, MAX_DIFF_BYTES);
        truncated = true;
    }
    DiffBundle {
        files: parse_unified_diff(&text),
        text,
        truncated,
    }
}

enum RunOutcome {
    Ok(String),
    CliMissing,
    Timeout,
    Failed,
}

/// Same spawn pattern as `summarize_session`: bounded wait, kill on drop.
async fn run_claude(prompt: &str, stdin_text: &str) -> RunOutcome {
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;
    let mut cmd: tokio::process::Command =
        shell_command("claude", &["-p", "--model", "haiku", prompt]).into();
    cmd.kill_on_drop(true);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return RunOutcome::CliMissing,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_text.as_bytes()).await;
        drop(stdin);
    }
    match tokio::time::timeout(
        Duration::from_secs(CLAUDE_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(o)) if o.status.success() => {
            RunOutcome::Ok(String::from_utf8_lossy(&o.stdout).to_string())
        }
        Ok(Ok(_)) | Ok(Err(_)) => RunOutcome::Failed,
        Err(_) => RunOutcome::Timeout,
    }
}

pub(crate) async fn consent_granted(
    db: &Arc<std::sync::Mutex<crate::database::Database>>,
) -> Result<bool, String> {
    db_op(db, |db| {
        Ok(db.get_user_meta(CONSENT_KEY)?.as_deref() == Some("true"))
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub status: String,
    pub cards: Vec<LessonCard>,
}

impl GenerateResult {
    fn status(s: &str) -> Self {
        Self {
            status: s.to_string(),
            cards: vec![],
        }
    }
}

#[command]
pub async fn get_learn_consent(state: State<'_, AppState>) -> Result<bool, String> {
    wrap_cmd("get_learn_consent", async move {
        consent_granted(&state.db).await
    })
    .await
}

#[command]
pub async fn set_learn_consent(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    wrap_cmd("set_learn_consent", async move {
        db_op(&state.db, move |db| {
            db.set_user_meta(CONSENT_KEY, Some(if enabled { "true" } else { "false" }))
        })
        .await
    })
    .await
}

#[command]
pub async fn generate_learn_cards(
    state: State<'_, AppState>,
    terminal_id: String,
    goal: Option<String>,
) -> Result<GenerateResult, String> {
    wrap_cmd("generate_learn_cards", async move {
        // Rust owns consent so direct IPC calls cannot bypass the preference.
        if !consent_granted(&state.db).await? {
            return Ok(GenerateResult::status("no_consent"));
        }
        let Some(_guard) = try_begin(&terminal_id) else {
            return Ok(GenerateResult::status("in_progress"));
        };
        let working_directory = {
            let terminals = state.terminals.lock().await;
            terminals
                .terminals
                .get(&terminal_id)
                .map(|t| t.config.working_directory.clone())
        };
        let Some(wd) = working_directory else {
            return Ok(GenerateResult::status("no_changes"));
        };
        let Ok(root) = resolve_repo_root(&wd).await else {
            return Ok(GenerateResult::status("no_changes"));
        };
        let bundle = collect_diff(&root).await;
        if bundle.is_empty() {
            return Ok(GenerateResult::status("no_changes"));
        }
        let diff_text = crate::error_reporter::scrub(&bundle.text);
        let prompt = build_prompt(goal.as_deref(), bundle.truncated);
        let stdout = match run_claude(&prompt, &diff_text).await {
            RunOutcome::Ok(s) => s,
            RunOutcome::CliMissing => return Ok(GenerateResult::status("cli_missing")),
            RunOutcome::Timeout => return Ok(GenerateResult::status("timeout")),
            RunOutcome::Failed => return Ok(GenerateResult::status("failed")),
        };
        let Ok(raw) = parse_cards(&stdout) else {
            return Ok(GenerateResult::status("failed"));
        };
        let root_path = std::path::PathBuf::from(&root);
        let cards = verify_cards(raw, &bundle, &terminal_id, |p| {
            if validate_git_pathspec(p).is_err() {
                return None;
            }
            std::fs::read_to_string(root_path.join(p)).ok()
        });
        if cards.is_empty() {
            return Ok(GenerateResult::status("no_cards"));
        }
        let (tid, to_store) = (terminal_id.clone(), cards.clone());
        db_op(&state.db, move |db| db.replace_learn_cards(&tid, &to_store)).await?;
        Ok(GenerateResult {
            status: "ok".into(),
            cards,
        })
    })
    .await
}

#[command]
pub async fn list_learn_cards(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Vec<LessonCard>, String> {
    wrap_cmd("list_learn_cards", async move {
        db_op(&state.db, move |db| db.list_learn_cards(&terminal_id)).await
    })
    .await
}

#[command]
pub async fn update_learn_card(
    state: State<'_, AppState>,
    id: String,
    saved: Option<bool>,
    answered_index: Option<u8>,
) -> Result<(), String> {
    wrap_cmd("update_learn_card", async move {
        db_op(&state.db, move |db| {
            db.update_learn_card(&id, saved, answered_index)
        })
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // concat! (not `\` line continuations, which would eat the leading space of context lines).
    const DIFF: &str = concat!(
        "diff --git a/src/lib/api.ts b/src/lib/api.ts\n",
        "--- a/src/lib/api.ts\n",
        "+++ b/src/lib/api.ts\n",
        "@@ -40,3 +40,6 @@\n",
        " import { http } from './http';\n",
        "+export function withRetry<T>(\n",
        "+  fn: () => Promise<T>,\n",
        "+): () => Promise<T> {\n",
        "-const old = 1;\n",
        "diff --git a/gone.ts b/gone.ts\n",
        "--- a/gone.ts\n",
        "+++ /dev/null\n",
        "@@ -1,1 +0,0 @@\n",
        "-export const gone = 1;\n",
    );

    const FILE: &str = "import { http } from './http';\nexport function withRetry<T>(\n  fn: () => Promise<T>,\n): () => Promise<T> {\n  return fn;\n}\n";

    fn raw(file: &str, quote: &[&str]) -> RawCard {
        RawCard {
            kind: "pattern".into(),
            title: "Decorator".into(),
            file: file.into(),
            quote: quote.iter().map(|s| s.to_string()).collect(),
            why: vec!["b".into(), "i".into(), "e".into()],
            question: "What does withRetry return?".into(),
            options: vec!["data".into(), "a function".into(), "a promise".into()],
            answer_index: 1,
            explain: "Line says () => Promise<T>.".into(),
        }
    }

    fn bundle() -> DiffBundle {
        DiffBundle {
            files: parse_unified_diff(DIFF),
            text: DIFF.into(),
            truncated: false,
        }
    }

    #[test]
    fn parse_unified_diff_collects_added_and_context_and_skips_deleted_files() {
        let files = parse_unified_diff(DIFF);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/lib/api.ts");
        assert_eq!(
            files[0].added,
            vec![
                "export function withRetry<T>(",
                "fn: () => Promise<T>,",
                "): () => Promise<T> {"
            ]
        );
        assert!(files[0]
            .visible
            .contains(&"import { http } from './http';".to_string()));
        assert!(!files[0].visible.contains(&"const old = 1;".to_string()));
    }

    #[test]
    fn parse_cards_accepts_plain_and_fenced_json() {
        let json = r#"{"cards":[{"kind":"pattern","title":"T","file":"a.ts","quote":["x"],"why":["a","b","c"],"question":"q","options":["1","2","3"],"answerIndex":0,"explain":"e"}]}"#;
        assert_eq!(parse_cards(json).unwrap().len(), 1);
        let fenced = format!("Here you go:\n```json\n{}\n```\n", json);
        assert_eq!(parse_cards(&fenced).unwrap().len(), 1);
    }

    #[test]
    fn parse_cards_rejects_garbage() {
        assert!(parse_cards("no json here").is_err());
        assert!(parse_cards("{\"cards\": 5}").is_err());
    }

    #[test]
    fn verify_keeps_real_quote_and_computes_lines_from_file() {
        let cards = verify_cards(
            vec![raw(
                "src/lib/api.ts",
                &["export function withRetry<T>(", "  fn: () => Promise<T>,"],
            )],
            &bundle(),
            "t1",
            |p| (p == "src/lib/api.ts").then(|| FILE.to_string()),
        );
        assert_eq!(cards.len(), 1);
        let c = &cards[0];
        assert_eq!((c.start_line, c.end_line), (2, 3));
        assert_eq!(c.highlight, vec![2, 3]);
        assert_eq!(
            c.quote,
            vec!["export function withRetry<T>(", "  fn: () => Promise<T>,"]
        );
        assert_eq!(c.terminal_id, "t1");
        assert!(!c.saved && c.answered_index.is_none());
    }

    #[test]
    fn verify_accepts_crlf_and_indent_drift() {
        let crlf = FILE.replace('\n', "\r\n");
        let cards = verify_cards(
            vec![raw(
                "src/lib/api.ts",
                &["export function withRetry<T>(", "fn: () => Promise<T>,"],
            )],
            &bundle(),
            "t1",
            |_| Some(crlf.clone()),
        );
        assert_eq!(cards.len(), 1);
        // Shown code is the real file line, with its real indentation.
        assert_eq!(cards[0].quote[1], "  fn: () => Promise<T>,");
    }

    #[test]
    fn verify_drops_hallucinated_quotes_unknown_files_and_context_only_quotes() {
        let b = bundle();
        let read = |_: &str| Some(FILE.to_string());
        assert!(verify_cards(
            vec![raw("src/lib/api.ts", &["export function invented()"])],
            &b,
            "t",
            read
        )
        .is_empty());
        assert!(verify_cards(
            vec![raw("other.ts", &["export function withRetry<T>("])],
            &b,
            "t",
            read
        )
        .is_empty());
        assert!(verify_cards(
            vec![raw("src/lib/api.ts", &["import { http } from './http';"])],
            &b,
            "t",
            read
        )
        .is_empty());
    }

    #[test]
    fn verify_drops_malformed_cards_and_caps_at_three() {
        let b = bundle();
        let read = |_: &str| Some(FILE.to_string());
        let mut bad = raw("src/lib/api.ts", &["export function withRetry<T>("]);
        bad.options.pop();
        assert!(verify_cards(vec![bad], &b, "t", read).is_empty());
        let mut bad_idx = raw("src/lib/api.ts", &["export function withRetry<T>("]);
        bad_idx.answer_index = 3;
        assert!(verify_cards(vec![bad_idx], &b, "t", read).is_empty());
        let many = (0..5)
            .map(|_| raw("src/lib/api.ts", &["export function withRetry<T>("]))
            .collect();
        assert_eq!(verify_cards(many, &b, "t", read).len(), MAX_CARDS);
    }

    #[test]
    fn verify_maps_unknown_kind_to_concept() {
        let mut r = raw("src/lib/api.ts", &["export function withRetry<T>("]);
        r.kind = "vibes".into();
        let cards = verify_cards(vec![r], &bundle(), "t", |_| Some(FILE.to_string()));
        assert_eq!(cards[0].kind, "concept");
    }

    #[test]
    fn in_flight_guard_blocks_second_run() {
        let g = try_begin("term-x").expect("first run starts");
        assert!(try_begin("term-x").is_none());
        assert!(try_begin("term-y").is_some());
        drop(g);
        assert!(try_begin("term-x").is_some());
    }

    #[test]
    fn prompt_mentions_json_contract_and_goal() {
        let p = build_prompt(Some("add retry"), true);
        assert!(p.contains("\"cards\""));
        assert!(p.contains("add retry"));
        assert!(p.contains("truncated"));
        assert!(!build_prompt(None, false).contains("truncated"));
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {:?} failed", args);
    }

    fn repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q"]);
        git(d, &["config", "user.email", "t@example.com"]);
        git(d, &["config", "user.name", "t"]);
        std::fs::write(d.join("a.ts"), "export const a = 1;\n").unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-q", "-m", "init"]);
        tmp
    }

    #[tokio::test]
    async fn collect_diff_includes_tracked_and_untracked_changes() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("a.ts"), "export const a = 2;\n").unwrap();
        std::fs::write(d.join("b.ts"), "export const b = 1;\n").unwrap();
        let bundle = collect_diff(d.to_str().unwrap()).await;
        let paths: Vec<&str> = bundle.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.ts") && paths.contains(&"b.ts"));
        assert!(!bundle.is_empty());
    }

    #[tokio::test]
    async fn collect_diff_caps_and_skips_binary() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("bin.dat"), [0u8, 1, 2, 0, 5]).unwrap();
        // Multi-byte characters so a naive byte cut would split a char.
        std::fs::write(d.join("big.ts"), "const s = 'é';\n".repeat(4000)).unwrap();
        let bundle = collect_diff(d.to_str().unwrap()).await;
        assert!(bundle.text.len() <= MAX_DIFF_BYTES);
        assert!(bundle.truncated);
        assert!(bundle.files.iter().all(|f| f.path != "bin.dat"));
    }

    #[tokio::test]
    async fn collect_diff_on_non_repo_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.ts"), "x").unwrap();
        assert!(collect_diff(tmp.path().to_str().unwrap()).await.is_empty());
    }

    #[tokio::test]
    async fn consent_is_off_by_default_and_rust_owned() {
        let db = std::sync::Arc::new(std::sync::Mutex::new(
            crate::database::Database::new_in_memory().unwrap(),
        ));
        assert!(!consent_granted(&db).await.unwrap());
        db.lock()
            .unwrap()
            .set_user_meta(CONSENT_KEY, Some("true"))
            .unwrap();
        assert!(consent_granted(&db).await.unwrap());
    }
}
