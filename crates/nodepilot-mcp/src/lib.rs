//! MCP (Model Context Protocol) server that lets AI agents manage the panel and servers.
//!
//! Transports: stdio (`nodepilot mcp [--token np_…]`) and HTTP (`POST /api/mcp` with an API token).
//! Each tool is bound to a permission area and level: `tools/list` shows only the tools the token allows,
//! and `tools/call` checks permissions again.

use nodepilot_core::access::{Area, Level, Principal};
use nodepilot_core::audit::{AuditEvent, Severity};
use nodepilot_core::backups::{BackupJobInput, RunFilter, StorageInput};
use nodepilot_core::graphs::{EdgeInput, GraphFilter, GraphInput, NodeInput};
use nodepilot_core::models::{BulkExecRequest, IdentityInput, NoteFilter, NoteInput, ProjectInput, ServerFilter, ServerInput};
use nodepilot_core::ssh::manage::{PowerAction, ServiceAction, Signal};
use nodepilot_core::terminals::{OpenTerminal, ReadQuery, TerminalInput};
use nodepilot_core::{App, Error};
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const PROTOCOL_VERSION: &str = "2025-06-18";
const READ_LIMIT: u64 = 256 * 1024;

const INSTRUCTIONS: &str = "NodePilot manages fleets of Linux servers (mostly Ubuntu/Debian) over SSH. \
Servers are grouped into projects (a server can be in several). Typical flow: list_projects / list_servers to find targets, \
get_graph to understand how servers depend on each other, get_server_stats for health, exec / bulk_exec for one-off commands, \
terminal_open + terminal_send for interactive work (keeps cwd and env, supports prompts), files and services tools, notes to \
document what you changed, graph tools to keep the infrastructure diagram up to date, backup tools to configure and run backups. \
Commands run as the server's configured user (non-root uses `sudo -n` for service/power actions). These are real production \
servers: prefer read-only checks first and explain destructive actions before doing them. You only see tools your API token allows.";

// ---------- transport ----------

pub async fn serve_stdio(app: App, principal: Principal) -> std::io::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(line) {
            Ok(req) => handle(&app, &principal, req).await,
            Err(e) => Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        if let Some(resp) = response {
            let mut out = serde_json::to_vec(&resp).expect("serializable");
            out.push(b'\n');
            stdout.write_all(&out).await?;
            stdout.flush().await?;
        }
    }
    Ok(())
}

/// Handles one JSON-RPC message. Returns `None` for notifications (no `id`).
pub async fn handle(app: &App, principal: &Principal, req: Value) -> Option<Value> {
    let id = req.get("id").cloned()?;
    let method = req.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    Some(match method {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "nodepilot", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }),
        ),
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": list_tools(principal) })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let Some(tool) = TOOLS.iter().find(|t| t.name == name) else {
                return Some(error(id, -32602, &format!("unknown tool: {name}")));
            };
            let denied = principal.require(tool.area, tool.level).err();
            let logged_args = args.clone();
            let result = match &denied {
                None => call(app, principal, &name, args).await,
                Some(e) => Err(e.to_string()),
            };
            let severity = if denied.is_some() || tool.destructive {
                Severity::Critical
            } else if tool.level == Level::Write {
                Severity::Warning
            } else {
                Severity::Info
            };
            let outcome = match (&denied, &result) {
                (Some(_), _) => "denied".to_owned(),
                (None, Ok(_)) => "ok".to_owned(),
                (None, Err(e)) => format!("error: {}", e.chars().take(300).collect::<String>()),
            };
            app.audit(AuditEvent::new(Some(principal), format!("mcp:{name}")).severity(severity).details(logged_args).outcome(outcome));
            match result {
                Ok(v) => ok(id, json!({ "content": [{ "type": "text", "text": text(&v) }] })),
                Err(msg) => ok(id, json!({ "content": [{ "type": "text", "text": msg }], "isError": true })),
            }
        }
        _ => error(id, -32601, &format!("method not found: {method}")),
    })
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "ok".into(),
        v => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ---------- tool arguments ----------

