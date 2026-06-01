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
