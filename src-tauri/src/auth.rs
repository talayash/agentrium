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
use crate::database;
use crate::error_reporter;
use crate::AppState;

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

/// Providers the broker accepts. Must stay in sync with the zod enum in
/// `agentrium-api/src/app/api/auth/desktop/start/route.ts`.
const SUPPORTED_PROVIDERS: &[&str] = &["google", "github"];

fn is_supported_provider(provider: &str) -> bool {
    SUPPORTED_PROVIDERS.contains(&provider)
}

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
        // Mirror the broker's zod enum. Email + password is deferred to M2.
        if !is_supported_provider(&provider) {
            // Wrong provider is a caller-side bug/config choice, not a
            // runtime failure - skip telemetry.
            return Err(error_reporter::user_err(format!(
                "unsupported OAuth provider: {provider}"
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

    // Start the sync engine now that credentials are in place.
    let app_state = app.state::<AppState>();
    let engine = crate::sync::start_engine(app.clone(), app_state.db.clone(), token.clone());
    let sync_handle = app_state.sync_handle.clone();
    tauri::async_runtime::spawn(async move {
        *sync_handle.lock().await = Some(engine);
    });

    // Run guest→account migration synchronously (touches DB but not the
    // network). If any rows moved, emit a one-shot event so the FE can toast.
    {
        let db_arc = app_state.db.clone();
        let db_guard = db_arc.lock().unwrap_or_else(|p| p.into_inner());
        match run_guest_migration(&db_guard) {
            Ok(counts) if counts.total() > 0 => {
                let _ = app.emit("guest-migration-completed", counts);
            }
            Ok(_) => {}
            Err(e) => {
                crate::error_reporter::report_bg("guest_migration", e);
            }
        }
    }

    // Emit access token to the frontend. authStore fetches user via /api/me.
    let payload = AuthTokensReceivedPayload { access_token: token, state };
    if let Err(e) = app.emit("auth-tokens-received", payload) {
        eprintln!("[auth] failed to emit event: {e}");
    }
}

/// Response shape from the broker's credentials-based auth endpoints
/// (`/api/auth/desktop/signup` and `.../signin-credentials`).
#[derive(Debug, Deserialize)]
struct CredentialsAuthResponse {
    access_token: String,
    refresh_token: String,
    // `user` is echoed back but the frontend fetches it fresh via
    // fetch_current_user, so we ignore it here.
}

/// Store the refresh token in the OS keychain and emit auth-tokens-received
/// so the frontend hydrates identically to the OAuth deep-link path.
/// Called by both signup_credentials and signin_credentials on success.
fn complete_credentials_auth(
    app: &tauri::AppHandle,
    tokens: CredentialsAuthResponse,
) -> Result<(), String> {
    credentials::store_refresh_token(&tokens.refresh_token)?;
    let payload = AuthTokensReceivedPayload {
        access_token: tokens.access_token,
        // Credentials flow has no PKCE state — pass an empty string.
        // The frontend's auth-tokens-received listener doesn't require it
        // (state matching is only meaningful for the OAuth deep-link path
        // where CSRF via URL query is a concern).
        state: String::new(),
    };
    app.emit("auth-tokens-received", payload)
        .map_err(|e| format!("emit failed: {e}"))
}

#[derive(Debug, Serialize)]
struct SignupRequest<'a> {
    email: &'a str,
    password: &'a str,
    name: Option<&'a str>,
}

/// Register a new email+password account with the broker. On success, stores
/// the refresh token + emits `auth-tokens-received` so the frontend hydrates
/// exactly like the OAuth path. Errors are propagated as user_err (not
/// telemetry-worthy caller-side mistakes).
#[command]
pub async fn signup_credentials(
    app: tauri::AppHandle,
    email: String,
    password: String,
    name: Option<String>,
) -> Result<(), String> {
    wrap_cmd("signup_credentials", async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{API_BASE}/api/auth/desktop/signup"))
            .json(&SignupRequest {
                email: &email,
                password: &password,
                name: name.as_deref(),
            })
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let error_code = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
            let message = body.get("message").and_then(|v| v.as_str()).map(String::from);
            // 409 = duplicate email is the ONE case the UI explicitly handles
            // ("Sign in instead?"). Everything else is generic.
            let user_msg = match (status.as_u16(), error_code) {
                (409, _) => "email_taken".to_string(),
                (400, "invalid_password") => message.unwrap_or_else(|| "Invalid password".into()),
                (400, _) => "Invalid signup details".into(),
                _ => format!("Signup failed ({status})"),
            };
            return Err(error_reporter::user_err(user_msg));
        }

        let tokens: CredentialsAuthResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        complete_credentials_auth(&app, tokens)
    })
    .await
}

