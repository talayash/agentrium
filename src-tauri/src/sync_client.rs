//! Thin reqwest wrapper for `/api/sync/pull` and `/api/sync/push`.
//! Handles Bearer header + one-shot 401 refresh (spec §7.2).
//!
//! Owns no state beyond the current access token. Callers construct a fresh
//! `SyncClient` when the token changes (post-login, post-rehydrate).

use crate::auth;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const API_BASE: &str = "https://agentrium-api.vercel.app";

#[derive(Debug, Serialize)]
pub struct PullRequest {
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tables: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    #[serde(default)]
    pub profiles: Option<Vec<Value>>,
    #[serde(default)]
    pub custom_agents: Option<Vec<Value>>,
    #[serde(default)]
    pub workspaces: Option<Vec<Value>>,
    pub server_time: String,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct PushRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiles: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_agents: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
pub struct PushResponse {
    pub accepted: HashMap<String, Vec<String>>,
    pub skipped: HashMap<String, Vec<String>>,
}

pub struct SyncClient {
    http: reqwest::Client,
    access_token: String,
}

impl SyncClient {
    pub fn new(access_token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            access_token,
        }
    }

    pub fn set_access_token(&mut self, token: String) {
        self.access_token = token;
    }

    pub async fn pull(&mut self, req: PullRequest) -> Result<PullResponse, SyncError> {
        self.post_with_refresh("/api/sync/pull", &req).await
    }

    pub async fn push(&mut self, req: PushRequest) -> Result<PushResponse, SyncError> {
        self.post_with_refresh("/api/sync/push", &req).await
    }

    async fn post_with_refresh<Req: Serialize, Resp: for<'de> Deserialize<'de>>(
        &mut self,
        path: &str,
        body: &Req,
    ) -> Result<Resp, SyncError> {
        let url = format!("{API_BASE}{path}");
        let resp = self
            .http
            .post(&url)
            .timeout(std::time::Duration::from_secs(30))
            .bearer_auth(&self.access_token)
            .json(body)
            .send()
            .await
            .map_err(SyncError::Network)?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            // One-shot refresh, then retry. Force-logout on second 401 is
            // handled by the sync engine layer, not here.
            let new_token = auth::refresh_access_token()
                .await
                .map_err(SyncError::Refresh)?
                .ok_or_else(|| SyncError::Refresh("no refresh token stored".into()))?;
            self.access_token = new_token;
            let retry = self
                .http
                .post(&url)
                .timeout(std::time::Duration::from_secs(30))
                .bearer_auth(&self.access_token)
                .json(body)
                .send()
                .await
                .map_err(SyncError::Network)?;
            return self.decode(retry).await;
        }
        self.decode(resp).await
    }

    async fn decode<Resp: for<'de> Deserialize<'de>>(
        &self,
        resp: reqwest::Response,
    ) -> Result<Resp, SyncError> {
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(SyncError::Server(status.as_u16(), text));
        }
        resp.json::<Resp>().await.map_err(SyncError::Decode)
    }
}

#[derive(Debug)]
pub enum SyncError {
    Network(reqwest::Error),
    Refresh(String),
    Server(u16, String),
    Decode(reqwest::Error),
}

impl SyncError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, SyncError::Server(401, _))
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Network(e) => write!(f, "network: {e}"),
            SyncError::Refresh(s) => write!(f, "refresh: {s}"),
            SyncError::Server(code, body) => write!(f, "server {code}: {body}"),
            SyncError::Decode(e) => write!(f, "decode: {e}"),
        }
    }
}
