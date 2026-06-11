# Verified Review Cockpit — Phase 1: LSP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawn and manage real language servers (typescript-language-server, pyright, rust-analyzer) from the Rust backend and surface their diagnostics as squiggles in the existing Monaco file editor, with a Language Servers settings page for install/status/restart.

**Architecture:** Minimal LSP client: Rust owns server processes (stdio JSON-RPC with Content-Length framing, Helix-style reader/writer/stderr tasks), exposes thin Tauri commands (`lsp_did_open/change/close`, generic `lsp_request`) and pushes `lsp-diagnostics` / `lsp-status` events. The frontend keeps stock monaco-editor 0.52 + `@monaco-editor/react` untouched — it syncs open file tabs to the backend and converts published diagnostics to `monaco.editor.setModelMarkers`. NO monaco-languageclient.

**Tech Stack:** Rust (tokio, serde_json, reqwest, zip, flate2), Tauri 2 IPC + events, React 18 + Zustand, monaco-editor 0.52, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-11-verified-review-cockpit-design.md` (this plan = Phase 1 only).

**Spec deviation (intentional):** the spec's Phase 1 mentions squiggles in "the existing `InlineDiffView` and editor", but `InlineDiffView` is a custom HTML diff renderer, not Monaco — squiggles are impossible there. Phase 1 surfaces diagnostics in the Monaco editor (`FileEditorView`, edit mode); diff-surface intelligence arrives with the cockpit's Monaco DiffEditor in Phase 2.

---

## File structure

**Create (Rust):**
- `src-tauri/src/lsp/mod.rs` — `LspManager`: server registry keyed by `(root, language)`, initialize handshake, doc sync, restart caps, event emission
- `src-tauri/src/lsp/transport.rs` — Content-Length frame decoder/encoder (pure, unit-tested)
- `src-tauri/src/lsp/client.rs` — one child process: spawn (Windows `.cmd` handling, `CREATE_NO_WINDOW`), reader/writer/stderr tasks, request-id correlation, server→client request auto-reply
- `src-tauri/src/lsp/acquire.rs` — server specs, PATH probing, install (npm prefix / GitHub release download), rust project-root discovery

**Create (frontend):**
- `src/lib/lsp/paths.ts` + `paths.test.ts` — `pathToFileUri`, `pathKey` (pure)
- `src/lib/lsp/languages.ts` + `languages.test.ts` — file path → `{server, languageId}` (pure)
- `src/lib/lsp/markers.ts` + `markers.test.ts` — LSP Diagnostic[] → Monaco marker data (pure)
- `src/lib/lsp/lspClient.ts` — singleton: appStore subscription → doc sync, diagnostics listener → markers
- `src/components/settings/categories/LanguageServersPage.tsx`

**Modify:**
- `src-tauri/Cargo.toml` — add `zip`, `flate2`
- `src-tauri/src/main.rs` — `mod lsp;`, AppState field, command registration
- `src-tauri/src/commands.rs` — `shell_command` → `pub(crate)`; new `lsp_*` commands
- `src/store/appStore.ts` — `lspEnabled` persisted setting
- `src/store/appStore.test.ts` — persisted-keys allow-list
- `src/App.tsx` — `initLsp()` once on mount
- `src/components/settings/index.ts` — category entry
- `src/components/settings/SettingsWindow.tsx` — pages map entry

**Languages covered (per spec):** `typescript` (also serves JS), `python`, `rust`. PATH detection first; auto-install fallback (npm for tsserver/pyright into app-data prefix, GitHub release binary for rust-analyzer).

---

### Task 1: Frame codec (`lsp/transport.rs`)

**Files:**
- Create: `src-tauri/src/lsp/transport.rs`
- Create: `src-tauri/src/lsp/mod.rs` (module declarations only for now)
- Modify: `src-tauri/src/main.rs` (add `mod lsp;`)

- [ ] **Step 1: Scaffold the module so tests can compile**

`src-tauri/src/lsp/mod.rs`:
```rust
pub mod transport;
```

In `src-tauri/src/main.rs`, after `mod otel_receiver;` (line 13) add:
```rust
mod lsp;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/lsp/transport.rs` with ONLY the test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn decodes_single_complete_frame() {
        let mut d = FrameDecoder::new();
        let out = d.feed(&frame(r#"{"a":1}"#));
        assert_eq!(out, vec![br#"{"a":1}"#.to_vec()]);
    }

    #[test]
    fn decodes_frame_split_across_feeds() {
        let mut d = FrameDecoder::new();
        let bytes = frame(r#"{"a":1}"#);
        let (first, second) = bytes.split_at(10);
        assert!(d.feed(first).is_empty());
        assert_eq!(d.feed(second), vec![br#"{"a":1}"#.to_vec()]);
    }

    #[test]
    fn decodes_two_frames_in_one_feed() {
        let mut d = FrameDecoder::new();
        let mut bytes = frame(r#"{"a":1}"#);
        bytes.extend(frame(r#"{"b":2}"#));
        let out = d.feed(&bytes);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], br#"{"b":2}"#.to_vec());
    }

    #[test]
    fn handles_extra_headers_case_insensitively() {
        let body = r#"{"a":1}"#;
        let raw = format!(
            "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}",
            body.len(), body
        );
        let mut d = FrameDecoder::new();
        assert_eq!(d.feed(raw.as_bytes()), vec![body.as_bytes().to_vec()]);
    }

    #[test]
    fn drops_malformed_header_without_looping() {
        let mut d = FrameDecoder::new();
        let mut bytes = b"Garbage: x\r\n\r\n".to_vec();
        bytes.extend(frame(r#"{"ok":true}"#));
        assert_eq!(d.feed(&bytes), vec![br#"{"ok":true}"#.to_vec()]);
    }

    #[test]
    fn encode_frame_roundtrips() {
        let body = br#"{"jsonrpc":"2.0"}"#;
        let mut d = FrameDecoder::new();
        assert_eq!(d.feed(&encode_frame(body)), vec![body.to_vec()]);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test lsp::transport`
Expected: compile error — `FrameDecoder` not found.

- [ ] **Step 4: Implement the codec**

Prepend to `src-tauri/src/lsp/transport.rs` (above the test module):
```rust
//! LSP base-protocol framing: `Content-Length: N\r\n...\r\n\r\n<N bytes>`.

/// Incremental decoder. Feed raw stdout bytes, get back complete message
/// bodies. Holds partial data between feeds.
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let Some(header_end) = find_subslice(&self.buf, b"\r\n\r\n") else {
                break;
            };
            let header = String::from_utf8_lossy(&self.buf[..header_end]).to_string();
            let len = header.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            });
            let Some(len) = len else {
                // Malformed header block: drop it so we can't loop forever.
                self.buf.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break; // body not fully arrived yet
            }
            out.push(self.buf[body_start..body_start + len].to_vec());
            self.buf.drain(..body_start + len);
        }
        out
    }
}

pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test lsp::transport`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lsp/ src-tauri/src/main.rs
git commit -m "feat(lsp): Content-Length frame codec for LSP stdio transport"
```

---

### Task 2: JSON-RPC client over a child process (`lsp/client.rs`)

**Files:**
- Create: `src-tauri/src/lsp/client.rs`
- Modify: `src-tauri/src/lsp/mod.rs`

- [ ] **Step 1: Write failing tests for the pure parts**

Create `src-tauri/src/lsp/client.rs` with the test module:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_configuration_gets_null_per_item() {
        let reply = server_request_reply(
            &json!(7),
            "workspace/configuration",
            &json!({ "items": [{"section": "python"}, {"section": "pyright"}] }),
        );
        assert_eq!(reply["id"], json!(7));
        assert_eq!(reply["result"], json!([null, null]));
    }

    #[test]
    fn unknown_server_request_gets_null_result() {
        let reply = server_request_reply(&json!("x"), "client/registerCapability", &json!({}));
        assert_eq!(reply["result"], serde_json::Value::Null);
        assert_eq!(reply["jsonrpc"], "2.0");
    }

    #[test]
    fn classify_routes_messages() {
        assert!(matches!(
            classify(&json!({"jsonrpc":"2.0","id":1,"result":{}})),
            Incoming::Response { .. }
        ));
        assert!(matches!(
            classify(&json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}})),
            Incoming::Response { .. }
        ));
        assert!(matches!(
            classify(&json!({"jsonrpc":"2.0","id":2,"method":"workspace/configuration","params":{}})),
            Incoming::ServerRequest { .. }
        ));
        assert!(matches!(
            classify(&json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}})),
            Incoming::Notification { .. }
        ));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test lsp::client` — Expected: compile error (after adding `pub mod client;` to `src-tauri/src/lsp/mod.rs`).

