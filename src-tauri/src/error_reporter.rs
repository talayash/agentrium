#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorSource {
    RustPanic,
    RustCommand,
    Frontend,
}

impl ErrorSource {
    pub fn as_tag(&self) -> &'static str {
        match self {
            ErrorSource::RustPanic => "rust_panic",
            ErrorSource::RustCommand => "rust_command",
            ErrorSource::Frontend => "frontend",
        }
    }
}

/// Marker prefix used to tag a `Result::Err(String)` as user-input validation
/// rather than an internal bug. `wrap_cmd` detects this prefix and:
///   1. strips it before returning the error to the frontend (so UI is unchanged), and
///   2. skips telemetry reporting.
/// `\x01` (SOH) is a control character that does not appear in any error
/// message we generate or any library `Display` impl we depend on. Do NOT
/// build `user_err` strings from untrusted external input.
pub const USER_ERR_PREFIX: &str = "\x01u\x01";

/// Tag `msg` as a user-input validation error. The returned `String` is what
/// you should return from a command body via `Err(user_err(...))`.
pub fn user_err(msg: impl Into<String>) -> String {
    let mut s = String::from(USER_ERR_PREFIX);
    s.push_str(&msg.into());
    s
}

/// True if `s` was produced by `user_err`.
pub fn is_user_error(s: &str) -> bool {
    s.starts_with(USER_ERR_PREFIX)
}

/// Return the original message without the `USER_ERR_PREFIX` if present;
/// otherwise return the input unchanged. Allocation-free in the common case.
pub fn strip_user_prefix(s: &str) -> &str {
    s.strip_prefix(USER_ERR_PREFIX).unwrap_or(s)
}

/// Single source of truth: should this `Err(String)` be sent to telemetry?
/// `wrap_cmd` calls this so the rule lives next to the helpers.
pub fn should_report(err: &str) -> bool {
    !is_user_error(err)
}

pub fn scrub(input: &str) -> String {
    use std::sync::OnceLock;
    static WIN_USER: OnceLock<regex::Regex> = OnceLock::new();
    static FILE_URI_USER: OnceLock<regex::Regex> = OnceLock::new();
    // Match `C:\Users\<username>` where the username portion ends at the next path
    // separator, whitespace, or shell metacharacter. The terminator is NOT consumed,
    // so a trailing backslash, apostrophe, etc. remains intact in the output.
    let win = WIN_USER
        .get_or_init(|| regex::Regex::new(r#"C:\\Users\\[^\\/\s'"<>|*?]+"#).unwrap());
    let uri = FILE_URI_USER
        .get_or_init(|| regex::Regex::new(r#"file:///C:/Users/[^/\s'"<>|*?]+"#).unwrap());
    let step1 = win.replace_all(input, r"C:\Users\<user>");
    let step2 = uri.replace_all(&step1, "file:///C:/Users/<user>");
    step2.into_owned()
}

pub fn fingerprint(
    source: ErrorSource,
    kind: Option<&str>,
    message: &str,
    stack: Option<&str>,
) -> String {
    use sha2::{Digest, Sha256};
    let first_line = stack
        .and_then(|s| s.lines().find(|l| !l.trim().is_empty()))
        .or_else(|| message.lines().find(|l| !l.trim().is_empty()))
        .unwrap_or("")
        .trim();
    let kind_str = kind.unwrap_or("");
    let mut h = Sha256::new();
    h.update(source.as_tag().as_bytes());
    h.update(b"|");
    h.update(kind_str.as_bytes());
    h.update(b"|");
    h.update(first_line.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(16);
    for b in digest.iter().take(8) {
        use std::fmt::Write;
        write!(&mut out, "{:02x}", b).unwrap();
    }
    out
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::Serialize;

const WORKER_URL: &str = "https://ct-analytics.claude-terminal.workers.dev";
const INGEST_TOKEN: Option<&str> = option_env!("CT_INGEST_TOKEN");
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MESSAGE_MAX: usize = 2048;
const STACK_MAX: usize = 8192;

#[derive(Serialize)]
struct ErrorReportPayload<'a> {
    installation_id: &'a str,
    app_version: &'a str,
    os: &'a str,
    source: &'static str,
    kind: Option<&'a str>,
    message: &'a str,
    stack: Option<&'a str>,
    fingerprint: &'a str,
}

const DEDUP_WINDOW: Duration = Duration::from_secs(60);

pub struct Dedup {
    map: Mutex<HashMap<String, Instant>>,
}

impl Dedup {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    pub fn should_send(&self, fp: &str, now: Instant) -> bool {
        let mut map = match self.map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(), // poisoned mutex; recover by taking the data
        };
        // Opportunistic prune: drop expired entries.
        map.retain(|_, t| now.saturating_duration_since(*t) <= DEDUP_WINDOW);
        if let Some(last) = map.get(fp) {
            if now.saturating_duration_since(*last) <= DEDUP_WINDOW {
                return false;
            }
        }
        map.insert(fp.to_string(), now);
        true
    }
}

static REPORTER: OnceLock<ReporterState> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);

struct ReporterState {
    installation_id: String,
    app_version: String,
    dedup: Dedup,
}

pub fn init(installation_id: String, app_version: String) {
    let _ = REPORTER.set(ReporterState {
        installation_id,
        app_version,
        dedup: Dedup::new(),
    });
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub async fn report(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
) {
    if !is_enabled() {
        return;
    }
    let token = match INGEST_TOKEN {
        Some(t) if !t.is_empty() => t,
        _ => return,
    };
    let state = match REPORTER.get() {
        Some(s) => s,
        None => {
            eprintln!("[error_reporter] report() called before init(); skipping");
            return;
        }
    };

    let scrubbed_message = clamp(scrub(&message), MESSAGE_MAX);
    let scrubbed_stack = stack.map(|s| clamp(scrub(&s), STACK_MAX));
    let fp = fingerprint(source, kind.as_deref(), &scrubbed_message, scrubbed_stack.as_deref());

    if !state.dedup.should_send(&fp, Instant::now()) {
        return;
    }

    let payload = ErrorReportPayload {
        installation_id: &state.installation_id,
        app_version: &state.app_version,
        os: std::env::consts::OS,
        source: source.as_tag(),
        kind: kind.as_deref(),
        message: &scrubbed_message,
        stack: scrubbed_stack.as_deref(),
        fingerprint: &fp,
    };

    let client = match reqwest::Client::builder().timeout(SEND_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[error_reporter] http client build failed: {}", e);
            return;
        }
    };

    match client
        .post(format!("{}/error_report", WORKER_URL))
        .header("x-ct-token", token)
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                eprintln!("[error_reporter] worker responded {}", resp.status());
            }
        }
        Err(e) => {
            eprintln!("[error_reporter] send failed: {}", e);
        }
    }
}

