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

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = complete_signin(&app, token, Some(refresh), Some(state)).await {
            let _ = app.emit("auth-error", error);
        }
    });
}

async fn complete_signin(
    app: &tauri::AppHandle,
    token: String,
    refresh: Option<String>,
    event_state: Option<String>,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let mut engine = app_state.sync_handle.lock().await;
    // Identify the account from the authenticated server response before any
    // local rows can be pushed with this token.
    let user = fetch_current_user(token.clone()).await?;
    if let Some(previous) = engine.take() { previous.shutdown().await; }
    let db = app_state.db.clone();
    let counts = tokio::task::spawn_blocking(move || {
        let db = db.lock().unwrap_or_else(|p| p.into_inner());
        db.activate_sync_account(&user.id)?;
        run_guest_migration(&db)
    }).await.map_err(|e| e.to_string())??;
    if let Some(refresh) = refresh { credentials::store_refresh_token(&refresh)?; }
    *engine = Some(crate::sync::start_engine(app.clone(), app_state.db.clone(), token.clone()));
    if counts.total() > 0 { let _ = app.emit("guest-migration-completed", counts); }
    if let Some(state) = event_state {
        app.emit("auth-tokens-received", AuthTokensReceivedPayload { access_token: token, state })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
async fn complete_credentials_auth(
    app: &tauri::AppHandle,
    tokens: CredentialsAuthResponse,
) -> Result<(), String> {
    complete_signin(app, tokens.access_token, Some(tokens.refresh_token), Some(String::new())).await
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
        complete_credentials_auth(&app, tokens).await
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
        complete_credentials_auth(&app, tokens).await
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
            .timeout(Duration::from_secs(30))
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
    let mut engine = state.sync_handle.lock().await;
    if let Some(handle) = engine.take() { handle.shutdown().await; }
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

fn refresh_status_rejects_token(status: reqwest::StatusCode) -> Result<bool, String> {
    match status.as_u16() {
        200..=299 => Ok(false),
        401 | 403 => Ok(true),
        _ => Err(format!("Token refresh temporarily failed ({status})")),
    }
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
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({ "refresh_token": refresh }))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if refresh_status_rejects_token(resp.status())? {
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
    _state: tauri::State<'_, AppState>,
) -> Result<Option<RehydrateResult>, String> {
    wrap_cmd("rehydrate_auth", async move {
        match refresh_access_token().await? {
            Some(access_token) => {
                complete_signin(&app, access_token.clone(), None, None).await?;
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
    // Remove internal entries accidentally enqueued by older builds.
    tx.execute("DELETE FROM sync_queue WHERE table_name = 'workspaces' AND row_key IN
        (SELECT sync_id FROM workspaces WHERE substr(name, 1, 2) = '__')", [])
        .map_err(|e| e.to_string())?;
    let mut counts = GuestMigrationCounts::default();
    for (table, key_col) in [
        ("profiles", "id"),
        ("custom_agents", "id"),
        ("workspaces", "sync_id"),
    ] {
        let filter = if table == "workspaces" { " AND substr(name, 1, 2) != '__'" } else { "" };
        let sql_ids = format!("SELECT {key_col} FROM {table} WHERE sync_state = 'local_only'{filter}");
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
    fn transient_refresh_errors_do_not_reject_saved_token() {
        assert_eq!(refresh_status_rejects_token(reqwest::StatusCode::OK).unwrap(), false);
        for status in [401, 403] {
            assert!(refresh_status_rejects_token(reqwest::StatusCode::from_u16(status).unwrap()).unwrap());
        }
        for status in [400, 408, 429, 500, 502, 503, 504] {
            assert!(refresh_status_rejects_token(reqwest::StatusCode::from_u16(status).unwrap()).is_err());
        }
    }

    #[test]
    fn guest_migration_excludes_and_unqueues_internal_workspaces() {
        let db = database::Database::new_in_memory().unwrap();
        let internal = db.save_workspace("__last_session__", &[]).unwrap();
        db.enqueue_sync("workspaces", &internal).unwrap();
        db.save_workspace("user workspace", &[]).unwrap();
        let counts = run_guest_migration(&db).unwrap();
        assert_eq!(counts.workspaces, 1);
        assert_eq!(db.sync_queue_depth().unwrap(), 1);
        assert_ne!(db.peek_sync_queue(10).unwrap()[0].row_key, internal);
        assert!(db.load_workspace("__last_session__").is_ok());
    }

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

    /// Upgrade path for an existing install: profiles/workspaces created as a
    /// guest (no `sync_account_id`) must survive the very first sign-in and be
    /// enqueued for push. This is the exact sequence `complete_signin` runs.
    /// A stale global pull cursor left by an older build must be dropped so
    /// the first pull for the new account is a full one.
    #[test]
    fn first_sign_in_adopts_existing_guest_rows() {
        let db = crate::database::Database::new_in_memory().unwrap();
        db.conn().execute(
            "INSERT INTO profiles (id, name, working_directory, claude_args, env_vars, updated_at, sync_state)
             VALUES ('p1', 'Agentrium', '/home/me/agentrium', '[]', '{}', '2026-09-12T09:00:00Z', 'local_only'),
                    ('p2', 'Creditly', '/home/me/creditly', '[]', '{}', '2026-09-12T09:00:00Z', 'local_only')",
            [],
        ).unwrap();
        let ws = db.save_workspace("daily", &[]).unwrap();
        db.set_last_pull_cursor("2026-09-12T19:53:52.636Z").unwrap();
        assert_eq!(db.get_user_meta("sync_account_id").unwrap(), None);

        db.activate_sync_account("new-account").unwrap();
        let counts = run_guest_migration(&db).unwrap();

        let names: Vec<String> = db.get_profiles().unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names.len(), 2, "guest profiles must still be visible after first sign-in");
        assert!(names.contains(&"Agentrium".to_string()) && names.contains(&"Creditly".to_string()));
        assert!(db.load_workspace("daily").is_ok());
        assert_eq!(counts.profiles, 2);
        assert_eq!(counts.workspaces, 1);
        assert_eq!(db.sync_queue_depth().unwrap(), 3);
        let queued: Vec<String> = db.peek_sync_queue(10).unwrap().into_iter().map(|e| e.row_key).collect();
        assert!(queued.contains(&"p1".to_string()) && queued.contains(&"p2".to_string()) && queued.contains(&ws));
        assert_eq!(db.get_last_pull_cursor().unwrap(), None, "stale global cursor must not leak into the account");
        assert_eq!(db.get_user_meta("sync_account_id").unwrap().as_deref(), Some("new-account"));
    }
}
