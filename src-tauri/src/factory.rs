//! AI Factory persisted types. Factories and runs are local only (never synced).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::factory_def::Definition;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Factory {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub source_path: String,
    pub definition: Definition,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRow {
    pub at: String,
    pub step_id: String,
    pub kind: String,
    pub detail: String,
}
