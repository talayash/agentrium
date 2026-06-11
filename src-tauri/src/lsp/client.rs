//! One running language-server child process: spawn, framed stdio pump,
//! request-id correlation, stderr ring buffer. Protocol-agnostic beyond
//! JSON-RPC — the manager (mod.rs) owns LSP semantics.

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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
    match method {
        "workspace/configuration" => {
            let n = params
                .get("items")
                .and_then(|i| i.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            json!({ "jsonrpc": "2.0", "id": id, "result": Value::Array(vec![Value::Null; n]) })
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "method not implemented" }
        }),
    }
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

pub struct LspClient {
    child: Child,
    next_id: AtomicI64,
    pending: Pending,
    writer_tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Set by the pump tasks when the process is gone; lets `request()`
    /// fail fast instead of waiting out the timeout.
    dead: Arc<AtomicBool>,
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
        // Since Rust 1.77.2 (BatBadBut fix), std/tokio route .cmd/.bat
        // programs through cmd.exe themselves with injection-safe escaping,
        // so no manual `cmd /C` wrapper is needed.
        let mut cmd = Command::new(program);
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
        // Unbounded is a deliberate trade-off: LSP frames are small and
        // didChange is debounced upstream, so backpressure isn't needed.
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let stderr_ring = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_RING_CAP)));
        let dead = Arc::new(AtomicBool::new(false));

        // Writer task: serializes all outgoing frames onto stdin.
        let pending_w = pending.clone();
        let dead_w = dead.clone();
        tokio::spawn(async move {
            while let Some(bytes) = writer_rx.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            dead_w.store(true, Ordering::SeqCst);
            for (_, tx) in pending_w.lock().await.drain() {
                let _ = tx.send(Err("language server exited".into()));
            }
        });

        // Reader task: frames → classify → resolve pending / auto-reply / sink.
        let pending_r = pending.clone();
        let writer_r = writer_tx.clone();
        let dead_r = dead.clone();
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
                            // Don't hold the pending lock across tx.send.
                            let tx = pending_r.lock().await.remove(&id);
                            if let Some(tx) = tx {
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
            dead_r.store(true, Ordering::SeqCst);
            for (_, tx) in pending_r.lock().await.drain() {
                let _ = tx.send(Err("language server exited".into()));
            }
        });

        // Stderr task: ring buffer for the settings-page log viewer.
        // read_until (not lines()) so non-UTF-8 output and unbounded lines
        // can't kill or bloat the task.
        let ring = stderr_ring.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = Vec::new();
            loop {
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let mut line = String::from_utf8_lossy(&buf).trim_end().to_string();
                if line.len() > 4000 {
                    line = line.chars().take(4000).collect();
                }
                let mut r = ring.lock().await;
                if r.len() >= STDERR_RING_CAP {
                    r.pop_front();
                }
                r.push_back(line);
                buf.clear();
            }
        });

        Ok(Self {
            child,
            next_id: AtomicI64::new(1),
            pending,
            writer_tx,
            dead,
            stderr_ring,
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.dead.load(Ordering::SeqCst) {
            return Err("language server exited".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self
            .writer_tx
            .send(encode_frame(msg.to_string().as_bytes()))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err("language server writer closed".into());
        }
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

    pub fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::SeqCst)
    }

    /// Hard-kill the child. On Windows this may terminate a shim parent
    /// (e.g. an npm .cmd wrapper) rather than the server grandchild — the
    /// manager should attempt a graceful shutdown/exit handshake first;
    /// stdin EOF (pipe drop) is the practical backstop.
    pub async fn kill(&mut self) {
        self.dead.store(true, Ordering::SeqCst);
        let _ = self.child.kill().await;
    }
}

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
    fn unknown_server_request_gets_method_not_found() {
        let reply = server_request_reply(&json!("x"), "client/registerCapability", &json!({}));
        assert_eq!(reply["error"]["code"], json!(-32601));
        assert!(reply.get("result").is_none());
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

    #[test]
    fn classify_non_integer_id_response_is_other() {
        assert!(matches!(
            classify(&json!({"jsonrpc":"2.0","id":"abc","result":{}})),
            Incoming::Other
        ));
    }

    #[test]
    fn classify_error_response_carries_message() {
        match classify(&json!({"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"nope"}})) {
            Incoming::Response { id, result } => {
                assert_eq!(id, 3);
                let err = result.unwrap_err();
                assert!(err.contains("nope"), "error text was: {}", err);
            }
            _ => panic!("expected Response"),
        }
    }
}