#[derive(Debug, Serialize)]
struct SigninCredentialsRequest<'a> {
    email: &'a str,
    password: &'a str,
}

/// Sign in with email + password. On success, stores the refresh token +
/// emits `auth-tokens-received`.
#[command]
pub async fn signin_credentials(
    app: tauri::AppHandle,
    email: String,
    password: String,
) -> Result<(), String> {
    wrap_cmd("signin_credentials", async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{API_BASE}/api/auth/desktop/signin-credentials"))
            .json(&SigninCredentialsRequest {
                email: &email,
                password: &password,
            })
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let user_msg = match status.as_u16() {
                401 => "invalid_credentials".to_string(),
                400 => "Invalid sign-in details".to_string(),
                _ => format!("Sign-in failed ({status})"),
            };
            return Err(error_reporter::user_err(user_msg));
        }

        let tokens: CredentialsAuthResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        complete_credentials_auth(&app, tokens)
    })
    .await
}

/// Fetch the currently-signed-in user from the broker `/api/me`, using the
/// short-lived access token the frontend obtained via `auth-tokens-received`.
/// The frontend calls this after every access-token refresh; refresh itself is
/// Task 26. Refresh tokens never travel through this command - they live in the
/// OS keychain and are only sent to the broker's `/api/auth/desktop/refresh`.
#[command]
pub async fn fetch_current_user(access_token: String) -> Result<AuthUser, String> {
    wrap_cmd("fetch_current_user", async move {
        let resp = reqwest::Client::new()
            .get(format!("{API_BASE}/api/me"))
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("api returned {}", resp.status()));
        }

        #[derive(Deserialize)]
        struct MeResponse {
            user: AuthUser,
        }
        let body: MeResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        Ok(body.user)
    })
    .await
}

/// Sign out locally: drop the refresh token from the OS keychain and clear the
/// cached logged-in-user id. The broker has no session state to revoke in M1;
/// M3 will add server-side revocation when we introduce sync.
#[command]
pub async fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let db_arc = state.db.clone();
    // Stop the sync engine first so no more push/pull happens after logout.
    if let Some(handle) = state.sync_handle.lock().await.take() {
        handle.shutdown();
    }
    wrap_cmd("logout", async move {
        credentials::clear_refresh_token()?;
        tokio::task::spawn_blocking(move || {
            let db = db_arc.lock().unwrap_or_else(|p| p.into_inner());
            db.delete_user_meta("logged_in_user_id")
        })
        .await
        .map_err(|e| format!("DB task failed: {e}"))??;
        Ok(())
    })
    .await
}

/// Record that we've shown the "sign in to sync" prompt to this user, so we
/// don't nag them again on every launch. The M1 UI shows the prompt once; the
/// frontend inspects `get_auth_prompt_seen` at boot.
#[command]
pub async fn mark_auth_prompt_seen(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let db_arc = state.db.clone();
    wrap_cmd("mark_auth_prompt_seen", async move {
        tokio::task::spawn_blocking(move || {
            let db = db_arc.lock().unwrap_or_else(|p| p.into_inner());
            db.set_user_meta("auth_prompt_seen", Some("1"))
        })
        .await
        .map_err(|e| format!("DB task failed: {e}"))??;
        Ok(())
    })
    .await
}

