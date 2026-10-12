# Learn Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Learn" feature (flag ON by default) that turns an agent session's git diff into 1-3 verified, interactive lesson cards in a new Inspector tab.

**Architecture:** A new Rust module `learn.rs` collects the terminal's git diff, asks the user's own `claude -p --model haiku` for strict JSON cards, verifies every quoted line against the diff and the file on disk, and stores cards in a local-only SQLite table. The frontend adds a persisted `learnEnabled` flag, a non-persisted `learnStore`, a Learn tab in the Inspector, a consent block, and a Settings page. Sending code requires a separate Rust-enforced consent (`learn_ai_consent`, default off).

**Tech Stack:** Tauri 2, Rust (rusqlite, serde, tokio, uuid, tempfile for tests), React 18 + TypeScript, Zustand, Tailwind, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-12-learn-cards-design.md` (read it before starting any task).

## Global Constraints

- All work is in the `agentrium/` repo on branch `feat/learn-cards`. Run Rust commands from `agentrium/src-tauri`, frontend commands from `agentrium/`.
- Never use an em-dash or en-dash character anywhere (code, comments, copy, commit messages). Use a plain hyphen.
- `learnEnabled` default `true`. `learn_ai_consent` default off, stored in `user_meta`, checked in Rust before any spawn.
- Diff cap: 24 KiB (`MAX_DIFF_BYTES = 24 * 1024`). Max cards: 3. Max quote lines per card: 12. `claude -p` timeout: 60 s.
- `learn_cards` table is local only. Never call `enqueue_sync` / `touch_sync_row` for it. No change to `agentrium-api`.
- Every `#[command]` body is wrapped in `wrap_cmd("<name>", ...)`. Expected outcomes are `GenerateResult.status`, never `Err`. Use `error_reporter::user_err` for user-input errors.
- Frontend errors: user-initiated failure = `toast.error(...)` + `reportInvokeFailure('<command>', err)`; background best-effort = `.catch(() => {})` with a one-line comment. Never `console.error` only.
- No new colors: use existing Tailwind tokens (look at `tailwind.config.*` and neighbouring components such as `FileChangesPanel.tsx` for success / error / accent token names).
- Tauri arg names: Rust `terminal_id` / `answered_index` are passed from JS as `terminalId` / `answeredIndex`.

## Review Focus

1. Model quotes with different indentation or the file has CRLF line endings: card must still verify (comparison is on trimmed lines) and the shown code must be the real file lines. Test in Task 1 (`verify_accepts_crlf_and_indent_drift`).
2. Huge tracked diff, large untracked file, or binary file: generation must cap at 24 KiB, skip binaries, never panic on a UTF-8 boundary. Test in Task 3 (`collect_diff_caps_and_skips_binary`).
3. Terminal cwd is not a git repo (or terminal closed mid-run): result is `no_changes`, not an error toast. Test in Task 3 (`collect_diff_on_non_repo_is_empty`).
4. Auto trigger on `terminal-finished` and a manual click at the same time: second call returns `in_progress`, no duplicate rows. Test in Task 1 (`in_flight_guard_blocks_second_run`).
5. Model output wrapped in prose / code fences, invalid JSON, or wrong option count: fenced JSON parses, bad cards are dropped, nothing panics. Tests in Task 1 (`parse_cards_*`, `verify_drops_malformed_cards`).

---

### Task 1: Rust learn core (pure logic)

**Files:**
- Create: `src-tauri/src/learn.rs`
- Modify: `src-tauri/src/main.rs` (add `mod learn;` next to `mod session_context;`)

**Interfaces:**
- Produces (all `pub` in `crate::learn`):
  - `struct LessonCard` (serde camelCase): `id: String, terminal_id: String, created_at: String, kind: String, title: String, file_path: String, start_line: u32, end_line: u32, quote: Vec<String>, highlight: Vec<u32>, why: [String; 3], question: String, options: [String; 3], answer_index: u8, explain: String, saved: bool, answered_index: Option<u8>`
  - `struct RawCard` (Deserialize camelCase): `kind, title, file, quote: Vec<String>, why: Vec<String>, question, options: Vec<String>, answer_index: u8, explain`
  - `struct DiffFile { path: String, visible: Vec<String>, added: Vec<String> }`, `struct DiffBundle { files: Vec<DiffFile>, text: String, truncated: bool }` with `fn is_empty(&self) -> bool`
  - `fn parse_unified_diff(text: &str) -> Vec<DiffFile>`
  - `fn parse_cards(stdout: &str) -> Result<Vec<RawCard>, String>`
  - `fn verify_cards<F: Fn(&str) -> Option<String>>(raw: Vec<RawCard>, bundle: &DiffBundle, terminal_id: &str, read_file: F) -> Vec<LessonCard>`
  - `fn build_prompt(goal: Option<&str>, truncated: bool) -> String`
  - `fn try_begin(terminal_id: &str) -> Option<InFlightGuard>` (guard removes the id on drop)
  - consts `MAX_DIFF_BYTES`, `MAX_CARDS`, `CONSENT_KEY = "learn_ai_consent"`

- [ ] **Step 1: Write the module skeleton with tests first**

Create `src-tauri/src/learn.rs` with the types and stub functions (`todo!()` bodies) plus this test module at the bottom:

```rust
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
        DiffBundle { files: parse_unified_diff(DIFF), text: DIFF.into(), truncated: false }
    }

    #[test]
    fn parse_unified_diff_collects_added_and_context_and_skips_deleted_files() {
        let files = parse_unified_diff(DIFF);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/lib/api.ts");
        assert_eq!(files[0].added, vec!["export function withRetry<T>(", "fn: () => Promise<T>,", "): () => Promise<T> {"]);
        assert!(files[0].visible.contains(&"import { http } from './http';".to_string()));
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
            vec![raw("src/lib/api.ts", &["export function withRetry<T>(", "  fn: () => Promise<T>,"])],
            &bundle(),
            "t1",
            |p| (p == "src/lib/api.ts").then(|| FILE.to_string()),
        );
        assert_eq!(cards.len(), 1);
        let c = &cards[0];
        assert_eq!((c.start_line, c.end_line), (2, 3));
        assert_eq!(c.highlight, vec![2, 3]);
        assert_eq!(c.quote, vec!["export function withRetry<T>(", "  fn: () => Promise<T>,"]);
        assert_eq!(c.terminal_id, "t1");
        assert!(!c.saved && c.answered_index.is_none());
    }

    #[test]
    fn verify_accepts_crlf_and_indent_drift() {
        let crlf = FILE.replace('\n', "\r\n");
        let cards = verify_cards(
            vec![raw("src/lib/api.ts", &["export function withRetry<T>(", "fn: () => Promise<T>,"])],
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
        assert!(verify_cards(vec![raw("src/lib/api.ts", &["export function invented()"])], &b, "t", read).is_empty());
        assert!(verify_cards(vec![raw("other.ts", &["export function withRetry<T>("])], &b, "t", read).is_empty());
        assert!(verify_cards(vec![raw("src/lib/api.ts", &["import { http } from './http';"])], &b, "t", read).is_empty());
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
        let many = (0..5).map(|_| raw("src/lib/api.ts", &["export function withRetry<T>("])).collect();
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
```

Add `mod learn;` to `src-tauri/src/main.rs` next to the other `mod` lines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked learn::tests` (from `agentrium/src-tauri`)
Expected: compiles, tests FAIL / panic with `not yet implemented`.

- [ ] **Step 3: Implement**

Replace the stubs with:

```rust
//! Learn Cards: turn a session's git diff into 1-3 short, verified lessons.
//! Pure logic lives here; IPC commands are added in the same file (Task 3).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

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
                    files.push(DiffFile { path: p.strip_prefix("b/").unwrap_or(p).to_string(), ..Default::default() });
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
        let (Some(i), true) = (current, in_hunk) else { continue };
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
    let env: RawEnvelope =
        serde_json::from_str(&stdout[start..=end]).map_err(|e| format!("invalid lesson JSON: {e}"))?;
    Ok(env.cards)
}

