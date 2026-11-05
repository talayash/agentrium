//! Transcript tailing for the insight layer. `TailState` reads new complete
//! lines from an agent's session JSONL by byte offset; `start` drives it from a
//! per-terminal polling loop.

use crate::config::AgentKind;
use crate::insight_parse::{parse_claude_line, parse_codex_line, InsightRecord};
use crate::terminal::TerminalManager;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// On first attach to a large transcript, only the last this-many bytes are read.
pub const INITIAL_TAIL_BYTES: u64 = 4 * 1024 * 1024;

pub struct TailState {
    pub path: PathBuf,
    offset: u64,
    /// Bytes after the last newline seen so far (a partial line). Kept as raw
    /// bytes so a UTF-8 sequence split across polls decodes correctly.
    carry: Vec<u8>,
    started: bool,
}

pub struct TailPoll {
    pub lines: Vec<String>,
    /// The file shrank (truncated or rewritten) and was re-read from the start.
    pub reset: bool,
}

impl TailState {
    pub fn new(path: PathBuf) -> Self {
        Self { path, offset: 0, carry: Vec::new(), started: false }
    }

    pub fn poll(&mut self) -> std::io::Result<TailPoll> {
        let empty = TailPoll { lines: Vec::new(), reset: false };
        let mut file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
            Err(e) => return Err(e),
        };
        let len = file.metadata()?.len();
        let mut reset = false;
        let mut skip_partial_first = false;

        if !self.started {
            self.started = true;
            if len > INITIAL_TAIL_BYTES {
                self.offset = len - INITIAL_TAIL_BYTES;
                skip_partial_first = true;
            }
        } else if len < self.offset {
            self.offset = 0;
            self.carry.clear();
            reset = true;
        }

        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        self.offset += buf.len() as u64;

        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(&buf);

        if skip_partial_first {
            // The window likely starts mid-line: drop up to and including the first newline.
            match data.iter().position(|&b| b == b'\n') {
                Some(i) => { data.drain(..=i); }
                None => { data.clear(); }
            }
        }

        let mut pieces: Vec<&[u8]> = data.split(|&b| b == b'\n').collect();
        // Last piece has no trailing newline yet: carry it to the next poll.
        let tail = pieces.pop().unwrap_or(&[]).to_vec();
        let lines = pieces
            .into_iter()
            .map(|raw| String::from_utf8_lossy(raw).trim_end_matches('\r').to_string())
            .filter(|l| !l.is_empty())
            .collect();
        self.carry = tail;
        Ok(TailPoll { lines, reset })
    }
}

/// Pure reset/continue decision for one tick. A new path (or a first attach)
/// starts a fresh `TailState` and tells the UI to clear; the same path keeps
/// its offset; an unresolved path drops the state.
pub(crate) fn next_tail(
    current: Option<TailState>,
    resolved: Option<PathBuf>,
) -> (Option<TailState>, bool) {
    match (current, resolved) {
        (_, None) => (None, false),
        (Some(cur), Some(p)) if cur.path == p => (Some(cur), false),
        (_, Some(p)) => (Some(TailState::new(p)), true),
    }
}

type PathKey = (String, String, AgentKind);

/// How long an unresolved (None) lookup is trusted before re-resolving for the
/// same key. Codex resolution walks every rollout file.
const NONE_BACKOFF: std::time::Duration = std::time::Duration::from_secs(10);

/// Caches the resolved transcript path per (session id, cwd, agent). Codex
/// resolution walks every rollout file, so it must not run on every tick: a
/// found path is reused while it exists, an unresolved result is reused for
/// `NONE_BACKOFF`, and a key change always re-resolves immediately.
#[derive(Default)]
pub(crate) struct PathCache {
    entry: Option<(PathKey, Option<PathBuf>, std::time::Instant)>,
}

impl PathCache {
    pub(crate) fn resolve(
        &mut self,
        key: PathKey,
        resolver: impl FnOnce() -> Option<PathBuf>,
    ) -> Option<PathBuf> {
        self.resolve_at(key, std::time::Instant::now(), resolver)
    }

    /// Same as `resolve` with an injectable clock, for tests.
    pub(crate) fn resolve_at(
        &mut self,
        key: PathKey,
        now: std::time::Instant,
        resolver: impl FnOnce() -> Option<PathBuf>,
    ) -> Option<PathBuf> {
        if let Some((k, cached, at)) = &self.entry {
            if *k == key {
                match cached {
                    Some(p) if p.exists() => return Some(p.clone()),
                    None if now.saturating_duration_since(*at) < NONE_BACKOFF => return None,
                    _ => {}
                }
            }
        }
        let resolved = resolver();
        self.entry = Some((key, resolved.clone(), now));
        resolved
    }
}

#[derive(Serialize)]
pub struct InsightSupport {
    pub supported: bool,
}

#[derive(Serialize, Clone)]
struct InsightBatch {
    id: String,
    records: Vec<InsightRecord>,
    reset: bool,
}