#[derive(Deserialize, JsonSchema)]
struct Empty {}

macro_rules! id_args {
    ($name:ident { $($field:ident),+ }) => {
        #[derive(Deserialize, JsonSchema)]
        struct $name { $($field: String),+ }
    };
}
id_args!(ServerId { server_id });
id_args!(ProjectId { project_id });
id_args!(ProjectServer { project_id, server_id });
id_args!(IdentityId { identity_id });
id_args!(NoteId { note_id });
id_args!(GraphId { graph_id });
id_args!(GraphNodeId { graph_id, node_id });
id_args!(GraphEdgeId { graph_id, edge_id });
id_args!(StorageId { storage_id });
id_args!(JobId { job_id });
id_args!(BackupId { backup_id });
id_args!(SessionId { session_id });

macro_rules! with_id {
    ($name:ident, $id:ident, $inner:ty) => {
        #[derive(Deserialize, JsonSchema)]
        struct $name {
            $id: String,
            #[serde(flatten)]
            input: $inner,
        }
    };
}
with_id!(UpdateProject, project_id, ProjectInput);
with_id!(UpdateServer, server_id, ServerInput);
with_id!(UpdateIdentity, identity_id, IdentityInput);
with_id!(UpdateNote, note_id, NoteInput);
with_id!(AddNode, graph_id, NodeInput);
with_id!(Connect, graph_id, EdgeInput);
with_id!(UpdateStorage, storage_id, StorageInput);
with_id!(UpdateJob, job_id, BackupJobInput);

