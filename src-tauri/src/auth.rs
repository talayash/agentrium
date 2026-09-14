//! OAuth flow orchestration for Agentrium desktop.
//!
//! Flow (see docs/superpowers/specs/2026-09-11-auth-sync-sharing-design.md §6.1):
//! 1. Frontend invokes `start_oauth_login`.
//! 2. We generate state + PKCE verifier/challenge, store in `PendingMap`.
//! 3. Open browser to https://agentrium-api.vercel.app/api/auth/desktop/start?...
//! 4. Broker runs the provider login, then returns the browser to
//!    agentrium://auth-return?code=...&state=...  (one-time code, 60 s TTL;
//!    tokens never travel in the URL).
//! 5. Deep-link handler validates state, POSTs code + code_verifier + state to
//!    /api/auth/desktop/token, stores the refresh token in the keychain, and
//!    emits auth-tokens-received. Any failure emits auth-error.
//!
//! CONTRACT: the callback shape and the token endpoint are documented in
//! agentrium-api/README.md ("Desktop sign-in flow"). Change both repos
//! together; `parse_auth_return` / `exchange_code` tests below pin this side.

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
/// `agentrium://auth-return?code=...&state=...`, which the deep-link handler
/// validates against the pending map before exchanging the code for tokens.
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

/// Parsed `agentrium://auth-return` callback (broker contract: `code` + `state`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthReturn {
    pub code: String,
    pub state: String,
}

/// Classify a deep link. `Ok(None)` = not an auth-return URL (someone else's).
/// `Ok(Some)` = well-formed callback. `Err` = it *is* an auth-return but does
/// not match the broker contract (e.g. the legacy `token=` shape) - callers
/// must surface that, never ignore it.
pub fn parse_auth_return(url: &str) -> Result<Option<AuthReturn>, String> {
    let parsed = Url::parse(url).map_err(|e| format!("bad deep-link URL: {e}"))?;

    // Some OSes route the path segment as host, some as path. Handle both.
    let is_auth_return = parsed.host_str() == Some("auth-return")
        || parsed.path() == "/auth-return";
    if !is_auth_return {
        return Ok(None);
    }

    let mut code = None;
    let mut state = None;
    let mut seen = Vec::new();
    for (k, v) in parsed.query_pairs() {
        seen.push(k.to_string());
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() && !state.is_empty() => {
            Ok(Some(AuthReturn { code, state }))
        }
        (code, state) => {
            let mut missing = Vec::new();
            if code.is_none() { missing.push("code"); }
            if state.is_none() { missing.push("state"); }
            Err(format!(
                "sign-in callback is missing {} (got: {}); the desktop app and the auth broker disagree on the callback contract",
                missing.join(" and "),
                if seen.is_empty() { "no params".to_string() } else { seen.join(", ") },
            ))
        }
    }
}

/// Optional device descriptor sent with every token-issuing request
/// (broker README, "Desktop sign-in flow"). Additive on the wire: an older
/// broker ignores it. Stored server-side on the refresh token so the admin
/// dashboard can show app version / OS per account.
#[derive(Serialize, Debug, Clone)]
pub struct ClientInfo {
    pub app_version: &'static str,
    pub os: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
}

