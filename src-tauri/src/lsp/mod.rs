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
    /// Cached resolution results so ensure() doesn't re-probe PATH on every
    /// respawn. Invalidated by invalidate_resolution() and restart_language().
    resolutions: HashMap<String, (acquire::ServerSpec, acquire::Resolution)>,
}

impl LspManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app, servers: HashMap::new(), resolutions: HashMap::new() }
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

        // Use cached resolution if available; otherwise probe (blocking).
        let (spec, resolution) = if let Some(cached) = self.resolutions.get(language) {
            cached.clone()
        } else {
            let lang_owned = language.to_string();
            let result = tokio::task::spawn_blocking(move || acquire::resolve(&lang_owned))
                .await
                .map_err(|e| e.to_string())??;
            self.resolutions.insert(language.to_string(), result.clone());
            result
        };

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
        // Invalidate the cached resolution so the next ensure() re-probes PATH.
        self.invalidate_resolution(language);
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
