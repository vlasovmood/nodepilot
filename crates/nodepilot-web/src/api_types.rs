use nodepilot_core::access::Permissions;
use nodepilot_core::models::{ApiToken, BulkExecResult, User};
use nodepilot_core::ssh::manage::{PowerAction, Signal};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, JsonSchema)]
pub struct Health {
    pub status: &'static str,
    pub version: &'static str,
}

#[derive(Serialize, JsonSchema)]
pub struct VersionInfo {
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    /// Release asset file name for this platform.
    pub platform_asset: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct RefreshQuery {
    /// `1` checks GitHub now; otherwise returns the last result.
    pub refresh: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct AuthStatus {
    pub setup_required: bool,
    pub user: Option<User>,
}

#[derive(Serialize, JsonSchema)]
pub struct LoginResponse {
    /// Session token (valid for 30 days). Can also be sent as `Authorization: Bearer`.
    pub token: String,
    pub user: User,
}

#[derive(Serialize, JsonSchema)]
pub struct TokenBrief {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, JsonSchema)]
pub struct Me {
    pub user: User,
    /// `null` for a browser session (full access).
    pub token: Option<TokenBrief>,
    pub permissions: Permissions,
}

#[derive(Serialize, JsonSchema)]
pub struct CreatedToken {
    /// Token secret `np_…`. Shown only once.
    pub token: String,
    pub info: ApiToken,
}

#[derive(Serialize, JsonSchema)]
pub struct BulkExecResponse {
    pub results: Vec<BulkExecResult>,
}

#[derive(Serialize, JsonSchema)]
pub struct RecoveryCodes {
    /// One-time recovery codes. Shown only once.
    pub recovery_codes: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct OkResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct LogLines {
    pub lines: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct HistoryQuery {
    /// Time window in hours (1..744), default 24.
    pub hours: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TermQuery {
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    /// API token for WebSocket clients that cannot send an Authorization header.
    #[allow(dead_code)]
    pub token: Option<String>,
}

#[derive(Deserialize, Default, JsonSchema)]
pub struct KillBody {
    #[serde(default)]
    pub signal: Signal,
}

#[derive(Deserialize, JsonSchema)]
pub struct LogsQuery {
    pub lines: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct PowerBody {
    pub action: PowerAction,
}

#[derive(Deserialize, JsonSchema)]
pub struct ListQuery {
    /// Directory to list; defaults to the user's home directory.
    pub path: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct DownloadQuery {
    /// Absolute file path.
    pub path: String,
    /// `1` returns the file as an attachment (Content-Disposition: attachment).
    pub download: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct UploadQuery {
    /// Absolute path of the file to create or overwrite.
    pub path: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct DeleteQuery {
    /// Absolute path of the file or directory.
    pub path: String,
    /// `1` deletes a directory with all its contents.
    pub recursive: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct MkdirBody {
    pub path: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct RenameBody {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct JobsQuery {
    pub server_id: Option<String>,
}
