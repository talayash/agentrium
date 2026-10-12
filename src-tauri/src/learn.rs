//! Learn Cards: turn a session's git diff into 1-3 short, verified lessons.
//! Pure logic lives here; IPC commands are added in the same file (Task 3).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

// TODO(Task 3): remove the allow(dead_code) attributes once the IPC commands use these items.
#[allow(dead_code)]
pub const MAX_DIFF_BYTES: usize = 24 * 1024;
pub const MAX_CARDS: usize = 3;
#[allow(dead_code)]
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

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct DiffBundle {
    pub files: Vec<DiffFile>,
    pub text: String,
    pub truncated: bool,
}

#[allow(dead_code)]
impl DiffBundle {
    pub fn is_empty(&self) -> bool {
        self.files.iter().all(|f| f.added.is_empty())
    }
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
#[allow(dead_code)]
pub struct InFlightGuard(String);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

#[allow(dead_code)]
pub fn try_begin(terminal_id: &str) -> Option<InFlightGuard> {
    let mut set = in_flight().lock().unwrap_or_else(|e| e.into_inner());
    if !set.insert(terminal_id.to_string()) {
        return None;
    }
    Some(InFlightGuard(terminal_id.to_string()))
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
}
