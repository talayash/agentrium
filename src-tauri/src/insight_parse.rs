//! Parsers that turn agent transcript lines (Claude Code JSONL, Codex rollout
//! JSONL) into a small `InsightRecord` enum. The wire format is mirrored by a
//! TypeScript type, so variant and field names must stay snake_case.
// Callers (tailer, panel commands) arrive in later tasks.
#![allow(dead_code)]

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InsightRecord {
    UserPrompt { ts: Option<String>, text: String },
    AssistantText { ts: Option<String>, text: String },
    ToolUse { ts: Option<String>, id: String, name: String, target: Option<String>, input: Option<Value> },
    ToolResult { ts: Option<String>, tool_use_id: String, is_error: bool, text: String, lines_added: Option<u32>, lines_removed: Option<u32> },
    Usage { ts: Option<String>, message_id: String, input_tokens: u64, output_tokens: u64 },
}

const CLIP_LIMIT: usize = 4096;
const CLIP_HEAD: usize = 1024;
const CLIP_TAIL: usize = 3072;
const TARGET_MAX_CHARS: usize = 300;
const TARGET_KEYS: [&str; 8] = [
    "file_path",
    "notebook_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
];

/// Keep the first 1024 and last 3072 chars of results longer than 4096 chars.
pub(crate) fn clip_result_text(s: &str) -> String {
    let total = s.chars().count();
    if total <= CLIP_LIMIT {
        return s.to_string();
    }
    let head: String = s.chars().take(CLIP_HEAD).collect();
    let tail: String = s.chars().skip(total - CLIP_TAIL).collect();
    format!("{head}\n...\n{tail}")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn timestamp(v: &Value) -> Option<String> {
    v.get("timestamp").and_then(Value::as_str).map(str::to_string)
}

/// First present string among `keys` in the JSON object `input`, truncated.
fn target_from_keys(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .map(|s| truncate_chars(s, TARGET_MAX_CHARS))
}

/// Join the `text` field of every block whose `type` is `block_type`.
fn join_blocks(content: &Value, block_type: &str) -> String {
    match content.as_array() {
        Some(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some(block_type))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}

fn count_lines(s: &str) -> u32 {
    s.lines().count() as u32
}

fn line_counts(tur: &Value) -> (Option<u32>, Option<u32>) {
    if let Some(hunks) = tur.get("structuredPatch").and_then(Value::as_array) {
        let (mut added, mut removed) = (0u32, 0u32);
        for line in hunks
            .iter()
            .filter_map(|h| h.get("lines").and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
        {
            if line.starts_with('+') {
                added += 1;
            } else if line.starts_with('-') {
                removed += 1;
            }
        }
        return (Some(added), Some(removed));
    }
    if tur.get("type").and_then(Value::as_str) == Some("create") {
        if let Some(content) = tur.get("content").and_then(Value::as_str) {
            return (Some(count_lines(content)), None);
        }
    }
    let old = tur.get("oldString").and_then(Value::as_str);
    let new = tur.get("newString").and_then(Value::as_str);
    if old.is_some() || new.is_some() {
        return (new.map(count_lines), old.map(count_lines));
    }
    (None, None)
}

/// Text of a tool result `content`: a string, or the joined `text` blocks.
fn result_text(content: Option<&Value>) -> String {
    let raw = match content {
        Some(Value::String(s)) => s.clone(),
        Some(v @ Value::Array(_)) => join_blocks(v, "text"),
        _ => String::new(),
    };
    clip_result_text(&raw)
}

/// Emit a prompt unless it is a `<...>` command or reminder wrapper.
fn push_prompt(out: &mut Vec<InsightRecord>, ts: &Option<String>, text: &str) {
    if text.trim().starts_with('<') {
        return;
    }
    out.push(InsightRecord::UserPrompt { ts: ts.clone(), text: text.to_string() });
}

pub fn parse_claude_line(line: &str) -> Vec<InsightRecord> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let rec_type = v.get("type").and_then(Value::as_str).unwrap_or("");
    if rec_type != "user" && rec_type != "assistant" {
        return vec![];
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if flag("isSidechain") || flag("isMeta") {
        return vec![];
    }
    let ts = timestamp(&v);
    let Some(message) = v.get("message") else {
        return vec![];
    };
    let content = message.get("content");
    let mut out = Vec::new();

    if rec_type == "user" {
        match content {
            Some(Value::String(s)) => push_prompt(&mut out, &ts, s),
            Some(c @ Value::Array(blocks)) => {
                let text = join_blocks(c, "text");
                if !text.is_empty() {
                    push_prompt(&mut out, &ts, &text);
                }
                let tur = v.get("toolUseResult");
                for b in blocks {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let (lines_added, lines_removed) = tur.map(line_counts).unwrap_or((None, None));
                    out.push(InsightRecord::ToolResult {
                        ts: ts.clone(),
                        tool_use_id: b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                        is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        text: result_text(b.get("content")),
                        lines_added,
                        lines_removed,
                    });
                }
            }
            _ => {}
        }
        return out;
    }

    // assistant
    if let Some(blocks) = content.and_then(Value::as_array) {
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = b.get("text").and_then(Value::as_str) {
                        out.push(InsightRecord::AssistantText { ts: ts.clone(), text: text.to_string() });
                    }
                }
                Some("tool_use") => {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                    let input = b.get("input");
                    let target = input.and_then(|i| target_from_keys(i, &TARGET_KEYS));
                    let keep_input = if name == "AskUserQuestion" { input.cloned() } else { None };
                    out.push(InsightRecord::ToolUse {
                        ts: ts.clone(),
                        id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                        name,
                        target,
                        input: keep_input,
                    });
                }
                _ => {}
            }
        }
    }
    if let (Some(usage), Some(id)) = (message.get("usage"), message.get("id").and_then(Value::as_str)) {
        let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
        out.push(InsightRecord::Usage {
            ts,
            message_id: id.to_string(),
            input_tokens: n("input_tokens") + n("cache_creation_input_tokens"),
            output_tokens: n("output_tokens"),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/insight_claude_fixture.jsonl");

    fn line(i: usize) -> Vec<InsightRecord> {
        parse_claude_line(FIXTURE.lines().nth(i).unwrap())
    }

    #[test]
    fn skips_unknown_and_wrapper_records() {
        assert!(line(0).is_empty());
        assert!(line(2).is_empty());
        assert!(line(9).is_empty());
    }

    #[test]
    fn parses_user_prompt() {
        let r = line(1);
        assert_eq!(r.len(), 1);
        assert!(matches!(&r[0], InsightRecord::UserPrompt { text, .. } if text == "fix the sync test"));
    }

    #[test]
    fn parses_text_and_usage() {
        let r = line(3);
        assert_eq!(r.len(), 2);
        assert!(matches!(&r[0], InsightRecord::AssistantText { text, .. } if text == "Looking at it."));
        assert!(matches!(
            &r[1],
            InsightRecord::Usage { message_id, input_tokens: 15, output_tokens: 7, .. } if message_id == "msg_1"
        ));
    }

    #[test]
    fn parses_tool_use_target_without_input() {
        let r = line(4);
        assert_eq!(r.len(), 1);
        assert!(matches!(
            &r[0],
            InsightRecord::ToolUse { name, target: Some(t), input: None, .. } if name == "Edit" && t == "src/a.rs"
        ));
    }

    #[test]
    fn counts_structured_patch_lines() {
        let r = line(5);
        assert_eq!(r.len(), 1);
        assert!(matches!(
            &r[0],
            InsightRecord::ToolResult {
                tool_use_id,
                lines_added: Some(2),
                lines_removed: Some(1),
                is_error: false,
                ..
            } if tool_use_id == "toolu_e"
        ));
    }

    #[test]
    fn bash_error_result_without_tool_use_result() {
        let r = line(7);
        assert_eq!(r.len(), 1);
        assert!(matches!(
            &r[0],
            InsightRecord::ToolResult { ts: None, is_error: true, lines_added: None, text, .. }
                if text.contains("38 passed")
        ));
    }

    #[test]
    fn ask_user_question_keeps_input() {
        let r = line(8);
        assert_eq!(r.len(), 1);
        match &r[0] {
            InsightRecord::ToolUse { input: Some(v), .. } => {
                assert_eq!(v["questions"][0]["header"], "Sync strategy");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn clip_result_text_keeps_head_and_tail() {
        let s: String = (0..10_000u32)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        let out = clip_result_text(&s);
        let chars: Vec<char> = s.chars().collect();
        let head: String = chars[..1024].iter().collect();
        let tail: String = chars[chars.len() - 3072..].iter().collect();
        assert!(out.starts_with(&head));
        assert!(out.ends_with(&tail));
        assert!(out.contains("\n...\n"));
        assert_eq!(clip_result_text("short"), "short");
    }
}