impl ClientInfo {
    /// `app_version` and `os` are always sent, telemetry consent or not -
    /// they're needed for compatibility diagnostics (e.g. "this broker
    /// contract change requires desktop >= X"), and are far less identifying
    /// than a per-install id. `installation_id` is the correlation key that
    /// joins an account to the analytics dataset, so it follows the same
    /// telemetry consent flag as `send_telemetry_heartbeat`: omitted from the
    /// wire (via `skip_serializing_if`) whenever the user has telemetry off.
    pub fn current() -> Self {
        let installation_id = if crate::telemetry::enabled() {
            error_reporter::installation_id()
        } else {
            None
        };
        Self {
            app_version: env!("CARGO_PKG_VERSION"),
            os: std::env::consts::OS,
            installation_id,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct TokenExchangeResponse {
    pub access_token: String,
    pub refresh_token: String,
}

/// PKCE token exchange (broker: `POST /api/auth/desktop/token`). A wrong
/// verifier burns the one-time code server-side, so this is called exactly
/// once per callback.
pub async fn exchange_code(
    base_url: &str,
    code: &str,
    code_verifier: &str,
    state: &str,
    client: &ClientInfo,
) -> Result<TokenExchangeResponse, String> {
    let resp = reqwest::Client::new()
        .post(format!("{base_url}/api/auth/desktop/token"))
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": code_verifier,
            "state": state,
            "client": client,
        }))
        .send()
        .await
        .map_err(|e| format!("token exchange request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let code = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_else(|| body.chars().take(120).collect());
        return Err(format!("token exchange rejected ({status}): {code}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("token exchange returned an unexpected body: {e}"))
}

/// Called by the deep-link plugin when the OS routes `agentrium://` URLs to us.
///
/// Handles `agentrium://auth-return?code=...&state=...`. Other paths are
/// ignored (M3 will add `import/<id>` etc.). Every failure on an auth-return
/// URL is emitted as `auth-error` so the LoginModal can stop spinning and tell
/// the user, and reported to telemetry because it means a real broken flow.
pub fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    let fail = |msg: String| {
        eprintln!("[auth] {msg}");
        error_reporter::report_bg("auth_deep_link", msg.clone());
        let _ = app.emit("auth-error", msg);
    };

    let ret = match parse_auth_return(url) {
        Ok(Some(ret)) => ret,
        Ok(None) => return, // not for us
        Err(e) => return fail(e),
    };

    let pending = app.state::<Arc<PendingMap>>();
    let Some(flow) = pending.take(&ret.state) else {
        return fail("sign-in callback arrived for an unknown or expired attempt; please try again".into());
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let tokens = exchange_code(API_BASE, &ret.code, &flow.code_verifier, &ret.state, &ClientInfo::current()).await?;
            complete_signin(&app, tokens.access_token, Some(tokens.refresh_token), Some(ret.state)).await
        }
        .await;
        if let Err(error) = result {
            eprintln!("[auth] {error}");
            error_reporter::report_bg("auth_deep_link", error.clone());
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
    client: ClientInfo,
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
                client: ClientInfo::current(),
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
    client: ClientInfo,
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
                client: ClientInfo::current(),
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
        .json(&serde_json::json!({ "refresh_token": refresh, "client": ClientInfo::current() }))
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

    // ---- Desktop <-> broker callback contract (agentrium-api README,
    // "Desktop sign-in flow"). The broker returns the browser to
    // `agentrium://auth-return?code=…&state=…`; tokens never travel in the URL.
    // If the broker changes this shape, these tests are the desktop-side alarm.

    #[test]
    fn auth_return_parses_the_documented_code_and_state_shape() {
        let got = parse_auth_return("agentrium://auth-return?code=abc123&state=st-1").unwrap().unwrap();
        assert_eq!(got.code, "abc123");
        assert_eq!(got.state, "st-1");
    }

    #[test]
    fn auth_return_accepts_path_form_used_by_some_platforms() {
        let got = parse_auth_return("agentrium:///auth-return?state=st-2&code=zzz").unwrap().unwrap();
        assert_eq!(got.code, "zzz");
        assert_eq!(got.state, "st-2");
    }

    #[test]
    fn non_auth_return_deep_links_are_not_ours() {
        assert!(parse_auth_return("agentrium://import/abc?code=1&state=2").unwrap().is_none());
    }

    #[test]
    fn legacy_token_callback_is_a_loud_contract_mismatch_not_a_silent_ignore() {
        // The pre-PKCE broker put tokens in the URL. A callback in that shape
        // means the two repos disagree; surface it instead of hanging the modal.
        let err = parse_auth_return("agentrium://auth-return?token=t&refresh=r&state=s").unwrap_err();
        assert!(err.contains("code"), "error should name the missing param: {err}");
    }

    #[test]
    fn auth_return_without_state_is_an_error() {
        assert!(parse_auth_return("agentrium://auth-return?code=abc").is_err());
    }

    #[test]
    fn auth_return_with_malformed_url_is_an_error() {
        assert!(parse_auth_return("not a url").is_err());
    }

    /// Minimal one-shot HTTP server: captures the first request and replies
    /// with a canned body. Keeps the exchange test free of a mock-HTTP dep.
    fn one_shot_http_server(status_line: &'static str, body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let mut got = Vec::new();
            loop {
                let n = stream.read(&mut buf).unwrap();
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                if let Some(idx) = text.find("\r\n\r\n") {
                    let len: usize = text[..idx]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                        .unwrap_or(0);
                    if got.len() >= idx + 4 + len { break; }
                }
                if n == 0 { break; }
            }
            tx.send(String::from_utf8_lossy(&got).to_string()).unwrap();
            let resp = format!(
                "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    #[test]
    fn exchange_code_posts_the_documented_body_and_reads_tokens() {
        let (base, rx) = one_shot_http_server(
            "HTTP/1.1 200 OK",
            r#"{"access_token":"AT","refresh_token":"RT","user":{"id":"u1","email":"e@x","name":null,"image":null}}"#,
        );
        let rt = tokio::runtime::Runtime::new().unwrap();
        let client = ClientInfo { app_version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS, installation_id: Some("inst-test".into()) };
        let tokens = rt
            .block_on(exchange_code(&base, "the-code", "the-verifier-43chars-xxxxxxxxxxxxxxxxxxxxxxxxx", "the-state", &client))
            .unwrap();
        assert_eq!(tokens.access_token, "AT");
        assert_eq!(tokens.refresh_token, "RT");

        let req = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(req.starts_with("POST /api/auth/desktop/token HTTP/1.1"), "unexpected request line: {req}");
        let body_start = req.find("\r\n\r\n").unwrap() + 4;
        let body: serde_json::Value = serde_json::from_str(&req[body_start..]).unwrap();
        assert_eq!(body["code"], "the-code");
        assert_eq!(body["code_verifier"], "the-verifier-43chars-xxxxxxxxxxxxxxxxxxxxxxxxx");
        assert_eq!(body["state"], "the-state");
        assert_eq!(body["client"]["app_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["client"]["os"], std::env::consts::OS);
        assert_eq!(body["client"]["installation_id"], "inst-test");
        assert_eq!(body.as_object().unwrap().len(), 4, "code, code_verifier, state, client");
    }

    #[test]
    fn exchange_code_surfaces_the_broker_error_code() {
        let (base, _rx) = one_shot_http_server("HTTP/1.1 400 Bad Request", r#"{"error":"invalid_grant"}"#);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt.block_on(exchange_code(&base, "c", "v", "s", &ClientInfo::current())).unwrap_err();
        assert!(err.contains("invalid_grant"), "error should carry the broker code: {err}");
    }

    #[test]
    fn client_info_omits_a_missing_installation_id() {
        let c = ClientInfo { app_version: "1.0.0", os: "windows", installation_id: None };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v, serde_json::json!({ "app_version": "1.0.0", "os": "windows" }));
    }

    /// `ClientInfo::current()` must omit `installation_id` when telemetry
    /// consent is off, regardless of whether the database has already
    /// populated one in `error_reporter`.
    ///
    /// This only exercises the disabled branch, deliberately. The enabled
    /// branch calls `error_reporter::installation_id()`, which reads a
    /// process-global `OnceLock` armed by `error_reporter::init_early()`;
    /// `error_reporter::tests::enabled_defaults_to_false_before_init`
    /// explicitly documents relying on no other test in this binary calling
    /// `init_early()` first, so doing that here to exercise the enabled
    /// branch would make that other test's outcome depend on run order.
    /// `client_info_omits_a_missing_installation_id` and
    /// `exchange_code_posts_the_documented_body_and_reads_tokens` already
    /// cover the enabled/`Some(id)` shape via direct construction.
    #[test]
    fn client_info_current_omits_installation_id_when_telemetry_disabled() {
        crate::telemetry::set_enabled(false);
        let info = ClientInfo::current();
        assert_eq!(info.installation_id, None);
        let v = serde_json::to_value(&info).unwrap();
        assert!(
            v.as_object().unwrap().get("installation_id").is_none(),
            "installation_id must be absent from the wire when telemetry is off: {v}"
        );
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
