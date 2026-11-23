//! Single source of truth for API endpoints: the permission middleware and the OpenAPI spec are built from it.

use nodepilot_core::access::{Area, Level};
use nodepilot_core::audit::{AuditEntry, AuditFilter, AuditSettings, AuditSettingsInput};
use nodepilot_core::backups::BackupKeyPair;
use nodepilot_core::backups::{BackupJob, BackupJobInput, BackupRun, RunFilter, Storage, StorageInput};
use nodepilot_core::files::DirListing;
use nodepilot_core::graphs::{EdgeInput, Graph, GraphEdge, GraphFilter, GraphInput, GraphNode, GraphSummary, NodeInput};
use nodepilot_core::models::*;
use nodepilot_core::panel_key::{DeployRequest, DetectIpRequest, DetectedIp, PanelKeyInfo, PanelKeyInput, ServerOpResult};
use nodepilot_core::security::SecurityStatus;
use nodepilot_core::ssh::ExecOutput;
use nodepilot_core::ssh::manage::{Process, Service};
use nodepilot_core::stats::{StatsPoint, StatsSnapshot};
use nodepilot_core::terminals::{OpenTerminal, ReadQuery, ResizeTerminal, TerminalInfo, TerminalInput, TerminalOutput};
use nodepilot_core::totp::{DisableTwoFactor, TotpCode, TotpSetup, TwoFactorStatus};
use nodepilot_core::updates::{InstallStatus, UpdateInfo, UpdateSettings, UpdateSettingsInput};
use schemars::{JsonSchema, Schema, SchemaGenerator};

use crate::api_types::*;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Access {
    Public,
    /// Any authenticated caller; the handler checks permissions itself.
    Authenticated,
    Scoped(Area, Level),
}

pub type SchemaFn = fn(&mut SchemaGenerator) -> Schema;

#[derive(Clone, Copy)]
pub enum Body {
    None,
    Json(SchemaFn),
    Binary,
}

#[derive(Clone, Copy)]
pub enum Reply {
    NoContent,
    Json(SchemaFn),
    Binary,
    WebSocket,
}

#[derive(Clone, Copy)]
pub struct Endpoint {
    pub method: &'static str,
    pub path: &'static str,
    pub group: &'static str,
    pub summary: &'static str,
    pub access: Access,
    pub query: Option<SchemaFn>,
    pub body: Body,
    pub reply: Reply,
}

fn s<T: JsonSchema>(g: &mut SchemaGenerator) -> Schema {
    g.subschema_for::<T>()
}

use Access::{Authenticated, Public, Scoped};
use Area::*;
use Level::{Read as R, Write as W};

macro_rules! ep {
    ($m:literal $p:literal, $g:literal, $acc:expr, $sum:literal $(, q = $q:ty)? $(, body = $b:ty)? $(, raw = $raw:ident)? => $reply:expr) => {
        Endpoint {
            method: $m,
            path: $p,
            group: $g,
            summary: $sum,
            access: $acc,
            query: ep!(@opt $($q)?),
            body: ep!(@body $($b)? $($raw)?),
            reply: $reply,
        }
    };
    (@opt) => { None };
    (@opt $q:ty) => { Some(s::<$q> as SchemaFn) };
    (@body) => { Body::None };
    (@body binary) => { Body::Binary };
    (@body $b:ty) => { Body::Json(s::<$b> as SchemaFn) };
}

macro_rules! json {
    ($t:ty) => {
        Reply::Json(s::<$t> as SchemaFn)
    };
}

const NC: Reply = Reply::NoContent;

