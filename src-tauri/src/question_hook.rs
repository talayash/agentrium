//! Pending AskUserQuestion via a Claude Code PreToolUse hook.
//!
//! Claude Code 2.1.318 writes an `AskUserQuestion` tool_use to the session
//! JSONL only together with its tool_result, so the transcript alone never
//! shows a pending question. Each Claude terminal is therefore launched with
//! `--settings <private file>` holding one PreToolUse HTTP hook (matcher
//! `AskUserQuestion`) that POSTs the hook input to the embedded receiver
//! (`otel_receiver`), which turns it into an `insight-records` batch.
//!
//! Facts read from the installed 2.1.318 bundle (strings only, never run):
//! (a) `--settings <file-or-json>`: "Path to a settings JSON file or a JSON
//!     string to load additional settings from". It is the `flagSettings`
//!     source next to user/project/local/policy. Sources merge with
//!     `settingsMergeCustomizer`, which concatenates arrays
//!     (`if(Array.isArray(e)&&Array.isArray(n)) ... return L([...e,...n])`),
//!     and the hook snapshot captures hooks per source
//!     (`[["userSettings","user"],["localSettings","local"],["flagSettings","flag"]]`),
//!     so our PreToolUse entry is added to the user's hooks, not swapped in.
//!     The option is a plain commander option, so a second `--settings` would
//!     replace the user's own one: see `user_sets_settings`.
//! (b) `type: "http"` exists: keys `url` ("URL to POST the hook input JSON
//!     to"), `timeout` (seconds), `headers`, `allowedEnvVars`, `onFailure`
//!     (default 'continue'). A refused connection or non-2xx yields
//!     `hook_non_blocking_error`; a timeout yields `hook_cancelled`; only the
//!     cloud-session / remote paths (`withheld` / `unanswered`) block. A 2xx
//!     with an empty body is "treated as empty JSON object" (no decision), so
//!     the receiver answers 204 with no body. Loopback is explicitly allowed
//!     ("Loopback (127.0.0.1, ::1) is allowed for local dev").
//! (c) PreToolUse input: `{session_id, transcript_path, cwd,
//!     hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id}`.
//!     A missing or empty id still gets a stable synthetic
//!     `hook-<session_id>-<n>` so the frontend can track it (Task 15 treats
//!     `hook-` ids as answered by any later tool_result or prompt).
//! PROVISIONAL: that PreToolUse fires before AskUserQuestion renders its
//! prompt (no exception for this tool was found; confirmed live in Task 17).

use crate::insight_parse::InsightRecord;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Receiver route the hook POSTs to.
pub const ROUTE: &str = "/hooks/pre-tool-use";
/// The only tool the hook is registered for.
pub const MATCHER: &str = "AskUserQuestion";
/// Seconds Claude waits for the receiver. It answers at once, and a timeout
/// only cancels the hook, never the tool.
const HOOK_TIMEOUT_SECS: u64 = 5;

struct HookEntry {
    token: String,
    settings_path: Option<PathBuf>,
    synthetic: u64,
}

/// Per-terminal hook tokens, in memory only.
#[derive(Default)]
pub struct HookRegistry {
    entries: HashMap<String, HookEntry>,
}

impl HookRegistry {
    /// Issue (or re-issue) a random token for `terminal_id`.
    pub fn issue(&mut self, terminal_id: &str) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.entries.insert(
            terminal_id.to_string(),
            HookEntry { token: token.clone(), settings_path: None, synthetic: 0 },
        );
        token
    }

    pub fn set_settings_path(&mut self, terminal_id: &str, path: PathBuf) {
        if let Some(e) = self.entries.get_mut(terminal_id) {
            e.settings_path = Some(path);
        }
    }

    /// Forget `terminal_id`; returns its settings file for the caller to delete.
    pub fn revoke(&mut self, terminal_id: &str) -> Option<PathBuf> {
        self.entries.remove(terminal_id).and_then(|e| e.settings_path)
    }

    fn drain(&mut self) -> Vec<PathBuf> {
        self.entries.drain().filter_map(|(_, e)| e.settings_path).collect()
    }
}