fn find_block(lines: &[&str], quote: &[String]) -> Option<usize> {
    if quote.is_empty() || quote.len() > lines.len() {
        return None;
    }
    (0..=lines.len() - quote.len())
        .find(|&i| quote.iter().enumerate().all(|(j, q)| lines[i + j].trim() == q.trim()))
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
        if r.title.trim().is_empty() || r.why.len() != 3 || r.options.len() != 3 || r.answer_index > 2 {
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
        let Some(file) = bundle.files.iter().find(|f| f.path == r.file) else { continue };
        let visible: HashSet<&str> = file.visible.iter().map(String::as_str).collect();
        let added: HashSet<&str> = file.added.iter().map(String::as_str).collect();
        let nonblank: Vec<&str> = quote.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        if !nonblank.iter().all(|l| visible.contains(l)) || !nonblank.iter().any(|l| added.contains(l)) {
            continue;
        }
        let Some(content) = read_file(&file.path) else { continue };
        let lines: Vec<&str> = content.lines().collect();
        let Some(start) = find_block(&lines, &quote) else { continue };
        let real: Vec<String> =
            lines[start..start + quote.len()].iter().map(|l| l.trim_end_matches('\r').to_string()).collect();
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
        let kind = if KINDS.contains(&r.kind.as_str()) { r.kind } else { "concept".to_string() };
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
            options: [r.options[0].clone(), r.options[1].clone(), r.options[2].clone()],
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
        in_flight().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

pub fn try_begin(terminal_id: &str) -> Option<InFlightGuard> {
    let mut set = in_flight().lock().unwrap_or_else(|e| e.into_inner());
    if !set.insert(terminal_id.to_string()) {
        return None;
    }
    Some(InFlightGuard(terminal_id.to_string()))
}
```

If `chrono` is not already a dependency, check `Cargo.toml` (it is used by `database.rs` via `chrono::Utc::now()`, so it is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked learn::tests`
Expected: all 10 tests PASS. Also run `cargo clippy --locked -- -D warnings` scoped check: no new warnings in `learn.rs` (dead-code warnings for items used in Task 3 are acceptable only if clippy is not run with `-D warnings` in CI; if it is, add `#[allow(dead_code)]` on the module items temporarily and remove it in Task 3).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/learn.rs src-tauri/src/main.rs
git commit -m "feat(learn): diff parsing, card parsing and verification core"
```

---

### Task 2: `learn_cards` table and database methods

**Files:**
- Modify: `src-tauri/src/database.rs` (schema in `init_schema`, methods next to `save_session_summary`, tests in the existing `mod tests`)

**Interfaces:**
- Consumes: `crate::learn::LessonCard` (Task 1).
- Produces on `Database`:
  - `fn replace_learn_cards(&self, terminal_id: &str, cards: &[LessonCard]) -> Result<(), String>` (deletes that terminal's unsaved cards, inserts new ones, one transaction)
  - `fn list_learn_cards(&self, terminal_id: &str) -> Result<Vec<LessonCard>, String>` (newest generation first, insert order within a generation; `saved` / `answered_index` columns override JSON)
  - `fn update_learn_card(&self, id: &str, saved: Option<bool>, answered_index: Option<u8>) -> Result<(), String>` (`answered_index > 2` returns `Err` via `error_reporter::user_err`)

- [ ] **Step 1: Write the failing tests** (append inside the existing `#[cfg(test)] mod tests` in `database.rs`)

```rust
    fn learn_card(id: &str, terminal: &str, created: &str) -> crate::learn::LessonCard {
        crate::learn::LessonCard {
            id: id.into(),
            terminal_id: terminal.into(),
            created_at: created.into(),
            kind: "pattern".into(),
            title: format!("card {id}"),
            file_path: "src/a.ts".into(),
            start_line: 1,
            end_line: 2,
            quote: vec!["a".into(), "b".into()],
            highlight: vec![1],
            why: ["b".into(), "i".into(), "e".into()],
            question: "q".into(),
            options: ["1".into(), "2".into(), "3".into()],
            answer_index: 0,
            explain: "e".into(),
            saved: false,
            answered_index: None,
        }
    }

    #[test]
    fn learn_cards_round_trip_and_update() {
        let db = Database::new_in_memory().unwrap();
        db.replace_learn_cards("t1", &[learn_card("a", "t1", "2026-10-12T10:00:00Z"), learn_card("b", "t1", "2026-10-12T10:00:00Z")]).unwrap();
        let cards = db.list_learn_cards("t1").unwrap();
        assert_eq!(cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        db.update_learn_card("a", Some(true), Some(2)).unwrap();
        let a = db.list_learn_cards("t1").unwrap().into_iter().find(|c| c.id == "a").unwrap();
        assert!(a.saved);
        assert_eq!(a.answered_index, Some(2));
        assert!(db.update_learn_card("a", None, Some(3)).is_err());
        assert!(db.list_learn_cards("other").unwrap().is_empty());
    }

    #[test]
    fn regenerating_learn_cards_keeps_saved_and_drops_unsaved() {
        let db = Database::new_in_memory().unwrap();
        db.replace_learn_cards("t1", &[learn_card("old-saved", "t1", "2026-10-12T10:00:00Z"), learn_card("old", "t1", "2026-10-12T10:00:00Z")]).unwrap();
        db.update_learn_card("old-saved", Some(true), None).unwrap();
        db.replace_learn_cards("t1", &[learn_card("new", "t1", "2026-10-12T11:00:00Z")]).unwrap();
        let ids: Vec<String> = db.list_learn_cards("t1").unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["new".to_string(), "old-saved".to_string()]);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked learn_cards`
Expected: FAIL to compile (`no method named replace_learn_cards`).

- [ ] **Step 3: Implement**

In `init_schema`, inside the existing `execute_batch` string after the `session_summaries` table:

```sql
            CREATE TABLE IF NOT EXISTS learn_cards (
                id TEXT PRIMARY KEY,
                terminal_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                file_path TEXT NOT NULL,
                card_json TEXT NOT NULL,
                saved INTEGER NOT NULL DEFAULT 0,
                answered_index INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_learn_cards_terminal ON learn_cards(terminal_id);
```

Methods (next to `get_session_summary`):

```rust
    /// Learn Cards are local only: never enqueue them for sync.
    pub fn replace_learn_cards(&self, terminal_id: &str, cards: &[crate::learn::LessonCard]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM learn_cards WHERE terminal_id = ?1 AND saved = 0", params![terminal_id])
            .map_err(|e| e.to_string())?;
        for c in cards {
            let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO learn_cards (id, terminal_id, created_at, kind, title, file_path, card_json, saved, answered_index)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL)",
                params![c.id, terminal_id, c.created_at, c.kind, c.title, c.file_path, json],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn list_learn_cards(&self, terminal_id: &str) -> Result<Vec<crate::learn::LessonCard>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT card_json, saved, answered_index FROM learn_cards
                 WHERE terminal_id = ?1 ORDER BY created_at DESC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![terminal_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (json, saved, answered) = row.map_err(|e| e.to_string())?;
            // A row that no longer parses (older shape) is skipped, not fatal.
            let Ok(mut card) = serde_json::from_str::<crate::learn::LessonCard>(&json) else { continue };
            card.saved = saved != 0;
            card.answered_index = answered.and_then(|a| u8::try_from(a).ok());
            out.push(card);
        }
        Ok(out)
    }

    pub fn update_learn_card(&self, id: &str, saved: Option<bool>, answered_index: Option<u8>) -> Result<(), String> {
        if let Some(a) = answered_index {
            if a > 2 {
                return Err(crate::error_reporter::user_err("Invalid answer index"));
            }
            self.conn
                .execute("UPDATE learn_cards SET answered_index = ?1 WHERE id = ?2", params![a as i64, id])
                .map_err(|e| e.to_string())?;
        }
        if let Some(s) = saved {
            self.conn
                .execute("UPDATE learn_cards SET saved = ?1 WHERE id = ?2", params![s as i64, id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked learn_cards` then `cargo test --locked init_schema_is_idempotent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/database.rs
git commit -m "feat(learn): local-only learn_cards table"
```

---

### Task 3: Diff collection, Claude call and IPC commands

**Files:**
- Modify: `src-tauri/src/learn.rs` (add IO + commands + tests)
- Modify: `src-tauri/src/commands.rs` (make `resolve_repo_root` and `validate_git_pathspec` `pub(crate)`; no other change)
- Modify: `src-tauri/src/main.rs` (register 5 commands next to `commands::summarize_session`)
- If any test or list enumerates registered command names (grep for `get_summary_enabled` in `src-tauri/src` and `src/`), add the new names there too.

**Interfaces:**
- Consumes: Task 1 functions, Task 2 DB methods, `crate::commands::{db_op, wrap_cmd, shell_command, git_cmd_async, resolve_repo_root, validate_git_pathspec}`, `crate::error_reporter::scrub`, `crate::AppState`.
- Produces IPC commands (JS names):
  - `get_learn_consent() -> bool`
  - `set_learn_consent({ enabled: boolean }) -> void`
  - `generate_learn_cards({ terminalId: string, goal?: string | null }) -> { status, cards: LessonCard[] }`
  - `list_learn_cards({ terminalId: string }) -> LessonCard[]`
  - `update_learn_card({ id: string, saved?: boolean | null, answeredIndex?: number | null }) -> void`
- Produces Rust: `pub async fn collect_diff(repo_root: &str) -> DiffBundle`, `pub(crate) async fn consent_granted(db: &Arc<std::sync::Mutex<Database>>) -> Result<bool, String>`.

- [ ] **Step 1: Write the failing tests** (add to `learn::tests`)

```rust
    fn git(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
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
        let db = std::sync::Arc::new(std::sync::Mutex::new(crate::database::Database::new_in_memory().unwrap()));
        assert!(!consent_granted(&db).await.unwrap());
        db.lock().unwrap().set_user_meta(CONSENT_KEY, Some("true")).unwrap();
        assert!(consent_granted(&db).await.unwrap());
    }
```

Check that `tokio` has the `macros` + `rt` features for `#[tokio::test]` (grep existing `#[tokio::test]` usage in `src-tauri/src`; if none exists, use `tauri::async_runtime::block_on(async { ... })` inside plain `#[test]` functions instead).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --locked learn::tests`
Expected: FAIL to compile (`collect_diff` / `consent_granted` not found).

- [ ] **Step 3: Implement** (append to `learn.rs` above `#[cfg(test)]`; add the needed `use` lines at the top)

```rust
use crate::commands::{db_op, git_cmd_async, resolve_repo_root, shell_command, validate_git_pathspec, wrap_cmd};
use crate::AppState;
use std::path::Path;
use std::sync::Arc;
use tauri::{command, State};

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
    DiffBundle { files: parse_unified_diff(&text), text, truncated }
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
    let mut cmd: tokio::process::Command = shell_command("claude", &["-p", "--model", "haiku", prompt]).into();
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
    match tokio::time::timeout(Duration::from_secs(CLAUDE_TIMEOUT_SECS), child.wait_with_output()).await {
        Ok(Ok(o)) if o.status.success() => RunOutcome::Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(Ok(_)) | Ok(Err(_)) => RunOutcome::Failed,
        Err(_) => RunOutcome::Timeout,
    }
}

pub(crate) async fn consent_granted(db: &Arc<std::sync::Mutex<crate::database::Database>>) -> Result<bool, String> {
    db_op(db, |db| Ok(db.get_user_meta(CONSENT_KEY)?.as_deref() == Some("true"))).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub status: String,
    pub cards: Vec<LessonCard>,
}

impl GenerateResult {
    fn status(s: &str) -> Self {
        Self { status: s.to_string(), cards: vec![] }
    }
}

#[command]
pub async fn get_learn_consent(state: State<'_, AppState>) -> Result<bool, String> {
    wrap_cmd("get_learn_consent", async move { consent_granted(&state.db).await }).await
}

#[command]
pub async fn set_learn_consent(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    wrap_cmd("set_learn_consent", async move {
        db_op(&state.db, move |db| db.set_user_meta(CONSENT_KEY, Some(if enabled { "true" } else { "false" }))).await
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
            terminals.terminals.get(&terminal_id).map(|t| t.config.working_directory.clone())
        };
        let Some(wd) = working_directory else { return Ok(GenerateResult::status("no_changes")) };
        let Ok(root) = resolve_repo_root(&wd).await else { return Ok(GenerateResult::status("no_changes")) };
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
        let Ok(raw) = parse_cards(&stdout) else { return Ok(GenerateResult::status("failed")) };
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
        Ok(GenerateResult { status: "ok".into(), cards })
    })
    .await
}

#[command]
pub async fn list_learn_cards(state: State<'_, AppState>, terminal_id: String) -> Result<Vec<LessonCard>, String> {
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
        db_op(&state.db, move |db| db.update_learn_card(&id, saved, answered_index)).await
    })
    .await
}
```

Adjust to the real field names if they differ: confirm `state.terminals.lock().await.terminals.get(..).config.working_directory` against `session_context.rs:63-66` and `commands.rs:2240-2245`, and confirm `error_reporter::scrub` takes `&str` (it is called with a `Cow` deref in `summarize_session`). In `commands.rs` change `async fn resolve_repo_root` and `fn validate_git_pathspec` to `pub(crate)`. In `main.rs` add after `commands::get_session_summary,`:

```rust
            learn::get_learn_consent,
            learn::set_learn_consent,
            learn::generate_learn_cards,
            learn::list_learn_cards,
            learn::update_learn_card,
```

Remove any temporary `#[allow(dead_code)]` added in Task 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --locked learn::` then `cargo clippy --locked` and `cargo fmt --check`
Expected: all learn tests PASS, no new clippy warnings, fmt clean (run `cargo fmt` if not).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/learn.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat(learn): consent-gated generate/list/update commands"
```

---

### Task 4: Frontend types, appStore flag and learnStore

**Files:**
- Create: `src/lib/learn.ts`
- Create: `src/store/learnStore.ts`, `src/store/learnStore.test.ts`
- Modify: `src/store/appStore.ts` (state, actions, `partialize`, make `toggleHints` / `toggleChanges` / `toggleWorkspaces` also set `learnOpen: false`)
- Modify: `src/store/appStore.test.ts` (`PERSISTED_KEYS` + new tests)

**Interfaces:**
- Consumes: IPC commands from Task 3.
- Produces:
  - `src/lib/learn.ts`: `type LearnKind`, `interface LessonCard`, `type GenerateStatus`, `interface GenerateResult`, `const KIND_LABEL`, `const KIND_SHORT`, `const STATUS_MESSAGE`, `type LearnLevel = 0 | 1 | 2`.
  - `appStore`: `learnEnabled: boolean` (default `true`), `learnLevel: LearnLevel` (default `1`), `learnOpen: boolean` (default `false`), `toggleLearn()`, `openLearn()`, `setLearnEnabled(v)`, `setLearnLevel(l)`.
  - `useLearnStore`: `byTerminal: Record<string, { status: PanelStatus; cards: LessonCard[]; unseen: number }>`, `load(terminalId)`, `generate(terminalId, opts?: { goal?: string; silent?: boolean }) => Promise<GenerateResult | null>`, `markSeen(terminalId)`, `answer(terminalId, cardId, index)`, `toggleSave(terminalId, cardId)`. `type PanelStatus = 'idle' | 'loading' | GenerateStatus`.

- [ ] **Step 1: Write the failing tests**

`src/store/learnStore.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useLearnStore } from './learnStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { LessonCard } from '../lib/learn';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

const card = (id: string, extra: Partial<LessonCard> = {}): LessonCard => ({
  id, terminalId: 't1', createdAt: '2026-10-12T10:00:00Z', kind: 'pattern', title: `Card ${id}`,
  filePath: 'src/a.ts', startLine: 1, endLine: 2, quote: ['a', 'b'], highlight: [1],
  why: ['b', 'i', 'e'], question: 'q?', options: ['x', 'y', 'z'], answerIndex: 1, explain: 'because',
  saved: false, answeredIndex: null, ...extra,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(reportInvokeFailure).mockReset();
  useLearnStore.setState({ byTerminal: {} });
});

it('generate ok reloads the list and marks new cards unseen', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'generate_learn_cards') return { status: 'ok', cards: [card('a'), card('b')] } as never;
    if (cmd === 'list_learn_cards') return [card('a'), card('b'), card('old', { saved: true })] as never;
    return undefined as never;
  });
  const res = await useLearnStore.getState().generate('t1', { goal: 'add retry' });
  expect(invoke).toHaveBeenCalledWith('generate_learn_cards', { terminalId: 't1', goal: 'add retry' });
  expect(res?.status).toBe('ok');
  const entry = useLearnStore.getState().byTerminal.t1;
  expect(entry.status).toBe('ok');
  expect(entry.cards.map((c) => c.id)).toEqual(['a', 'b', 'old']);
  expect(entry.unseen).toBe(2);
});

it('keeps non-ok statuses as data without reporting', async () => {
  vi.mocked(invoke).mockResolvedValue({ status: 'no_consent', cards: [] } as never);
  await useLearnStore.getState().generate('t1');
  expect(useLearnStore.getState().byTerminal.t1.status).toBe('no_consent');
  expect(reportInvokeFailure).not.toHaveBeenCalled();
});

it('reports a thrown manual generate but stays quiet when silent', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('boom'));
  await useLearnStore.getState().generate('t1');
  expect(useLearnStore.getState().byTerminal.t1.status).toBe('failed');
  expect(reportInvokeFailure).toHaveBeenCalledWith('generate_learn_cards', expect.anything());
  vi.mocked(reportInvokeFailure).mockReset();
  await useLearnStore.getState().generate('t2', { silent: true });
  expect(reportInvokeFailure).not.toHaveBeenCalled();
});

it('answer and toggleSave update optimistically and persist', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [card('a')], unseen: 1 } } });
  vi.mocked(invoke).mockResolvedValue(undefined as never);
  await useLearnStore.getState().answer('t1', 'a', 2);
  expect(useLearnStore.getState().byTerminal.t1.cards[0].answeredIndex).toBe(2);
  expect(invoke).toHaveBeenCalledWith('update_learn_card', { id: 'a', saved: null, answeredIndex: 2 });
  await useLearnStore.getState().toggleSave('t1', 'a');
  expect(useLearnStore.getState().byTerminal.t1.cards[0].saved).toBe(true);
  expect(invoke).toHaveBeenCalledWith('update_learn_card', { id: 'a', saved: true, answeredIndex: null });
});

it('reverts a failed save', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [card('a')], unseen: 0 } } });
  vi.mocked(invoke).mockRejectedValue(new Error('disk'));
  await useLearnStore.getState().toggleSave('t1', 'a');
  expect(useLearnStore.getState().byTerminal.t1.cards[0].saved).toBe(false);
  expect(reportInvokeFailure).toHaveBeenCalledWith('update_learn_card', expect.anything());
});
```

In `src/store/appStore.test.ts` add `'learnEnabled'`, `'learnLevel'`, `'learnOpen'` to `PERSISTED_KEYS`, and add:

```ts
it('Learn is on by default and its tab is exclusive with the other inspector tabs', () => {
  const s = useAppStore.getState();
  expect(s.learnEnabled).toBe(true);
  s.toggleChanges();
  s.toggleLearn();
  expect(useAppStore.getState()).toMatchObject({ learnOpen: true, changesOpen: false, workspacesOpen: false, hintsOpen: false });
  useAppStore.getState().toggleHints();
  expect(useAppStore.getState().learnOpen).toBe(false);
});

it('turning Learn off closes its tab', () => {
  useAppStore.getState().openLearn();
  useAppStore.getState().setLearnEnabled(false);
  expect(useAppStore.getState()).toMatchObject({ learnEnabled: false, learnOpen: false });
  useAppStore.getState().setLearnEnabled(true);
});
```

(Match the file's existing import / reset conventions for `useAppStore`; if tests reset state in `beforeEach`, follow that.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/learnStore.test.ts src/store/appStore.test.ts`
Expected: FAIL (module not found / properties undefined).

- [ ] **Step 3: Implement**

`src/lib/learn.ts`:

```ts
export type LearnKind = 'pattern' | 'system_design' | 'syntax' | 'concept';
export type LearnLevel = 0 | 1 | 2;

export interface LessonCard {
  id: string;
  terminalId: string;
  createdAt: string;
  kind: LearnKind;
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  quote: string[];
  highlight: number[];
  why: [string, string, string];
  question: string;
  options: [string, string, string];
  answerIndex: number;
  explain: string;
  saved: boolean;
  answeredIndex: number | null;
}

export type GenerateStatus =
  | 'ok' | 'no_consent' | 'no_changes' | 'no_cards' | 'in_progress' | 'cli_missing' | 'timeout' | 'failed';

export interface GenerateResult {
  status: GenerateStatus;
  cards: LessonCard[];
}

export const KIND_LABEL: Record<LearnKind, string> = {
  pattern: 'Design pattern',
  system_design: 'System design',
  syntax: 'Syntax',
  concept: 'Concept',
};

export const KIND_SHORT: Record<LearnKind, string> = {
  pattern: 'Pattern',
  system_design: 'System design',
  syntax: 'Syntax',
  concept: 'Concept',
};

export const LEVEL_LABELS = ['Beginner', 'Intermediate', 'Expert'] as const;

export const STATUS_MESSAGE: Record<Exclude<GenerateStatus, 'ok'>, string> = {
  no_consent: 'Allow Learn to read this change to get lessons.',
  no_changes: 'No changes to learn from yet. Run an agent, then try again.',
  no_cards: 'Nothing in this change was worth a lesson.',
  in_progress: 'Lessons are already being written for this session.',
  cli_missing: 'Learn needs Claude Code installed.',
  timeout: 'Claude took too long. Try again.',
  failed: 'Could not write lessons for this change. Try again.',
};
```

`src/store/learnStore.ts`:

```ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toast } from './toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { GenerateResult, GenerateStatus, LessonCard } from '../lib/learn';

export type PanelStatus = 'idle' | 'loading' | GenerateStatus;

export interface TerminalLearn {
  status: PanelStatus;
  cards: LessonCard[];
  unseen: number;
}

interface LearnState {
  byTerminal: Record<string, TerminalLearn>;
  load: (terminalId: string) => Promise<void>;
  generate: (terminalId: string, opts?: { goal?: string; silent?: boolean }) => Promise<GenerateResult | null>;
  markSeen: (terminalId: string) => void;
  answer: (terminalId: string, cardId: string, index: number) => Promise<void>;
  toggleSave: (terminalId: string, cardId: string) => Promise<void>;
}

const EMPTY: TerminalLearn = { status: 'idle', cards: [], unseen: 0 };

export const useLearnStore = create<LearnState>((set, get) => {
  const patch = (terminalId: string, p: Partial<TerminalLearn>) =>
    set((s) => ({ byTerminal: { ...s.byTerminal, [terminalId]: { ...(s.byTerminal[terminalId] ?? EMPTY), ...p } } }));
  const patchCard = (terminalId: string, cardId: string, p: Partial<LessonCard>) => {
    const entry = get().byTerminal[terminalId];
    if (!entry) return;
    patch(terminalId, { cards: entry.cards.map((c) => (c.id === cardId ? { ...c, ...p } : c)) });
  };

  return {
    byTerminal: {},

    load: async (terminalId) => {
      try {
        const cards = await invoke<LessonCard[]>('list_learn_cards', { terminalId });
        patch(terminalId, { cards });
      } catch {
        // Best-effort read of local cards; the panel still offers Generate.
      }
    },

    generate: async (terminalId, opts = {}) => {
      patch(terminalId, { status: 'loading' });
      try {
        const res = await invoke<GenerateResult>('generate_learn_cards', { terminalId, goal: opts.goal ?? null });
        if (res.status === 'ok') {
          const cards = await invoke<LessonCard[]>('list_learn_cards', { terminalId }).catch(() => res.cards);
          patch(terminalId, { status: 'ok', cards, unseen: res.cards.length });
        } else {
          patch(terminalId, { status: res.status });
        }
        return res;
      } catch (err) {
        patch(terminalId, { status: 'failed' });
        if (!opts.silent) {
          toast.error('Could not write lessons');
          reportInvokeFailure('generate_learn_cards', err);
        }
        return null;
      }
    },

    markSeen: (terminalId) => {
      if (get().byTerminal[terminalId]?.unseen) patch(terminalId, { unseen: 0 });
    },

    answer: async (terminalId, cardId, index) => {
      patchCard(terminalId, cardId, { answeredIndex: index });
      try {
        await invoke('update_learn_card', { id: cardId, saved: null, answeredIndex: index });
      } catch (err) {
        toast.error('Could not save your answer');
        reportInvokeFailure('update_learn_card', err);
      }
    },

    toggleSave: async (terminalId, cardId) => {
      const card = get().byTerminal[terminalId]?.cards.find((c) => c.id === cardId);
      if (!card) return;
      const next = !card.saved;
      patchCard(terminalId, cardId, { saved: next });
      try {
        await invoke('update_learn_card', { id: cardId, saved: next, answeredIndex: null });
      } catch (err) {
        patchCard(terminalId, cardId, { saved: !next });
        toast.error('Could not save the card');
        reportInvokeFailure('update_learn_card', err);
      }
    },
  };
});
```

`src/store/appStore.ts`: add to the state interface (near `lspEnabled`):

```ts
  learnEnabled: boolean;
  learnLevel: LearnLevel;
  learnOpen: boolean;
```

and to the actions interface (near `toggleHints`):

```ts
  toggleLearn: () => void;
  openLearn: () => void;
  setLearnEnabled: (v: boolean) => void;
  setLearnLevel: (l: LearnLevel) => void;
```

(`import type { LearnLevel } from '../lib/learn';`). Defaults: `learnEnabled: true, learnLevel: 1, learnOpen: false`. Actions:

```ts
      toggleLearn: () => set((state) => ({ learnOpen: !state.learnOpen, changesOpen: false, workspacesOpen: false, hintsOpen: false })),
      openLearn: () => set({ learnOpen: true, changesOpen: false, workspacesOpen: false, hintsOpen: false }),
      setLearnEnabled: (v) => set(v ? { learnEnabled: true } : { learnEnabled: false, learnOpen: false }),
      setLearnLevel: (l) => set({ learnLevel: l }),
```

Add `learnOpen: false` to the object returned by `toggleHints`, `toggleChanges` and `toggleWorkspaces`. Add `learnEnabled`, `learnLevel`, `learnOpen` to `partialize`. If the persist config has a `version` + `migrate`, do not bump it: missing keys fall back to defaults on merge (confirm by reading the persist block near line 1335; if `migrate` rebuilds state explicitly, add the three defaults there).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/learnStore.test.ts src/store/appStore.test.ts` then `npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/learn.ts src/store/learnStore.ts src/store/learnStore.test.ts src/store/appStore.ts src/store/appStore.test.ts
git commit -m "feat(learn): learn flag (default on) and learn store"
```

---

### Task 5: Learn UI components

**Files:**
- Create: `src/components/learn/LessonCard.tsx`, `src/components/learn/LessonCard.test.tsx`
- Create: `src/components/learn/LearnConsent.tsx`
- Create: `src/components/learn/LearnPanel.tsx`, `src/components/learn/LearnPanel.test.tsx`

**Interfaces:**
- Consumes: `useLearnStore`, `useAppStore` (`learnLevel`, `setLearnLevel`), `useTerminalStore` (`activeTerminalId`, `terminals`), `src/lib/learn.ts`.
- Produces:
  - `LessonCardView` component (exported name, file `LessonCard.tsx`) props: `{ card: LessonCard; level: LearnLevel; onPick: (i: number) => void; onToggleSave: () => void; onLevel: (l: LearnLevel) => void; onNext: () => void }`
  - `LearnConsent` props: `{ onAllowed: () => void }`
  - `LearnPanel` (no props) for the Inspector.

UI copy and structure follow the sketch (https://claude.ai/artifact/9aviw3G5svH64FeQyH3yZ1). Use existing tokens and classes (`text-text-primary`, `text-text-secondary`, `text-text-tertiary`, `bg-fill-active`, `bg-fill-hover`, `border-[var(--seam)]`, plus whatever success/error/accent tokens the codebase already uses; check `FileChangesPanel.tsx` and `tailwind.config.*`). Every interactive element is a real `<button type="button">` with an accessible name. Respect reduced motion: no new animations.

- [ ] **Step 1: Write the failing tests**

`src/components/learn/LessonCard.test.tsx`:

```tsx
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LessonCardView } from './LessonCard';
import type { LessonCard } from '../../lib/learn';

afterEach(cleanup);

const card: LessonCard = {
  id: 'a', terminalId: 't1', createdAt: '', kind: 'pattern', title: 'Decorator: wrap a function',
  filePath: 'src/lib/api.ts', startLine: 42, endLine: 43, quote: ['export function withRetry<T>(', '  fn: () => Promise<T>,'],
  highlight: [42], why: ['simple why', 'middle why', 'expert why'], question: 'What does withRetry return?',
  options: ['The data', 'A new function', 'A Promise'], answerIndex: 1, explain: 'Line 45 returns a function.',
  saved: false, answeredIndex: null,
};

const noop = () => {};

it('shows the quoted code with real line numbers and the level text', () => {
  render(<LessonCardView card={card} level={1} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect(screen.getByText('src/lib/api.ts:42-43')).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('middle why')).toBeTruthy();
  expect(screen.getByText('Pick an answer to reveal why.')).toBeTruthy();
});

it('reports a pick and level changes', () => {
  const onPick = vi.fn();
  const onLevel = vi.fn();
  render(<LessonCardView card={card} level={1} onPick={onPick} onToggleSave={noop} onLevel={onLevel} onNext={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'A new function' }));
  expect(onPick).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole('button', { name: 'Explain simpler' }));
  expect(onLevel).toHaveBeenCalledWith(0);
  fireEvent.click(screen.getByRole('button', { name: 'Go deeper' }));
  expect(onLevel).toHaveBeenCalledWith(2);
});

