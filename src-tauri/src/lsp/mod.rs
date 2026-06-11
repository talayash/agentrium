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
const RESTART_WINDOW: std::time::Duration = std::time::Duration::from_secs(120);
const INITIALIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Windowed restart counting (VS Code/Zed style): attempts reset once the
/// previous spawn has been up longer than RESTART_WINDOW.
fn next_attempt(history: Option<(u8, std::time::Duration)>) -> Result<u8, ()> {
    match history {
        None => Ok(1),
        Some((_, since)) if since > RESTART_WINDOW => Ok(1),
        Some((attempts, _)) if attempts >= MAX_RESTARTS => Err(()),
        Some((attempts, _)) => Ok(attempts + 1),
    }
}

fn path_to_uri(p: &str) -> String {
    // url handles full percent-encoding (%, non-ASCII, ...); the manual path
    // below only covers relative inputs, where from_file_path fails.
    if let Ok(u) = url::Url::from_file_path(p) {
        return u.to_string();
    }
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
}

/// Spawn-attempt bookkeeping for the windowed restart cap. Kept separate from
/// ServerEntry so failed spawns/handshakes (which never insert an entry)
/// still count toward the cap.
struct SpawnHistory {
    attempts: u8,
    last_spawn: std::time::Instant,
}

/// A document the frontend has opened, mirrored so we can replay
/// textDocument/didOpen after a server respawn.
struct OpenDoc {
    language_id: String,
    text: String,
    version: i64,
}

pub struct LspManager {
    app: tauri::AppHandle,
    servers: HashMap<(String, String), ServerEntry>, // (root, language)
    spawn_history: HashMap<(String, String), SpawnHistory>,
    /// Open documents per (root, language), keyed by file path.
    open_docs: HashMap<(String, String), HashMap<String, OpenDoc>>,
    /// Cached resolution results so ensure() doesn't re-probe PATH on every
    /// respawn. Missing is never cached (so an out-of-band install is picked
    /// up automatically). Invalidated by invalidate_resolution() and
    /// restart_language().
    resolutions: HashMap<String, (acquire::ServerSpec, acquire::Resolution)>,
}