#[derive(Deserialize, JsonSchema)]
struct UpdateNode {
    graph_id: String,
    node_id: String,
    #[serde(flatten)]
    input: NodeInput,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateEdge {
    graph_id: String,
    edge_id: String,
    #[serde(flatten)]
    input: EdgeInput,
}
#[derive(Deserialize, JsonSchema)]
struct CreateGraph {
    name: String,
    description: Option<String>,
    project_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct UpdateGraph {
    graph_id: String,
    name: Option<String>,
    description: Option<String>,
    /// Empty string detaches the graph from its project.
    project_id: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct History {
    server_id: String,
    /// 1..744, default 24.
    hours: Option<u32>,
}
#[derive(Deserialize, JsonSchema)]
struct ExecArgs {
    server_id: String,
    command: String,
    /// Default 60, maximum 3600.
    timeout_secs: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
struct TerminalSend {
    session_id: String,
    /// Text to type. Control characters: "\u0003" = Ctrl+C, "\u0004" = Ctrl+D, "\t" = Tab, "\u001b" = Esc.
    data: String,
    /// Press Enter after the text (default true).
    enter: Option<bool>,
    /// How long to wait for output, in ms (default 2000, maximum 30000).
    wait_ms: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
struct TerminalRead {
    session_id: String,
    /// Offset from the previous response (`next`); 0 returns the whole buffer.
    since: Option<u64>,
    wait_ms: Option<u64>,
}
#[derive(Deserialize, JsonSchema)]
struct KillArgs {
    server_id: String,
    pid: u32,
    signal: Option<Signal>,
}
#[derive(Deserialize, JsonSchema)]
struct ServiceArgs {
    server_id: String,
    name: String,
    action: ServiceAction,
}
#[derive(Deserialize, JsonSchema)]
struct LogsArgs {
    server_id: String,
    name: String,
    lines: Option<u32>,
}
#[derive(Deserialize, JsonSchema)]
struct PowerArgs {
    server_id: String,
    action: PowerAction,
}
#[derive(Deserialize, JsonSchema)]
struct PathArgs {
    server_id: String,
    /// Absolute path; for list_files defaults to the home directory.
    path: Option<String>,
}
#[derive(Deserialize, JsonSchema)]
struct WriteArgs {
    server_id: String,
    path: String,
    content: String,
}
#[derive(Deserialize, JsonSchema)]
struct RenameArgs {
    server_id: String,
    from: String,
    to: String,
}
#[derive(Deserialize, JsonSchema)]
struct DeleteArgs {
    server_id: String,
    path: String,
    /// Delete a directory with all its contents.
    recursive: Option<bool>,
}
#[derive(Deserialize, JsonSchema)]
struct JobsArgs {
    server_id: Option<String>,
}

// ---------- registry ----------

type SchemaFn = fn() -> Value;

struct Tool {
    name: &'static str,
    area: Area,
    level: Level,
    description: &'static str,
    schema: SchemaFn,
    destructive: bool,
}

fn schema<T: JsonSchema>() -> Value {
    let mut settings = SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    let mut v = settings.into_generator().into_root_schema_for::<T>().to_value();
    if let Some(o) = v.as_object_mut() {
        o.remove("$schema");
        o.remove("title");
        o.entry("properties").or_insert_with(|| json!({}));
        o.insert("type".into(), json!("object"));
    }
    v
}

macro_rules! tool {
    ($name:literal, $area:ident, $level:ident, $args:ty, $desc:literal) => {
        tool!($name, $area, $level, $args, $desc, false)
    };
    ($name:literal, $area:ident, $level:ident, $args:ty, $desc:literal, $destructive:expr) => {
        Tool {
            name: $name,
            area: Area::$area,
            level: Level::$level,
            description: $desc,
            schema: schema::<$args> as SchemaFn,
            destructive: $destructive,
        }
    };
}

const DESTRUCTIVE: bool = true;

static TOOLS: &[Tool] = &[
    // projects
    tool!("list_projects", Projects, Read, Empty, "List projects (groups of servers) with server counts."),
    tool!("create_project", Projects, Write, ProjectInput, "Create a project."),
    tool!("update_project", Projects, Write, UpdateProject, "Rename a project or change its description/color."),
    tool!("delete_project", Projects, Write, ProjectId, "Delete a project (servers stay in the panel).", DESTRUCTIVE),
    tool!("add_server_to_project", Projects, Write, ProjectServer, "Add a server to a project."),
    tool!("remove_server_from_project", Projects, Write, ProjectServer, "Remove a server from a project."),
    // servers
    tool!("list_servers", Servers, Read, ServerFilter, "List servers (compact), filter by project, name/host substring or tag."),
    tool!("get_server", Servers, Read, ServerId, "Full server card (no secrets)."),
    tool!(
        "create_server",
        Servers,
        Write,
        ServerInput,
        "Add a server. auth: {type:'identity',identity_id} | {type:'password',password} | {type:'key',private_key,passphrase?}."
    ),
    tool!(
        "update_server",
        Servers,
        Write,
        UpdateServer,
        "Change server fields; omit `auth` to keep credentials; project_ids replaces the whole set."
    ),
    tool!("delete_server", Servers, Write, ServerId, "Remove a server from the panel (the machine itself is untouched).", DESTRUCTIVE),
    tool!("test_server", Servers, Read, ServerId, "Test SSH connectivity and latency."),
    tool!("get_server_stats", Servers, Read, ServerId, "Collect live stats: CPU %, load, RAM, swap, disks, network, uptime, OS."),
    tool!("get_stats_history", Servers, Read, History, "Metrics history (downsampled to ~600 points)."),
    // identities
    tool!("list_identities", Identities, Read, Empty, "Keychain entries (names and kinds only, never secrets)."),
    tool!("create_identity", Identities, Write, IdentityInput, "Store a reusable password or SSH private key."),
    tool!("update_identity", Identities, Write, UpdateIdentity, "Rename or replace the secret of a keychain entry."),
    tool!("delete_identity", Identities, Write, IdentityId, "Delete a keychain entry (fails if servers use it).", DESTRUCTIVE),
    // exec & terminal
    tool!(
        "exec",
        Exec,
        Write,
        ExecArgs,
        "Run a non-interactive shell command on one server. Returns exit_code, stdout, stderr (1 MiB cap each).",
        DESTRUCTIVE
    ),
    tool!(
        "bulk_exec",
        Exec,
        Write,
        BulkExecRequest,
        "Run the same command on many servers in parallel (by project_id and/or server_ids).",
        DESTRUCTIVE
    ),
    tool!(
        "terminal_open",
        Exec,
        Write,
        OpenTerminal,
        "Open a persistent interactive shell (PTY) on a server. Keeps cwd/env between commands; use for interactive programs and prompts."
    ),
    tool!(
        "terminal_send",
        Exec,
        Write,
        TerminalSend,
        "Type into a terminal session (Enter pressed by default) and return the new output (ANSI stripped).",
        DESTRUCTIVE
    ),
    tool!("terminal_read", Exec, Write, TerminalRead, "Read terminal output since an offset (e.g. while a long command runs)."),
    tool!("terminal_list", Exec, Write, Empty, "Open terminal sessions."),
    tool!("terminal_close", Exec, Write, SessionId, "Close a terminal session."),
    // system
    tool!("list_processes", System, Read, ServerId, "Top 200 processes by CPU."),
    tool!("kill_process", System, Write, KillArgs, "Send TERM (default), KILL or HUP to a process.", DESTRUCTIVE),
    tool!("list_services", System, Read, ServerId, "systemd services with load/active/sub state."),
    tool!(
        "service_action",
        System,
        Write,
        ServiceArgs,
        "start | stop | restart | reload | enable | disable a systemd service.",
        DESTRUCTIVE
    ),
    tool!("service_logs", System, Read, LogsArgs, "Recent journal lines of a systemd service."),
    tool!("power", System, Write, PowerArgs, "Reboot or shut down a server.", DESTRUCTIVE),
    // files
    tool!("list_files", Files, Read, PathArgs, "List a directory over SFTP (default: home)."),
    tool!("read_file", Files, Read, PathArgs, "Read a UTF-8 text file (max 256 KiB)."),
    tool!("write_file", Files, Write, WriteArgs, "Create or overwrite a text file.", DESTRUCTIVE),
    tool!("make_dir", Files, Write, PathArgs, "Create a directory."),
    tool!("rename_path", Files, Write, RenameArgs, "Rename or move a file/directory.", DESTRUCTIVE),
    tool!("delete_path", Files, Write, DeleteArgs, "Delete a file, or a directory with recursive=true.", DESTRUCTIVE),
    // notes
    tool!("list_notes", Notes, Read, NoteFilter, "Markdown notes, optionally for a project or server."),
    tool!("get_note", Notes, Read, NoteId, "A note with its full body."),
    tool!("create_note", Notes, Write, NoteInput, "Create a markdown note (e.g. document what you changed)."),
    tool!("update_note", Notes, Write, UpdateNote, "Edit a note; project_id/server_id null detaches it."),
    tool!("delete_note", Notes, Write, NoteId, "Delete a note.", DESTRUCTIVE),
    // graphs
    tool!("list_graphs", Graphs, Read, GraphFilter, "Infrastructure diagrams (graphs)."),
    tool!(
        "get_graph",
        Graphs,
        Read,
        GraphId,
        "Read a graph as text: nodes (ids, roles, linked servers), typed connections (ids) and notes."
    ),
    tool!("create_graph", Graphs, Write, CreateGraph, "Create an empty graph."),
    tool!("update_graph", Graphs, Write, UpdateGraph, "Rename a graph or change its description/project."),
    tool!("delete_graph", Graphs, Write, GraphId, "Delete a graph.", DESTRUCTIVE),
    tool!(
        "graph_add_node",
        Graphs,
        Write,
        AddNode,
        "Add a node (type 'node' with role and optional server_id) or a canvas note (type 'note', text in `note`). Position is automatic if x/y omitted."
    ),
    tool!("graph_update_node", Graphs, Write, UpdateNode, "Change a node: label, role, server_id, color, note, position."),
    tool!("graph_remove_node", Graphs, Write, GraphNodeId, "Remove a node and all its connections.", DESTRUCTIVE),
    tool!(
        "graph_connect",
        Graphs,
        Write,
        Connect,
        "Connect two nodes. kind: link | depends | cascade | vpn | replication | other; label and note explain why."
    ),
    tool!("graph_update_edge", Graphs, Write, UpdateEdge, "Change a connection: kind, label, note, direction, endpoints."),
    tool!("graph_remove_edge", Graphs, Write, GraphEdgeId, "Remove a connection.", DESTRUCTIVE),
    // backups
    tool!("list_backup_storages", Backups, Read, Empty, "Backup storages (panel directory or S3)."),
    tool!("create_backup_storage", Backups, Write, StorageInput, "Add a storage: kind 'local' with local.path, or 's3' with s3 settings."),
    tool!("update_backup_storage", Backups, Write, UpdateStorage, "Change a storage (S3 secret kept if omitted)."),
    tool!("delete_backup_storage", Backups, Write, StorageId, "Delete a storage (fails if jobs use it).", DESTRUCTIVE),
    tool!("test_backup_storage", Backups, Write, StorageId, "Write and delete a probe object to verify a storage."),
    tool!("list_backup_jobs", Backups, Read, JobsArgs, "Backup jobs (files / postgres / mysql), schedules and last run."),
    tool!("get_backup_job", Backups, Read, JobId, "A backup job."),
    tool!(
        "create_backup_job",
        Backups,
        Write,
        BackupJobInput,
        "Create a backup job. schedule is cron in UTC: 6 fields with seconds ('0 0 3 * * *' = daily 03:00, '0 0 4 * * Sun') or classic 5-field crontab ('0 3 * * 1' = Mondays 03:00); encryption: 'none', 'passphrase' (set passphrase) or 'recipients' (age public keys in recipients; the panel cannot decrypt those)."
    ),
    tool!("update_backup_job", Backups, Write, UpdateJob, "Change a backup job (secrets kept if omitted)."),
    tool!(
        "delete_backup_job",
        Backups,
        Write,
        JobId,
        "Delete a backup job and its run history. Archive files stay in the storage but are no longer listed.",
        DESTRUCTIVE
    ),
    tool!("run_backup", Backups, Write, JobId, "Start a backup job now (runs in background; poll list_backups)."),
    tool!("list_backups", Backups, Read, RunFilter, "Backup runs with status, size and errors."),
    tool!("delete_backup", Backups, Write, BackupId, "Delete a backup archive.", DESTRUCTIVE),
];

/// These need `exec:write` (session access) but change nothing.
const READ_ONLY_EXEC: &[&str] = &["terminal_read", "terminal_list"];

fn list_tools(principal: &Principal) -> Vec<Value> {
    TOOLS
        .iter()
        .filter(|t| principal.perms.allows(t.area, t.level))
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": {
                    "readOnlyHint": t.level == Level::Read || READ_ONLY_EXEC.contains(&t.name),
                    "destructiveHint": t.destructive,
                },
                "_meta": { "nodepilot/permission": format!("{}:{}", t.area.as_str(), if t.level == Level::Read { "read" } else { "write" }) },
            })
        })
        .collect()
}

