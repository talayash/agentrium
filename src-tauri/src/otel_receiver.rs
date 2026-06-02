use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// One terminal's metrics extracted from a single OTLP/JSON export.
/// Fields are `Option` because a given export may carry only some metrics.
/// VERIFIED (Task 1, claude v2.1.159): counters arrive as DELTA increments
/// (aggregationTemporality=1) - each export is the delta since the last, so the
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

/// Read an OTLP numeric data-point value. `asInt` is a JSON string (protobuf
/// int64-as-string), `asDouble` is a number; tolerate either encoding for both.
fn point_u64(p: &Value) -> Option<u64> {
    if let Some(s) = p.get("asInt").and_then(|v| v.as_str()) {
        return s.parse::<u64>().ok();
    }
    if let Some(n) = p.get("asInt").and_then(|v| v.as_u64()) {
        return Some(n);
    }
    // Guard the f64→u64 cast: Rust `as` saturates, so a negative/NaN/inf would
    // silently become a bogus 0. Reject non-finite/negative instead.
    p.get("asDouble")
        .and_then(|v| v.as_f64())
        .and_then(|f| if f.is_finite() && f >= 0.0 { Some(f as u64) } else { None })
}

fn point_f64(p: &Value) -> Option<f64> {
    if let Some(f) = p.get("asDouble").and_then(|v| v.as_f64()) {
        // Don't propagate NaN/inf as a cost value.
        return if f.is_finite() { Some(f) } else { None };
    }
    if let Some(n) = p.get("asInt").and_then(|v| v.as_i64()) {
        return Some(n as f64);
    }
    p.get("asInt")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|f| f.is_finite())
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

/// Parse an OTLP/HTTP JSON metrics body into one update per terminal.id resource.
/// Returns an empty Vec for bodies with no `terminal.id` resource attribute.
pub fn parse_otlp_metrics(body: &str) -> Vec<SessionMetricUpdate> {
    let root: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();

    let resource_metrics = root
        .get("resourceMetrics")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    for rm in resource_metrics {
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

/// Start an OTLP/HTTP-JSON metrics receiver on an ephemeral localhost port.
/// Returns the bound port. Spawns one accept thread; each POST /v1/metrics is
/// parsed, merged, and emitted to the frontend as `terminal-metrics`.
/// The returned `Arc<Mutex<MetricsAggregator>>` lets close_terminal forget state.
pub fn start(app: tauri::AppHandle) -> std::io::Result<(u16, Arc<Mutex<MetricsAggregator>>)> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "OTLP receiver bound a non-IP address"))?;
    let agg = Arc::new(Mutex::new(MetricsAggregator::new()));
    let agg_thread = agg.clone();

    std::thread::spawn(move || {
        // Cap the body we'll buffer. The only legitimate client is the local
        // claude CLI posting small OTLP payloads (a few KB); the bound stops a
        // misbehaving local process from OOMing us with a giant body.
        const MAX_OTLP_BODY_BYTES: usize = 4 * 1024 * 1024;
        for mut request in server.incoming_requests() {
            // Reject oversized payloads up front via Content-Length.
            if request.body_length().is_some_and(|n| n > MAX_OTLP_BODY_BYTES) {
                let _ = request.respond(tiny_http::Response::empty(413));
                continue;
            }
            // Only metrics POSTs carry a body we care about.
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);

            let updates = parse_otlp_metrics(&body);
            {
                let mut guard = match agg_thread.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(), // poisoned: recover, telemetry is non-critical
                };
                for u in updates {
                    let merged = guard.apply(u);
                    use tauri::Emitter;
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
        eprintln!("[otel_receiver] accept loop exited - telemetry collection stopped");
    });

    Ok((port, agg))
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
        // Assert the exact values captured from the real session turn so a
        // token-parsing regression (wrong field/type-key) is caught.
        assert!(
            (u.cost_usd.expect("cost present") - 0.2390325).abs() < 1e-6,
            "cost_usd was {:?}",
            u.cost_usd
        );
        assert_eq!(u.tokens_input, Some(10319));
        assert_eq!(u.tokens_output, Some(95));
        assert_eq!(u.tokens_cache_read, Some(0));
        assert_eq!(u.tokens_cache_creation, Some(29610));
    }

    #[test]
    fn ignores_bodies_without_terminal_id() {
        let body = r#"{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[]}]}"#;
        assert!(parse_otlp_metrics(body).is_empty());
    }

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
        // Use epsilon comparison because 0.01 + 0.05 = 0.060000000000000005 in IEEE 754.
        assert!((merged2.cost_usd.unwrap() - 0.06).abs() < 1e-10, "expected ~0.06, got {:?}", merged2.cost_usd); // 0.01 + 0.05
        assert_eq!(merged2.tokens_input, Some(100)); // unchanged (no delta)
        assert_eq!(merged2.tokens_output, Some(40));
    }

    #[test]
    fn extracts_cost_and_token_types_from_illustrative_payload() {
        // Illustrative OTLP/JSON shape - asInt is a STRING per protobuf-JSON,
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