/// What the receiver answers, plus the record to emit (terminal id, record).
#[derive(Debug, PartialEq)]
pub struct HookResponse {
    pub status: u16,
    pub emit: Option<(String, InsightRecord)>,
}

impl HookResponse {
    fn status(status: u16) -> Self {
        Self { status, emit: None }
    }
}

/// True when `url` (path plus query, as tiny_http reports it) is the hook route.
pub fn is_hook_route(url: &str) -> bool {
    url.split('?').next() == Some(ROUTE)
}

fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let (_, query) = url.split_once('?')?;
    query.split('&').find_map(|pair| match pair.split_once('=') {
        Some((k, v)) if k == key => Some(v),
        _ => None,
    })
}

/// Comparison that does not stop at the first differing byte, so the token
/// is not leaked through timing.
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Pure request handling for `POST ROUTE?terminal=<id>&token=<t>`: unknown
/// terminal 404, wrong or missing token 403, body not a JSON object 400,
/// anything else 204 (a record is emitted only for AskUserQuestion on a
/// terminal whose insight tailer is running).
pub fn handle_request(
    reg: &mut HookRegistry,
    url: &str,
    body: &str,
    tailer_running: impl Fn(&str) -> bool,
    now_ts: String,
) -> HookResponse {
    let Some(terminal_id) = query_param(url, "terminal") else {
        return HookResponse::status(404);
    };
    let Some(entry) = reg.entries.get_mut(terminal_id) else {
        return HookResponse::status(404);
    };
    if !query_param(url, "token").is_some_and(|t| token_matches(&entry.token, t)) {
        return HookResponse::status(403);
    }
    let input: Value = match serde_json::from_str(body) {
        Ok(v @ Value::Object(_)) => v,
        _ => return HookResponse::status(400),
    };
    if input.get("tool_name").and_then(Value::as_str) != Some(MATCHER) || !tailer_running(terminal_id) {
        return HookResponse::status(204);
    }
    let id = match input.get("tool_use_id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => {
            entry.synthetic += 1;
            let session = input.get("session_id").and_then(Value::as_str).unwrap_or("unknown");
            format!("hook-{session}-{}", entry.synthetic)
        }
    };
    let record = InsightRecord::ToolUse {
        ts: Some(now_ts),
        id,
        name: MATCHER.to_string(),
        target: None,
        input: input.get("tool_input").filter(|v| !v.is_null()).cloned(),
    };
    HookResponse { status: 204, emit: Some((terminal_id.to_string(), record)) }
}

/// The settings document passed through `--settings`.
pub fn settings_json(port: u16, terminal_id: &str, token: &str) -> Value {
    json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": MATCHER,
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}{ROUTE}?terminal={terminal_id}&token={token}"),
                    "timeout": HOOK_TIMEOUT_SECS,
                }],
            }],
        },
    })
}

/// Per-user folder for hook settings files: the app data dir (same
/// per-instance naming as the database), never the shared temp dir, since
/// the file carries the terminal's token.
fn settings_dir() -> Result<PathBuf, String> {
    let app_name = format!("ClaudeTerminal{}", crate::instance_suffix());
    let base = directories::ProjectDirs::from("com", "claudeterminal", &app_name)
        .ok_or("Failed to get project directories")?
        .data_dir()
        .to_path_buf();
    Ok(base.join("hook-settings"))
}

/// Write `text` to a new private file in `dir`. Files older than a week
/// (left behind by a crash) are cleaned up on the way.
pub(crate) fn write_settings_file_in(dir: &Path, text: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    if let Ok(entries) = std::fs::read_dir(dir) {
        let week = std::time::Duration::from_secs(7 * 24 * 3600);
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > week);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = dir.join(format!("{}.json", uuid::Uuid::new_v4()));
    // create_new: never follow or reuse an existing file or symlink.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    Ok(path)
}

/// True when the user's own args already pass `--settings`: a second flag
/// would replace theirs, so the hook is skipped for that terminal.
pub fn user_sets_settings(args: &[String]) -> bool {
    args.iter().any(|a| a == "--settings" || a.starts_with("--settings="))
}