- [ ] **Step 3: Implement the client**

Full content above the tests in `src-tauri/src/lsp/client.rs`:
```rust
//! One running language-server child process: spawn, framed stdio pump,
//! request-id correlation, stderr ring buffer. Protocol-agnostic beyond
//! JSON-RPC — the manager (mod.rs) owns LSP semantics.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use super::transport::{encode_frame, FrameDecoder};

pub const REQUEST_TIMEOUT_SECS: u64 = 120; // Zed's number
const STDERR_RING_CAP: usize = 200;

/// Server-initiated notifications/requests forwarded to the manager:
/// (method, params).
pub type NotificationSink = mpsc::UnboundedSender<(String, Value)>;

pub enum Incoming<'a> {
    Response { id: i64, result: Result<&'a Value, String> },
    ServerRequest { id: &'a Value, method: &'a str, params: &'a Value },
    Notification { method: &'a str, params: &'a Value },
    Other,
}

pub fn classify(msg: &Value) -> Incoming<'_> {
    static NULL: Value = Value::Null;
    let params = msg.get("params").unwrap_or(&NULL);
    match (msg.get("id"), msg.get("method").and_then(|m| m.as_str())) {
        (Some(id), Some(method)) => Incoming::ServerRequest { id, method, params },
        (Some(id), None) => {
            let Some(id) = id.as_i64() else { return Incoming::Other };
            if let Some(err) = msg.get("error") {
                Incoming::Response { id, result: Err(err.to_string()) }
            } else {
                Incoming::Response { id, result: Ok(msg.get("result").unwrap_or(&NULL)) }
            }
        }
        (None, Some(method)) => Incoming::Notification { method, params },
        (None, None) => Incoming::Other,
    }
}

/// Auto-reply for server→client requests we don't implement. Replying (rather
/// than ignoring) prevents servers from stalling on an unanswered request.
pub fn server_request_reply(id: &Value, method: &str, params: &Value) -> Value {
    let result = match method {
        "workspace/configuration" => {
            let n = params
                .get("items")
                .and_then(|i| i.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            Value::Array(vec![Value::Null; n])
        }
        _ => Value::Null,
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

pub struct LspClient {
    child: Child,
    next_id: AtomicI64,
    pending: Pending,
    writer_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub stderr_ring: Arc<Mutex<VecDeque<String>>>,
}

impl LspClient {
    /// Spawn `program args` in `cwd` and start the three pump tasks
    /// (stdout reader, stdin writer, stderr collector). Server-initiated
    /// notifications go to `sink`.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: &str,
        sink: NotificationSink,
    ) -> Result<Self, String> {
        let mut cmd = if cfg!(target_os = "windows")
            && (program.to_lowercase().ends_with(".cmd") || program.to_lowercase().ends_with(".bat"))
        {
            // .cmd shims (npm bins) need cmd /C on Windows.
            let mut c = Command::new("cmd");
            c.arg("/C").arg(program);
            c
        } else {
            Command::new(program)
        };
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {}", program, e))?;

        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let stderr_ring = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_RING_CAP)));

        // Writer task: serializes all outgoing frames onto stdin.
        tokio::spawn(async move {
            while let Some(bytes) = writer_rx.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });

        // Reader task: frames → classify → resolve pending / auto-reply / sink.
        let pending_r = pending.clone();
        let writer_r = writer_tx.clone();
        tokio::spawn(async move {
            let mut decoder = FrameDecoder::new();
            let mut chunk = [0u8; 8192];
            loop {
                let n = match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break, // EOF / process gone
                    Ok(n) => n,
                };
                for body in decoder.feed(&chunk[..n]) {
                    let Ok(msg) = serde_json::from_slice::<Value>(&body) else { continue };
                    match classify(&msg) {
                        Incoming::Response { id, result } => {
                            if let Some(tx) = pending_r.lock().await.remove(&id) {
                                let _ = tx.send(result.map(|v| v.clone()));
                            }
                        }
                        Incoming::ServerRequest { id, method, params } => {
                            let reply = server_request_reply(id, method, params);
                            let _ = writer_r.send(encode_frame(reply.to_string().as_bytes()));
                        }
                        Incoming::Notification { method, params } => {
                            let _ = sink.send((method.to_string(), params.clone()));
                        }
                        Incoming::Other => {}
                    }
                }
            }
            // Process ended: fail all in-flight requests.
            for (_, tx) in pending_r.lock().await.drain() {
                let _ = tx.send(Err("language server exited".into()));
            }
        });

        // Stderr task: ring buffer for the settings-page log viewer.
        let ring = stderr_ring.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut r = ring.lock().await;
                if r.len() >= STDERR_RING_CAP {
                    r.pop_front();
                }
                r.push_back(line);
            }
        });

        Ok(Self {
            child,
            next_id: AtomicI64::new(1),
            pending,
            writer_tx,
            stderr_ring,
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.writer_tx
            .send(encode_frame(msg.to_string().as_bytes()))
            .map_err(|_| "language server writer closed".to_string())?;
        match tokio::time::timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("language server dropped the request".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("{} timed out after {}s", method, REQUEST_TIMEOUT_SECS))
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.writer_tx
            .send(encode_frame(msg.to_string().as_bytes()))
            .map_err(|_| "language server writer closed".to_string())
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}
```

Note: `creation_flags` is a native method on `tokio::process::Command` on Windows — no trait import needed (unlike `std::process::Command`, which requires `std::os::windows::process::CommandExt`).

Update `src-tauri/src/lsp/mod.rs`:
```rust
pub mod client;
pub mod transport;
```

- [ ] **Step 4: Run tests + full compile check**

Run: `cargo test lsp::` — Expected: 9 passed (6 transport + 3 client).
Run: `cargo check` — Expected: clean (warnings about unused items are OK at this stage).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp/
git commit -m "feat(lsp): JSON-RPC client over child process with stderr ring buffer"
```

---

### Task 3: Server acquisition (`lsp/acquire.rs`)

**Files:**
- Create: `src-tauri/src/lsp/acquire.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lsp/mod.rs`, `src-tauri/src/commands.rs:731` (`shell_command` visibility)

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml` `[dependencies]`, after `tiny_http = "0.12"` add:
```toml
zip = { version = "2", default-features = false, features = ["deflate"] }
flate2 = "1"
```

- [ ] **Step 2: Make `shell_command` reusable**

In `src-tauri/src/commands.rs:731` change:
```rust
fn shell_command(program: &str, args: &[&str]) -> std::process::Command {
```
to:
```rust
pub(crate) fn shell_command(program: &str, args: &[&str]) -> std::process::Command {
```