const MAX_BATCH: usize = 500;
const TICK: std::time::Duration = std::time::Duration::from_millis(500);

fn tailers() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static TAILERS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    TAILERS.get_or_init(Default::default)
}

/// Stop the tailer for `id`, if any.
pub fn stop(id: &str) {
    if let Ok(mut map) = tailers().lock() {
        if let Some(flag) = map.remove(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// Start (or restart) the tailer for `id`. The caller has already checked
/// that the agent supports transcripts.
pub fn start(app: AppHandle, manager: Arc<tokio::sync::Mutex<TerminalManager>>, id: String) {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = tailers().lock() {
        if let Some(old) = map.insert(id.clone(), flag.clone()) {
            old.store(true, Ordering::SeqCst);
        }
    }
    tokio::spawn(async move {
        let mut tail: Option<TailState> = None;
        let mut cache = PathCache::default();
        let mut pending_reset = false;
        let mut reported = false;
        loop {
            tokio::time::sleep(TICK).await;
            if flag.load(Ordering::SeqCst) {
                return;
            }
            // Read what we need under the lock, then release it before any IO.
            let (agent, session_id, cwd) = {
                let m = manager.lock().await;
                let Some(t) = m.terminals.get(&id) else {
                    // Terminal is gone: deregister only if we are still the current tailer.
                    if let Ok(mut map) = tailers().lock() {
                        if map.get(&id).is_some_and(|f| Arc::ptr_eq(f, &flag)) {
                            map.remove(&id);
                        }
                    }
                    return;
                };
                (
                    t.config.agent.clone(),
                    t.config.claude_session_id.clone(),
                    t.config.working_directory.clone(),
                )
            };
            let Some(session_id) = session_id else { continue };

            let provider = crate::session_provider::provider_for(&agent);
            if !provider.supports_transcript() {
                continue;
            }
            let key = (session_id.clone(), cwd.clone(), agent.clone());
            let resolved = {
                let (r, c) = tokio::task::spawn_blocking(move || {
                    let r = cache.resolve(key, || provider.transcript_path(&cwd, &session_id));
                    (r, cache)
                })
                .await
                .unwrap_or_else(|_| (None, PathCache::default()));
                cache = c;
                r
            };
            let (next, reset) = next_tail(tail.take(), resolved);
            tail = next;
            pending_reset |= reset;
            let Some(mut state) = tail.take() else { continue };

            let polled = tokio::task::spawn_blocking(move || {
                let r = state.poll();
                (state, r)
            })
            .await;
            let Ok((state, result)) = polled else { continue };
            tail = Some(state);
            let poll = match result {
                Ok(p) => p,
                Err(e) => {
                    if !reported {
                        reported = true;
                        crate::error_reporter::report_bg("insight_tail", format!("Failed to read transcript: {}", e));
                    }
                    continue;
                }
            };
            let reset = pending_reset || poll.reset;
            if poll.lines.is_empty() && !reset {
                continue;
            }
            let parse: fn(&str) -> Vec<InsightRecord> = match agent {
                AgentKind::Codex => parse_codex_line,
                _ => parse_claude_line,
            };
            let records: Vec<InsightRecord> = poll.lines.iter().flat_map(|l| parse(l)).collect();
            if flag.load(Ordering::SeqCst) {
                return;
            }
            if records.is_empty() && !reset {
                // Lines that parsed to nothing: no point waking the UI.
                continue;
            }
            let mut chunks: Vec<Vec<InsightRecord>> = records.chunks(MAX_BATCH).map(|c| c.to_vec()).collect();
            if chunks.is_empty() {
                chunks.push(Vec::new()); // a reset with no records still clears the UI
            }
            for (i, records) in chunks.into_iter().enumerate() {
                let batch = InsightBatch { id: id.clone(), records, reset: reset && i == 0 };
                if let Err(e) = app.emit("insight-records", batch) {
                    crate::error_reporter::report_bg("emit_insight_records", format!("Failed to emit insight-records: {}", e));
                }
            }
            pending_reset = false;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn lines(p: &TailPoll) -> Vec<&str> { p.lines.iter().map(|s| s.as_str()).collect() }

    #[test]
    fn reads_complete_lines_and_advances() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let mut t = TailState::new(p);
        assert_eq!(lines(&t.poll().unwrap()), ["a", "b"]);
        assert!(t.poll().unwrap().lines.is_empty());
    }

    #[test]
    fn partial_line_is_carried_to_next_poll() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "{\"x\":").unwrap();
        let mut t = TailState::new(p.clone());
        assert!(t.poll().unwrap().lines.is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"1}\n").unwrap();
        assert_eq!(lines(&t.poll().unwrap()), ["{\"x\":1}"]);
    }

    #[test]
    fn utf8_split_across_polls_survives() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        let bytes = "h\u{e9}llo\n".as_bytes().to_vec(); // e-acute is 2 bytes
        std::fs::write(&p, &bytes[..2]).unwrap();
        let mut t = TailState::new(p.clone());
        assert!(t.poll().unwrap().lines.is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&bytes[2..]).unwrap();
        assert_eq!(lines(&t.poll().unwrap()), ["h\u{e9}llo"]);
    }

    #[test]
    fn initial_attach_reads_only_tail_window() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        let line = format!("{}\n", "x".repeat(99));
        let total = (INITIAL_TAIL_BYTES + 10_000) as usize;
        let mut data = String::new();
        while data.len() < total { data.push_str(&line); }
        std::fs::write(&p, data).unwrap();
        let mut t = TailState::new(p);
        let poll = t.poll().unwrap();
        assert_eq!(poll.lines[0].len(), 99);
        let expected = (INITIAL_TAIL_BYTES / 100) as i64;
        assert!((poll.lines.len() as i64 - expected).abs() <= 1, "got {}", poll.lines.len());
    }

    #[test]
    fn truncated_file_resets() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "one\ntwo\nthree\n").unwrap();
        let mut t = TailState::new(p.clone());
        let first = t.poll().unwrap();
        assert!(!first.reset);
        std::fs::write(&p, "new\n").unwrap();
        let second = t.poll().unwrap();
        assert!(second.reset);
        assert_eq!(lines(&second), ["new"]);
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut t = TailState::new(tmp.path().join("nope.jsonl"));
        let poll = t.poll().unwrap();
        assert!(poll.lines.is_empty());
        assert!(!poll.reset);
    }

    #[test]
    fn crlf_is_trimmed() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "a\r\n\r\nb\r\n").unwrap();
        let mut t = TailState::new(p);
        assert_eq!(lines(&t.poll().unwrap()), ["a", "b"]);
    }

    #[test]
    fn tailer_resets_when_path_changes() {
        let a = TailState::new(PathBuf::from("a.jsonl"));
        let (st, reset) = next_tail(Some(a), Some(PathBuf::from("b.jsonl")));
        assert_eq!(st.unwrap().path, PathBuf::from("b.jsonl"));
        assert!(reset);
    }

    #[test]
    fn tailer_keeps_state_for_same_path() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "a
