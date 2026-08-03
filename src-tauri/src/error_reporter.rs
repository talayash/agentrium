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
    /// Empty until the database is open; filled in via `set_installation_id`.
    /// Mutex (not OnceLock) because early reports legitimately go out with an
    /// empty id and the real one arrives later.
    installation_id: Mutex<String>,
    app_version: String,
    dedup: Dedup,
}

/// Name of the consent marker file in the app data dir. Persisted here (not
/// in SQLite) so the flag is readable at process start even when the database
/// itself is the thing that's broken.
const ENABLED_FLAG_FILE: &str = "error_reporting_enabled";

fn read_enabled_flag(dir: &std::path::Path) -> Option<bool> {
    match std::fs::read_to_string(dir.join(ENABLED_FLAG_FILE)) {
        Ok(s) => match s.trim() {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        },
        Err(_) => None,
    }
}

fn write_enabled_flag(dir: &std::path::Path, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(ENABLED_FLAG_FILE), if enabled { "1" } else { "0" })
}

fn flag_dir() -> Option<std::path::PathBuf> {
    directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
        .map(|d| d.data_dir().to_path_buf())
}

/// Arm the reporter as the first statement of `main()`, before the panic hook
/// and before the database exists, so crashes during startup are reportable.
/// The enabled state comes from the persisted consent flag; when no flag has
/// ever been written (true first run) it defaults to enabled, matching the
/// frontend's `errorReportingEnabled: true` default the user would get seconds
/// later. The frontend still pushes its authoritative value on mount.
pub fn init_early() {
    let enabled = flag_dir().and_then(|d| read_enabled_flag(&d)).unwrap_or(true);
    ENABLED.store(enabled, Ordering::Relaxed);
    let _ = REPORTER.set(ReporterState {
        installation_id: Mutex::new(String::new()),
        // Kept in lockstep with tauri.conf.json by the release workflow.
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        dedup: Dedup::new(),
    });
}

/// Attach the real installation id once the database is open. Reports sent
/// before this carry an empty id - still useful, just not groupable per-install.
pub fn set_installation_id(id: String) {
    if let Some(state) = REPORTER.get() {
        let mut guard = state
            .installation_id
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *guard = id;
    }
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// `set_enabled` plus persistence of the consent flag, so the next process
/// start honors the user's choice before the frontend has mounted.
pub fn set_enabled_persist(enabled: bool) {
    set_enabled(enabled);
    if let Some(dir) = flag_dir() {
        if let Err(e) = write_enabled_flag(&dir, enabled) {
            eprintln!("[error_reporter] failed to persist enabled flag: {}", e);
        }
    }
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

    let installation_id = state
        .installation_id
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let payload = ErrorReportPayload {
        installation_id: &installation_id,
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

/// Bound on how long a synchronous flush may hold the caller. Slightly above
/// SEND_TIMEOUT so the HTTP timeout, not this one, is the normal limiter.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(7);

/// Deliver a report synchronously - the call does not return until the send
/// finished or FLUSH_TIMEOUT elapsed. Safe to call from anywhere, including
/// tokio worker threads and the panic hook: the future is driven on a fresh
/// thread with its own runtime, never nested into the caller's. This is what
/// lets panic reports survive `panic = "abort"` in release builds - the abort
/// only happens after the hook (and therefore the send) returns.
pub fn report_blocking(
    source: ErrorSource,
    kind: Option<String>,
    message: String,
    stack: Option<String>,
) {
    // Skip the thread machinery when report() would drop the event anyway.
    if !is_enabled() || REPORTER.get().is_none() {
        return;
    }
    let fut = report(source, kind, message, stack);
    if !flush_report_thread(fut, FLUSH_TIMEOUT) {
        eprintln!("[error_reporter] synchronous flush did not complete in time");
    }
}

/// Drive `fut` to completion on a dedicated thread with a one-shot runtime,
/// waiting at most `timeout`. Returns whether the future finished. A timed-out
/// future keeps running detached; that's fine for our best-effort sends.
fn flush_report_thread<F>(fut: F, timeout: Duration) -> bool
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let spawned = std::thread::Builder::new()
        .name("ct-error-flush".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[error_reporter] failed to build temp runtime: {}", e);
                    return; // done_tx drops; caller sees Disconnected -> false
                }
            };
            rt.block_on(fut);
            let _ = done_tx.send(());
        });
    match spawned {
        Ok(_) => done_rx.recv_timeout(timeout).is_ok(),
        Err(e) => {
            eprintln!("[error_reporter] failed to spawn flush thread: {}", e);
            false
        }
    }
}

/// Fire-and-forget report for background paths that sit outside `wrap_cmd`
/// (PTY reader threads, detached lifecycle tasks, the OTLP receiver). Never
/// blocks the caller: spawns onto the current runtime when there is one,
/// otherwise onto a short-lived thread. Use `report_blocking` instead when the
/// process is about to exit and the send must be given a chance to finish.
pub fn report_bg(kind: &'static str, message: String) {
    if !is_enabled() || REPORTER.get().is_none() {
        return;
    }
    let fut = report(ErrorSource::RustCommand, Some(kind.to_string()), message, None);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(fut);
    } else {
        let _ = std::thread::Builder::new()
            .name("ct-error-bg".into())
            .spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    rt.block_on(fut);
                }
            });
    }
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

    /// Unique per-test temp dir so parallel tests can't collide.
    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ct-error-reporter-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn read_enabled_flag_returns_none_when_missing() {
        let dir = test_dir("missing");
        assert_eq!(read_enabled_flag(&dir), None);
    }

    #[test]
    fn enabled_flag_round_trips_true_and_false() {
        let dir = test_dir("roundtrip");
        write_enabled_flag(&dir, true).unwrap();
        assert_eq!(read_enabled_flag(&dir), Some(true));
        write_enabled_flag(&dir, false).unwrap();
        assert_eq!(read_enabled_flag(&dir), Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_enabled_flag_returns_none_on_garbage() {
        let dir = test_dir("garbage");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(ENABLED_FLAG_FILE), "banana").unwrap();
        assert_eq!(read_enabled_flag(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flush_report_thread_completes_inside_tokio_runtime() {
        // Regression guard for the panic-hook path: report_blocking must be
        // able to drive a future to completion synchronously even when the
        // panicking thread is a tokio worker (where a nested block_on would
        // panic with "Cannot start a runtime from within a runtime").
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            assert!(flush_report_thread(async {}, Duration::from_secs(5)));
        });
    }

    #[test]
    fn flush_report_thread_completes_outside_runtime() {
        assert!(flush_report_thread(async {}, Duration::from_secs(5)));
    }

    #[test]
    fn flush_report_thread_times_out_on_hung_future() {
        // A future that never resolves must not wedge the caller forever.
        assert!(!flush_report_thread(
            std::future::pending::<()>(),
            Duration::from_millis(100)
        ));
    }
}
