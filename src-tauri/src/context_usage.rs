//! Context-window fill for the context meter: how many tokens the agent sent
//! as its prompt on its most recent reply, read from the tail of its session
//! transcript. That prompt size is what occupies the context window, so it is
//! the number the meter shows (the OTel feed only reports tokens spent).
//!
//! Independent of the insight tailer, which runs only while the Insight view
//! is on: the meter must work in plain CLI mode too.

use crate::config::AgentKind;
use crate::insight::PathCache;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ContextUsage {
    /// Prompt tokens on the latest reply (everything the window held).
    pub used_tokens: u64,
    /// Window size when the transcript states it (Codex). Claude transcripts
    /// do not, so the frontend derives it from the model.
    pub window_tokens: Option<u64>,
    pub model: Option<String>,
}

/// First read covers the last 1 MiB; a transcript whose tail is one huge tool
/// result falls back to the last 8 MiB before giving up.
const TAIL_BYTES: u64 = 1024 * 1024;
const TAIL_BYTES_MAX: u64 = 8 * 1024 * 1024;

/// Claude Code JSONL: an `assistant` line on the main thread carries
/// `message.usage`. The prompt size is uncached input plus cache reads plus
/// cache writes. Sidechain (subagent) turns have their own context and
/// synthetic messages have no real usage, so both are skipped.
pub fn claude_usage_from_line(line: &str) -> Option<ContextUsage> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let message = v.get("message")?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    if model.as_deref() == Some("<synthetic>") {
        return None;
    }
    let usage = message.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    if used == 0 {
        return None;
    }
    Some(ContextUsage {
        used_tokens: used,
        window_tokens: None,
        model,
    })
}

/// Codex rollout JSONL: `event_msg` / `token_count` with
/// `info.last_token_usage.input_tokens` (cached input is a subset of it) and,
/// in current builds, `info.model_context_window`.
pub fn codex_usage_from_line(line: &str) -> Option<ContextUsage> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = v.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?;
    let used = info
        .get("last_token_usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if used == 0 {
        return None;
    }
    let window = info
        .get("model_context_window")
        .and_then(Value::as_u64)
        .filter(|w| *w > 0);
    Some(ContextUsage {
        used_tokens: used,
        window_tokens: window,
        model: None,
    })
}

/// The newest usage in `text` (complete JSONL lines, oldest first).
pub fn last_usage_in(text: &str, agent: &AgentKind) -> Option<ContextUsage> {
    let parse: fn(&str) -> Option<ContextUsage> = match agent {
        AgentKind::Codex => codex_usage_from_line,
        _ => claude_usage_from_line,
    };
    text.lines().rev().find_map(parse)
}

/// The last `max` bytes of `path`, minus the leading partial line when the
/// read starts mid-file.
fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        Ok(text
            .split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default())
    } else {
        Ok(text)
    }
}

fn usage_from_file(path: &Path, agent: &AgentKind) -> std::io::Result<Option<ContextUsage>> {
    let len = std::fs::metadata(path)?.len();
    let found = last_usage_in(&read_tail(path, TAIL_BYTES)?, agent);
    if found.is_some() || len <= TAIL_BYTES {
        return Ok(found);
    }
    Ok(last_usage_in(&read_tail(path, TAIL_BYTES_MAX)?, agent))
}

#[derive(Default)]
struct Entry {
    paths: PathCache,
    /// File length the cached result was read at; unchanged length = no new turn.
    read_at_len: Option<u64>,
    usage: Option<ContextUsage>,
}

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Usage for one terminal. Re-reads the transcript only when it grew or was
/// rewritten, so polling every session every few seconds is mostly a `stat`.
/// Blocking: call from `spawn_blocking`.
pub fn usage_for_terminal(
    id: &str,
    agent: &AgentKind,
    session_id: &str,
    cwd: &str,
) -> Option<ContextUsage> {
    let provider = crate::session_provider::provider_for(agent);
    if !provider.supports_transcript() {
        return None;
    }
    let mut map = cache().lock().ok()?;
    let entry = map.entry(id.to_string()).or_default();
    let key = (session_id.to_string(), cwd.to_string(), agent.clone());
    let path: PathBuf = entry
        .paths
        .resolve(key, || provider.transcript_path(cwd, session_id))?;
    let len = std::fs::metadata(&path).ok()?.len();
    if entry.read_at_len == Some(len) {
        return entry.usage.clone();
    }
    match usage_from_file(&path, agent) {
        Ok(usage) => {
            entry.read_at_len = Some(len);
            entry.usage = usage.clone();
            usage
        }
        Err(e) => {
            crate::error_reporter::report_bg(
                "context_usage_read",
                format!("Failed to read transcript: {}", e),
            );
            None
        }
    }
}