it('reveals the verdict and locks options once answered', () => {
  render(<LessonCardView card={{ ...card, answeredIndex: 0 }} level={1} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect(screen.getByText(/Not quite\./)).toBeTruthy();
  expect(screen.getByText(/Line 45 returns a function\./)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'A Promise' }) as HTMLButtonElement).disabled).toBe(true);
});

it('disables level buttons at the ends and shows saved state', () => {
  render(<LessonCardView card={{ ...card, saved: true }} level={0} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect((screen.getByRole('button', { name: 'Explain simpler' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Saved' }).getAttribute('aria-pressed')).toBe('true');
});
```

`src/components/learn/LearnPanel.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { LearnPanel } from './LearnPanel';
import { useLearnStore } from '../../store/learnStore';
import { useTerminalStore } from '../../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue([] as never);
  useLearnStore.setState({ byTerminal: {} });
  useTerminalStore.setState({ activeTerminalId: 't1' } as never);
});

it('asks for consent and generates after Allow', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'no_consent', cards: [], unseen: 0 } } });
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'generate_learn_cards') return { status: 'no_changes', cards: [] } as never;
    return [] as never;
  });
  render(<LearnPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_learn_consent', { enabled: true }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('generate_learn_cards', expect.objectContaining({ terminalId: 't1' })));
});