impl LspManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            servers: HashMap::new(),
            spawn_history: HashMap::new(),
            open_docs: HashMap::new(),
            resolutions: HashMap::new(),
        }
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
    /// handshake on first spawn. Respects the windowed restart cap.
    pub async fn ensure(
        &mut self,
        root: &str,
        language: &str,
    ) -> Result<Arc<tokio::sync::Mutex<LspClient>>, String> {
        let key = (root.to_string(), language.to_string());
        if let Some(entry) = self.servers.get(&key) {
            if entry.client.lock().await.is_alive() {
                return Ok(entry.client.clone());
            }
            self.servers.remove(&key);
        }

        let history = self
            .spawn_history
            .get(&key)
            .map(|h| (h.attempts, h.last_spawn.elapsed()));
        let Ok(attempts) = next_attempt(history) else {
            self.emit_status(language, root, "error", Some("crashed too many times".into()));
            // user_err: expected condition (cap is by design), not a defect —
            // keeps every debounced did_change from spamming telemetry.
            return Err(crate::error_reporter::user_err(format!("{language} server crashed {MAX_RESTARTS}+ times; will retry after a cooldown, or restart it from Settings → Editor → Language Servers")));
        };

        self.emit_status(language, root, "starting", None);

        // Use cached resolution if available; otherwise probe (blocking).
        let (spec, resolution) = if let Some(cached) = self.resolutions.get(language) {
            cached.clone()
        } else {
            let lang_owned = language.to_string();
            let result = tokio::task::spawn_blocking(move || acquire::resolve(&lang_owned))
                .await
                .map_err(|e| e.to_string())??;
            // Don't cache Missing: a server installed outside the app should
            // be picked up on the next open without manual invalidation.
            if !matches!(result.1, acquire::Resolution::Missing) {
                self.resolutions.insert(language.to_string(), result.clone());
            }
            result
        };

        let program = match resolution {
            acquire::Resolution::Path { program, .. } => program,
            acquire::Resolution::Installed { program } => program,
            acquire::Resolution::Missing => {
                self.emit_status(language, root, "error", Some("not installed".into()));
                // user_err: a missing optional server is an expected state,
                // not a defect — skip telemetry.
                return Err(crate::error_reporter::user_err(format!("{language} language server is not installed (Settings → Editor → Language Servers)")));
            }
        };

        // Record the attempt BEFORE spawning so failed spawns and failed
        // handshakes still consume an attempt — otherwise a server that dies
        // during initialize would respawn-churn forever past the cap.
        self.spawn_history.insert(
            key.clone(),
            SpawnHistory { attempts, last_spawn: std::time::Instant::now() },
        );

        let (sink_tx, mut sink_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
        let args: Vec<String> = spec.args.iter().map(|s| s.to_string()).collect();
        let client = LspClient::spawn(&program, &args, root, sink_tx).inspect_err(|_| {
            // Invalidate cache: the binary that was resolved may have been deleted.
            self.invalidate_resolution(language);
        })?;
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
        // Own 30s timeout: a wedged server must not hold the manager for the
        // client's 120s request timeout.
        let init_result = {
            let c = client.lock().await;
            let fut = c.request("initialize", json!({
                "processId": std::process::id(),
                "rootUri": path_to_uri(root),
                "workspaceFolders": [{ "uri": path_to_uri(root), "name": "workspace" }],
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": { "relatedInformation": true },
                        "synchronization": {}
                    }
                }
            }));
            match tokio::time::timeout(INITIALIZE_TIMEOUT, fut).await {
                Ok(r) => r,
                Err(_) => Err("initialize timed out after 30s".to_string()),
            }
        };
        if let Err(e) = init_result {
            self.emit_status(language, root, "error", Some(e.clone()));
            return Err(e);
        }
        client.lock().await.notify("initialized", json!({}))?;

        // Respawn: replay didOpen for every doc the frontend still has open.
        // Servers ignore didChange for documents they never saw opened, so
        // diagnostics would go dark after a silent respawn otherwise. (On a
        // first spawn open_docs has no entries for this key — did_open
        // records only after ensure() returns.)
        if let Some(docs) = self.open_docs.get(&key) {
            let c = client.lock().await;
            for (path, doc) in docs {
                let _ = c.notify("textDocument/didOpen", json!({
                    "textDocument": {
                        "uri": path_to_uri(path),
                        "languageId": doc.language_id,
                        "version": doc.version,
                        "text": doc.text
                    }
                }));
            }
        }

        self.emit_status(language, root, "running", None);
        self.servers.insert(key, ServerEntry { client: client.clone() });
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
        self.open_docs
            .entry((root.to_string(), language.to_string()))
            .or_default()
            .insert(path.to_string(), OpenDoc {
                language_id: language_id.to_string(),
                text: text.to_string(),
                version,
            });
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
        if let Some(doc) = self
            .open_docs
            .get_mut(&(root.to_string(), language.to_string()))
            .and_then(|docs| docs.get_mut(path))
        {
            doc.text = text.to_string();
            doc.version = version;
        }
        let c = client.lock().await;
        c.notify("textDocument/didChange", json!({
            "textDocument": { "uri": path_to_uri(path), "version": version },
            "contentChanges": [{ "text": text }]
        }))
    }

    pub async fn did_close(&mut self, root: &str, language: &str, path: &str) -> Result<(), String> {
        let key = (root.to_string(), language.to_string());
        if let Some(docs) = self.open_docs.get_mut(&key) {
            docs.remove(path);
            if docs.is_empty() {
                self.open_docs.remove(&key);
            }
        }
        let Some(entry) = self.servers.get(&key) else { return Ok(()) };
        let c = entry.client.lock().await;
        if !c.is_alive() {
            return Ok(()); // nothing to tell a dead server; close is not an error
        }
        c.notify("textDocument/didClose", json!({
            "textDocument": { "uri": path_to_uri(path) }
        }))
    }

    /// Kill every server for `language`; they respawn (with fresh resolution
    /// and a reset restart counter) on the next did_open.
    pub async fn restart_language(&mut self, language: &str) {
        // Manual restart = fresh start: re-probe PATH and reset the cap.
        self.invalidate_resolution(language);
        self.spawn_history.retain(|(_, l), _| l != language);
        let keys: Vec<_> = self
            .servers
            .keys()
            .filter(|(_, l)| l == language)
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = self.servers.remove(&key) {
                graceful_stop(&entry.client).await;
                self.emit_status(&key.1, &key.0, "stopped", None);
            }
        }
    }

    pub async fn running_roots(&self, language: &str) -> Vec<String> {
        let mut out = Vec::new();
        for ((root, lang), entry) in self.servers.iter() {
            if lang == language && entry.client.lock().await.is_alive() {
                out.push(root.clone());
            }
        }
        out
    }

    pub async fn stderr_log(&self, language: &str) -> Vec<String> {
        let mut sections: Vec<(String, Vec<String>)> = Vec::new();
        for ((root, lang), entry) in self.servers.iter() {
            if lang == language {
                let c = entry.client.lock().await;
                let ring = c.stderr_ring.lock().await;
                sections.push((root.clone(), ring.iter().cloned().collect()));
            }
        }
        if sections.len() == 1 {
            return sections.pop().unwrap().1;
        }
        // Multi-root: label each server's section so the log viewer can tell
        // them apart.
        let mut out = Vec::new();
        for (root, lines) in sections {
            out.push(format!("--- {root} ---"));
            out.extend(lines);
        }
        out
    }

    /// Forget the cached PATH/install resolution for `language` (e.g. after an
    /// install completes) so the next ensure() re-probes.
    pub fn invalidate_resolution(&mut self, language: &str) {
        self.resolutions.remove(language);
    }
}