pub fn report_blocking(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
) {
    let fut = report(source, kind, message, stack);

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        // We're on a Tokio thread; spawn and detach. In release with panic=abort
        // the process will likely die before completion, but in debug builds it
        // runs to completion since the panic hook returns and the runtime stays up.
        handle.spawn(fut);
        return;
    }

    // No runtime - build a one-shot single-threaded runtime and drive `fut` to
    // completion (or our 5s timeout). Best-effort.
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[error_reporter] failed to build temp runtime: {}", e);
            return;
        }
    };
    rt.block_on(async {
        // The 5s timeout inside report() bounds the wait.
        fut.await;
    });
}

fn clamp(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    // Find the largest valid char boundary <= max.
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = s;
    out.truncate(cut);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_replaces_windows_user_path() {
        let input = r"thread panicked at C:\Users\alice\code\app\src\main.rs:42:10";
        let out = scrub(input);
        assert_eq!(
            out,
            r"thread panicked at C:\Users\<user>\code\app\src\main.rs:42:10"
        );
    }

    #[test]
    fn scrub_replaces_file_uri_user_path() {
        let input = "at handler (file:///C:/Users/alice/app/index.js:1:1)";
        let out = scrub(input);
        assert_eq!(out, "at handler (file:///C:/Users/<user>/app/index.js:1:1)");
    }

    #[test]
    fn scrub_leaves_other_paths_alone() {
        let input = r"C:\ProgramData\foo and /usr/share/bar";
        assert_eq!(scrub(input), input);
    }

    #[test]
    fn scrub_replaces_multiple_occurrences() {
        let input = r"C:\Users\bob\one and C:\Users\bob\two";
        assert_eq!(scrub(input), r"C:\Users\<user>\one and C:\Users\<user>\two");
    }

    #[test]
    fn scrub_handles_username_followed_by_quote_or_space() {
        // Real case from the feat/error-reporter smoke test: error message ended
        // with the username followed by an apostrophe, not a backslash. The
        // earlier regex required a trailing \ and leaked the username.
        let input = r"Path '\\?\C:\Users\tal' is not under any active terminal";
        assert_eq!(
            scrub(input),
            r"Path '\\?\C:\Users\<user>' is not under any active terminal"
        );
        // Same shape with a trailing space.
        assert_eq!(
            scrub(r"saw C:\Users\eve and continued"),
            r"saw C:\Users\<user> and continued"
        );
    }

    #[test]
    fn scrub_handles_file_uri_username_followed_by_quote() {
        let input = r#"src=file:///C:/Users/eve" loaded"#;
        assert_eq!(scrub(input), r#"src=file:///C:/Users/<user>" loaded"#);
    }

    #[test]
    fn source_tags_are_stable() {
        assert_eq!(ErrorSource::RustPanic.as_tag(), "rust_panic");
        assert_eq!(ErrorSource::RustCommand.as_tag(), "rust_command");
        assert_eq!(ErrorSource::Frontend.as_tag(), "frontend");
    }

    #[test]
    fn fingerprint_is_stable_for_identical_inputs() {
        let a = fingerprint(ErrorSource::RustPanic, Some("PtyOpenError"), "boom", Some("at foo\nat bar"));
        let b = fingerprint(ErrorSource::RustPanic, Some("PtyOpenError"), "boom", Some("at foo\nat bar"));
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn fingerprint_changes_with_source() {
        let a = fingerprint(ErrorSource::RustPanic, None, "boom", None);
        let b = fingerprint(ErrorSource::Frontend, None, "boom", None);
        assert_ne!(a, b);
    }

    #[test]
    fn fingerprint_uses_first_stack_line_when_present() {
        let with_stack = fingerprint(ErrorSource::Frontend, None, "ignored", Some("at A\nat B"));
        let other_stack = fingerprint(ErrorSource::Frontend, None, "ignored", Some("at A\nat C"));
        // First line is the same ("at A") so fingerprint matches even with different deeper frames.
        assert_eq!(with_stack, other_stack);
    }

    #[test]
    fn fingerprint_falls_back_to_message_when_stack_missing() {
        let a = fingerprint(ErrorSource::Frontend, None, "msg one", None);
        let b = fingerprint(ErrorSource::Frontend, None, "msg two", None);
        assert_ne!(a, b);
    }

    use std::time::{Duration, Instant};

    #[test]
    fn should_send_first_time_returns_true() {
        let dedup = Dedup::new();
        let now = Instant::now();
        assert!(dedup.should_send("abc", now));
    }

    #[test]
    fn should_send_within_window_returns_false() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        let t1 = t0 + Duration::from_secs(30);
        assert!(!dedup.should_send("abc", t1));
    }

    #[test]
    fn should_send_after_window_returns_true() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        let t1 = t0 + Duration::from_secs(61);
        assert!(dedup.should_send("abc", t1));
    }

    #[test]
    fn should_send_distinct_fingerprints_independent() {
        let dedup = Dedup::new();
        let t0 = Instant::now();
        assert!(dedup.should_send("abc", t0));
        assert!(dedup.should_send("def", t0));
    }

    #[test]
    fn enabled_defaults_to_false_before_init() {
        // Note: state is process-global; this test relies on running before any init().
        // With cargo test default (single binary), other tests don't call init(),
        // so this stays valid.
        assert!(!is_enabled());
    }

    #[test]
    fn set_enabled_flips_the_flag() {
        // Force a known state.
        set_enabled(false);
        assert!(!is_enabled());
        set_enabled(true);
        assert!(is_enabled());
        set_enabled(false);
    }

    #[test]
    fn user_err_round_trips_via_strip() {
        let e = user_err("Working tree dirty");
        assert!(e.starts_with(USER_ERR_PREFIX));
        assert_eq!(strip_user_prefix(&e), "Working tree dirty");
    }

    #[test]
    fn strip_user_prefix_passthrough_for_plain_strings() {
        assert_eq!(strip_user_prefix("ordinary error"), "ordinary error");
    }

    #[test]
    fn is_user_error_detects_prefixed_string() {
        assert!(is_user_error(&user_err("x")));
        assert!(!is_user_error("plain"));
        assert!(!is_user_error(""));
    }

    #[test]
    fn should_report_skips_user_errors() {
        assert!(!should_report(&user_err("validation")));
    }

    #[test]
    fn should_report_keeps_internal_errors() {
        assert!(should_report("DB connection refused"));
    }
}
