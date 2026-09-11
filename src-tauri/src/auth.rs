//! OAuth flow orchestration for Agentrium desktop.
//!
//! Flow (see docs/superpowers/specs/2026-09-11-auth-sync-sharing-design.md §6.1):
//! 1. Frontend invokes `start_oauth_login`.
//! 2. We generate state + PKCE verifier/challenge, store in `PendingMap`.
//! 3. Open browser to https://agentrium-api.vercel.app/api/auth/desktop/start?...
//! 4. Backend redirects through Google, then to agentrium://auth-return?token=...&state=...
//! 5. Deep-link handler validates state, stores refresh token in keychain, emits auth-changed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{command, Emitter, Manager, State};
use url::Url;

use crate::commands::wrap_cmd;
use crate::credentials;
use crate::error_reporter;

const PENDING_TTL: Duration = Duration::from_secs(3 * 60);

#[derive(Debug, Clone)]
pub struct PendingFlow {
    pub state: String,
    pub code_verifier: String,
    pub created_at: Instant,
}

#[derive(Default, Debug)]
pub struct PendingMap {
    inner: Mutex<HashMap<String, PendingFlow>>,
}

impl PendingMap {
    pub fn insert(&self, flow: PendingFlow) {
        self.gc();
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        guard.insert(flow.state.clone(), flow);
    }

    pub fn take(&self, state: &str) -> Option<PendingFlow> {
        self.gc();
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        guard.remove(state)
    }

    fn gc(&self) {
        let mut guard = self.inner.lock().expect("PendingMap poisoned");
        let now = Instant::now();
        guard.retain(|_, v| now.duration_since(v.created_at) < PENDING_TTL);
    }
}

/// Generate a random 32-byte state, base64url-encoded (no padding).
pub fn generate_state() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Generate a PKCE verifier (43-128 chars base64url) and derive the challenge.
pub fn generate_pkce() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = URL_SAFE_NO_PAD.encode(buf); // 43 chars
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub image: Option<String>,
}

/// Broker base URL. The Vercel endpoint owns the Google OAuth client secret;
/// the desktop app only sees state + PKCE + the final refresh token via the
/// `agentrium://auth-return` deep link.
const API_BASE: &str = "https://agentrium-api.vercel.app";
const CALLBACK_URL: &str = "agentrium://auth-return";

#[derive(Debug, Serialize, Deserialize)]
pub struct StartOAuthLoginResult {
    pub opened_url: String,
}

/// Kick off an OAuth sign-in: generate state + PKCE, record them in the
/// pending map, and launch the system browser at the Vercel broker URL. The
/// browser redirects through the identity provider back to
/// `agentrium://auth-return?token=...&state=...`, which the deep-link handler
/// (Task 20) validates against the pending map.
#[command]
pub async fn start_oauth_login(
    provider: String,
    pending: State<'_, Arc<PendingMap>>,
) -> Result<StartOAuthLoginResult, String> {
    // Clone once so the async move only captures owned data.
    let pending = pending.inner().clone();
    wrap_cmd("start_oauth_login", async move {
        if provider != "google" {
            // Wrong provider is a caller-side bug/config choice, not a
            // runtime failure - skip telemetry.
            return Err(error_reporter::user_err(format!(
                "provider not supported in M1: {provider}"
            )));
        }

        let state = generate_state();
        let (verifier, challenge) = generate_pkce();

        pending.insert(PendingFlow {
            state: state.clone(),
            code_verifier: verifier,
            created_at: Instant::now(),
        });

        let url = format!(
            "{API_BASE}/api/auth/desktop/start?provider={provider}&state={state}&callback={cb}&code_challenge={challenge}&code_challenge_method=S256",
            provider = urlencoding::encode(&provider),
            state = urlencoding::encode(&state),
            cb = urlencoding::encode(CALLBACK_URL),
            challenge = urlencoding::encode(&challenge),
        );

        // Match `open_external_url` / `open_feedback_inbox`: the `open` crate
        // is already a direct dep and hands the URL to the OS default handler.
        // Avoids pulling in `tauri-plugin-shell` just for this.
        open::that(&url).map_err(|e| format!("failed to open browser: {e}"))?;

        Ok(StartOAuthLoginResult { opened_url: url })
    })
    .await
}

#[derive(Debug, Serialize, Clone)]
pub struct AuthTokensReceivedPayload {
    pub access_token: String,
    pub state: String,
}

/// Called by the deep-link plugin when the OS routes `agentrium://` URLs to us.
///
/// Only handles `agentrium://auth-return?token=...&refresh=...&state=...`.
/// Other paths are ignored (M2/M3 will add `import/<id>` etc.).
pub fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[auth] bad deep-link URL {url}: {e}");
            return;
        }
    };

    // Some OSes route the path segment as host, some as path. Handle both.
    let is_auth_return = parsed.host_str() == Some("auth-return")
        || parsed.path() == "/auth-return";
    if !is_auth_return {
        return; // not for us
    }

    let mut token = None;
    let mut refresh = None;
    let mut state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "token" => token = Some(v.to_string()),
            "refresh" => refresh = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }

    let (Some(token), Some(refresh), Some(state)) = (token, refresh, state) else {
        eprintln!("[auth] missing token/refresh/state in deep-link URL");
        return;
    };

    let pending = app.state::<Arc<PendingMap>>();
    if pending.take(&state).is_none() {
        eprintln!("[auth] unknown or expired state; ignoring deep-link");
        return;
    }

    if let Err(e) = credentials::store_refresh_token(&refresh) {
        eprintln!("[auth] failed to store refresh token: {e}");
        let _ = app.emit("auth-error", &format!("keychain error: {e}"));
        return;
    }

    // Emit access token to the frontend. authStore fetches user via /api/me.
    let payload = AuthTokensReceivedPayload { access_token: token, state };
    if let Err(e) = app.emit("auth-tokens-received", payload) {
        eprintln!("[auth] failed to emit event: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_is_43_chars_and_unique() {
        let a = generate_state();
        let b = generate_state();
        assert_eq!(a.len(), 43); // 32 bytes -> 43 base64url no-pad chars
        assert_ne!(a, b);
    }

    #[test]
    fn pkce_challenge_matches_sha256_of_verifier() {
        let (verifier, challenge) = generate_pkce();
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(hasher.finalize());
        assert_eq!(challenge, expected);
    }

    #[test]
    fn pending_map_take_removes_entry() {
        let map = PendingMap::default();
        let state = "abc".to_string();
        map.insert(PendingFlow {
            state: state.clone(),
            code_verifier: "v".into(),
            created_at: Instant::now(),
        });
        assert!(map.take(&state).is_some());
        assert!(map.take(&state).is_none());
    }

    #[test]
    fn pending_map_gcs_expired() {
        let map = PendingMap::default();
        map.insert(PendingFlow {
            state: "old".into(),
            code_verifier: "v".into(),
            created_at: Instant::now() - Duration::from_secs(300),
        });
        assert!(map.take("old").is_none());
    }
}
