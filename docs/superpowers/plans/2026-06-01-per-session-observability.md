# Per-Session Observability & Cost/Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface live per-session token usage, estimated USD cost, and tool activity for each Claude Code terminal — with per-tab cost chips, a detail panel, and an optional per-session budget cap that warns/auto-stops a runaway agent.

**Architecture:** ClaudeTerminal already spawns each `claude` process via `portable-pty` and controls its child environment (`terminal.rs:206`). We exploit the Claude Code CLI's built-in OpenTelemetry: per terminal we inject `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*` env vars pointing the CLI's OTLP/HTTP metrics exporter at a tiny localhost receiver embedded in the Rust backend. Each child is tagged with `OTEL_RESOURCE_ATTRIBUTES=terminal.id=<our-uuid>` so incoming metrics are attributed back to the exact terminal without needing Claude's internal `session.id`. The receiver parses OTLP/JSON, accumulates cumulative counters per terminal, and emits a `terminal-metrics` Tauri event — the same channel→event→store pattern already used for `terminal-output`. No CLI fork, no protocol work beyond a JSON parser.

**Tech Stack:** Rust (`tiny_http` for the embedded OTLP receiver, `serde_json` already present), Tauri 2 events, React + Zustand, Vitest (frontend) + `cargo test` (backend).

**Decisions locked in (from deep research, 2026-06-01):**
- **Embedded OTLP/HTTP-JSON receiver** over log-parsing or a bundled collector — fully local, no telemetry egress, smallest dependency (`tiny_http`).
- **Single shared receiver** on one ephemeral localhost port; metrics routed by the `terminal.id` resource attribute (not per-session ports).
- **Budget enforcement by watching the cost metric and calling the existing `close_terminal`** — NOT migrating to the Agent SDK (`max_budget_usd` is SDK-only; out of scope for the raw-PTY model).
- Cost is the CLI's **estimated** USD per request — label it "est." in the UI.

**⚠️ Verify-first (Task 1 gate):** Three upstream behaviors must be confirmed against the installed `claude` build before building on them, because OTel env var handling is the load-bearing assumption: (1) `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` is honored (vs. forcing protobuf), (2) `OTEL_RESOURCE_ATTRIBUTES=terminal.id=…` appears in the exported resource, (3) the metric names below (`claude_code.cost.usage`, `claude_code.token.usage`) match. Task 1 captures a real payload and turns it into the test fixture; **do not skip it.**

**MVP boundary:** Phases A + B (Tasks 1–10) ship a complete, useful feature (live per-tab cost + token panel + settings). Phase C (Task 11, budget caps) is an independent follow-on.

---

## File Structure

**Create:**
- `src-tauri/src/otel_receiver.rs` — embedded OTLP/HTTP-JSON receiver: server thread, pure parser, per-terminal cumulative aggregator, emits `terminal-metrics`.
- `src-tauri/tests/otlp_fixture.json` — captured real OTLP/JSON metrics payload (test fixture).
- `src/lib/sessionMetrics.ts` — `SessionMetrics` type + pure merge helper (shared by store + tests).
- `src/components/SessionMetricsPanel.tsx` — detail panel (token breakdown + cost + sparkline-free MVP).

**Modify:**
- `src-tauri/Cargo.toml` — add `tiny_http`.
- `src-tauri/src/main.rs` — declare `mod otel_receiver`; start receiver in `setup`; store port on `AppState`.
- `src-tauri/src/commands.rs` — extend `AppState` with `otel_port`; pass endpoint + enable flag into `create_terminal`.
- `src-tauri/src/terminal.rs` — generate `id` early; inject OTel env vars before spawn (`create_terminal` signature + body).
- `src/store/terminalStore.ts` — `terminalMetrics` map + `setTerminalMetrics`; clear on close.
- `src/App.tsx` — `listen('terminal-metrics')`.
- `src/components/TerminalTabs.tsx` — per-tab cost chip.
- `src/store/appStore.ts` — `costTrackingEnabled`, `sessionBudgetUsd` (persisted).
- `src/components/SettingsModal.tsx` — toggle + budget input.

---

## Task 1: Capture a real OTLP payload fixture (verification gate)

**Files:**
- Create: `src-tauri/tests/otlp_fixture.json`

This task has no automated test — it is the empirical gate that de-risks every later task.

- [ ] **Step 1: Start a throwaway listener that prints whatever Claude posts**

On Windows PowerShell, run a one-off Node listener (Node is a prerequisite for this app):

```powershell
node -e "require('http').createServer((q,s)=>{let b=[];q.on('data',c=>b.push(c));q.on('end',()=>{console.log('=== '+q.url+' ===');console.log(Buffer.concat(b).toString());s.writeHead(200);s.end()})}).listen(4318,()=>console.error('listening :4318'))"
```

- [ ] **Step 2: In a second terminal, run Claude with telemetry pointed at it, do one turn, then quit**

```powershell
$env:CLAUDE_CODE_ENABLE_TELEMETRY="1"
$env:OTEL_METRICS_EXPORTER="otlp"
$env:OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
$env:OTEL_EXPORTER_OTLP_METRICS_PROTOCOL="http/json"
$env:OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
$env:OTEL_EXPORTER_OTLP_COMPRESSION="none"
$env:OTEL_METRIC_EXPORT_INTERVAL="3000"
$env:OTEL_METRICS_INCLUDE_SESSION_ID="true"
$env:OTEL_RESOURCE_ATTRIBUTES="terminal.id=TEST-TERMINAL-1"
claude
```

Type one prompt (e.g. "say hi"), wait ~5s for an export, then `/exit`.

- [ ] **Step 3: Confirm the three load-bearing assumptions in the printed payload**

Expected in the listener output:
- A POST to `/v1/metrics` with a **JSON** body (not binary) → confirms `http/json` honored.
- `"key":"terminal.id"` with `"stringValue":"TEST-TERMINAL-1"` inside `resource.attributes` → confirms resource-attr correlation.
- Metric names `claude_code.cost.usage` and `claude_code.token.usage` present.

