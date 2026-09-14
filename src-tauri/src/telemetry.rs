use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

const WORKER_URL: &str = "https://ct-analytics.claude-terminal.workers.dev";

/// Whether the user has telemetry (usage heartbeats) turned on, as last
/// reported by the frontend via `send_telemetry_heartbeat`. Defaults to
/// disabled until the frontend's first call. Consulted by
/// `auth::ClientInfo::current()` so the per-install correlation id sent with
/// sign-in / refresh requests follows this same consent, not just the
/// heartbeat itself.
static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn set_enabled(enabled: bool) {
    TELEMETRY_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    TELEMETRY_ENABLED.load(Ordering::Relaxed)
}

#[derive(Serialize)]
struct HeartbeatPayload {
    installation_id: String,
    app_version: String,
    os: String,
    os_version: String,
    timestamp: String,
}

pub async fn send_heartbeat(installation_id: String, app_version: String) {
    let os = std::env::consts::OS.to_string();
    let os_version = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);

    let payload = HeartbeatPayload {
        installation_id,
        app_version,
        os,
        os_version,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[telemetry] Failed to create HTTP client: {}", e);
            return;
        }
    };

    match client
        .post(format!("{}/heartbeat", WORKER_URL))
        .json(&payload)
        .send()
        .await
    {
        Ok(resp) => {
            eprintln!("[telemetry] Heartbeat sent (status: {})", resp.status());
        }
        Err(e) => {
            eprintln!("[telemetry] Heartbeat failed: {}", e);
        }
    }
}