/// Best-effort LSP shutdown handshake, then hard kill. Servers exit on
/// `exit` (or on stdin EOF when the process drops); kill() is the backstop.
async fn graceful_stop(client: &Arc<tokio::sync::Mutex<LspClient>>) {
    {
        let c = client.lock().await;
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            c.request("shutdown", Value::Null),
        )
        .await;
        let _ = c.notify("exit", Value::Null);
    }
    // Give the server a moment to exit on its own before the hard kill.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    client.lock().await.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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

    // Windows-only: on other hosts Url::from_file_path rejects drive-letter
    // paths and the relative-path fallback (no % encoding) kicks in.
    #[cfg(windows)]
    #[test]
    fn path_to_uri_percent_encodes_literal_percent() {
        let uri = path_to_uri(r"C:\dev\100%done\a.ts");
        assert!(uri.contains("100%25done"), "got {uri}");
    }

    #[cfg(windows)]
    #[test]
    fn path_to_uri_percent_encodes_non_ascii() {
        assert_eq!(
            path_to_uri(r"C:\Users\José\a.ts"),
            "file:///C:/Users/Jos%C3%A9/a.ts"
        );
    }

    #[test]
    fn next_attempt_first_spawn_is_one() {
        assert_eq!(next_attempt(None), Ok(1));
    }

    #[test]
    fn next_attempt_increments_within_window_under_cap() {
        assert_eq!(next_attempt(Some((1, Duration::from_secs(5)))), Ok(2));
        assert_eq!(next_attempt(Some((2, Duration::from_secs(119)))), Ok(3));
    }

    #[test]
    fn next_attempt_errs_at_cap_within_window() {
        assert_eq!(next_attempt(Some((3, Duration::from_secs(5)))), Err(()));
        assert_eq!(next_attempt(Some((200, Duration::from_secs(5)))), Err(()));
    }

    #[test]
    fn next_attempt_resets_beyond_window() {
        assert_eq!(next_attempt(Some((3, Duration::from_secs(121)))), Ok(1));
    }
}