fn registry() -> &'static Mutex<HookRegistry> {
    static REG: OnceLock<Mutex<HookRegistry>> = OnceLock::new();
    REG.get_or_init(Default::default)
}

fn lock() -> MutexGuard<'static, HookRegistry> {
    registry().lock().unwrap_or_else(|p| p.into_inner())
}

/// `report_bg` once per kind for the app's lifetime: a failure here repeats
/// for every terminal, and one report is enough to act on.
fn report_once(kind: &'static str, message: String) {
    static SEEN: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let first = SEEN
        .get_or_init(Default::default)
        .lock()
        .map(|mut s| s.insert(kind))
        .unwrap_or(false);
    if first {
        crate::error_reporter::report_bg(kind, message);
    }
}

/// Revokes a terminal's hook on drop unless `disarm`ed, so a spawn that
/// fails after `prepare` leaves no token or file behind.
pub struct HookGuard {
    terminal_id: Option<String>,
}

impl HookGuard {
    pub fn disarm(mut self) {
        self.terminal_id = None;
    }
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        if let Some(id) = self.terminal_id.take() {
            revoke(&id);
        }
    }
}

/// Register `terminal_id`, write its settings file and return the argv to
/// append (`--settings <path>`) plus a revoke guard. `None` skips the hook
/// (the terminal still starts) when the file cannot be written or its path
/// would not reach Claude unchanged through the spawn shell.
pub fn prepare(terminal_id: &str, port: u16) -> Option<(Vec<String>, HookGuard)> {
    let dir = match settings_dir() {
        Ok(d) => d,
        Err(e) => {
            report_once("question_hook_dir", e);
            return None;
        }
    };
    prepare_in(&dir, terminal_id, port, cfg!(target_os = "windows"))
}

pub(crate) fn prepare_in(
    dir: &Path,
    terminal_id: &str,
    port: u16,
    windows: bool,
) -> Option<(Vec<String>, HookGuard)> {
    let token = lock().issue(terminal_id);
    let guard = HookGuard { terminal_id: Some(terminal_id.to_string()) };
    let path = match write_settings_file_in(dir, &settings_json(port, terminal_id, &token).to_string()) {
        Ok(p) => p,
        Err(e) => {
            report_once("question_hook_settings_write", e);
            return None; // guard drops here: token revoked
        }
    };
    lock().set_settings_path(terminal_id, path.clone());
    let arg = path.to_string_lossy().to_string();
    let safe = if windows {
        crate::terminal::is_cmd_safe(&arg)
    } else {
        crate::terminal::is_posix_quote_safe(&arg)
    };
    if !safe {
        // e.g. a user name with `%`, `!` or `'` in the data dir: skip rather
        // than risk a mangled argv. The guard drop deletes the file.
        report_once("question_hook_unsafe_path", "Hook settings path is not shell-safe".to_string());
        return None;
    }
    Some((vec!["--settings".to_string(), arg], guard))
}

/// Forget a terminal's token and delete its settings file (terminal closed
/// or its process exited).
pub fn revoke(terminal_id: &str) {
    let path = lock().revoke(terminal_id);
    if let Some(p) = path {
        // Best effort: a leftover file is removed by the age sweep.
        let _ = std::fs::remove_file(p);
    }
}

/// Revoke every terminal (app shutdown).
pub fn revoke_all() {
    let paths = lock().drain();
    for p in paths {
        // Best effort, as in `revoke`.
        let _ = std::fs::remove_file(p);
    }
}

