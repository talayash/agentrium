//! OAuth flow orchestration for Agentrium desktop.
//!
//! Flow (see docs/superpowers/specs/2026-09-11-auth-sync-sharing-design.md §6.1):
//! 1. Frontend invokes `start_oauth_login`.
//! 2. We generate state + PKCE verifier/challenge, store in `PendingMap`.
//! 3. Open browser to https://agentrium-api.vercel.app/api/auth/desktop/start?...
//! 4. Backend redirects through Google, then to agentrium://auth-return?token=...&state=...
//! 5. Deep-link handler validates state, stores refresh token in keychain, emits auth-changed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