// ---------- calls ----------

fn args<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("invalid arguments: {e}"))
}

fn val<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

trait OrMsg<T> {
    fn m(self) -> Result<T, String>;
}
impl<T> OrMsg<T> for Result<T, Error> {
    fn m(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

fn done(r: Result<(), Error>) -> Result<Value, String> {
    r.m().map(|_| Value::Null)
}

async fn call(app: &App, principal: &Principal, name: &str, a: Value) -> Result<Value, String> {
    match name {
        // projects
        "list_projects" => val(app.list_projects().await.m()?),
        "create_project" => val(app.create_project(args(a)?).await.m()?),
        "update_project" => {
            let a: UpdateProject = args(a)?;
            val(app.update_project(&a.project_id, a.input).await.m()?)
        }
        "delete_project" => done(app.delete_project(&args::<ProjectId>(a)?.project_id).await),
        "add_server_to_project" => {
            let a: ProjectServer = args(a)?;
            done(app.add_server_to_project(&a.project_id, &a.server_id).await)
        }
        "remove_server_from_project" => {
            let a: ProjectServer = args(a)?;
            done(app.remove_server_from_project(&a.project_id, &a.server_id).await)
        }
        // servers
        "list_servers" => {
            let f: ServerFilter = args(a)?;
            let servers = app.list_servers(&f).await.m()?;
            Ok(Value::Array(
                servers
                    .into_iter()
                    .map(|s| {
                        json!({ "id": s.id, "name": s.name, "host": s.host, "port": s.port, "username": s.username,
                                "tags": s.tags, "project_ids": s.project_ids, "status": s.status, "description": s.description })
                    })
                    .collect(),
            ))
        }
        "get_server" => val(app.get_server(&args::<ServerId>(a)?.server_id).await.m()?),
        "create_server" => val(app.create_server(args(a)?).await.m()?),
        "update_server" => {
            let a: UpdateServer = args(a)?;
            val(app.update_server(&a.server_id, a.input).await.m()?)
        }
        "delete_server" => done(app.delete_server(&args::<ServerId>(a)?.server_id).await),
        "test_server" => val(app.test_server(&args::<ServerId>(a)?.server_id).await.m()?),
        "get_server_stats" => {
            let id = args::<ServerId>(a)?.server_id;
            app.get_server(&id).await.m()?;
            val(app.collect_stats(&id).await.m()?)
        }
        "get_stats_history" => {
            let a: History = args(a)?;
            val(app.stats_history(&a.server_id, a.hours.unwrap_or(24)).await.m()?)
        }
        // identities
        "list_identities" => val(app.list_identities().await.m()?),
        "create_identity" => val(app.create_identity(args(a)?).await.m()?),
        "update_identity" => {
            let a: UpdateIdentity = args(a)?;
            val(app.update_identity(&a.identity_id, a.input).await.m()?)
        }
        "delete_identity" => done(app.delete_identity(&args::<IdentityId>(a)?.identity_id).await),
        // exec & terminal
        "exec" => {
            let a: ExecArgs = args(a)?;
            val(app.exec(&a.server_id, &a.command, a.timeout_secs).await.m()?)
        }
        "bulk_exec" => val(app.bulk_exec(args::<BulkExecRequest>(a)?).await.m()?),
        "terminal_open" => {
            let info = app.open_terminal(args(a)?, &principal.label()).await.m()?;
            let out = app.terminal_output(&info.id, ReadQuery { since: 0, wait_ms: Some(1500), strip_ansi: true }).await.m()?;
            Ok(json!({ "session": info, "output": out }))
        }
        "terminal_send" => {
            let a: TerminalSend = args(a)?;
            let input =
                TerminalInput { data: a.data, enter: a.enter.unwrap_or(true), wait_ms: Some(a.wait_ms.unwrap_or(2000)), strip_ansi: true };
            val(app.terminal_input(&a.session_id, input).await.m()?)
        }
        "terminal_read" => {
            let a: TerminalRead = args(a)?;
            val(app
                .terminal_output(&a.session_id, ReadQuery { since: a.since.unwrap_or(0), wait_ms: a.wait_ms, strip_ansi: true })
                .await
                .m()?)
        }
        "terminal_list" => val(app.list_terminals()),
        "terminal_close" => done(app.close_terminal(&args::<SessionId>(a)?.session_id).await),
        // system
        "list_processes" => val(app.processes(&args::<ServerId>(a)?.server_id).await.m()?),
        "kill_process" => {
            let a: KillArgs = args(a)?;
            done(app.kill_process(&a.server_id, a.pid, a.signal.unwrap_or_default()).await)
        }
        "list_services" => val(app.services(&args::<ServerId>(a)?.server_id).await.m()?),
        "service_action" => {
            let a: ServiceArgs = args(a)?;
            val(app.service_action(&a.server_id, &a.name, a.action).await.m()?)
        }
        "service_logs" => {
            let a: LogsArgs = args(a)?;
            Ok(Value::String(app.service_logs(&a.server_id, &a.name, a.lines.unwrap_or(200)).await.m()?.join("\n")))
        }
        "power" => {
            let a: PowerArgs = args(a)?;
            done(app.power(&a.server_id, a.action).await)
        }
        // files
        "list_files" => {
            let a: PathArgs = args(a)?;
            val(app.list_dir(&a.server_id, a.path.as_deref()).await.m()?)
        }
        "read_file" => {
            let a: PathArgs = args(a)?;
            let path = a.path.ok_or("path is required")?;
            let data = app.read_file(&a.server_id, &path, READ_LIMIT).await.m()?;
            Ok(Value::String(String::from_utf8(data).map_err(|_| "file is not valid UTF-8 text".to_owned())?))
        }
        "write_file" => {
            let a: WriteArgs = args(a)?;
            done(app.write_file(&a.server_id, &a.path, a.content.into_bytes()).await)
        }
        "make_dir" => {
            let a: PathArgs = args(a)?;
            done(app.make_dir(&a.server_id, a.path.as_deref().ok_or("path is required")?).await)
        }
        "rename_path" => {
            let a: RenameArgs = args(a)?;
            done(app.rename_path(&a.server_id, &a.from, &a.to).await)
        }
        "delete_path" => {
            let a: DeleteArgs = args(a)?;
            done(app.delete_path(&a.server_id, &a.path, a.recursive.unwrap_or(false)).await)
        }
        // notes
        "list_notes" => val(app.list_notes(&args::<NoteFilter>(a)?).await.m()?),
        "get_note" => val(app.get_note(&args::<NoteId>(a)?.note_id).await.m()?),
        "create_note" => val(app.create_note(args(a)?).await.m()?),
        "update_note" => {
            let a: UpdateNote = args(a)?;
            val(app.update_note(&a.note_id, a.input).await.m()?)
        }
        "delete_note" => done(app.delete_note(&args::<NoteId>(a)?.note_id).await),
        // graphs
        "list_graphs" => val(app.list_graphs(&args::<GraphFilter>(a)?).await.m()?),
        "get_graph" => describe_graph(app, &args::<GraphId>(a)?.graph_id).await.map(Value::String),
        "create_graph" => {
            let a: CreateGraph = args(a)?;
            let input =
                GraphInput { name: Some(a.name), description: a.description, project_id: Some(a.project_id), doc: None, version: None };
            val(app.create_graph(input).await.m()?.summary)
        }
        "update_graph" => {
            let a: UpdateGraph = args(a)?;
            let project_id = a.project_id.map(|p| if p.is_empty() { None } else { Some(p) });
            let input = GraphInput { name: a.name, description: a.description, project_id, doc: None, version: None };
            val(app.update_graph(&a.graph_id, input).await.m()?.summary)
        }
        "delete_graph" => done(app.delete_graph(&args::<GraphId>(a)?.graph_id).await),
        "graph_add_node" => {
            let a: AddNode = args(a)?;
            val(app.add_graph_node(&a.graph_id, a.input).await.m()?)
        }
        "graph_update_node" => {
            let a: UpdateNode = args(a)?;
            val(app.update_graph_node(&a.graph_id, &a.node_id, a.input).await.m()?)
        }
        "graph_remove_node" => {
            let a: GraphNodeId = args(a)?;
            done(app.remove_graph_node(&a.graph_id, &a.node_id).await)
        }
        "graph_connect" => {
            let a: Connect = args(a)?;
            val(app.add_graph_edge(&a.graph_id, a.input).await.m()?)
        }
        "graph_update_edge" => {
            let a: UpdateEdge = args(a)?;
            val(app.update_graph_edge(&a.graph_id, &a.edge_id, a.input).await.m()?)
        }
        "graph_remove_edge" => {
            let a: GraphEdgeId = args(a)?;
            done(app.remove_graph_edge(&a.graph_id, &a.edge_id).await)
        }
        // backups
        "list_backup_storages" => val(app.list_storages().await.m()?),
        "create_backup_storage" => val(app.create_storage(args(a)?).await.m()?),
        "update_backup_storage" => {
            let a: UpdateStorage = args(a)?;
            val(app.update_storage(&a.storage_id, a.input).await.m()?)
        }
        "delete_backup_storage" => done(app.delete_storage(&args::<StorageId>(a)?.storage_id).await),
        "test_backup_storage" => match app.test_storage(&args::<StorageId>(a)?.storage_id).await {
            Ok(()) => Ok(json!({ "ok": true })),
            Err(e) => Ok(json!({ "ok": false, "error": e.to_string() })),
        },
        "list_backup_jobs" => val(app.list_backup_jobs(args::<JobsArgs>(a)?.server_id.as_deref()).await.m()?),
        "get_backup_job" => val(app.get_backup_job(&args::<JobId>(a)?.job_id).await.m()?),
        "create_backup_job" => val(app.create_backup_job(args(a)?).await.m()?),
        "update_backup_job" => {
            let a: UpdateJob = args(a)?;
            val(app.update_backup_job(&a.job_id, a.input).await.m()?)
        }
        "delete_backup_job" => done(app.delete_backup_job(&args::<JobId>(a)?.job_id).await),
        "run_backup" => val(app.run_backup(&args::<JobId>(a)?.job_id).await.m()?),
        "list_backups" => val(app.list_backup_runs(&args::<RunFilter>(a)?).await.m()?),
        "delete_backup" => done(app.delete_backup_run(&args::<BackupId>(a)?.backup_id).await),
        other => Err(format!("unknown tool: {other}")),
    }
}

async fn describe_graph(app: &App, id: &str) -> Result<String, String> {
    use std::fmt::Write as _;
    let g = app.get_graph(id).await.m()?;
    let servers = app.list_servers(&ServerFilter::default()).await.m()?;
    let server = |sid: &Option<String>| {
        sid.as_ref().map(|sid| match servers.iter().find(|s| &s.id == sid) {
            Some(s) => format!("server {} ({}@{}, id {}, status {:?})", s.name, s.username, s.host, s.id, s.status),
            None => format!("server {sid} (deleted)"),
        })
    };
    let label = |nid: &str| g.doc.nodes.iter().find(|n| n.id == nid).map(|n| n.label.clone()).unwrap_or_else(|| nid.to_owned());
    let indent = |s: &str| s.trim().replace('\n', "\n  ");

    let mut out = format!("Graph \"{}\" (id {}, version {})", g.summary.name, g.summary.id, g.summary.version);
    if !g.summary.description.is_empty() {
        let _ = write!(out, " — {}", g.summary.description);
    }
    out.push_str("\n\nNodes:\n");
    for n in g.doc.nodes.iter().filter(|n| n.kind == "node") {
        let _ = write!(out, "- [{}] {}", n.id, if n.label.is_empty() { "(unnamed)" } else { &n.label });
        if let Some(r) = &n.role {
            let _ = write!(out, " (role: {r})");
        }
        if let Some(s) = server(&n.server_id) {
            let _ = write!(out, " -> {s}");
        }
        if !n.note.trim().is_empty() {
            let _ = write!(out, "\n  note: {}", indent(&n.note));
        }
        out.push('\n');
    }
    out.push_str("\nConnections:\n");
    for e in &g.doc.edges {
        let arrow = if e.directed { "->" } else { "<->" };
        let _ = write!(out, "- [{}] {} {arrow} {} ({})", e.id, label(&e.source), label(&e.target), e.kind);
        if !e.label.is_empty() {
            let _ = write!(out, ": {}", e.label);
        }
        if !e.note.trim().is_empty() {
            let _ = write!(out, " — note: {}", indent(&e.note));
        }
        out.push('\n');
    }
    let notes: Vec<_> = g.doc.nodes.iter().filter(|n| n.kind == "note").collect();
    if !notes.is_empty() {
        out.push_str("\nCanvas notes:\n");
        for n in notes {
            let _ = writeln!(out, "- [{}] {}", n.id, indent(&n.note));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_unique_and_schemas_are_objects() {
        let mut seen = std::collections::HashSet::new();
        for t in TOOLS {
            assert!(seen.insert(t.name), "duplicate tool {}", t.name);
            let s = (t.schema)();
            assert_eq!(s["type"], "object", "{}", t.name);
            assert!(!s.to_string().contains("\"$ref\""), "{} schema must be self-contained", t.name);
        }
    }
}