it('shows the status message when there is nothing to learn', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'no_changes', cards: [], unseen: 0 } } });
  render(<LearnPanel />);
  expect(screen.getByText('No changes to learn from yet. Run an agent, then try again.')).toBeTruthy();
});

it('renders cards and clears the unseen badge', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', unseen: 2, cards: [{
    id: 'a', terminalId: 't1', createdAt: '', kind: 'syntax', title: 'Generics carry the type',
    filePath: 'a.ts', startLine: 1, endLine: 1, quote: ['x'], highlight: [1], why: ['b', 'i', 'e'],
    question: 'q?', options: ['1', '2', '3'], answerIndex: 0, explain: 'e', saved: false, answeredIndex: null,
  }] } } });
  render(<LearnPanel />);
  expect(screen.getByText('Generics carry the type')).toBeTruthy();
  expect(useLearnStore.getState().byTerminal.t1.unseen).toBe(0);
});

it('has a manual generate button', async () => {
  render(<LearnPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Learn from current changes' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('generate_learn_cards', expect.objectContaining({ terminalId: 't1' })));
});
```

(If `useTerminalStore.setState({ activeTerminalId })` does not match the store shape, adapt the setup to how other component tests seed the terminal store; grep `useTerminalStore.setState` in `src/**/*.test.tsx`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/learn`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/components/learn/LessonCard.tsx`:

```tsx
import type { LearnLevel, LessonCard } from '../../lib/learn';
import { KIND_LABEL } from '../../lib/learn';

interface Props {
  card: LessonCard;
  level: LearnLevel;
  onPick: (index: number) => void;
  onToggleSave: () => void;
  onLevel: (level: LearnLevel) => void;
  onNext: () => void;
}

const ghostBtn =
  'h-9 px-3 rounded-lg border border-[var(--seam)] text-[12px] text-text-primary hover:bg-fill-hover disabled:opacity-40 disabled:hover:bg-transparent';

export function LessonCardView({ card, level, onPick, onToggleSave, onLevel, onNext }: Props) {
  const answered = card.answeredIndex !== null;
  const correct = answered && card.answeredIndex === card.answerIndex;
  const highlighted = new Set(card.highlight);

  return (
    <article className="flex flex-col gap-3 p-4 rounded-xl border border-[var(--seam)] bg-fill-hover/40">
      <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">{KIND_LABEL[card.kind]}</span>
      <h3 className="m-0 text-[15px] font-semibold text-text-primary leading-snug">{card.title}</h3>

      <div className="rounded-lg border border-[var(--seam)] overflow-x-auto font-mono text-[12px]">
        <div className="flex justify-between px-2.5 py-1.5 border-b border-[var(--seam)] text-[11px] text-text-tertiary">
          <span>{`${card.filePath}:${card.startLine}-${card.endLine}`}</span>
          <span>from diff</span>
        </div>
        <div className="py-1.5">
          {card.quote.map((line, i) => {
            const n = card.startLine + i;
            return (
              <div key={n} className={`flex whitespace-pre pr-3 ${highlighted.has(n) ? 'bg-accent/15' : ''}`}>
                <span className="w-9 shrink-0 pr-3 text-right text-text-tertiary select-none">{n}</span>
                <span className="text-text-secondary">{line}</span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="m-0 text-[13px] leading-relaxed text-text-secondary">{card.why[level]}</p>

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-text-primary">Predict first: {card.question}</span>
        {card.options.map((opt, i) => {
          const isAnswer = i === card.answerIndex;
          const isPicked = i === card.answeredIndex;
          const tone = !answered
            ? 'border-[var(--seam)] text-text-primary hover:bg-fill-hover'
            : isAnswer
              ? 'border-success text-text-primary bg-success/10'
              : isPicked
                ? 'border-error text-text-primary bg-error/10'
                : 'border-[var(--seam)] text-text-tertiary';
          return (
            <button
              key={i}
              type="button"
              disabled={answered}
              aria-pressed={isPicked}
              onClick={() => onPick(i)}
              className={`min-h-10 px-3 py-2 rounded-lg border text-left text-[13px] ${tone}`}
            >
              {opt}
            </button>
          );
        })}
        {answered ? (
          <div className="px-3 py-2.5 rounded-lg bg-success/10 text-[13px] leading-relaxed text-text-primary">
            {correct ? 'Correct.' : 'Not quite.'} {card.explain}
          </div>
        ) : (
          <span className="text-[12px] text-text-tertiary">Pick an answer to reveal why.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className={ghostBtn} disabled={level === 0} onClick={() => onLevel((level - 1) as LearnLevel)}>
          Explain simpler
        </button>
        <button type="button" className={ghostBtn} disabled={level === 2} onClick={() => onLevel((level + 1) as LearnLevel)}>
          Go deeper
        </button>
        <button type="button" className={ghostBtn} aria-pressed={card.saved} onClick={onToggleSave}>
          {card.saved ? 'Saved' : 'Save card'}
        </button>
        <button type="button" onClick={onNext} className="ml-auto h-9 px-3.5 rounded-lg bg-accent text-white text-[12px] font-semibold">
          Next card
        </button>
      </div>
    </article>
  );
}
```

Replace `text-accent`, `bg-accent`, `bg-accent/15`, `border-success`, `bg-success/10`, `border-error`, `bg-error/10`, and `text-white` with the codebase's real token names if they differ (verify each exists; a missing Tailwind class silently renders nothing). The text on the accent button must keep 4.5:1 contrast.

`src/components/learn/LearnConsent.tsx`:

```tsx
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../store/toastStore';
import { reportInvokeFailure } from '../../lib/errorReporter';

export function LearnConsent({ onAllowed }: { onAllowed: () => void }) {
  const allow = () => {
    invoke('set_learn_consent', { enabled: true })
      .then(onAllowed)
      .catch((err) => {
        toast.error('Could not enable Learn');
        reportInvokeFailure('set_learn_consent', err);
      });
  };
  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl border border-[var(--seam)]">
      <p className="m-0 text-[13px] leading-relaxed text-text-secondary">
        Learn reads this session's git diff (up to 24 KiB) and sends it to the model configured in your Claude CLI to
        write short lessons. Known secrets are scrubbed, but source code is sent. You can turn this off in Settings, Learn.
      </p>
      <button type="button" onClick={allow} className="self-start h-9 px-3.5 rounded-lg bg-accent text-white text-[12px] font-semibold">
        Allow
      </button>
    </div>
  );
}
```

`src/components/learn/LearnPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useLearnStore } from '../../store/learnStore';
import { useTerminalStore } from '../../store/terminalStore';
import { KIND_SHORT, LEVEL_LABELS, STATUS_MESSAGE } from '../../lib/learn';
import type { LearnLevel } from '../../lib/learn';
import { LessonCardView } from './LessonCard';
import { LearnConsent } from './LearnConsent';

export function LearnPanel() {
  const terminalId = useTerminalStore((s) => s.activeTerminalId);
  const goal = useTerminalStore((s) => (s.activeTerminalId ? s.terminals.get(s.activeTerminalId)?.sessionContext?.goal : undefined));
  const entry = useLearnStore((s) => (terminalId ? s.byTerminal[terminalId] : undefined));
  const { load, generate, markSeen, answer, toggleSave } = useLearnStore.getState();
  const level = useAppStore((s) => s.learnLevel);
  const setLevel = useAppStore((s) => s.setLearnLevel);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (terminalId && !entry) void load(terminalId);
  }, [terminalId, entry, load]);
  useEffect(() => {
    if (terminalId && entry?.unseen) markSeen(terminalId);
  }, [terminalId, entry?.unseen, markSeen]);
  const cardCount = entry?.cards.length ?? 0;
  useEffect(() => setIndex(0), [terminalId, cardCount]);

  if (!terminalId) {
    return <p className="p-4 text-[13px] text-text-tertiary">Open a session to learn from its changes.</p>;
  }

  const status = entry?.status ?? 'idle';
  const cards = entry?.cards ?? [];
  const card = cards[Math.min(index, Math.max(cards.length - 1, 0))];
  const run = () => void generate(terminalId, { goal });

  return (
    <div className="h-full overflow-y-auto p-4 flex flex-col gap-3.5">
      <div role="group" aria-label="Level" className="flex gap-1 p-0.5 rounded-lg bg-fill-hover/40">
        {LEVEL_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-pressed={level === i}
            onClick={() => setLevel(i as LearnLevel)}
            className={`flex-1 h-8 rounded-md text-[12px] ${level === i ? 'bg-fill-active text-text-primary font-semibold' : 'text-text-tertiary hover:text-text-primary'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={run}
        disabled={status === 'loading'}
        className="h-9 rounded-lg border border-[var(--seam)] text-[12px] text-text-primary hover:bg-fill-hover disabled:opacity-50"
      >
        Learn from current changes
      </button>

      {status === 'no_consent' && <LearnConsent onAllowed={run} />}
      {status === 'loading' && <p className="text-[13px] text-text-tertiary">Reading the diff and writing lessons...</p>}
      {status !== 'loading' && status !== 'idle' && status !== 'ok' && status !== 'no_consent' && (
        <p className="text-[13px] text-text-tertiary">{STATUS_MESSAGE[status]}</p>
      )}
      {status === 'idle' && cards.length === 0 && (
        <p className="text-[13px] text-text-tertiary">Run an agent, then press Learn from current changes.</p>
      )}

      {card && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === card.id}
                onClick={() => setIndex(i)}
                className={`h-8 px-3 rounded-full border text-[12px] ${c.id === card.id ? 'border-accent text-text-primary font-semibold' : 'border-[var(--seam)] text-text-tertiary'}`}
              >
                {`${i + 1} ${KIND_SHORT[c.kind]}`}
              </button>
            ))}
          </div>
          <LessonCardView
            card={card}
            level={level}
            onPick={(i) => void answer(terminalId, card.id, i)}
            onToggleSave={() => void toggleSave(terminalId, card.id)}
            onLevel={setLevel}
            onNext={() => setIndex((i) => (i + 1) % cards.length)}
          />
          <span className="text-[11px] leading-relaxed text-text-tertiary">
            Generated with your Claude CLI. Quoted lines are checked against the diff.
          </span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/learn` then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/learn
git commit -m "feat(learn): lesson card, consent and learn panel UI"
```

---

### Task 6: Wire Learn into the Inspector, App, TitleBar and command palette

**Files:**
- Modify: `src/components/Inspector.tsx`
- Create: `src/components/Inspector.test.tsx`
- Modify: `src/App.tsx` (inspector visibility at ~line 1067, `terminal-finished` handler at ~line 758-782)
- Modify: `src/components/TitleBar.tsx` (~line 37-49)
- Modify: `src/components/CommandPalette.tsx` (~line 166-181)

**Interfaces:**
- Consumes: `learnEnabled`, `learnOpen`, `toggleLearn`, `openLearn` (Task 4), `useLearnStore` (Task 4), `LearnPanel` (Task 5), `toast` from `src/store/toastStore` (check the `ToastAction` type for field names before using it).

- [ ] **Step 1: Write the failing test**

`src/components/Inspector.test.tsx`:

```tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inspector } from './Inspector';
import { useAppStore } from '../store/appStore';
import { useLearnStore } from '../store/learnStore';
import { useTerminalStore } from '../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('./FileChangesPanel', () => ({ FileChangesPanel: () => <div>changes-panel</div> }));
vi.mock('./WorkspacesPanel', () => ({ WorkspacesPanel: () => <div>workspaces-panel</div> }));
vi.mock('./HintsPanel', () => ({ HintsPanel: () => <div>hints-panel</div> }));
vi.mock('./learn/LearnPanel', () => ({ LearnPanel: () => <div>learn-panel</div> }));

afterEach(cleanup);
beforeEach(() => {
  useAppStore.setState({ learnEnabled: true, learnOpen: false, changesOpen: true, workspacesOpen: false, hintsOpen: false });
  useLearnStore.setState({ byTerminal: {} });
  useTerminalStore.setState({ activeTerminalId: 't1' } as never);
});

it('shows a Learn tab that opens the Learn panel', () => {
  render(<Inspector />);
  fireEvent.click(screen.getByRole('button', { name: /Learn/ }));
  expect(screen.getByText('learn-panel')).toBeTruthy();
  expect(useAppStore.getState().changesOpen).toBe(false);
});

it('shows the unseen count on the Learn tab', () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [], unseen: 3 } } });
  render(<Inspector />);
  expect(screen.getByRole('button', { name: /Learn/ }).textContent).toContain('3');
});

it('hides the Learn tab when the feature is off', () => {
  useAppStore.setState({ learnEnabled: false });
  render(<Inspector />);
  expect(screen.queryByRole('button', { name: /Learn/ })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Inspector.test.tsx`
Expected: FAIL (no Learn tab).

- [ ] **Step 3: Implement**

`Inspector.tsx`:
- `type InspectorTab = 'changes' | 'workspaces' | 'commands' | 'learn';`
- Add `{ id: 'learn', label: 'Learn', Icon: GraduationCap }` (import `GraduationCap` from `lucide-react`) as the 4th entry; render `TABS.filter((t) => t.id !== 'learn' || learnEnabled)`.
- Read `learnEnabled`, `learnOpen`, `toggleLearn` from `useAppStore`; unseen count via `useLearnStore((s) => (activeTerminalId ? s.byTerminal[activeTerminalId]?.unseen ?? 0 : 0))` with `activeTerminalId` from `useTerminalStore`.
- `active`: `changesOpen ? 'changes' : workspacesOpen ? 'workspaces' : learnOpen && learnEnabled ? 'learn' : 'commands'`.
- `openTab`: add `else if (id === 'learn') toggleLearn();` before the hints fallback.
- `close`: add `else if (learnOpen) toggleLearn();`.
- When `id === 'learn' && unseen > 0` render a small count pill after the label: `<span className="ml-0.5 px-1.5 rounded-full bg-accent text-white text-[10px] font-semibold">{unseen}</span>` (same token caveat as Task 5).
- Body: `{active === 'learn' && <LearnPanel />}` (import from `./learn/LearnPanel`).
- Update the doc comment to mention the Learn tab.

`App.tsx`:
- Select `learnOpen` and `learnEnabled` where `changesOpen` / `workspacesOpen` / `hintsOpen` are selected; change the inspector condition to `(changesOpen || workspacesOpen || hintsOpen || (learnOpen && learnEnabled))`.
- In the `terminal-finished` handler, directly after the summary IIFE (still inside the `!isDetached` path):

```ts
      // Learn Cards: best-effort background work. Consent is enforced in Rust,
      // so a no_consent result is silent; generate() records failures in the store.
      if (useAppStore.getState().learnEnabled) {
        const goal = useTerminalStore.getState().terminals.get(id)?.sessionContext?.goal;
        useLearnStore.getState().generate(id, { goal, silent: true }).then((res) => {
          if (res?.status === 'ok' && res.cards.length > 0) {
            const n = res.cards.length;
            toast.info('Lessons ready', `${n} lesson${n === 1 ? '' : 's'} from this change`, {
              duration: 8000,
              actions: [{ label: 'Open Learn', onClick: () => useAppStore.getState().openLearn() }],
            });
          }
        }).catch(() => {
          // generate() never throws; this only guards the toast callback.
        });
      }
```

(Adjust the action object to the real `ToastAction` fields in `src/store/toastStore.ts`, e.g. `variant: 'primary'`.)

`TitleBar.tsx`: select `learnOpen`, `learnEnabled`, `toggleLearn`; `inspectorOpen = changesOpen || workspacesOpen || hintsOpen || (learnOpen && learnEnabled)`; in `toggleInspector` add `else if (learnOpen) toggleLearn();` before the final `else toggleChanges();`.

`CommandPalette.tsx`: after the `actions` array literal is built and before `actions.forEach`, add:

```ts
      if (useAppStore.getState().learnEnabled) {
        actions.push(
          { label: 'Open Learn', description: 'Show lessons from the active session changes', icon: GraduationCap, action: () => { useAppStore.getState().openLearn(); closeCommandPalette(); } },
          { label: 'Learn from Current Changes', description: 'Write 1-3 short lessons from the active session git diff', icon: GraduationCap, action: () => {
            closeCommandPalette();
            const id = useTerminalStore.getState().activeTerminalId;
            if (!id) return;
            useAppStore.getState().openLearn();
            const goal = useTerminalStore.getState().terminals.get(id)?.sessionContext?.goal;
            void useLearnStore.getState().generate(id, { goal });
          } },
        );
      }
```

(Change `const actions` to keep its type annotation; `push` works on a `const` array. Import `GraduationCap` and `useLearnStore`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/Inspector.test.tsx src/components/learn src/store` then `npx tsc --noEmit` then `npm run test:run`
Expected: all PASS, including existing tests (fix any existing test that asserted the exact list of inspector tabs or palette actions).

- [ ] **Step 5: Commit**

```bash
git add src/components/Inspector.tsx src/components/Inspector.test.tsx src/App.tsx src/components/TitleBar.tsx src/components/CommandPalette.tsx
git commit -m "feat(learn): Learn tab, finish-trigger and palette commands"
```

---

### Task 7: Settings page (feature flag + consent)

**Files:**
- Create: `src/components/settings/categories/LearnPage.tsx`, `src/components/settings/categories/LearnPage.test.tsx`
- Modify: `src/components/settings/index.ts` (add `{ id: 'learn', label: 'Learn' }` to the `claude` group pages, after `defaults`)
- Modify: `src/components/settings/SettingsWindow.tsx` (add `'claude.learn': lazy(() => import('./categories/LearnPage')),`)

**Interfaces:**
- Consumes: `learnEnabled`, `setLearnEnabled` (Task 4); IPC `get_learn_consent`, `set_learn_consent` (Task 3); `PageHeader`, `PageSection`, `SettingRow`, `Toggle` from `../SettingRow`; `registerSetting` from `../index`.

- [ ] **Step 1: Write the failing test**

`LearnPage.test.tsx`:

```tsx
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import LearnPage from './LearnPage';
import { useAppStore } from '../../../store/appStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

beforeEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset().mockResolvedValue(false as never);
  useAppStore.setState({ learnEnabled: true });
});

it('Learn is on by default and can be turned off', () => {
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Learn from agent changes' });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(toggle);
  expect(useAppStore.getState().learnEnabled).toBe(false);
});

it('consent is off until Rust persists it', async () => {
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Allow Learn to send the session diff to Claude' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_learn_consent'));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_learn_consent', { enabled: true }));
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

it('keeps consent off if persisting fails', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'set_learn_consent') throw new Error('disk');
    return false as never;
  });
  render(<LearnPage />);
  const toggle = screen.getByRole('switch', { name: 'Allow Learn to send the session diff to Claude' });
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_learn_consent', { enabled: true }));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/categories/LearnPage.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`LearnPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'claude', page: 'learn' } as const;
[
  { id: 'learn-enabled', label: 'Learn from agent changes' },
  { id: 'learn-consent', label: 'Allow Learn to send the session diff to Claude' },
].forEach(({ id, label }) =>
  registerSetting({ category: cat, id, label, keywords: ['learn', 'lessons', 'tutor', 'education', 'teach', 'quiz'] })
);

export default function LearnPage() {
  const learnEnabled = useAppStore((s) => s.learnEnabled);
  const setLearnEnabled = useAppStore((s) => s.setLearnEnabled);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    invoke<boolean>('get_learn_consent').then(setConsent).catch(() => {
      // Fail closed: the backend also checks consent on every request.
    });
  }, []);

  return (
    <div>
      <PageHeader title="Learn" />
      <PageSection title="Learn Cards">
        <SettingRow
          label="Learn from agent changes"
          description="On by default. Shows the Learn tab in the Inspector. After an agent changes code, Learn turns the diff into 1-3 short lessons with a quick question, so you understand what was built."
        >
          <Toggle label="Learn from agent changes" value={learnEnabled} onChange={setLearnEnabled} />
        </SettingRow>
        <SettingRow
          label="Allow Learn to send the session diff to Claude"
          description="Off until you allow it. Sends up to 24 KiB of the session's git diff to the model service configured in your Claude CLI. Known secrets are scrubbed, but source code is sent. Without this, Learn does not write lessons."
        >
          <Toggle
            label="Allow Learn to send the session diff to Claude"
            value={consent}
            onChange={(enabled) => {
              invoke('set_learn_consent', { enabled })
                .then(() => setConsent(enabled))
                .catch((err) => {
                  toast.error('Could not change the Learn preference');
                  reportInvokeFailure('set_learn_consent', err);
                });
            }}
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
```

Register the page in `index.ts` and `SettingsWindow.tsx` as listed above. If `src/components/settings/index.test.ts` asserts the full page list, add `learn` there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/settings` then `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings
git commit -m "feat(learn): Settings > Agents > Learn page with flag and consent"
```

---

### Task 8: Full verification

**Files:** none new. Fix anything that fails, in the file that owns it.

- [ ] **Step 1: Run every check CI runs**

```bash
cd src-tauri && cargo fmt --check && cargo clippy --locked && cargo test --locked
cd .. && npx tsc --noEmit && npm run test:run
```

Expected: all green. Report exact failures if any remain.

- [ ] **Step 2: Dash check**

Run: `git diff master --name-only | xargs grep -nP "[\x{2013}\x{2014}]"` (or the PowerShell equivalent: `Select-String` over the changed files with a regex matching code points U+2013 and U+2014).
Expected: no matches.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore(learn): verification fixes"
```

(Skip the commit if there is nothing to commit.)