pub static ENDPOINTS: &[Endpoint] = &[
    // ----- meta & auth -----
    ep!("GET" "/api/health", "Meta", Public, "Check that the panel is running" => json!(Health)),
    ep!("GET" "/api/openapi.json", "Meta", Public, "OpenAPI 3.1 spec for this API" => json!(serde_json::Value)),
    ep!("GET" "/api/auth/status", "Auth", Public, "Whether initial setup is needed and who is signed in" => json!(AuthStatus)),
    ep!("POST" "/api/auth/setup", "Auth", Public, "Create the admin account (only while no users exist)", body = Credentials => json!(LoginResponse)),
    ep!("POST" "/api/auth/login", "Auth", Public, "Sign in with username and password: session token + cookie", body = Credentials => json!(LoginResponse)),
    ep!("POST" "/api/auth/logout", "Auth", Authenticated, "End the session" => NC),
    ep!("GET" "/api/auth/me", "Auth", Authenticated, "Current user and token permissions" => json!(Me)),
    ep!("POST" "/api/mcp", "AI", Authenticated, "MCP (JSON-RPC 2.0) for AI agents; tools are filtered by token permissions", body = serde_json::Value => json!(serde_json::Value)),
    // ----- security -----
    ep!("GET" "/api/auth/2fa", "Security", Authenticated, "2FA status of the current user" => json!(TwoFactorStatus)),
    ep!("POST" "/api/auth/2fa/setup", "Security", Authenticated, "Start 2FA setup: secret and otpauth link for the QR code (session only)" => json!(TotpSetup)),
    ep!("POST" "/api/auth/2fa/enable", "Security", Authenticated, "Enable 2FA by confirming a code; returns recovery codes", body = TotpCode => json!(RecoveryCodes)),
    ep!("POST" "/api/auth/2fa/disable", "Security", Authenticated, "Disable 2FA (password and code)", body = DisableTwoFactor => NC),
    ep!("POST" "/api/auth/2fa/recovery-codes", "Security", Authenticated, "Generate new recovery codes", body = TotpCode => json!(RecoveryCodes)),
    ep!("GET" "/api/security/status", "Security", Scoped(Admin, R), "Panel security summary" => json!(SecurityStatus)),
    ep!("GET" "/api/security/panel-key", "Security", Scoped(Admin, R), "Panel SSH key: public key, restrictions, authorized_keys line" => json!(PanelKeyInfo)),
    ep!("POST" "/api/security/panel-key", "Security", Scoped(Admin, W), "Create the panel SSH key", body = PanelKeyInput => json!(PanelKeyInfo)),
    ep!("PATCH" "/api/security/panel-key", "Security", Scoped(Admin, W), "Change the addresses the panel SSH key is accepted from", body = PanelKeyInput => json!(PanelKeyInfo)),
    ep!("POST" "/api/security/panel-key/detect-ip", "Security", Scoped(Admin, W), "Detect the panel's address as the server sees it", body = DetectIpRequest => json!(DetectedIp)),
    ep!("POST" "/api/security/panel-key/deploy", "Security", Scoped(Admin, W), "Install the panel SSH key on servers and switch them to it", body = DeployRequest => json!(Vec<ServerOpResult>)),
    ep!("POST" "/api/security/panel-key/rotate", "Security", Scoped(Admin, W), "Replace the panel SSH key with a new one on all servers" => json!(Vec<ServerOpResult>)),
    ep!("POST" "/api/security/panel-key/revoke", "Security", Scoped(Admin, W), "Emergency removal of panel SSH keys from servers" => json!(Vec<ServerOpResult>)),
    ep!("GET" "/api/audit", "Security", Scoped(Admin, R), "Audit log", q = AuditFilter => json!(Vec<AuditEntry>)),
    ep!("GET" "/api/audit/settings", "Security", Scoped(Admin, R), "Audit log forwarding (syslog, webhook) and retention" => json!(AuditSettings)),
    ep!("PATCH" "/api/audit/settings", "Security", Scoped(Admin, W), "Change audit log forwarding", body = AuditSettingsInput => json!(AuditSettings)),
    ep!("POST" "/api/audit/test", "Security", Scoped(Admin, W), "Send a test event to syslog/webhook" => json!(OkResult)),
    ep!("POST" "/api/backup-keys/generate", "Backups", Scoped(Backups, W), "Generate an age key pair (the private key is shown once and not stored)" => json!(BackupKeyPair)),
    // ----- system -----
    ep!("GET" "/api/system/version", "Meta", Authenticated, "Panel version and platform" => json!(VersionInfo)),
    ep!("GET" "/api/system/update", "Updates", Scoped(Admin, R), "Whether a new version is available (refresh=1 checks now)", q = RefreshQuery => json!(UpdateInfo)),
    ep!("PATCH" "/api/system/update/settings", "Updates", Scoped(Admin, W), "Update check settings", body = UpdateSettingsInput => json!(UpdateSettings)),
    ep!("POST" "/api/system/update/install", "Updates", Scoped(Admin, W), "Download, verify and install the latest version; the panel then restarts" => json!(InstallStatus)),
    ep!("GET" "/api/system/update/status", "Updates", Scoped(Admin, R), "Update installation progress" => json!(InstallStatus)),
    // ----- tokens -----
    ep!("GET" "/api/tokens", "Tokens", Scoped(Admin, R), "List API tokens" => json!(Vec<ApiToken>)),
    ep!("POST" "/api/tokens", "Tokens", Scoped(Admin, W), "Issue an API token (the secret is shown once)", body = TokenInput => json!(CreatedToken)),
    ep!("PATCH" "/api/tokens/{id}", "Tokens", Scoped(Admin, W), "Change an API token's name, permissions or expiry", body = TokenInput => json!(ApiToken)),
    ep!("DELETE" "/api/tokens/{id}", "Tokens", Scoped(Admin, W), "Revoke an API token" => NC),
    // ----- projects -----
    ep!("GET" "/api/projects", "Projects", Scoped(Projects, R), "List projects" => json!(Vec<Project>)),
    ep!("POST" "/api/projects", "Projects", Scoped(Projects, W), "Create a project", body = ProjectInput => json!(Project)),
    ep!("GET" "/api/projects/{id}", "Projects", Scoped(Projects, R), "Get a project" => json!(Project)),
    ep!("PATCH" "/api/projects/{id}", "Projects", Scoped(Projects, W), "Update a project", body = ProjectInput => json!(Project)),
    ep!("DELETE" "/api/projects/{id}", "Projects", Scoped(Projects, W), "Delete a project (its servers are kept)" => NC),
    ep!("PUT" "/api/projects/{id}/servers/{server_id}", "Projects", Scoped(Projects, W), "Add a server to a project" => NC),
    ep!("DELETE" "/api/projects/{id}/servers/{server_id}", "Projects", Scoped(Projects, W), "Remove a server from a project" => NC),
    // ----- identities -----
    ep!("GET" "/api/identities", "Identities", Scoped(Identities, R), "List the keychain (without secrets)" => json!(Vec<Identity>)),
    ep!("POST" "/api/identities", "Identities", Scoped(Identities, W), "Add a password or SSH key", body = IdentityInput => json!(Identity)),
    ep!("GET" "/api/identities/{id}", "Identities", Scoped(Identities, R), "Get an identity (without its secret)" => json!(Identity)),
    ep!("PATCH" "/api/identities/{id}", "Identities", Scoped(Identities, W), "Update an identity (the secret only if provided)", body = IdentityInput => json!(Identity)),
    ep!("DELETE" "/api/identities/{id}", "Identities", Scoped(Identities, W), "Delete an identity (409 if in use)" => NC),
    // ----- servers -----
    ep!("GET" "/api/servers", "Servers", Scoped(Servers, R), "List servers", q = ServerFilter => json!(Vec<Server>)),
    ep!("POST" "/api/servers", "Servers", Scoped(Servers, W), "Add a server", body = ServerInput => json!(Server)),
    ep!("POST" "/api/servers/bulk", "Servers", Scoped(Servers, W), "Add many servers (all or nothing)", body = Vec<ServerInput> => json!(Vec<Server>)),
    ep!("GET" "/api/servers/{id}", "Servers", Scoped(Servers, R), "Get a server" => json!(Server)),
    ep!("PATCH" "/api/servers/{id}", "Servers", Scoped(Servers, W), "Update a server", body = ServerInput => json!(Server)),
    ep!("DELETE" "/api/servers/{id}", "Servers", Scoped(Servers, W), "Remove a server from the panel" => NC),
    ep!("POST" "/api/servers/{id}/test", "Servers", Scoped(Servers, R), "Test the SSH connection" => json!(TestResult)),
    ep!("DELETE" "/api/servers/{id}/host-key", "Servers", Scoped(Servers, W), "Forget the pinned host key" => NC),
    ep!("GET" "/api/stats", "Stats", Scoped(Servers, R), "Latest stats for all servers" => json!(Vec<StatsSnapshot>)),
    ep!("GET" "/api/servers/{id}/stats", "Stats", Scoped(Servers, R), "Server stats" => json!(StatsSnapshot)),
    ep!("GET" "/api/servers/{id}/stats/history", "Stats", Scoped(Servers, R), "Metrics history", q = HistoryQuery => json!(Vec<StatsPoint>)),
    // ----- exec & terminals -----
    ep!("POST" "/api/servers/{id}/exec", "Exec", Scoped(Exec, W), "Run a command on a server", body = ExecRequest => json!(ExecOutput)),
    ep!("POST" "/api/exec", "Exec", Scoped(Exec, W), "Run a command on many servers", body = BulkExecRequest => json!(BulkExecResponse)),
    ep!("GET" "/api/servers/{id}/terminal", "Exec", Scoped(Exec, W), "Interactive terminal over WebSocket (binary frames carry data, text frames carry JSON commands)", q = TermQuery => Reply::WebSocket),
    ep!("GET" "/api/terminal-sessions", "Terminal sessions", Scoped(Exec, W), "List open terminal sessions" => json!(Vec<TerminalInfo>)),
    ep!("POST" "/api/terminal-sessions", "Terminal sessions", Scoped(Exec, W), "Open a persistent terminal session (PTY)", body = OpenTerminal => json!(TerminalInfo)),
    ep!("GET" "/api/terminal-sessions/{id}", "Terminal sessions", Scoped(Exec, W), "Get a terminal session" => json!(TerminalInfo)),
    ep!("DELETE" "/api/terminal-sessions/{id}", "Terminal sessions", Scoped(Exec, W), "Close a terminal session" => NC),
    ep!("POST" "/api/terminal-sessions/{id}/input", "Terminal sessions", Scoped(Exec, W), "Send input (and wait for output)", body = TerminalInput => json!(TerminalOutput)),
    ep!("GET" "/api/terminal-sessions/{id}/output", "Terminal sessions", Scoped(Exec, W), "Read output starting from an offset", q = ReadQuery => json!(TerminalOutput)),
    ep!("POST" "/api/terminal-sessions/{id}/resize", "Terminal sessions", Scoped(Exec, W), "Resize the terminal", body = ResizeTerminal => json!(TerminalInfo)),
    // ----- system -----
    ep!("GET" "/api/servers/{id}/processes", "System", Scoped(System, R), "Processes (top 200 by CPU)" => json!(Vec<Process>)),
    ep!("POST" "/api/servers/{id}/processes/{pid}/kill", "System", Scoped(System, W), "Send a signal to a process", body = KillBody => NC),
    ep!("GET" "/api/servers/{id}/services", "System", Scoped(System, R), "systemd services" => json!(Vec<Service>)),
    ep!("GET" "/api/servers/{id}/services/{name}/logs", "System", Scoped(System, R), "Service logs", q = LogsQuery => json!(LogLines)),
    ep!("POST" "/api/servers/{id}/services/{name}/{action}", "System", Scoped(System, W), "start | stop | restart | reload | enable | disable" => json!(ExecOutput)),
    ep!("POST" "/api/servers/{id}/power", "System", Scoped(System, W), "Reboot or shut down", body = PowerBody => NC),
    // ----- files -----
    ep!("GET" "/api/servers/{id}/files", "Files", Scoped(Files, R), "List a directory (home directory by default)", q = ListQuery => json!(DirListing)),
    ep!("DELETE" "/api/servers/{id}/files", "Files", Scoped(Files, W), "Delete a file or directory (recursive=1)", q = DeleteQuery => NC),
    ep!("GET" "/api/servers/{id}/files/content", "Files", Scoped(Files, R), "Download a file (download=1 sends it as an attachment)", q = DownloadQuery => Reply::Binary),
    ep!("PUT" "/api/servers/{id}/files/content", "Files", Scoped(Files, W), "Upload or overwrite a file (body is raw bytes, up to 512 MiB)", q = UploadQuery, raw = binary => NC),
    ep!("POST" "/api/servers/{id}/files/mkdir", "Files", Scoped(Files, W), "Create a directory", body = MkdirBody => NC),
    ep!("POST" "/api/servers/{id}/files/rename", "Files", Scoped(Files, W), "Rename or move", body = RenameBody => NC),
    // ----- notes -----
    ep!("GET" "/api/notes", "Notes", Scoped(Notes, R), "List notes (filter by project/server)", q = NoteFilter => json!(Vec<Note>)),
    ep!("POST" "/api/notes", "Notes", Scoped(Notes, W), "Create a note", body = NoteInput => json!(Note)),
    ep!("GET" "/api/notes/{id}", "Notes", Scoped(Notes, R), "Get a note" => json!(Note)),
    ep!("PATCH" "/api/notes/{id}", "Notes", Scoped(Notes, W), "Update a note (null unlinks it from the project/server)", body = NoteInput => json!(Note)),
    ep!("DELETE" "/api/notes/{id}", "Notes", Scoped(Notes, W), "Delete a note" => NC),
    // ----- graphs -----
    ep!("GET" "/api/graphs", "Graphs", Scoped(Graphs, R), "List graphs", q = GraphFilter => json!(Vec<GraphSummary>)),
    ep!("POST" "/api/graphs", "Graphs", Scoped(Graphs, W), "Create a graph", body = GraphInput => json!(Graph)),
    ep!("GET" "/api/graphs/{id}", "Graphs", Scoped(Graphs, R), "Get a full graph (document with nodes and edges)" => json!(Graph)),
    ep!("PATCH" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "Update a graph; pass version to guard against overwrites (409)", body = GraphInput => json!(Graph)),
    ep!("PUT" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "Same as PATCH", body = GraphInput => json!(Graph)),
    ep!("DELETE" "/api/graphs/{id}", "Graphs", Scoped(Graphs, W), "Delete a graph" => NC),
    ep!("POST" "/api/graphs/{id}/nodes", "Graphs", Scoped(Graphs, W), "Add a node or note to the canvas", body = NodeInput => json!(GraphNode)),
    ep!("PATCH" "/api/graphs/{id}/nodes/{node_id}", "Graphs", Scoped(Graphs, W), "Update a node", body = NodeInput => json!(GraphNode)),
    ep!("DELETE" "/api/graphs/{id}/nodes/{node_id}", "Graphs", Scoped(Graphs, W), "Delete a node along with its edges" => NC),
    ep!("POST" "/api/graphs/{id}/edges", "Graphs", Scoped(Graphs, W), "Connect two nodes", body = EdgeInput => json!(GraphEdge)),
    ep!("PATCH" "/api/graphs/{id}/edges/{edge_id}", "Graphs", Scoped(Graphs, W), "Update an edge", body = EdgeInput => json!(GraphEdge)),
    ep!("DELETE" "/api/graphs/{id}/edges/{edge_id}", "Graphs", Scoped(Graphs, W), "Delete an edge" => NC),
    // ----- backups -----
    ep!("GET" "/api/backup-storages", "Backups", Scoped(Backups, R), "List backup storages" => json!(Vec<Storage>)),
    ep!("POST" "/api/backup-storages", "Backups", Scoped(Backups, W), "Add a storage (panel directory or S3)", body = StorageInput => json!(Storage)),
    ep!("GET" "/api/backup-storages/{id}", "Backups", Scoped(Backups, R), "Get a storage" => json!(Storage)),
    ep!("PATCH" "/api/backup-storages/{id}", "Backups", Scoped(Backups, W), "Update a storage", body = StorageInput => json!(Storage)),
    ep!("DELETE" "/api/backup-storages/{id}", "Backups", Scoped(Backups, W), "Delete a storage (409 if in use)" => NC),
    ep!("POST" "/api/backup-storages/{id}/test", "Backups", Scoped(Backups, W), "Test writing to a storage" => json!(OkResult)),
    ep!("GET" "/api/backup-jobs", "Backups", Scoped(Backups, R), "List backup jobs", q = JobsQuery => json!(Vec<BackupJob>)),
    ep!("POST" "/api/backup-jobs", "Backups", Scoped(Backups, W), "Create a backup job", body = BackupJobInput => json!(BackupJob)),
    ep!("GET" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, R), "Get a backup job" => json!(BackupJob)),
    ep!("PATCH" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, W), "Update a backup job", body = BackupJobInput => json!(BackupJob)),
    ep!("DELETE" "/api/backup-jobs/{id}", "Backups", Scoped(Backups, W), "Delete a backup job" => NC),
    ep!("POST" "/api/backup-jobs/{id}/run", "Backups", Scoped(Backups, W), "Run a backup now" => json!(BackupRun)),
    ep!("GET" "/api/backups", "Backups", Scoped(Backups, R), "Backup run history", q = RunFilter => json!(Vec<BackupRun>)),
    ep!("GET" "/api/backups/{id}", "Backups", Scoped(Backups, R), "Get a backup run" => json!(BackupRun)),
    ep!("DELETE" "/api/backups/{id}", "Backups", Scoped(Backups, W), "Delete a backup archive" => NC),
    ep!("GET" "/api/backups/{id}/download", "Backups", Scoped(Backups, R), "Download a backup archive (as stored, encrypted)" => Reply::Binary),
];

pub fn find(method: &str, path: &str) -> Option<&'static Endpoint> {
    ENDPOINTS.iter().find(|e| e.method == method && e.path == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_and_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for e in ENDPOINTS {
            assert!(seen.insert((e.method, e.path)), "duplicate endpoint {} {}", e.method, e.path);
            assert!(e.path.starts_with("/api/"), "{}", e.path);
        }
    }
}