#[command]
pub async fn get_auth_prompt_seen(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let db_arc = state.db.clone();
    wrap_cmd("get_auth_prompt_seen", async move {
        let seen = tokio::task::spawn_blocking(move || {
            let db = db_arc.lock().unwrap_or_else(|p| p.into_inner());
            db.get_user_meta("auth_prompt_seen")
        })
        .await
        .map_err(|e| format!("DB task failed: {e}"))??;
        Ok(seen.is_some())
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct RehydrateResult {
    pub access_token: String,
}

/// Exchange the OS-keychain-stored refresh token for a new access token
/// (rotating the refresh in the process). Returns the new access token on
/// success. Returns `Ok(None)` if no refresh token is stored or the broker
/// rejects it (in which case the stale token is cleared from the keychain).
///
/// Shared by `rehydrate_auth` (boot path) and the sync engine's 401 retry
/// (background path).
pub async fn refresh_access_token() -> Result<Option<String>, String> {
    let refresh = match credentials::read_refresh_token()? {
        Some(v) => v,
        None => return Ok(None),
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{API_BASE}/api/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if !resp.status().is_success() {
        let _ = credentials::clear_refresh_token();
        return Ok(None);
    }

    #[derive(Deserialize)]
    struct RefreshResponse {
        access_token: String,
        refresh_token: String,
    }
    let body: RefreshResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;

    // Rotate the stored refresh token.
    credentials::store_refresh_token(&body.refresh_token)?;

    Ok(Some(body.access_token))
}

/// Boot-time refresh flow: swap the keychain refresh token for a fresh access
/// token (rotating the refresh token as a side-effect). Returns `None` when
/// there's nothing stored, or when the broker rejects the token — in the
/// latter case we also clear the stale token so we don't retry next boot.
#[command]
pub async fn rehydrate_auth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<RehydrateResult>, String> {
    wrap_cmd("rehydrate_auth", async move {
        match refresh_access_token().await? {
            Some(access_token) => {
                // Start the sync engine now that we have credentials.
                let handle = crate::sync::start_engine(
                    app.clone(),
                    state.db.clone(),
                    access_token.clone(),
                );
                *state.sync_handle.lock().await = Some(handle);
                Ok(Some(RehydrateResult { access_token }))
            }
            None => Ok(None),
        }
    })
    .await
}

#[derive(Debug, Default, serde::Serialize, Clone)]
pub struct GuestMigrationCounts {
    pub profiles: usize,
    pub custom_agents: usize,
    pub workspaces: usize,
}

impl GuestMigrationCounts {
    pub fn total(&self) -> usize {
        self.profiles + self.custom_agents + self.workspaces
    }
}

/// Enqueues every locally-authored row (sync_state='local_only') for push and
/// flips it to 'synced'. Runs in one transaction. Returns per-table counts.
///
/// Called from `handle_deep_link` when a successful login lands, so the
/// account picks up whatever the user created as a guest.
pub fn run_guest_migration(db: &database::Database) -> Result<GuestMigrationCounts, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = db.conn().unchecked_transaction().map_err(|e| e.to_string())?;
    let mut counts = GuestMigrationCounts::default();
    for (table, key_col) in [
        ("profiles", "id"),
        ("custom_agents", "id"),
        ("workspaces", "sync_id"),
    ] {
        let sql_ids = format!("SELECT {key_col} FROM {table} WHERE sync_state = 'local_only'");
        let ids: Vec<String> = tx
            .prepare(&sql_ids)
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for id in &ids {
            let update = format!(
                "UPDATE {table} SET updated_at = ?1, sync_state = 'synced' WHERE {key_col} = ?2"
            );
            tx.execute(&update, rusqlite::params![now, id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO sync_queue (table_name, row_key, enqueued_at, attempts, last_error)
                 VALUES (?1, ?2, ?3, 0, NULL)",
                rusqlite::params![table, id, now],
            )
            .map_err(|e| e.to_string())?;
        }
        match table {
            "profiles" => counts.profiles = ids.len(),
            "custom_agents" => counts.custom_agents = ids.len(),
            "workspaces" => counts.workspaces = ids.len(),
            _ => {}
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(counts)
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

    #[test]
    fn supported_providers_accepts_google_and_github_only() {
        assert!(is_supported_provider("google"));
        assert!(is_supported_provider("github"));
        assert!(!is_supported_provider("apple"));
        assert!(!is_supported_provider("Google")); // case-sensitive
        assert!(!is_supported_provider(""));
    }

    #[test]
    fn run_guest_migration_enqueues_local_only_rows() {
        let db = crate::database::Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'a', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'local_only'),
                    ('p2', 'b', '/tmp', '[]', '{}', '2026-01-01T00:00:00Z', 'synced')",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO workspaces (sync_id, name, terminals, created_at, updated_at, sync_state)
             VALUES ('w1', 'main', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'local_only')",
            [],
        ).unwrap();

        let counts = run_guest_migration(&db).unwrap();
        assert_eq!(counts.profiles, 1);
        assert_eq!(counts.workspaces, 1);
        assert_eq!(counts.custom_agents, 0);
        assert_eq!(counts.total(), 2);
        assert_eq!(db.sync_queue_depth().unwrap(), 2);

        let synced_profiles: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM profiles WHERE sync_state = 'synced'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(synced_profiles, 2);

        // Running again is a no-op (idempotent).
        let counts2 = run_guest_migration(&db).unwrap();
        assert_eq!(counts2.total(), 0);
    }
}