- [ ] **Step 3: Write failing tests**

Create `src-tauri/src/lsp/acquire.rs` starting with tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_languages_have_specs() {
        for lang in ["typescript", "python", "rust"] {
            assert!(server_spec(lang).is_some(), "missing spec for {lang}");
        }
        assert!(server_spec("cobol").is_none());
    }

    #[test]
    fn npm_bin_path_is_under_data_dir() {
        let spec = server_spec("typescript").unwrap();
        let p = installed_bin_path(&spec);
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.contains("lsp-servers"), "got {s}");
        if cfg!(target_os = "windows") {
            assert!(s.ends_with("typescript-language-server.cmd"), "got {s}");
        } else {
            assert!(s.ends_with("typescript-language-server"), "got {s}");
        }
    }

    #[test]
    fn rust_project_root_walks_up_to_cargo_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let crate_dir = tmp.path().join("backend");
        let nested = crate_dir.join("src").join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(crate_dir.join("Cargo.toml"), "[package]").unwrap();
        let file = nested.join("main.rs");
        std::fs::write(&file, "fn main(){}").unwrap();

        let root = rust_project_root(file.to_str().unwrap(), tmp.path().to_str().unwrap());
        assert_eq!(root, crate_dir.to_string_lossy().to_string());
    }

    #[test]
    fn rust_project_root_falls_back_when_no_cargo_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("loose.rs");
        std::fs::write(&file, "").unwrap();
        let root = rust_project_root(file.to_str().unwrap(), tmp.path().to_str().unwrap());
        assert_eq!(root, tmp.path().to_string_lossy().to_string());
    }
}
```

Run: `cargo test lsp::acquire` (after adding `pub mod acquire;` to `mod.rs`) — Expected: compile error.

- [ ] **Step 4: Implement acquisition**

Content above the tests in `src-tauri/src/lsp/acquire.rs`:
```rust
//! Language-server discovery and installation.
//! Order: binary on PATH → app-data install dir → Missing (settings page
//! offers Install). Claude Code's own LSP plugins use PATH-only; we go one
//! step further and self-install like Zed/mason.

use std::path::PathBuf;

pub struct ServerSpec {
    /// Our language key: "typescript" | "python" | "rust".
    pub language: &'static str,
    /// Binary name probed on PATH and produced by install.
    pub bin: &'static str,
    pub args: &'static [&'static str],
    /// npm packages to `npm install --prefix <data>/lsp-servers`, empty for
    /// GitHub-release downloads (rust-analyzer).
    pub npm_packages: &'static [&'static str],
}

pub fn server_spec(language: &str) -> Option<ServerSpec> {
    match language {
        "typescript" => Some(ServerSpec {
            language: "typescript",
            bin: "typescript-language-server",
            args: &["--stdio"],
            npm_packages: &["typescript-language-server", "typescript"],
        }),
        "python" => Some(ServerSpec {
            language: "python",
            bin: "pyright-langserver",
            args: &["--stdio"],
            npm_packages: &["pyright"],
        }),
        "rust" => Some(ServerSpec {
            language: "rust",
            bin: "rust-analyzer",
            args: &[],
            npm_packages: &[],
        }),
        _ => None,
    }
}

pub fn lsp_data_dir() -> PathBuf {
    directories::ProjectDirs::from("com", "claudeterminal", "ClaudeTerminal")
        .map(|d| d.data_dir().join("lsp-servers"))
        .unwrap_or_else(|| PathBuf::from("lsp-servers"))
}

pub fn installed_bin_path(spec: &ServerSpec) -> PathBuf {
    let dir = lsp_data_dir();
    if spec.npm_packages.is_empty() {
        // GitHub-release binary layout: lsp-servers/bin/<bin>[.exe]
        let name = if cfg!(target_os = "windows") {
            format!("{}.exe", spec.bin)
        } else {
            spec.bin.to_string()
        };
        dir.join("bin").join(name)
    } else {
        let name = if cfg!(target_os = "windows") {
            format!("{}.cmd", spec.bin)
        } else {
            spec.bin.to_string()
        };
        dir.join("node_modules").join(".bin").join(name)
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// `program` is what we pass to LspClient::spawn.
    Path { program: String, version: Option<String> },
    Installed { program: String },
    Missing,
}

/// PATH probe + install-dir check. Blocking (runs `--version`); call from
/// spawn_blocking or an async command body via tokio::task::spawn_blocking.
pub fn resolve(language: &str) -> Result<(ServerSpec, Resolution), String> {
    let spec = server_spec(language).ok_or_else(|| format!("unknown language {language}"))?;
    // 1) PATH
    let probe = crate::commands::shell_command(spec.bin, &["--version"]).output();
    if let Ok(out) = probe {
        if out.status.success() {
            let version = String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string());
            let resolution = Resolution::Path { program: spec.bin.to_string(), version };
            return Ok((spec, resolution));
        }
    }
    // 2) install dir
    let installed = installed_bin_path(&spec);
    if installed.exists() {
        let resolution = Resolution::Installed { program: installed.to_string_lossy().to_string() };
        return Ok((spec, resolution));
    }
    Ok((spec, Resolution::Missing))
}

/// Install the server for `language` into the app data dir.
pub async fn install(language: &str) -> Result<(), String> {
    let spec = server_spec(language).ok_or_else(|| format!("unknown language {language}"))?;
    let dir = lsp_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if spec.npm_packages.is_empty() {
        install_rust_analyzer(&dir).await
    } else {
        let mut args: Vec<String> = vec!["install".into(), "--prefix".into(), dir.to_string_lossy().to_string()];
        args.extend(spec.npm_packages.iter().map(|s| s.to_string()));
        let out = tokio::task::spawn_blocking(move || {
            let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            crate::commands::shell_command("npm", &arg_refs).output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).to_string())
        }
    }
}

fn ra_asset() -> Result<(&'static str, bool), String> {
    // (asset name, is_zip)
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-pc-windows-msvc.zip", true))
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        Ok(("rust-analyzer-aarch64-pc-windows-msvc.zip", true))
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(("rust-analyzer-aarch64-apple-darwin.gz", false))
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-apple-darwin.gz", false))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok(("rust-analyzer-x86_64-unknown-linux-gnu.gz", false))
    } else {
        Err("no rust-analyzer build for this platform — install it on PATH instead".into())
    }
}

