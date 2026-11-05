//! Transcript tailing for the insight layer. `TailState` reads new complete
//! lines from an agent's session JSONL by byte offset; Task 4 drives it from a
//! per-terminal polling loop.
#![allow(dead_code)] // callers land in the next task

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

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
}