If `http/json` is NOT honored (binary body), STOP and escalate — the plan's parser assumes JSON; the fallback (protobuf decode) changes Task 2 materially.

- [ ] **Step 4: Save the captured body verbatim as the fixture**

Paste the exact JSON body posted to `/v1/metrics` into `src-tauri/tests/otlp_fixture.json`. This real payload — not the illustrative one in Task 2 — is the source of truth for the parser tests. Keep `terminal.id` = `TEST-TERMINAL-1`.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/tests/otlp_fixture.json
git commit -m "test: capture real OTLP metrics fixture from claude CLI"
```

---

## Task 2: Pure OTLP/JSON parser with unit tests

**Files:**
- Create: `src-tauri/src/otel_receiver.rs`
- Test: inline `#[cfg(test)]` module in `src-tauri/src/otel_receiver.rs` (reads `tests/otlp_fixture.json`)

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/otel_receiver.rs` with ONLY the type, a stub, and the test:

```rust
use serde::Serialize;

/// One terminal's metrics extracted from a single OTLP/JSON export.
/// Fields are `Option` because a given export may carry only some metrics.
/// VERIFIED (Task 1, claude v2.1.159): counters arrive as DELTA increments
/// (aggregationTemporality=1) — each export is the delta since the last, so the
/// aggregator SUMS them. Token values are `asDouble` (JSON numbers), type key is
/// `type` with camelCase values input/output/cacheRead/cacheCreation.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct SessionMetricUpdate {
    pub terminal_id: String,
    pub cost_usd: Option<f64>,
    pub tokens_input: Option<u64>,
    pub tokens_output: Option<u64>,
    pub tokens_cache_read: Option<u64>,
    pub tokens_cache_creation: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
}

/// Parse an OTLP/HTTP JSON metrics body into one update per terminal.id resource.
/// Returns an empty Vec for bodies with no `terminal.id` resource attribute.
pub fn parse_otlp_metrics(_body: &str) -> Vec<SessionMetricUpdate> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixture_into_one_keyed_update() {
        let body = include_str!("../tests/otlp_fixture.json");
        let updates = parse_otlp_metrics(body);
        let u = updates
            .iter()
            .find(|u| u.terminal_id == "TEST-TERMINAL-1")
            .expect("fixture must contain terminal.id=TEST-TERMINAL-1");
        // At least cost OR tokens must be populated from a real session turn.
        assert!(
            u.cost_usd.is_some() || u.tokens_input.is_some() || u.tokens_output.is_some(),
            "expected cost or token data, got {:?}",
            u
        );
    }

    #[test]
    fn ignores_bodies_without_terminal_id() {
        let body = r#"{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[]}]}"#;
        assert!(parse_otlp_metrics(body).is_empty());
    }

    #[test]
    fn extracts_cost_and_token_types_from_illustrative_payload() {
        // Illustrative OTLP/JSON shape — asInt is a STRING per protobuf-JSON,
        // asDouble is a number. Verify the real fixture matches this shape in Task 1.
        let body = r#"{
          "resourceMetrics":[{
            "resource":{"attributes":[
              {"key":"terminal.id","value":{"stringValue":"T9"}}
            ]},
            "scopeMetrics":[{"metrics":[
              {"name":"claude_code.cost.usage","sum":{"dataPoints":[
                {"asDouble":0.0123,"attributes":[]}
              ]}},
              {"name":"claude_code.token.usage","sum":{"dataPoints":[
                {"asInt":"1500","attributes":[{"key":"type","value":{"stringValue":"input"}}]},
                {"asInt":"320","attributes":[{"key":"type","value":{"stringValue":"output"}}]},
                {"asInt":"80","attributes":[{"key":"type","value":{"stringValue":"cacheRead"}}]}
              ]}}
            ]}]
          }]
        }"#;
        let u = &parse_otlp_metrics(body)[0];
        assert_eq!(u.terminal_id, "T9");
        assert_eq!(u.cost_usd, Some(0.0123));
        assert_eq!(u.tokens_input, Some(1500));
        assert_eq!(u.tokens_output, Some(320));
        assert_eq!(u.tokens_cache_read, Some(80));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri; cargo test --lib otel_receiver`
Expected: FAIL — `not yet implemented` panic (the `unimplemented!()` stub) on the parsing tests.

- [ ] **Step 3: Implement the parser**

Replace the `parse_otlp_metrics` stub body with:

```rust
use serde_json::Value;

/// Read an OTLP numeric data-point value. `asInt` is a JSON string (protobuf
/// int64-as-string), `asDouble` is a number; tolerate either encoding for both.
fn point_u64(p: &Value) -> Option<u64> {
    if let Some(s) = p.get("asInt").and_then(|v| v.as_str()) {
        return s.parse::<u64>().ok();
    }
    if let Some(n) = p.get("asInt").and_then(|v| v.as_u64()) {
        return Some(n);
    }
    p.get("asDouble").and_then(|v| v.as_f64()).map(|f| f as u64)
}

fn point_f64(p: &Value) -> Option<f64> {
    if let Some(f) = p.get("asDouble").and_then(|v| v.as_f64()) {
        return Some(f);
    }
    p.get("asInt")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
}

/// Find the `type` attribute string on a data point (input/output/cacheRead/...).
fn point_type(p: &Value) -> Option<String> {
    p.get("attributes")?.as_array()?.iter().find_map(|a| {
        if a.get("key")?.as_str()? == "type" {
            a.get("value")?.get("stringValue")?.as_str().map(String::from)
        } else {
            None
        }
    })
}

fn data_points(metric: &Value) -> &[Value] {
    // Counters arrive as `sum`; gauges as `gauge`. Both expose `dataPoints`.
    metric
        .get("sum")
        .or_else(|| metric.get("gauge"))
        .and_then(|s| s.get("dataPoints"))
        .and_then(|d| d.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[])
}