b
").unwrap();
        let mut a = TailState::new(p.clone());
        assert_eq!(a.poll().unwrap().lines.len(), 2);
        let (st, reset) = next_tail(Some(a), Some(p));
        assert!(!reset);
        let mut st = st.unwrap();
        assert!(st.poll().unwrap().lines.is_empty(), "offset must be kept");
    }

    #[test]
    fn tailer_drops_state_when_path_unresolved() {
        let a = TailState::new(PathBuf::from("a.jsonl"));
        let (st, reset) = next_tail(Some(a), None);
        assert!(st.is_none());
        assert!(!reset);
        let (st, reset) = next_tail(st, Some(PathBuf::from("b.jsonl")));
        assert!(st.is_some());
        assert!(reset);
    }

    #[test]
    fn first_attach_reports_reset() {
        let (st, reset) = next_tail(None, Some(PathBuf::from("b.jsonl")));
        assert!(st.is_some());
        assert!(reset);
    }

    #[test]
    fn path_cache_reuses_until_key_changes_or_file_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("t.jsonl");
        std::fs::write(&p, "x
").unwrap();
        let mut cache = PathCache::default();
        let mut calls = 0;
        let key = ("s1".to_string(), "cwd".to_string(), crate::config::AgentKind::Claude);
        for _ in 0..3 {
            let got = cache.resolve(key.clone(), || { calls += 1; Some(p.clone()) });
            assert_eq!(got, Some(p.clone()));
        }
        assert_eq!(calls, 1);
        let key2 = ("s2".to_string(), "cwd".to_string(), crate::config::AgentKind::Claude);
        cache.resolve(key2.clone(), || { calls += 1; Some(p.clone()) });
        assert_eq!(calls, 2);
        std::fs::remove_file(&p).unwrap();
        cache.resolve(key2, || { calls += 1; None });
        assert_eq!(calls, 3);
    }
    #[test]
    fn path_cache_backs_off_on_none() {
        use std::time::{Duration, Instant};
        let mut cache = PathCache::default();
        let key = ("s1".to_string(), "cwd".to_string(), crate::config::AgentKind::Claude);
        let t0 = Instant::now();
        let mut calls = 0;
        assert_eq!(cache.resolve_at(key.clone(), t0, || { calls += 1; None }), None);
        assert_eq!(cache.resolve_at(key.clone(), t0 + Duration::from_secs(5), || { calls += 1; None }), None);
        assert_eq!(calls, 1, "None must not be re-resolved within the backoff");
        // A different key re-resolves immediately.
        let key2 = ("s2".to_string(), "cwd".to_string(), crate::config::AgentKind::Claude);
        cache.resolve_at(key2.clone(), t0 + Duration::from_secs(6), || { calls += 1; None });
        assert_eq!(calls, 2);
        // After the backoff the same key re-resolves.
        cache.resolve_at(key2, t0 + Duration::from_secs(6) + NONE_BACKOFF, || { calls += 1; None });
        assert_eq!(calls, 3);
    }
}