async fn install_rust_analyzer(dir: &std::path::Path) -> Result<(), String> {
    let (asset, is_zip) = ra_asset()?;
    let url = format!(
        "https://github.com/rust-lang/rust-analyzer/releases/latest/download/{asset}"
    );
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let bin_dir = dir.join("bin");
    let target = installed_bin_path(&server_spec("rust").unwrap());
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        if is_zip {
            let reader = std::io::Cursor::new(bytes.as_ref().to_vec());
            let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
            let mut entry = zip.by_index(0).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        } else {
            let mut gz = flate2::read::GzDecoder::new(bytes.as_ref());
            std::io::copy(&mut gz, &mut out).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// rust-analyzer needs the directory containing Cargo.toml, not the git root
/// (this repo's Cargo.toml lives in src-tauri/, not the repo root). Walk up
/// from the file toward `fallback`; return the first dir with a Cargo.toml,
/// else `fallback`.
pub fn rust_project_root(file_path: &str, fallback: &str) -> String {
    let mut dir = std::path::Path::new(file_path).parent();
    let stop = std::path::Path::new(fallback);
    while let Some(d) = dir {
        if d.join("Cargo.toml").exists() {
            return d.to_string_lossy().to_string();
        }
        if d == stop {
            break;
        }
        dir = d.parent();
    }
    fallback.to_string()
}
```

Add to `src-tauri/src/lsp/mod.rs`:
```rust
pub mod acquire;
```

- [ ] **Step 5: Run tests**

Run: `cargo test lsp::` — Expected: 13 passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lsp/ src-tauri/src/commands.rs
git commit -m "feat(lsp): server acquisition - PATH probe, npm prefix install, rust-analyzer download"
```

---

### Task 4: LspManager — lifecycle, doc sync, events (`lsp/mod.rs`)

**Files:**
- Modify: `src-tauri/src/lsp/mod.rs`

- [ ] **Step 1: Implement the manager**

Replace `src-tauri/src/lsp/mod.rs` with:
```rust
//! LSP subsystem: spawns language servers per (workspace root, language),
//! runs the initialize handshake, syncs documents, and forwards
//! publishDiagnostics to the frontend as `lsp-diagnostics` events.
//!
//! Position encoding: Monaco and LSP both default to UTF-16 — positions
//! pass through unconverted. Do not change one side without the other.

pub mod acquire;
pub mod client;
pub mod transport;

use std::collections::HashMap;
use std::sync::Arc;
use serde_json::{json, Value};
use tauri::Emitter;
use client::LspClient;

const MAX_RESTARTS: u8 = 3;

fn path_to_uri(p: &str) -> String {
    let mut n = p.replace('\\', "/");
    if !n.starts_with('/') {
        n = format!("/{n}");
    }
    // Minimal encoding: spaces and '#' are the practical offenders in paths.
    format!("file://{}", n.replace(' ', "%20").replace('#', "%23"))
}

#[derive(Clone, serde::Serialize)]
pub struct StatusEvent {
    pub language: String,
    pub root: String,
    /// "starting" | "running" | "error" | "stopped"
    pub state: String,
    pub detail: Option<String>,
}

struct ServerEntry {
    client: Arc<tokio::sync::Mutex<LspClient>>,
    restarts: u8,
}

pub struct LspManager {
    app: tauri::AppHandle,
    servers: HashMap<(String, String), ServerEntry>, // (root, language)
}

impl LspManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app, servers: HashMap::new() }
    }

    fn emit_status(&self, language: &str, root: &str, state: &str, detail: Option<String>) {
        let _ = self.app.emit("lsp-status", StatusEvent {
            language: language.to_string(),
            root: root.to_string(),
            state: state.to_string(),
            detail,
        });
    }

    /// Get-or-spawn the server for (root, language). Runs the initialize
    /// handshake on first spawn. Respects the restart cap.
    pub async fn ensure(
        &mut self,
        root: &str,
        language: &str,
    ) -> Result<Arc<tokio::sync::Mutex<LspClient>>, String> {
        let key = (root.to_string(), language.to_string());
        let mut prior_restarts = 0u8;
        if let Some(entry) = self.servers.get(&key) {
            let alive = entry.client.lock().await.is_alive();
            if alive {
                return Ok(entry.client.clone());
            }
            prior_restarts = entry.restarts + 1;
            if prior_restarts > MAX_RESTARTS {
                self.emit_status(language, root, "error", Some("crashed too many times".into()));
                return Err(format!("{language} server crashed {MAX_RESTARTS}+ times; restart it from Settings → Editor → Language Servers"));
            }
            self.servers.remove(&key);
        }

        self.emit_status(language, root, "starting", None);
        let lang_owned = language.to_string();
        let (spec, resolution) = tokio::task::spawn_blocking(move || acquire::resolve(&lang_owned))
            .await
            .map_err(|e| e.to_string())??;
        let program = match resolution {
            acquire::Resolution::Path { program, .. } => program,
            acquire::Resolution::Installed { program } => program,
            acquire::Resolution::Missing => {
                self.emit_status(language, root, "error", Some("not installed".into()));
                return Err(format!("{language} language server is not installed (Settings → Editor → Language Servers)"));
            }
        };

        let (sink_tx, mut sink_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
        let args: Vec<String> = spec.args.iter().map(|s| s.to_string()).collect();
        let client = LspClient::spawn(&program, &args, root, sink_tx)?;
        let client = Arc::new(tokio::sync::Mutex::new(client));

        // Route server notifications → frontend events.
        let app = self.app.clone();
        let (ev_root, ev_lang) = (root.to_string(), language.to_string());
        tokio::spawn(async move {
            while let Some((method, params)) = sink_rx.recv().await {
                if method == "textDocument/publishDiagnostics" {
                    let _ = app.emit("lsp-diagnostics", json!({
                        "language": ev_lang,
                        "root": ev_root,
                        "uri": params.get("uri").cloned().unwrap_or(Value::Null),
                        "diagnostics": params.get("diagnostics").cloned().unwrap_or(json!([])),
                    }));
                }
            }
        });

        // Initialize handshake (client lock held only for the call duration).
        let init_result = {
            let c = client.lock().await;
            c.request("initialize", json!({
                "processId": std::process::id(),
                "rootUri": path_to_uri(root),
                "workspaceFolders": [{ "uri": path_to_uri(root), "name": "workspace" }],
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": { "relatedInformation": true },
                        "synchronization": {}
                    }
                }
            })).await
        };
        if let Err(e) = init_result {
            self.emit_status(language, root, "error", Some(e.clone()));
            return Err(e);
        }
        client.lock().await.notify("initialized", json!({}))?;

        self.emit_status(language, root, "running", None);
        self.servers.insert(key, ServerEntry { client: client.clone(), restarts: prior_restarts });
        Ok(client)
    }

    pub async fn did_open(
        &mut self,
        root: &str,
        language: &str,
        path: &str,
        language_id: &str,
        text: &str,
        version: i64,
    ) -> Result<(), String> {
        let client = self.ensure(root, language).await?;
        let c = client.lock().await;
        c.notify("textDocument/didOpen", json!({
            "textDocument": {
                "uri": path_to_uri(path),
                "languageId": language_id,
                "version": version,
                "text": text
            }
        }))
    }

    /// Full-document sync: a change event without a range replaces the whole
    /// document — universally supported by tsserver/pyright/rust-analyzer.
    pub async fn did_change(
        &mut self,
        root: &str,
        language: &str,
        path: &str,
        text: &str,
        version: i64,
    ) -> Result<(), String> {
        let client = self.ensure(root, language).await?;
        let c = client.lock().await;
        c.notify("textDocument/didChange", json!({
            "textDocument": { "uri": path_to_uri(path), "version": version },
            "contentChanges": [{ "text": text }]
        }))
    }

    pub async fn did_close(&mut self, root: &str, language: &str, path: &str) -> Result<(), String> {
        let key = (root.to_string(), language.to_string());
        let Some(entry) = self.servers.get(&key) else { return Ok(()) };
        let c = entry.client.lock().await;
        c.notify("textDocument/didClose", json!({
            "textDocument": { "uri": path_to_uri(path) }
        }))
    }

    /// Generic passthrough for future features (hover, definition, ...).
    pub async fn request(
        &mut self,
        root: &str,
        language: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let client = self.ensure(root, language).await?;
        let c = client.lock().await;
        c.request(method, params).await
    }

    /// Kill every server for `language`; they respawn (with reset restart
    /// counter) on the next did_open.
    pub async fn restart_language(&mut self, language: &str) {
        let keys: Vec<_> = self
            .servers
            .keys()
            .filter(|(_, l)| l == language)
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = self.servers.remove(&key) {
                entry.client.lock().await.kill().await;
                self.emit_status(&key.1, &key.0, "stopped", None);
            }
        }
    }

    pub async fn running_roots(&mut self, language: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ((root, lang), entry) in self.servers.iter() {
            if lang == language && entry.client.lock().await.is_alive() {
                out.push(root.clone());
            }
        }
        out
    }

    pub async fn stderr_log(&self, language: &str) -> Vec<String> {
        for ((_, lang), entry) in self.servers.iter() {
            if lang == language {
                let c = entry.client.lock().await;
                let ring = c.stderr_ring.lock().await;
                return ring.iter().cloned().collect();
            }
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_to_uri_windows_drive() {
        assert_eq!(
            path_to_uri(r"C:\Users\tal\my repo\a.ts"),
            "file:///C:/Users/tal/my%20repo/a.ts"
        );
    }

    #[test]
    fn path_to_uri_unix() {
        assert_eq!(path_to_uri("/home/tal/a.rs"), "file:///home/tal/a.rs");
    }
}
```

- [ ] **Step 2: Run tests + compile**

Run: `cargo test lsp::` — Expected: 15 passed.
Run: `cargo check` — Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): LspManager - lifecycle, initialize handshake, doc sync, diagnostics events"
```

---

### Task 5: Tauri commands + AppState wiring

**Files:**
- Modify: `src-tauri/src/main.rs` (AppState struct ~line 19, `.setup` ~line 57, `generate_handler!` ~line 85)
- Modify: `src-tauri/src/commands.rs` (append new commands at end of file)

- [ ] **Step 1: Add the manager to AppState**

In `src-tauri/src/main.rs`, add a field to `AppState`:
```rust
pub struct AppState {
    pub terminals: Arc<Mutex<terminal::TerminalManager>>,
    pub db: Arc<Mutex<database::Database>>,
    /// Localhost port of the embedded OTLP metrics receiver (0 if disabled/failed).
    pub otel_port: u16,
    /// Shared aggregator so close_terminal can forget a terminal's metrics.
    pub otel_agg: std::sync::Arc<std::sync::Mutex<crate::otel_receiver::MetricsAggregator>>,
    pub lsp: Arc<Mutex<lsp::LspManager>>,
}
```

In `.setup`, before `app.manage(AppState {`:
```rust
let lsp_manager = lsp::LspManager::new(app.handle().clone());
```
and inside the `app.manage(AppState { ... })` literal add:
```rust
lsp: Arc::new(Mutex::new(lsp_manager)),
```

- [ ] **Step 2: Add the commands**

Append to `src-tauri/src/commands.rs`:
```rust
// ─── LSP ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LspLanguageStatus {
    pub language: String,
    pub resolution: crate::lsp::acquire::Resolution,
    pub running_roots: Vec<String>,
}

#[command]
pub async fn lsp_did_open(
    state: tauri::State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
    language_id: String,
    text: String,
    version: i64,
) -> Result<(), String> {
    wrap_cmd("lsp_did_open", async move {
        // rust-analyzer wants the crate root (Cargo.toml dir), not the git root.
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_open(&root, &language, &path, &language_id, &text, version).await
    })
    .await
}

#[command]
pub async fn lsp_did_change(
    state: tauri::State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
    text: String,
    version: i64,
) -> Result<(), String> {
    wrap_cmd("lsp_did_change", async move {
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_change(&root, &language, &path, &text, version).await
    })
    .await
}

#[command]
pub async fn lsp_did_close(
    state: tauri::State<'_, crate::AppState>,
    root: String,
    language: String,
    path: String,
) -> Result<(), String> {
    wrap_cmd("lsp_did_close", async move {
        let root = if language == "rust" {
            crate::lsp::acquire::rust_project_root(&path, &root)
        } else {
            root
        };
        let mut mgr = state.lsp.lock().await;
        mgr.did_close(&root, &language, &path).await
    })
    .await
}

#[command]
pub async fn lsp_request(
    state: tauri::State<'_, crate::AppState>,
    root: String,
    language: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    wrap_cmd("lsp_request", async move {
        let mut mgr = state.lsp.lock().await;
        mgr.request(&root, &language, &method, params).await
    })
    .await
}

#[command]
pub async fn lsp_status(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<LspLanguageStatus>, String> {
    wrap_cmd("lsp_status", async move {
        let mut out = Vec::new();
        for language in ["typescript", "python", "rust"] {
            let lang = language.to_string();
            let (_, resolution) =
                tokio::task::spawn_blocking(move || crate::lsp::acquire::resolve(&lang))
                    .await
                    .map_err(|e| e.to_string())??;
            let running_roots = {
                let mut mgr = state.lsp.lock().await;
                mgr.running_roots(language).await
            };
            out.push(LspLanguageStatus {
                language: language.to_string(),
                resolution,
                running_roots,
            });
        }
        Ok(out)
    })
    .await
}

#[command]
pub async fn lsp_install_server(language: String) -> Result<String, String> {
    wrap_cmd("lsp_install_server", async move {
        crate::lsp::acquire::install(&language).await?;
        Ok(format!("{language} language server installed"))
    })
    .await
}

#[command]
pub async fn lsp_restart_server(
    state: tauri::State<'_, crate::AppState>,
    language: String,
) -> Result<(), String> {
    wrap_cmd("lsp_restart_server", async move {
        let mut mgr = state.lsp.lock().await;
        mgr.restart_language(&language).await;
        Ok(())
    })
    .await
}

#[command]
pub async fn lsp_server_log(
    state: tauri::State<'_, crate::AppState>,
    language: String,
) -> Result<Vec<String>, String> {
    wrap_cmd("lsp_server_log", async move {
        let mgr = state.lsp.lock().await;
        Ok(mgr.stderr_log(&language).await)
    })
    .await
}
```

Note: match the exact `wrap_cmd` call shape used by neighboring commands in this file (e.g. `check_system_requirements` at `commands.rs:813`) — if `wrap_cmd` in this codebase takes the future differently, mirror that. `Serialize` is already imported at the top of commands.rs (used by `SystemStatus`); if not, add `use serde::Serialize;`.

- [ ] **Step 3: Register the commands**

In `src-tauri/src/main.rs` `generate_handler!`, after `commands::get_changelist_assignments,` add:
```rust
commands::lsp_did_open,
commands::lsp_did_change,
commands::lsp_did_close,
commands::lsp_request,
commands::lsp_status,
commands::lsp_install_server,
commands::lsp_restart_server,
commands::lsp_server_log,
```

- [ ] **Step 4: Compile + run all Rust tests**

Run: `cargo check` then `cargo test`
Expected: clean check; all tests pass (15 lsp + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/commands.rs
git commit -m "feat(lsp): Tauri IPC commands and AppState wiring for the LSP subsystem"
```

---

### Task 6: Frontend path helpers (`src/lib/lsp/paths.ts`)

**Files:**
- Create: `src/lib/lsp/paths.ts`, `src/lib/lsp/paths.test.ts`

- [ ] **Step 1: Write failing tests**

`src/lib/lsp/paths.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { pathToFileUri, pathKey } from './paths';

describe('pathToFileUri', () => {
  it('converts a Windows path', () => {
    expect(pathToFileUri('C:\\Users\\tal\\app\\a.ts')).toBe('file:///C:/Users/tal/app/a.ts');
  });
  it('encodes spaces', () => {
    expect(pathToFileUri('C:\\my repo\\a.ts')).toBe('file:///C:/my%20repo/a.ts');
  });
  it('passes unix paths through', () => {
    expect(pathToFileUri('/home/tal/a.rs')).toBe('file:///home/tal/a.rs');
  });
});

describe('pathKey', () => {
  it('normalizes a raw Windows path', () => {
    expect(pathKey('C:\\Users\\Tal\\a.ts')).toBe('c:/users/tal/a.ts');
  });
  it('normalizes a file URI with encoded drive colon', () => {
    expect(pathKey('file:///c%3A/Users/Tal/a.ts')).toBe('c:/users/tal/a.ts');
  });
  it('normalizes a plain file URI', () => {
    expect(pathKey('file:///C:/Users/Tal/my%20repo/a.ts')).toBe('c:/users/tal/my repo/a.ts');
  });
  it('matches raw path against its own URI', () => {
    expect(pathKey('C:\\x\\y.py')).toBe(pathKey(pathToFileUri('C:\\x\\y.py')));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/lsp/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/lsp/paths.ts`:
```typescript
// Path/URI bridging between Monaco models (raw fs paths) and LSP (file URIs).
// Different servers emit different encodings (`c%3A` vs `C:`), so all
// comparisons go through pathKey().

export function pathToFileUri(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (!n.startsWith('/')) n = '/' + n;
  // encodeURI leaves ':' and '/' intact; '#' would terminate the path.
  return 'file://' + encodeURI(n).replace(/#/g, '%23');
}

/** Canonical lowercase forward-slash form for matching paths and file URIs. */
export function pathKey(uriOrPath: string): string {
  let s = uriOrPath;
  if (s.startsWith('file://')) {
    s = decodeURIComponent(s.slice('file://'.length));
  }
  s = s.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1); // /C:/... → C:/...
  return s.toLowerCase();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/lsp/paths.test.ts` — Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lsp/
git commit -m "feat(lsp): path/URI bridging helpers"
```

---

### Task 7: Language mapping (`src/lib/lsp/languages.ts`)

**Files:**
- Create: `src/lib/lsp/languages.ts`, `src/lib/lsp/languages.test.ts`

- [ ] **Step 1: Write failing tests**

`src/lib/lsp/languages.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { lspServerForPath } from './languages';

describe('lspServerForPath', () => {
  it('maps ts/tsx to the typescript server with correct languageIds', () => {
    expect(lspServerForPath('C:\\a\\b.ts')).toEqual({ server: 'typescript', languageId: 'typescript' });
    expect(lspServerForPath('/a/b.tsx')).toEqual({ server: 'typescript', languageId: 'typescriptreact' });
  });
  it('maps js variants to the typescript server', () => {
    expect(lspServerForPath('a.js')).toEqual({ server: 'typescript', languageId: 'javascript' });
    expect(lspServerForPath('a.jsx')).toEqual({ server: 'typescript', languageId: 'javascriptreact' });
    expect(lspServerForPath('a.mjs')).toEqual({ server: 'typescript', languageId: 'javascript' });
  });
  it('maps python and rust', () => {
    expect(lspServerForPath('main.py')).toEqual({ server: 'python', languageId: 'python' });
    expect(lspServerForPath('lib.rs')).toEqual({ server: 'rust', languageId: 'rust' });
  });
  it('returns null for unsupported files', () => {
    expect(lspServerForPath('a.md')).toBeNull();
    expect(lspServerForPath('Dockerfile')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/lsp/languages.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/lsp/languages.ts`:
```typescript
// Maps file paths to (backend server key, LSP languageId). The server key
// matches src-tauri/src/lsp/acquire.rs::server_spec. languageId follows the
// LSP spec ('typescriptreact' for .tsx — tsserver cares about the react
// variants for JSX diagnostics).

export type LspServer = 'typescript' | 'python' | 'rust';

export interface LspBinding {
  server: LspServer;
  languageId: string;
}

const BY_EXT: Record<string, LspBinding> = {
  ts: { server: 'typescript', languageId: 'typescript' },
  tsx: { server: 'typescript', languageId: 'typescriptreact' },
  js: { server: 'typescript', languageId: 'javascript' },
  jsx: { server: 'typescript', languageId: 'javascriptreact' },
  mjs: { server: 'typescript', languageId: 'javascript' },
  cjs: { server: 'typescript', languageId: 'javascript' },
  py: { server: 'python', languageId: 'python' },
  pyi: { server: 'python', languageId: 'python' },
  rs: { server: 'rust', languageId: 'rust' },
};

export function lspServerForPath(path: string): LspBinding | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/lsp/languages.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lsp/languages.ts src/lib/lsp/languages.test.ts
git commit -m "feat(lsp): file path to language-server binding map"
```

---

### Task 8: Diagnostics → Monaco markers (`src/lib/lsp/markers.ts`)

**Files:**
- Create: `src/lib/lsp/markers.ts`, `src/lib/lsp/markers.test.ts`

- [ ] **Step 1: Write failing tests**

`src/lib/lsp/markers.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { diagnosticsToMarkers, type LspDiagnostic } from './markers';

const diag = (over: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
  message: "Cannot find name 'foo'.",
  severity: 1,
  source: 'ts',
  code: 2304,
  ...over,
});

describe('diagnosticsToMarkers', () => {
  it('converts 0-based LSP positions to 1-based Monaco positions', () => {
    const [m] = diagnosticsToMarkers([diag()]);
    expect(m.startLineNumber).toBe(5);
    expect(m.startColumn).toBe(3);
    expect(m.endLineNumber).toBe(5);
    expect(m.endColumn).toBe(10);
    expect(m.message).toBe("Cannot find name 'foo'.");
    expect(m.source).toBe('ts');
    expect(m.code).toBe('2304');
  });
  it('maps severities (LSP 1..4 → Monaco 8/4/2/1), default Warning', () => {
    expect(diagnosticsToMarkers([diag({ severity: 1 })])[0].severity).toBe(8);
    expect(diagnosticsToMarkers([diag({ severity: 2 })])[0].severity).toBe(4);
    expect(diagnosticsToMarkers([diag({ severity: 3 })])[0].severity).toBe(2);
    expect(diagnosticsToMarkers([diag({ severity: 4 })])[0].severity).toBe(1);
    expect(diagnosticsToMarkers([diag({ severity: undefined })])[0].severity).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/lsp/markers.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/lsp/markers.ts`:
```typescript
// LSP Diagnostic → monaco.editor.IMarkerData. Pure data conversion: no
// monaco import so it stays unit-testable. Numeric severity values are
// monaco's MarkerSeverity enum (Hint=1, Info=2, Warning=4, Error=8).

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number; // LSP: 1=Error 2=Warning 3=Info 4=Hint
  source?: string;
  code?: string | number;
}

export interface MarkerData {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: number;
  source?: string;
  code?: string;
}

const SEVERITY_LSP_TO_MONACO: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 };

export function diagnosticsToMarkers(diags: LspDiagnostic[]): MarkerData[] {
  return diags.map((d) => ({
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    message: d.message,
    severity: SEVERITY_LSP_TO_MONACO[d.severity ?? 2] ?? 4,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
  }));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/lsp/markers.test.ts` — Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lsp/markers.ts src/lib/lsp/markers.test.ts
git commit -m "feat(lsp): LSP diagnostics to Monaco marker conversion"
```

---

### Task 9: `lspEnabled` setting in appStore

**Files:**
- Modify: `src/store/appStore.ts`
- Modify: `src/store/appStore.test.ts`

- [ ] **Step 1: Update the persisted-keys allow-list test**

In `src/store/appStore.test.ts`, find the persisted-keys allow-list (the test updated by commit `c8bfc56` for `terminalScrollbarMode`) and add `'lspEnabled'` to the expected keys array, keeping the existing ordering convention.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/store/appStore.test.ts`
Expected: FAIL — allow-list mismatch (`lspEnabled` expected but not persisted).

- [ ] **Step 3: Implement the setting**

In `src/store/appStore.ts`:

1. In the `AppState` interface, next to the other boolean settings (e.g. after `errorReportingEnabled: boolean;` around line 63):
```typescript
// Master switch for language-server features (diagnostics squiggles).
lspEnabled: boolean;
setLspEnabled: (v: boolean) => void;
```

2. In the store creator, next to the other defaults:
```typescript
lspEnabled: true,
setLspEnabled: (v) => set({ lspEnabled: v }),
```

3. In the persist `partialize` function, add `lspEnabled: state.lspEnabled,` alongside the other persisted settings.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/store/appStore.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts
git commit -m "feat(lsp): lspEnabled persisted setting"
```

---

### Task 10: lspClient — doc sync + markers (`src/lib/lsp/lspClient.ts`)

**Files:**
- Create: `src/lib/lsp/lspClient.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Implement the client singleton**

`src/lib/lsp/lspClient.ts`:
```typescript
// Singleton bridge between the app and the Rust LSP subsystem.
//
// Doc sync: subscribes to appStore.openFiles and mirrors loaded, LSP-eligible
// tabs to the backend (didOpen / debounced didChange / didClose).
// Diagnostics: listens for `lsp-diagnostics` events, converts to Monaco
// markers, and applies them to the matching model. Diagnostics arriving
// before the model exists (editor not mounted yet) are cached and applied
// in onDidCreateModel.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as monaco from 'monaco-editor';
import { useAppStore, type FileTabState } from '../../store/appStore';
import { lspServerForPath, type LspBinding } from './languages';
import { pathKey, pathToFileUri } from './paths';
import { diagnosticsToMarkers, type LspDiagnostic } from './markers';

const CHANGE_DEBOUNCE_MS = 300;
const MARKER_OWNER = 'lsp';

interface SyncedDoc {
  binding: LspBinding;
  root: string;
  version: number;
  lastSent: string;
  debounce: ReturnType<typeof setTimeout> | null;
}

const synced = new Map<string, SyncedDoc>(); // key: tab.path (raw)
const pendingMarkers = new Map<string, monaco.editor.IMarkerData[]>(); // key: pathKey

function dirname(p: string): string {
  const n = p.replace(/\\/g, '/');
  const idx = n.lastIndexOf('/');
  return idx > 0 ? n.slice(0, idx) : n;
}

function rootFor(tab: FileTabState): string {
  return tab.repoRoot ?? dirname(tab.path);
}

function findModel(key: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModels().find((m) => pathKey(m.uri.toString()) === key) ?? null;
}

async function open(tab: FileTabState, binding: LspBinding): Promise<void> {
  const doc: SyncedDoc = {
    binding,
    root: rootFor(tab),
    version: 1,
    lastSent: tab.content,
    debounce: null,
  };
  synced.set(tab.path, doc);
  try {
    await invoke('lsp_did_open', {
      root: doc.root,
      language: binding.server,
      path: tab.path,
      languageId: binding.languageId,
      text: tab.content,
      version: 1,
    });
  } catch (err) {
    // Server missing/crashed: status events + settings page own the UX.
    console.warn('[lsp] didOpen failed:', err);
    synced.delete(tab.path);
  }
}

function change(path: string, doc: SyncedDoc, content: string): void {
  if (doc.debounce) clearTimeout(doc.debounce);
  doc.debounce = setTimeout(() => {
    doc.debounce = null;
    if (content === doc.lastSent) return;
    doc.lastSent = content;
    doc.version += 1;
    invoke('lsp_did_change', {
      root: doc.root,
      language: doc.binding.server,
      path,
      text: content,
      version: doc.version,
    }).catch((err) => console.warn('[lsp] didChange failed:', err));
  }, CHANGE_DEBOUNCE_MS);
}

function close(path: string, doc: SyncedDoc): void {
  if (doc.debounce) clearTimeout(doc.debounce);
  synced.delete(path);
  const key = pathKey(pathToFileUri(path));
  pendingMarkers.delete(key);
  const model = findModel(key);
  if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  invoke('lsp_did_close', {
    root: doc.root,
    language: doc.binding.server,
    path,
  }).catch((err) => console.warn('[lsp] didClose failed:', err));
}

function syncTabs(openFiles: FileTabState[], lspEnabled: boolean): void {
  if (!lspEnabled) {
    for (const [path, doc] of [...synced]) close(path, doc);
    return;
  }
  const present = new Set<string>();
  for (const tab of openFiles) {
    if (tab.loading) continue;
    const binding = lspServerForPath(tab.path);
    if (!binding) continue;
    present.add(tab.path);
    const doc = synced.get(tab.path);
    if (!doc) {
      void open(tab, binding);
    } else if (tab.content !== doc.lastSent) {
      change(tab.path, doc, tab.content);
    }
  }
  for (const [path, doc] of [...synced]) {
    if (!present.has(path)) close(path, doc);
  }
}

interface DiagnosticsEvent {
  language: string;
  root: string;
  uri: string;
  diagnostics: LspDiagnostic[];
}

let initialized = false;

export function initLsp(): void {
  if (initialized) return;
  initialized = true;

  void listen<DiagnosticsEvent>('lsp-diagnostics', (event) => {
    const key = pathKey(event.payload.uri);
    const markers = diagnosticsToMarkers(event.payload.diagnostics) as monaco.editor.IMarkerData[];
    const model = findModel(key);
    if (model) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    } else {
      pendingMarkers.set(key, markers);
    }
  });

  // Apply diagnostics that arrived before the editor mounted the model.
  monaco.editor.onDidCreateModel((model) => {
    const cached = pendingMarkers.get(pathKey(model.uri.toString()));
    if (cached) monaco.editor.setModelMarkers(model, MARKER_OWNER, cached);
  });

  // Mirror file tabs → LSP documents.
  useAppStore.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles || state.lspEnabled !== prev.lspEnabled) {
      syncTabs(state.openFiles, state.lspEnabled);
    }
  });
  const s = useAppStore.getState();
  syncTabs(s.openFiles, s.lspEnabled);
}
```

Note: if `FileTabState` is not currently exported from `appStore.ts`, export it (it is declared at `src/store/appStore.ts:28`).

- [ ] **Step 2: Wire into App.tsx**

In `src/App.tsx`, add the import and call it once on mount inside an existing or new `useEffect(() => { ... }, [])`:
```typescript
import { initLsp } from './lib/lsp/lspClient';
// inside a mount-only effect:
useEffect(() => {
  initLsp();
}, []);
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit` then `npx vite build`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/lsp/lspClient.ts src/App.tsx src/store/appStore.ts
git commit -m "feat(lsp): doc sync from file tabs and diagnostics markers in Monaco"
```

---

### Task 11: Language Servers settings page

**Files:**
- Create: `src/components/settings/categories/LanguageServersPage.tsx`
- Modify: `src/components/settings/index.ts` (CATEGORY_GROUPS), `src/components/settings/SettingsWindow.tsx` (pages map)

- [ ] **Step 1: Register the category**

In `src/components/settings/index.ts`, in the `editor` group's pages array:
```typescript
{ id: 'editor', label: 'Editor', pages: [
  { id: 'general',          label: 'General' },
  { id: 'font',             label: 'Font' },
  { id: 'language-servers', label: 'Language Servers' },
]},
```

In `src/components/settings/SettingsWindow.tsx` pages map, after `'editor.font'`:
```typescript
'editor.language-servers': lazy(() => import('./categories/LanguageServersPage')),
```

- [ ] **Step 2: Implement the page**

`src/components/settings/categories/LanguageServersPage.tsx` (follow the structure of `EditorGeneralPage.tsx` — use `SettingRow` if its API fits, otherwise plain rows like other pages do; the code below is the complete component):
```tsx
import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Loader2, RefreshCw, Download, FileText } from 'lucide-react';
import { Button } from '../../ui/Button';
import { useAppStore } from '../../../store/appStore';
import { registerSetting } from '../index';
import { toast } from '../../../store/toastStore';

registerSetting({
  category: { group: 'editor', page: 'language-servers' },
  id: 'lsp-enabled',
  label: 'Enable language servers',
  keywords: ['lsp', 'diagnostics', 'intellisense', 'squiggles', 'language server'],
});

interface LangStatus {
  language: string;
  resolution:
    | { kind: 'path'; program: string; version: string | null }
    | { kind: 'installed'; program: string }
    | { kind: 'missing' };
  running_roots: string[];
}

const LABELS: Record<string, string> = {
  typescript: 'TypeScript / JavaScript',
  python: 'Python (Pyright)',
  rust: 'Rust (rust-analyzer)',
};

export default function LanguageServersPage() {
  const lspEnabled = useAppStore((s) => s.lspEnabled);
  const setLspEnabled = useAppStore((s) => s.setLspEnabled);
  const [statuses, setStatuses] = useState<LangStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const refresh = useCallback(() => {
    invoke<LangStatus[]>('lsp_status')
      .then(setStatuses)
      .catch(() => setStatuses([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const un = listen('lsp-status', refresh);
    return () => { un.then((f) => f()); };
  }, [refresh]);

  const install = async (language: string) => {
    setInstalling(language);
    try {
      await invoke<string>('lsp_install_server', { language });
      toast.success('Installed', `${LABELS[language]} language server is ready`);
      refresh();
    } catch (err) {
      toast.error('Install failed', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setInstalling(null);
    }
  };

  const restart = async (language: string) => {
    await invoke('lsp_restart_server', { language }).catch(() => {});
    refresh();
  };

  const showLog = async (language: string) => {
    if (logFor === language) { setLogFor(null); return; }
    const lines = await invoke<string[]>('lsp_server_log', { language }).catch(() => []);
    setLogLines(lines);
    setLogFor(language);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-text-primary text-sm font-semibold">Language Servers</h2>
        <p className="text-text-tertiary text-[11px] mt-0.5">
          Real language intelligence (diagnostics squiggles) for files opened in the editor.
          Servers found on PATH are used as-is; missing ones can be installed locally.
        </p>
      </div>

      <label className="flex items-center justify-between">
        <span className="text-text-secondary text-[12px]">Enable language servers</span>
        <input
          type="checkbox"
          checked={lspEnabled}
          onChange={(e) => setLspEnabled(e.target.checked)}
        />
      </label>

      {loading ? (
        <Loader2 size={14} className="animate-spin text-text-tertiary" />
      ) : (
        <div className="space-y-2">
          {statuses.map((s) => (
            <div key={s.language} className="border border-border/50 rounded-md p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-text-primary text-[12px] font-medium">{LABELS[s.language] ?? s.language}</span>
                <div className="flex items-center gap-1.5">
                  {s.resolution.kind === 'missing' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={installing === s.language}
                      onClick={() => install(s.language)}
                    >
                      <Download size={12} /> Install
                    </Button>
                  ) : (
                    <span className="text-[10.5px] text-success">
                      {s.resolution.kind === 'path'
                        ? `On PATH${'version' in s.resolution && s.resolution.version ? ` · ${s.resolution.version}` : ''}`
                        : 'Installed'}
                    </span>
                  )}
                  {s.running_roots.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => restart(s.language)}>
                      <RefreshCw size={12} /> Restart
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => showLog(s.language)}>
                    <FileText size={12} /> Log
                  </Button>
                </div>
              </div>
              {s.running_roots.length > 0 && (
                <p className="text-text-tertiary text-[10.5px]">
                  Running in: {s.running_roots.join(', ')}
                </p>
              )}
              {logFor === s.language && (
                <pre className="max-h-40 overflow-auto bg-elevation-0 rounded p-2 text-[10px] text-text-tertiary font-mono whitespace-pre-wrap">
                  {logLines.length ? logLines.join('\n') : 'No stderr output captured.'}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Adjust toggle markup to match how `EditorGeneralPage.tsx` renders its checkboxes/toggles (reuse `SettingRow` if that's the established pattern) — visual consistency over the literal markup above.

- [ ] **Step 3: Type-check + settings index test**

Run: `npx tsc --noEmit` and `npx vitest run src/components/settings/index.test.ts`
Expected: clean / pass (if the index test asserts page registry contents, update it for `language-servers`).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/
git commit -m "feat(lsp): Language Servers settings page - status, install, restart, log"
```

---

### Task 12: Full verification + dogfood

**Files:** none (verification only)

- [ ] **Step 1: Full automated verification**

```bash
npx tsc --noEmit
npx vitest run
cd src-tauri && cargo test && cargo check && cd ..
```
Expected: all clean/pass.

- [ ] **Step 2: Manual dogfood checklist (run `npm run tauri dev`)**

1. Open `src/App.tsx` in the file editor → within a few seconds, no squiggles (clean file). Add `const x: number = 'oops';` → red squiggle appears on the string after ~1s; hover shows the TS error message (Monaco renders marker hover natively).
2. Delete the bad line → squiggle clears.
3. Settings → Editor → Language Servers: TypeScript shows "On PATH" or "Installed"; "Running in:" lists the repo root; Log shows stderr (may be empty).
4. If `rust-analyzer` is available (PATH or installed): open `src-tauri/src/main.rs`, introduce `let y: u32 = "x";` → squiggle appears (rust-analyzer takes ~10–60s to index first; later edits are fast).
5. Toggle "Enable language servers" off → markers clear; on → they return after reopening/editing the file.
6. Close the app → no orphaned `typescript-language-server`/`rust-analyzer` processes in Task Manager (kill_on_drop covers app exit because the PTY-style cleanup isn't needed — verify regardless).
7. Missing-server path: temporarily rename rust-analyzer off PATH, open a `.rs` file → no crash; settings page shows "Install" for Rust.

- [ ] **Step 3: Fix anything found, then final commit**

```bash
git add -A
git commit -m "feat(lsp): phase 1 LSP foundation - verification fixes"
```

---

## Out of scope for this plan (later phases)

- Hover/go-to-definition providers in editor & diffs (Phase 4 — `lsp_request` passthrough already supports them)
- Review Inbox, per-hunk accept/reject, gate bar, AI verdict (Phases 2–3, separate plans)
- Completions (Phase 4)
- Diff-aware "new diagnostics" filtering (Phase 2/3 — needs the cockpit's changed-lines context)

## Known risks / notes for the implementer

- **`wrap_cmd` exact signature**: mirror neighboring commands in `commands.rs` if the snippets here don't match its real shape.
- **rust-analyzer first-run latency**: diagnostics can take a minute on large crates; the `lsp-status` "running" event fires after `initialize`, not after indexing. Don't mistake slow indexing for breakage.
- **tsserver project discovery**: typescript-language-server finds `tsconfig.json` relative to the file; the repoRoot rootUri is fine for this repo.
- **Monaco model URIs**: `@monaco-editor/react` creates models from the `path` prop; never compare URIs directly — always go through `pathKey()`.
- **Locking**: `LspManager` methods run under one `Mutex`; `ensure()` holds it across the initialize handshake (seconds, first open per root only). Acceptable for v1; split locks only if it ever bites.