/// Drop cached state for terminals that no longer exist.
pub fn retain(live_ids: &[String]) {
    if let Ok(mut map) = cache().lock() {
        map.retain(|id, _| live_ids.iter().any(|l| l == id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_ASSISTANT: &str = r#"{"type":"assistant","isSidechain":false,"message":{"id":"m1","model":"claude-opus-4-1","usage":{"input_tokens":12,"cache_creation_input_tokens":3000,"cache_read_input_tokens":90000,"output_tokens":400}}}"#;

    #[test]
    fn claude_sums_all_three_input_buckets() {
        let u = claude_usage_from_line(CLAUDE_ASSISTANT).unwrap();
        assert_eq!(u.used_tokens, 93_012);
        assert_eq!(u.model.as_deref(), Some("claude-opus-4-1"));
        assert_eq!(u.window_tokens, None);
    }

    #[test]
    fn claude_skips_sidechain_synthetic_user_and_zero_usage() {
        let side = CLAUDE_ASSISTANT.replace(r#""isSidechain":false"#, r#""isSidechain":true"#);
        assert_eq!(claude_usage_from_line(&side), None);
        let synth = r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#;
        assert_eq!(claude_usage_from_line(synth), None);
        let user = r#"{"type":"user","message":{"role":"user","content":"hi"}}"#;
        assert_eq!(claude_usage_from_line(user), None);
        let zero = r#"{"type":"assistant","message":{"model":"m","usage":{"input_tokens":0}}}"#;
        assert_eq!(claude_usage_from_line(zero), None);
        assert_eq!(claude_usage_from_line("not json"), None);
    }

    #[test]
    fn codex_reads_last_turn_input_and_window() {
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":41000,"cached_input_tokens":40000,"output_tokens":900},"total_token_usage":{"input_tokens":500000},"model_context_window":272000}}}"#;
        let u = codex_usage_from_line(line).unwrap();
        assert_eq!(u.used_tokens, 41_000);
        assert_eq!(u.window_tokens, Some(272_000));
    }

    #[test]
    fn codex_without_info_or_window() {
        assert_eq!(
            codex_usage_from_line(
                r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#
            ),
            None
        );
        let no_window = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100}}}}"#;
        assert_eq!(
            codex_usage_from_line(no_window).unwrap().window_tokens,
            None
        );
    }

    #[test]
    fn last_usage_wins_and_ignores_trailing_non_usage_lines() {
        let older = CLAUDE_ASSISTANT.replace("90000", "1000");
        let text = format!("{older}\n{CLAUDE_ASSISTANT}\n{{\"type\":\"user\"}}\n");
        assert_eq!(
            last_usage_in(&text, &AgentKind::Claude)
                .unwrap()
                .used_tokens,
            93_012
        );
    }

    #[test]
    fn existing_fixtures_parse() {
        let claude = include_str!("../tests/insight_claude_fixture.jsonl");
        // fixture usage: 10 input + 5 cache write + 100 cache read
        assert_eq!(
            last_usage_in(claude, &AgentKind::Claude)
                .unwrap()
                .used_tokens,
            115
        );
        let codex = include_str!("../tests/insight_codex_fixture.jsonl");
        assert_eq!(
            last_usage_in(codex, &AgentKind::Codex).unwrap().used_tokens,
            100
        );
    }

    #[test]
    fn tail_read_drops_partial_first_line_and_falls_back_when_tail_is_one_huge_line() {
        let dir = std::env::temp_dir().join(format!("ctx-usage-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        // usage line, then a single tool-result line bigger than TAIL_BYTES
        let huge = format!(
            "{{\"type\":\"user\",\"text\":\"{}\"}}",
            "x".repeat((TAIL_BYTES + 10) as usize)
        );
        std::fs::write(&path, format!("{CLAUDE_ASSISTANT}\n{huge}\n")).unwrap();
        let u = usage_from_file(&path, &AgentKind::Claude).unwrap().unwrap();
        assert_eq!(u.used_tokens, 93_012);
        let tail = read_tail(&path, 100).unwrap();
        assert!(!tail.contains("assistant"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
