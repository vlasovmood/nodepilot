//! API types. Secrets appear only in input structs and are never serialized.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub type Ts = DateTime<Utc>;

// ---------- auth ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct User {
    pub id: String,
    pub username: String,
    pub created_at: Ts,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ApiToken {
    pub id: String,
    pub name: String,
    pub created_at: Ts,
    pub last_used_at: Option<Ts>,
    /// `null` means no expiry.
    pub expires_at: Option<Ts>,
    pub permissions: crate::access::Permissions,
}

/// Create or update an API token. All fields are optional in PATCH.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct TokenInput {
    pub name: Option<String>,
    /// Defaults to full access.
    pub permissions: Option<crate::access::Permissions>,
    /// Lifetime in days; `0` means no expiry. In PATCH, counted from now.
    pub expires_in_days: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct Credentials {
    pub username: String,
    pub password: String,
    /// Authenticator app code or recovery code (when 2FA is enabled).
    #[serde(default)]
    pub code: Option<String>,
}

// ---------- projects ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: Option<String>,
    pub server_count: i64,
    pub created_at: Ts,
    pub updated_at: Ts,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ProjectInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
}

// ---------- identities ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub server_count: i64,
    pub created_at: Ts,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct IdentityInput {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

// ---------- servers ----------

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AuthInput {
    Password { password: String },
    Key { private_key: String, passphrase: Option<String> },
    Identity { identity_id: String },
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ServerInput {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth: Option<AuthInput>,
    pub tags: Option<Vec<String>>,
    pub project_ids: Option<Vec<String>>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Online,
    Offline,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub identity_id: Option<String>,
    pub tags: Vec<String>,
    pub project_ids: Vec<String>,
    pub description: String,
    pub host_key_fingerprint: Option<String>,
    pub status: Status,
    pub created_at: Ts,
    pub updated_at: Ts,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ServerFilter {
    pub project_id: Option<String>,
    pub q: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

// ---------- exec ----------

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExecRequest {
    pub command: String,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BulkExecRequest {
    pub command: String,
    pub server_ids: Option<Vec<String>>,
    pub project_id: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct BulkExecResult {
    pub server_id: String,
    pub server_name: String,
    pub ok: bool,
    pub error: Option<String>,
    pub result: Option<nodepilot_ssh::ExecOutput>,
}

// ---------- notes ----------

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub project_id: Option<String>,
    pub server_id: Option<String>,
    pub pinned: bool,
    pub created_at: Ts,
    pub updated_at: Ts,
}

/// For PATCH: `project_id: null` detaches the note, an absent field leaves it unchanged.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct NoteInput {
    pub title: Option<String>,
    pub body: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub server_id: Option<Option<String>>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct NoteFilter {
    pub project_id: Option<String>,
    pub server_id: Option<String>,
}

pub(crate) fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}