/// Receiver entry point: authenticate, map, emit, and return the status to
/// answer with. Never waits on the UI.
pub fn serve(app: &tauri::AppHandle, url: &str, body: &str) -> u16 {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let resp = handle_request(&mut lock(), url, body, crate::insight::is_running, now);
    if let Some((id, record)) = resp.emit {
        crate::insight::emit_records(app, &id, vec![record]);
    }
    resp.status
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = "2026-11-05T10:00:00.000Z";

    fn url(id: &str, token: &str) -> String {
        format!("{ROUTE}?terminal={id}&token={token}")
    }

    fn ask_body(tool_use_id: Option<&str>) -> String {
        let mut v = json!({
            "session_id": "sess-1",
            "transcript_path": "/x.jsonl",
            "cwd": "/w",
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Pick one", "options": [{"label": "A"}]}]},
        });
        if let Some(id) = tool_use_id {
            v["tool_use_id"] = json!(id);
        }
        v.to_string()
    }

    fn running(_: &str) -> bool { true }

    #[test]
    fn valid_ask_user_question_maps_to_tool_use_record() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let r = handle_request(&mut reg, &url("T1", &token), &ask_body(Some("toolu_1")), running, TS.into());
        assert_eq!(r.status, 204);
        assert_eq!(
            r.emit,
            Some((
                "T1".to_string(),
                InsightRecord::ToolUse {
                    ts: Some(TS.into()),
                    id: "toolu_1".into(),
                    name: "AskUserQuestion".into(),
                    target: None,
                    input: Some(json!({"questions": [{"question": "Pick one", "options": [{"label": "A"}]}]})),
                }
            ))
        );
    }

    #[test]
    fn missing_tool_use_id_gets_a_stable_synthetic_id() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let ids: Vec<String> = (0..2)
            .map(|_| {
                let r = handle_request(&mut reg, &url("T1", &token), &ask_body(None), running, TS.into());
                match r.emit {
                    Some((_, InsightRecord::ToolUse { id, .. })) => id,
                    other => panic!("expected a tool use, got {other:?}"),
                }
            })
            .collect();
        assert_eq!(ids, ["hook-sess-1-1", "hook-sess-1-2"]);
        // An empty id counts as absent.
        let r = handle_request(&mut reg, &url("T1", &token), &ask_body(Some("")), running, TS.into());
        assert!(matches!(r.emit, Some((_, InsightRecord::ToolUse { ref id, .. })) if id == "hook-sess-1-3"));
    }

    #[test]
    fn wrong_or_missing_token_is_403() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let other = reg.issue("T2");
        assert_ne!(token, other);
        let body = ask_body(Some("toolu_1"));
        for u in [url("T1", "nope"), url("T1", &other), format!("{ROUTE}?terminal=T1"), url("T1", "")] {
            let r = handle_request(&mut reg, &u, &body, running, TS.into());
            assert_eq!(r, HookResponse { status: 403, emit: None }, "{u}");
        }
    }

    #[test]
    fn unknown_or_missing_terminal_is_404() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let body = ask_body(Some("toolu_1"));
        for u in [url("T9", &token), format!("{ROUTE}?token={token}"), ROUTE.to_string()] {
            let r = handle_request(&mut reg, &u, &body, running, TS.into());
            assert_eq!(r, HookResponse { status: 404, emit: None }, "{u}");
        }
    }

    #[test]
    fn revoked_terminal_is_404() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        reg.revoke("T1");
        let r = handle_request(&mut reg, &url("T1", &token), &ask_body(Some("x")), running, TS.into());
        assert_eq!(r.status, 404);
    }

    #[test]
    fn bad_json_is_400() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        for body in ["{not json", "", "[1,2]", "\"str\""] {
            let r = handle_request(&mut reg, &url("T1", &token), body, running, TS.into());
            assert_eq!(r, HookResponse { status: 400, emit: None }, "{body:?}");
        }
    }

    #[test]
    fn other_tools_are_ignored_with_204() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let body = json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "t"}).to_string();
        let r = handle_request(&mut reg, &url("T1", &token), &body, running, TS.into());
        assert_eq!(r, HookResponse { status: 204, emit: None });
    }

    #[test]
    fn stopped_tailer_accepts_and_drops() {
        let mut reg = HookRegistry::default();
        let token = reg.issue("T1");
        let r = handle_request(&mut reg, &url("T1", &token), &ask_body(Some("toolu_1")), |_| false, TS.into());
        assert_eq!(r, HookResponse { status: 204, emit: None });
    }

    #[test]
    fn settings_json_has_exactly_one_pre_tool_use_entry() {
        let v = settings_json(4321, "T1", "tok");
        let hooks = v["hooks"].as_object().expect("hooks object");
        assert_eq!(hooks.len(), 1, "only PreToolUse");
        let pre = v["hooks"]["PreToolUse"].as_array().expect("PreToolUse array");
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["matcher"], "AskUserQuestion");
        let inner = pre[0]["hooks"].as_array().expect("inner hooks");
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0]["type"], "http");
        assert_eq!(inner[0]["url"], "http://127.0.0.1:4321/hooks/pre-tool-use?terminal=T1&token=tok");
        assert!(inner[0]["timeout"].as_u64().is_some_and(|t| t > 0));
        // Never opt into blocking the tool on a hook failure.
        assert!(inner[0].get("onFailure").is_none());
    }

    #[test]
    fn settings_file_is_new_private_and_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hook-settings");
        let a = write_settings_file_in(&dir, "{\"a\":1}").unwrap();
        let b = write_settings_file_in(&dir, "{\"a\":1}").unwrap();
        assert_ne!(a, b, "one file per terminal");
        assert!(a.starts_with(&dir));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "{\"a\":1}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn revoke_returns_the_settings_path_once() {
        let mut reg = HookRegistry::default();
        reg.issue("T1");
        reg.set_settings_path("T1", PathBuf::from("/x/T1.json"));
        assert_eq!(reg.revoke("T1"), Some(PathBuf::from("/x/T1.json")));
        assert_eq!(reg.revoke("T1"), None);
    }

    #[test]
    fn user_supplied_settings_flag_is_detected() {
        assert!(user_sets_settings(&["--settings".into(), "x.json".into()]));
        assert!(user_sets_settings(&["--model".into(), "opus".into(), "--settings=x.json".into()]));
        assert!(!user_sets_settings(&["--model".into(), "opus".into()]));
        assert!(!user_sets_settings(&["--setting-sources".into(), "user".into()]));
    }

    #[test]
    fn prepare_writes_a_settings_file_the_receiver_accepts_and_guard_revokes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hook-settings");
        let (args, guard) = prepare_in(&dir, "prep-T1", 4321, cfg!(target_os = "windows")).expect("hook prepared");
        assert_eq!(args[0], "--settings");
        let path = PathBuf::from(&args[1]);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let hook_url = doc["hooks"]["PreToolUse"][0]["hooks"][0]["url"].as_str().unwrap().to_string();
        let route = hook_url.strip_prefix("http://127.0.0.1:4321").unwrap();
        let r = handle_request(&mut lock(), route, &ask_body(Some("toolu_9")), running, TS.into());
        assert_eq!(r.status, 204);
        assert!(r.emit.is_some());
        drop(guard);
        assert!(!path.exists(), "guard drop deletes the file");
        let r = handle_request(&mut lock(), route, &ask_body(Some("toolu_9")), running, TS.into());
        assert_eq!(r.status, 404, "guard drop revokes the token");
    }

    #[test]
    fn disarmed_guard_keeps_the_hook_until_revoke() {
        let tmp = tempfile::tempdir().unwrap();
        let (args, guard) = prepare_in(tmp.path(), "prep-T2", 1, cfg!(target_os = "windows")).expect("hook prepared");
        guard.disarm();
        let path = PathBuf::from(&args[1]);
        assert!(path.exists());
        revoke("prep-T2");
        assert!(!path.exists());
    }

    #[test]
    fn unsafe_settings_path_skips_the_hook() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("o'brien");
        assert!(prepare_in(&dir, "prep-T3", 1, false).is_none());
        assert!(std::fs::read_dir(&dir).unwrap().next().is_none(), "file removed");
        let dir = tmp.path().join("100%");
        assert!(prepare_in(&dir, "prep-T4", 1, true).is_none());
    }

    #[test]
    fn hook_route_matches_path_only() {
        assert!(is_hook_route("/hooks/pre-tool-use?terminal=a&token=b"));
        assert!(is_hook_route("/hooks/pre-tool-use"));
        assert!(!is_hook_route("/v1/metrics"));
        assert!(!is_hook_route("/hooks/pre-tool-use-x?terminal=a"));
    }
}