pub fn parse_otlp_metrics(body: &str) -> Vec<SessionMetricUpdate> {
    let root: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();

    let resource_metrics = root
        .get("resourceMetrics")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for rm in &resource_metrics {
        // Resolve terminal.id from resource attributes; skip if absent.
        let terminal_id = rm
            .get("resource")
            .and_then(|r| r.get("attributes"))
            .and_then(|a| a.as_array())
            .and_then(|attrs| {
                attrs.iter().find_map(|a| {
                    if a.get("key")?.as_str()? == "terminal.id" {
                        a.get("value")?.get("stringValue")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
            });
        let terminal_id = match terminal_id {
            Some(id) => id,
            None => continue,
        };

        let mut u = SessionMetricUpdate { terminal_id, ..Default::default() };

        let scope_metrics = rm.get("scopeMetrics").and_then(|v| v.as_array());
        for sm in scope_metrics.into_iter().flatten() {
            for metric in sm.get("metrics").and_then(|m| m.as_array()).into_iter().flatten() {
                let name = metric.get("name").and_then(|n| n.as_str()).unwrap_or("");
                match name {
                    "claude_code.cost.usage" => {
                        // Cumulative: sum the points present in this export.
                        let total: f64 = data_points(metric).iter().filter_map(point_f64).sum();
                        u.cost_usd = Some(u.cost_usd.unwrap_or(0.0) + total);
                    }
                    "claude_code.token.usage" => {
                        for p in data_points(metric) {
                            let val = point_u64(p);
                            match point_type(p).as_deref() {
                                Some("input") => u.tokens_input = val,
                                Some("output") => u.tokens_output = val,
                                Some("cacheRead") => u.tokens_cache_read = val,
                                Some("cacheCreation") => u.tokens_cache_creation = val,
                                _ => {}
                            }
                        }
                    }
                    "claude_code.lines_of_code.count" => {
                        for p in data_points(metric) {
                            let val = point_u64(p);
                            match point_type(p).as_deref() {
                                Some("added") => u.lines_added = val,
                                Some("removed") => u.lines_removed = val,
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        out.push(u);
    }
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri; cargo test --lib otel_receiver`
Expected: PASS (3 tests). If `parses_fixture_into_one_keyed_update` fails, the real fixture's metric names/shape differ from assumptions — adjust the `match` arms to the captured names and re-run.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/otel_receiver.rs
git commit -m "feat: OTLP/JSON metrics parser for per-session telemetry"
```

---

## Task 3: Embedded receiver server + cumulative aggregator

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/otel_receiver.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/otel_receiver.rs`

- [ ] **Step 1: Add the `tiny_http` dependency**

In `src-tauri/Cargo.toml`, under `[dependencies]` (after the `trash = "5"` line):

```toml
tiny_http = "0.12"
```

- [ ] **Step 2: Write the failing aggregator test**

Append to the `tests` module in `otel_receiver.rs`:

```rust
    #[test]
    fn aggregator_sums_delta_exports() {
        let mut agg = MetricsAggregator::new();
        let first = SessionMetricUpdate {
            terminal_id: "A".into(),
            cost_usd: Some(0.01),
            tokens_input: Some(100),
            ..Default::default()
        };
        let merged1 = agg.apply(first);
        assert_eq!(merged1.cost_usd, Some(0.01));
        assert_eq!(merged1.tokens_input, Some(100));

        // DELTA temporality: each export is an increment. The second export adds
        // 0.05 cost + 40 output tokens; input is absent (delta 0) so it stays 100.
        let second = SessionMetricUpdate {
            terminal_id: "A".into(),
            cost_usd: Some(0.05),
            tokens_output: Some(40),
            ..Default::default()
        };
        let merged2 = agg.apply(second);
        assert_eq!(merged2.cost_usd, Some(0.06)); // 0.01 + 0.05
        assert_eq!(merged2.tokens_input, Some(100)); // unchanged (no delta)
        assert_eq!(merged2.tokens_output, Some(40));
    }
```

- [ ] **Step 3: Run it to verify failure**

Run: `cd src-tauri; cargo test --lib otel_receiver`
Expected: FAIL — `cannot find type MetricsAggregator`.

- [ ] **Step 4: Implement the aggregator**

Add to `otel_receiver.rs` (above the `tests` module):

```rust
use std::collections::HashMap;

/// Holds the running per-terminal totals. Claude emits DELTA metrics
/// (aggregationTemporality=1), so each export is an increment we ADD; a partial
/// export (e.g. cost-only) leaves previously-accumulated token totals intact.
pub struct MetricsAggregator {
    by_terminal: HashMap<String, SessionMetricUpdate>,
}

impl MetricsAggregator {
    pub fn new() -> Self {
        Self { by_terminal: HashMap::new() }
    }

    /// Add a delta export into the running total and return the full snapshot.
    pub fn apply(&mut self, u: SessionMetricUpdate) -> SessionMetricUpdate {
        let entry = self
            .by_terminal
            .entry(u.terminal_id.clone())
            .or_insert_with(|| SessionMetricUpdate {
                terminal_id: u.terminal_id.clone(),
                ..Default::default()
            });
        // DELTA temporality: accumulate increments; absent field => no change.
        fn add_f(acc: &mut Option<f64>, d: Option<f64>) {
            if let Some(x) = d { *acc = Some(acc.unwrap_or(0.0) + x); }
        }
        fn add_u(acc: &mut Option<u64>, d: Option<u64>) {
            if let Some(x) = d { *acc = Some(acc.unwrap_or(0) + x); }
        }
        add_f(&mut entry.cost_usd, u.cost_usd);
        add_u(&mut entry.tokens_input, u.tokens_input);
        add_u(&mut entry.tokens_output, u.tokens_output);
        add_u(&mut entry.tokens_cache_read, u.tokens_cache_read);
        add_u(&mut entry.tokens_cache_creation, u.tokens_cache_creation);
        add_u(&mut entry.lines_added, u.lines_added);
        add_u(&mut entry.lines_removed, u.lines_removed);
        entry.clone()
    }

    /// Drop a terminal's accumulated metrics (called when a terminal closes).
    pub fn forget(&mut self, terminal_id: &str) {
        self.by_terminal.remove(terminal_id);
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd src-tauri; cargo test --lib otel_receiver`
Expected: PASS (4 tests).

- [ ] **Step 6: Implement the server entry point (no unit test — integration-covered in Task 5)**

Add to `otel_receiver.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Start an OTLP/HTTP-JSON metrics receiver on an ephemeral localhost port.
/// Returns the bound port. Spawns one accept thread; each POST /v1/metrics is
/// parsed, merged, and emitted to the frontend as `terminal-metrics`.
/// The returned `Arc<Mutex<MetricsAggregator>>` lets close_terminal forget state.
pub fn start(app: AppHandle) -> std::io::Result<(u16, Arc<Mutex<MetricsAggregator>>)> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let agg = Arc::new(Mutex::new(MetricsAggregator::new()));
    let agg_thread = agg.clone();

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            // Only metrics POSTs carry a body we care about.
            let mut body = String::new();
            use std::io::Read;
            let _ = request.as_reader().read_to_string(&mut body);

            let updates = parse_otlp_metrics(&body);
            {
                let mut guard = match agg_thread.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(), // poisoned: recover, telemetry is non-critical
                };
                for u in updates {
                    let merged = guard.apply(u);
                    if let Err(e) = app.emit("terminal-metrics", &merged) {
                        eprintln!("Failed to emit terminal-metrics: {}", e);
                    }
                }
            }
            // OTLP expects 200 with an (empty) JSON body.
            let response = tiny_http::Response::from_string("{}")
                .with_status_code(200)
                .with_header(
                    "Content-Type: application/json".parse::<tiny_http::Header>().unwrap(),
                );
            let _ = request.respond(response);
        }
    });

    Ok((port, agg))
}
```

- [ ] **Step 7: Build to verify it compiles**

Run: `cd src-tauri; cargo build`
Expected: compiles (warnings about `forget` being unused are fine until Task 6).

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/otel_receiver.rs
git commit -m "feat: embedded OTLP receiver server + cumulative aggregator"
```

---

## Task 4: Register the module and start the receiver at app setup

**Files:**
- Modify: `src-tauri/src/main.rs:18-21` (AppState) and the `setup` closure around `src-tauri/src/main.rs:56-63`
- Modify: `src-tauri/src/commands.rs:18-21` (AppState definition lives here per the grep)

> NOTE: `AppState` is defined in `commands.rs` (lines 18–21) and used in `main.rs`. Confirm with `grep -n "pub struct AppState" src-tauri/src`. Edit it where defined.

- [ ] **Step 1: Add `otel_port` and `otel_agg` to AppState**

In `src-tauri/src/commands.rs`, extend the struct (lines 18–21):

```rust
pub struct AppState {
    pub terminals: Arc<Mutex<terminal::TerminalManager>>,
    pub db: Arc<Mutex<database::Database>>,
    /// Localhost port of the embedded OTLP metrics receiver (0 if disabled/failed).
    pub otel_port: u16,
    /// Shared aggregator so close_terminal can forget a terminal's metrics.
    pub otel_agg: std::sync::Arc<std::sync::Mutex<crate::otel_receiver::MetricsAggregator>>,
}
```

- [ ] **Step 2: Declare the module in main.rs**

In `src-tauri/src/main.rs`, with the other `mod` declarations near the top (find them via `grep -n "^mod " src-tauri/src/main.rs`), add:

```rust
mod otel_receiver;
```

- [ ] **Step 3: Start the receiver and populate AppState in setup**

In `src-tauri/src/main.rs`, replace the `app.manage(AppState { ... })` block (lines 60–63) with:

```rust
            let (otel_port, otel_agg) = match otel_receiver::start(app.handle().clone()) {
                Ok((port, agg)) => {
                    eprintln!("[otel] metrics receiver listening on 127.0.0.1:{}", port);
                    (port, agg)
                }
                Err(e) => {
                    eprintln!("[otel] failed to start metrics receiver: {} (cost tracking disabled)", e);
                    (0, std::sync::Arc::new(std::sync::Mutex::new(otel_receiver::MetricsAggregator::new())))
                }
            };

            app.manage(AppState {
                terminals: Arc::new(Mutex::new(terminal_manager)),
                db: Arc::new(Mutex::new(db)),
                otel_port,
                otel_agg,
            });
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd src-tauri; cargo build`
Expected: compiles. (`tauri::Emitter` import in `otel_receiver.rs` must resolve — Tauri 2 re-exports it; if not, use `use tauri::Manager;` + `app.emit_to`/`app.emit` per the version. Match the import style already used in `commands.rs` for `app.emit`.)

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/main.rs src-tauri/src/commands.rs
git commit -m "feat: start OTLP receiver at app setup, expose port on AppState"
```

---

## Task 5: Inject OTel env vars per terminal in terminal.rs

**Files:**
- Modify: `src-tauri/src/terminal.rs:74-86` (signature) and `:148-214` (id generation + env injection)

This is the heart of the feature — the env injection at the PTY spawn point.

- [ ] **Step 1: Add the telemetry params to `create_terminal`'s signature**

In `src-tauri/src/terminal.rs`, extend the signature (after `continue_recent: bool,` at line 85):

```rust
        continue_recent: bool,
        /// `http://127.0.0.1:<port>` base of the embedded OTLP receiver, or
        /// None when cost tracking is disabled / the receiver failed to start.
        otel_endpoint: Option<String>,
```

- [ ] **Step 2: Generate the terminal id BEFORE building the command**

Currently `id` is created at line 214 (after spawn). Move it up. Immediately after the `safe_env_vars` filter block (after line 135, before `let pty_system = ...`), add:

```rust
        // Generate the id early so it can be injected as an OTel resource
        // attribute (terminal.id) — the receiver routes metrics back by it.
        let id = Uuid::new_v4().to_string();
```

Then at the original id site (line 214), DELETE the now-duplicate `let id = Uuid::new_v4().to_string();` so the later `let config = TerminalConfig { id: id.clone(), ... }` reuses the early `id`.

- [ ] **Step 3: Inject the OTel env vars after the user env loop**

In `src-tauri/src/terminal.rs`, immediately AFTER the existing user-env loop (lines 205–208):

```rust
        // Set environment variables (blocked keys already filtered out)
        for (key, value) in &safe_env_vars {
            cmd.env(key, value);
        }

        // Inject Claude Code OpenTelemetry config LAST so it wins over any
        // user-profile env, pointing the CLI's OTLP metrics exporter at our
        // embedded localhost receiver and tagging the resource with our id.
        if let Some(endpoint) = otel_endpoint.as_deref() {
            cmd.env("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
            cmd.env("OTEL_METRICS_EXPORTER", "otlp");
            cmd.env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
            cmd.env("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/json");
            cmd.env("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
            cmd.env("OTEL_EXPORTER_OTLP_COMPRESSION", "none");
            // 3s export interval ≈ near-real-time without hammering (default 60s).
            cmd.env("OTEL_METRIC_EXPORT_INTERVAL", "3000");
            cmd.env("OTEL_METRICS_INCLUDE_SESSION_ID", "true");
            cmd.env("OTEL_RESOURCE_ATTRIBUTES", format!("terminal.id={}", id));
        }
```

- [ ] **Step 4: Build to verify the signature change ripples to callers**

Run: `cd src-tauri; cargo build`
Expected: FAIL — `create_terminal` now has an arg the caller in `commands.rs` doesn't pass. That compile error is the contract for Task 6. (`create_script_terminal` is a separate fn and is unaffected — scripts get no telemetry.)

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/terminal.rs
git commit -m "feat: inject Claude Code OTel env vars per terminal at spawn"
```

---

## Task 6: Thread endpoint + enable flag through the command layer

**Files:**
- Modify: `src-tauri/src/commands.rs:245-292` (`create_terminal` command + `CreateTerminalRequest`) and `close_terminal` (around `:442`)

- [ ] **Step 1: Add a `cost_tracking` flag to the request struct**

In `src-tauri/src/commands.rs`, find `pub struct CreateTerminalRequest` (just above line 245) and add a field with a default so older callers/persisted rows still deserialize:

```rust
    /// Whether to enable per-session OTel cost/token tracking for this terminal.
    #[serde(default)]
    pub cost_tracking: bool,
```

- [ ] **Step 2: Compute the endpoint and pass it into `create_terminal`**

In `src-tauri/src/commands.rs`, inside the `create_terminal` command, just before the `let config = { ... terminals.create_terminal(...) }` block (line 278), add:

```rust
        // Build the OTLP endpoint only when the user enabled tracking AND the
        // receiver actually started (port != 0).
        let otel_endpoint = if request.cost_tracking && state.otel_port != 0 {
            Some(format!("http://127.0.0.1:{}", state.otel_port))
        } else {
            None
        };
```

Then add `otel_endpoint,` as the final argument to the `terminals.create_terminal(...)` call (after `continue_recent,` at line 290):

```rust
                continue_recent,
                otel_endpoint,
            )?
```

- [ ] **Step 3: Forget metrics when a terminal closes**

In `src-tauri/src/commands.rs`, find `pub async fn close_terminal` (line 442). Inside it, after the terminal is removed from the manager, add:

```rust
        // Drop accumulated telemetry so a reused id can't inherit stale totals.
        if let Ok(mut agg) = state.otel_agg.lock() {
            agg.forget(&id);
        }
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd src-tauri; cargo build`
Expected: PASS — the signature mismatch from Task 5 is resolved.

- [ ] **Step 5: Manual integration check (the real end-to-end gate)**

Run: `npm run tauri dev`. Open a terminal **with cost tracking on** (until Task 10 wires the UI toggle, temporarily hardcode `cost_tracking: true` in the `createTerminal` invoke in `terminalStore.ts`, or pass it via devtools). Send a prompt. Within ~5s, the dev console (Rust stderr) should show no emit errors, and adding a `console.log` in the Task 8 listener should show `terminal-metrics` payloads with a non-zero `cost_usd`. Revert any temporary hardcoding before Step 6.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/commands.rs
git commit -m "feat: wire per-session cost tracking through create/close commands"
```

---

## Task 7: Frontend SessionMetrics type, store map, and merge helper

**Files:**
- Create: `src/lib/sessionMetrics.ts`
- Modify: `src/store/terminalStore.ts`
- Test: `src/lib/sessionMetrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sessionMetrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyMetrics, totalTokens, type SessionMetrics } from './sessionMetrics';

describe('sessionMetrics', () => {
  it('emptyMetrics is all zero', () => {
    expect(emptyMetrics()).toEqual({
      costUsd: 0, tokensInput: 0, tokensOutput: 0,
      tokensCacheRead: 0, tokensCacheCreation: 0,
      linesAdded: 0, linesRemoved: 0,
    });
  });

  it('totalTokens sums all four token buckets', () => {
    const m: SessionMetrics = {
      ...emptyMetrics(),
      tokensInput: 100, tokensOutput: 40, tokensCacheRead: 10, tokensCacheCreation: 5,
    };
    expect(totalTokens(m)).toBe(155);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run test:run -- sessionMetrics`
Expected: FAIL — cannot resolve `./sessionMetrics`.

- [ ] **Step 3: Implement the lib**

Create `src/lib/sessionMetrics.ts`:

```ts
/** Per-terminal cumulative metrics, mirrored from the Rust SessionMetricUpdate. */
export interface SessionMetrics {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  linesAdded: number;
  linesRemoved: number;
}

/** The Rust event payload (snake_case, Option fields → possibly undefined). */
export interface TerminalMetricsPayload {
  terminal_id: string;
  cost_usd?: number | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_creation?: number | null;
  lines_added?: number | null;
  lines_removed?: number | null;
}

export function emptyMetrics(): SessionMetrics {
  return {
    costUsd: 0, tokensInput: 0, tokensOutput: 0,
    tokensCacheRead: 0, tokensCacheCreation: 0,
    linesAdded: 0, linesRemoved: 0,
  };
}

export function totalTokens(m: SessionMetrics): number {
  return m.tokensInput + m.tokensOutput + m.tokensCacheRead + m.tokensCacheCreation;
}

/** Apply an event payload over a prior snapshot. The BACKEND already summed the
 *  DELTA exports into a running total before emitting, so each payload is the
 *  full cumulative snapshot — the frontend takes latest-value-wins, NOT summing. */
export function mergeMetrics(prev: SessionMetrics, p: TerminalMetricsPayload): SessionMetrics {
  const pick = (v: number | null | undefined, fallback: number) =>
    typeof v === 'number' ? v : fallback;
  return {
    costUsd: pick(p.cost_usd, prev.costUsd),
    tokensInput: pick(p.tokens_input, prev.tokensInput),
    tokensOutput: pick(p.tokens_output, prev.tokensOutput),
    tokensCacheRead: pick(p.tokens_cache_read, prev.tokensCacheRead),
    tokensCacheCreation: pick(p.tokens_cache_creation, prev.tokensCacheCreation),
    linesAdded: pick(p.lines_added, prev.linesAdded),
    linesRemoved: pick(p.lines_removed, prev.linesRemoved),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:run -- sessionMetrics`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the metrics map + setter to the store**

In `src/store/terminalStore.ts`:

(a) Add the import near the top (after the `SessionState` import on line 7):

```ts
import { mergeMetrics, emptyMetrics, type SessionMetrics, type TerminalMetricsPayload } from '../lib/sessionMetrics';
```

(b) In the `TerminalState` interface, after `terminalStates: Map<string, SessionState>;` (line 61):

```ts
  // Live per-terminal cost/token metrics from the OTel receiver.
  terminalMetrics: Map<string, SessionMetrics>;
```

(c) In the actions section of the interface (after `setTerminalState` on line 100):

```ts
  applyTerminalMetrics: (payload: TerminalMetricsPayload) => void;
```

(d) In the store initializer, after `terminalStates: new Map(),` (line 122):

```ts
  terminalMetrics: new Map(),
```

(e) Add the action implementation (after the `setTerminalState` impl, around line 441):

```ts
  applyTerminalMetrics: (payload) => {
    const id = payload.terminal_id;
    set((s) => {
      const prev = s.terminalMetrics.get(id) ?? emptyMetrics();
      const next = mergeMetrics(prev, payload);
      const map = new Map(s.terminalMetrics);
      map.set(id, next);
      return { terminalMetrics: map };
    });
  },
```

(f) In `closeTerminal`'s `set` updater, alongside the other map cleanups (after the `newStates.delete(id)` block near line 269), add:

```ts
      const newMetrics = new Map(state.terminalMetrics);
      newMetrics.delete(id);
      if (childId) newMetrics.delete(childId);
```

and include `terminalMetrics: newMetrics,` in that `set`'s returned object.

- [ ] **Step 6: Build to verify types**

Run: `npm run build`
Expected: `tsc` passes (no type errors).

- [ ] **Step 7: Commit**

```powershell
git add src/lib/sessionMetrics.ts src/lib/sessionMetrics.test.ts src/store/terminalStore.ts
git commit -m "feat: terminalMetrics store + merge helpers"
```

---

## Task 8: Listen for `terminal-metrics` events in App.tsx

**Files:**
- Modify: `src/App.tsx` (around the existing `terminal-output` listener, lines 185–205)

- [ ] **Step 1: Pull the action from the store**

In `src/App.tsx`, extend the `useTerminalStore()` destructure on line 107:

```ts
  const { handleTerminalOutput, updateTerminalStatus, setLoopMode, setSessionSummary, createTerminal, createShellTerminalTab, applyTerminalMetrics } = useTerminalStore();
```

- [ ] **Step 2: Add the listener effect**

In `src/App.tsx`, after the `terminal-output` listener `useEffect` (ends line 205), add:

```tsx
  useEffect(() => {
    const unlisten = listen<TerminalMetricsPayload>('terminal-metrics', (event) => {
      applyTerminalMetrics(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyTerminalMetrics]);
```

- [ ] **Step 3: Add the type import**

Near the top of `src/App.tsx`, with the other imports:

```ts
import type { TerminalMetricsPayload } from './lib/sessionMetrics';
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: passes.

- [ ] **Step 5: Commit**

```powershell
git add src/App.tsx
git commit -m "feat: subscribe to terminal-metrics events"
```

---

## Task 9: Per-tab cost chip in TerminalTabs

**Files:**
- Modify: `src/components/TerminalTabs.tsx` (badges block, after the model badge at lines 274–284)

- [ ] **Step 1: Add a cost formatter (top of file, after `fileBasename`, line 25)**

```ts
function formatCost(usd: number): string {
  if (usd <= 0) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
```

- [ ] **Step 2: Subscribe to the metrics map**

In `src/components/TerminalTabs.tsx`, after the `terminalStates` subscription (line 33):

```ts
  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);
```

- [ ] **Step 3: Render the chip in the badges block**

In the `.map((terminal) => {...})` render, immediately AFTER the model badge block (after line 284, before the `{isWorktree && ...}` block):

```tsx
                  {(() => {
                    const cost = terminalMetrics.get(terminal.id)?.costUsd ?? 0;
                    const label = formatCost(cost);
                    if (!label) return null;
                    return (
                      <span
                        className="text-[9px] px-1 rounded font-medium flex-shrink-0 bg-emerald-500/15 text-emerald-400 tabular-nums"
                        title="Estimated session cost (live)"
                      >
                        {label}
                      </span>
                    );
                  })()}
```

- [ ] **Step 4: Verify visually**

Run: `npm run tauri dev`, open a cost-tracked terminal (temporarily force `cost_tracking: true` as in Task 6 Step 5 until Task 10 lands), send a prompt, confirm the green `$x.xx` chip appears on the tab within a few seconds and updates.

- [ ] **Step 5: Commit**

```powershell
git add src/components/TerminalTabs.tsx
git commit -m "feat: live per-tab estimated-cost chip"
```

---

## Task 10: Settings — enable toggle, budget input, and wire into createTerminal

**Files:**
- Modify: `src/store/appStore.ts` (interface near line 61, defaults near line 400, persist `partialize`)
- Modify: `src/store/terminalStore.ts` (`createTerminal` invoke, line 130)
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Add settings fields to appStore**

In `src/store/appStore.ts`, in the `AppState` interface near the other booleans (after `telemetryEnabled: boolean;` line 61):

```ts
  // Per-session OTel cost/token tracking (distinct from the analytics heartbeat
  // `telemetryEnabled`, which reports to ct-analytics). This is local only.
  costTrackingEnabled: boolean;
  // Per-session budget ceiling in USD; 0 = no cap. Used by Task 11.
  sessionBudgetUsd: number;
  setCostTrackingEnabled: (v: boolean) => void;
  setSessionBudgetUsd: (v: number) => void;
```

- [ ] **Step 2: Add defaults + actions in the store body**

In the persisted store initializer (near `notifyOnFinish: true,` line 400):

```ts
      costTrackingEnabled: true,
      sessionBudgetUsd: 0,
```

And with the other setters in the store body:

```ts
      setCostTrackingEnabled: (v) => set({ costTrackingEnabled: v }),
      setSessionBudgetUsd: (v) => set({ sessionBudgetUsd: Math.max(0, v) }),
```

- [ ] **Step 3: Persist the new fields**

In `src/store/appStore.ts`, find the `persist(...)` config's `partialize` (search `partialize`). Add `costTrackingEnabled` and `sessionBudgetUsd` to the persisted object so they survive restart (match the existing style — list them alongside `notifyOnFinish`).

- [ ] **Step 4: Pass the flag from createTerminal**

In `src/store/terminalStore.ts`, the `createTerminal` action builds the `request` (lines 130–141). Add `cost_tracking` by reading the setting via a dynamic import (avoids the appStore↔terminalStore cycle, matching the pattern already used at line 230):

```ts
  createTerminal: async (label, workingDirectory, claudeArgs, envVars, colorTag, nickname, restoredOutput, resumeSessionId, continueRecent) => {
    try {
      const { useAppStore } = await import('./appStore');
      const costTracking = useAppStore.getState().costTrackingEnabled;
      const config = await invoke<TerminalConfig>('create_terminal', {
        request: {
          label,
          working_directory: workingDirectory,
          claude_args: claudeArgs,
          env_vars: envVars,
          color_tag: colorTag || null,
          nickname: nickname || null,
          resume_session_id: resumeSessionId || null,
          continue_recent: !!continueRecent,
          cost_tracking: costTracking,
        },
      });
```

- [ ] **Step 5: Add the Settings UI controls**

In `src/components/SettingsModal.tsx`, locate the behavior toggles section (search for where `notifyOnFinish` is rendered) and add, matching the existing toggle markup:

```tsx
      {/* Cost tracking toggle — mirror the notifyOnFinish toggle's markup */}
      <label className="flex items-center justify-between">
        <span>
          <span className="block text-text-primary text-[13px]">Track per-session cost</span>
          <span className="block text-text-tertiary text-[11px]">
            Live token & estimated-USD metrics per terminal (local OpenTelemetry, no data leaves your machine)
          </span>
        </span>
        <input
          type="checkbox"
          checked={costTrackingEnabled}
          onChange={(e) => setCostTrackingEnabled(e.target.checked)}
        />
      </label>

      {/* Per-session budget cap */}
      <label className="flex items-center justify-between">
        <span>
          <span className="block text-text-primary text-[13px]">Per-session budget cap (USD)</span>
          <span className="block text-text-tertiary text-[11px]">0 = no cap. Warns when a session's estimated cost exceeds this.</span>
        </span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={sessionBudgetUsd}
          onChange={(e) => setSessionBudgetUsd(parseFloat(e.target.value) || 0)}
          className="w-20 bg-elevation-2 rounded px-2 py-1 text-[12px] text-text-primary"
        />
      </label>
```

Pull `costTrackingEnabled`, `setCostTrackingEnabled`, `sessionBudgetUsd`, `setSessionBudgetUsd` from `useAppStore()` at the top of `SettingsModal` (match how `notifyOnFinish` is read there).

- [ ] **Step 6: Build + verify the toggle gates telemetry**

Run: `npm run build` (expect pass), then `npm run tauri dev`. With the toggle OFF, a new terminal should produce no `terminal-metrics` / no cost chip; with it ON, the chip appears. Now remove any temporary `cost_tracking: true` hardcoding from Tasks 6/9.

- [ ] **Step 7: Commit**

```powershell
git add src/store/appStore.ts src/store/terminalStore.ts src/components/SettingsModal.tsx
git commit -m "feat: cost-tracking + budget settings, gate telemetry on toggle"
```

---

## Phase C

## Task 11: Per-session budget cap — warn + offer to stop

**Files:**
- Create: `src/components/SessionMetricsPanel.tsx` (detail panel; also the natural home for the budget bar)
- Modify: `src/App.tsx` (budget-watch effect)
- Modify: `src/store/terminalStore.ts` (`budgetWarnedIds` set to fire once)

- [ ] **Step 1: Add a one-shot warned-set to the store**

In `src/store/terminalStore.ts` interface (after `terminalMetrics`):

```ts
  // Terminals already warned about exceeding the budget cap (fire-once).
  budgetWarnedIds: Set<string>;
  markBudgetWarned: (id: string) => void;
```

Initializer: `budgetWarnedIds: new Set(),`

Action:

```ts
  markBudgetWarned: (id) => set((s) => {
    if (s.budgetWarnedIds.has(id)) return {};
    const next = new Set(s.budgetWarnedIds);
    next.add(id);
    return { budgetWarnedIds: next };
  }),
```

Also `delete(id)` it in `closeTerminal`'s cleanup (alongside `newMetrics`).

- [ ] **Step 2: Add the budget-watch effect in App.tsx**

In `src/App.tsx`, after the `terminal-metrics` listener effect (Task 8):

```tsx
  const terminalMetrics = useTerminalStore((s) => s.terminalMetrics);
  const budgetWarnedIds = useTerminalStore((s) => s.budgetWarnedIds);
  const markBudgetWarned = useTerminalStore((s) => s.markBudgetWarned);
  const sessionBudgetUsd = useAppStore((s) => s.sessionBudgetUsd);

  useEffect(() => {
    if (sessionBudgetUsd <= 0) return;
    for (const [id, m] of terminalMetrics) {
      if (m.costUsd >= sessionBudgetUsd && !budgetWarnedIds.has(id)) {
        markBudgetWarned(id);
        const inst = useTerminalStore.getState().terminals.get(id);
        const name = inst?.config.nickname || inst?.config.label || id;
        notify(
          'Session over budget',
          `"${name}" reached $${m.costUsd.toFixed(2)} (cap $${sessionBudgetUsd.toFixed(2)}).`,
        );
      }
    }
  }, [terminalMetrics, sessionBudgetUsd, budgetWarnedIds, markBudgetWarned, notify]);
```

(`notify` is already in scope from `useNotification()` at line 109; `useAppStore` is already imported.)

> Design note: MVP is **warn-only** (non-destructive). Auto-stop would call the existing `closeTerminal(id)` here, but killing a session mid-write risks losing the user's in-flight turn — gate any auto-stop behind an explicit opt-in setting in a later iteration, not this task.

- [ ] **Step 3: Create the detail panel with a budget progress bar**

Create `src/components/SessionMetricsPanel.tsx`:

```tsx
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { totalTokens } from '../lib/sessionMetrics';

export function SessionMetricsPanel({ terminalId }: { terminalId: string }) {
  const metrics = useTerminalStore((s) => s.terminalMetrics.get(terminalId));
  const budget = useAppStore((s) => s.sessionBudgetUsd);
  if (!metrics) return null;

  const pct = budget > 0 ? Math.min(100, (metrics.costUsd / budget) * 100) : 0;
  const over = budget > 0 && metrics.costUsd >= budget;

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between text-[11px] py-0.5">
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text-secondary tabular-nums">{value}</span>
    </div>
  );

  return (
    <div className="px-3 py-2 border-t border-[var(--ij-divider)] bg-elevation-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-text-tertiary uppercase tracking-wide">Session cost (est.)</span>
        <span className={`text-[13px] font-medium tabular-nums ${over ? 'text-red-400' : 'text-emerald-400'}`}>
          ${metrics.costUsd.toFixed(2)}
        </span>
      </div>
      {budget > 0 && (
        <div className="h-1 rounded-full bg-white/[0.08] mb-2 overflow-hidden">
          <div
            className={`h-full ${over ? 'bg-red-400' : 'bg-emerald-400'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <Row label="Input tokens" value={metrics.tokensInput.toLocaleString()} />
      <Row label="Output tokens" value={metrics.tokensOutput.toLocaleString()} />
      <Row label="Cache read" value={metrics.tokensCacheRead.toLocaleString()} />
      <Row label="Total tokens" value={totalTokens(metrics).toLocaleString()} />
    </div>
  );
}
```

- [ ] **Step 4: Mount the panel under the active terminal**

In `src/components/TerminalTabs.tsx`, in the content area where `SessionInsights` is conditionally rendered (lines 483–489), add the metrics panel alongside it:

```tsx
              {(() => {
                const inst = terminals.get(activeTerminalId);
                if (inst && useTerminalStore.getState().terminalMetrics.get(activeTerminalId)) {
                  return <SessionMetricsPanel terminalId={activeTerminalId} />;
                }
                return null;
              })()}
```

Add the import: `import { SessionMetricsPanel } from './SessionMetricsPanel';`

- [ ] **Step 5: Build + manual verify**

Run: `npm run build` (pass). Then `npm run tauri dev`: set a small budget (e.g. $0.05), run a prompt, confirm the panel shows token rows + cost, the bar fills, and a desktop notification fires once when cost crosses the cap (and does NOT re-fire on subsequent exports).

- [ ] **Step 6: Commit**

```powershell
git add src/components/SessionMetricsPanel.tsx src/components/TerminalTabs.tsx src/App.tsx src/store/terminalStore.ts
git commit -m "feat: session metrics panel + per-session budget warning"
```

---

## Final Verification

- [ ] **Run the full verification pipeline**

Run the project's `verification-loop` skill, or manually:

```powershell
cd src-tauri; cargo test; cargo build
```
```powershell
npm run test:run; npm run build
```
Expected: all tests pass, both builds clean.

- [ ] **Security sanity check**

Confirm the OTel receiver binds `127.0.0.1` only (never `0.0.0.0`) — verify the `Server::http("127.0.0.1:0")` literal in `otel_receiver.rs`. The receiver accepts only localhost POSTs and emits to the frontend; no untrusted external input reaches it. Run the `security-review` skill on the diff.

---

## Self-Review (completed by plan author)

**Spec coverage:** Live per-session token/cost (Tasks 2–9) ✓; per-tab visibility (Task 9) ✓; context/detail panel (Task 11) ✓; budget caps (Tasks 10–11) ✓; rides multi-agent/observability trend & built on existing PTY env injection (Architecture) ✓; differentiation = live per-session cost no competitor exposes (Architecture) ✓.

**Type consistency:** Rust `SessionMetricUpdate` (snake_case via serde) ↔ TS `TerminalMetricsPayload` (snake_case) ↔ `SessionMetrics` (camelCase, via `mergeMetrics`). Event name `terminal-metrics` consistent across `otel_receiver.rs` emit and `App.tsx` listen. `MetricsAggregator::{new,apply,forget}` used consistently in Tasks 3/4/6. `applyTerminalMetrics`/`terminalMetrics`/`budgetWarnedIds` names consistent across store/App/components.

**Placeholder scan:** No TBDs. Real code in every code step. The one empirical unknown (exact OTLP payload shape & metric names) is explicitly gated by Task 1's capture-and-replace-fixture step, with the parser's `match` arms flagged as the adjustment point if the captured names differ.

**Known risks flagged inline:** `http/json` support (Task 1 gate), `tauri::Emitter` import style (Task 4 Step 4), auto-stop deliberately deferred (Task 11 Step 2).
