use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use nodepilot_core::App;
use nodepilot_core::backups::{BackupJob, BackupJobInput, BackupRun, RunFilter, Storage, StorageInput};
use nodepilot_core::graphs::{EdgeInput, Graph, GraphEdge, GraphFilter, GraphInput, GraphNode, GraphSummary, NodeInput};
use nodepilot_core::models::*;
use nodepilot_core::ssh::ExecOutput;
use nodepilot_core::ssh::manage::{Process, Service, ServiceAction};
use nodepilot_core::stats::{StatsPoint, StatsSnapshot};
use nodepilot_core::terminals::{OpenTerminal, ReadQuery, ResizeTerminal, TerminalInfo, TerminalInput, TerminalOutput};
use nodepilot_core::updates::{InstallStatus, UpdateInfo, UpdateSettings, UpdateSettingsInput};

use nodepilot_core::audit::{AuditEvent, Severity};
use serde_json::json;

use crate::api_types::*;
use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};

type Id = Path<String>;
const NO_CONTENT: StatusCode = StatusCode::NO_CONTENT;

// ---------- projects ----------

async fn list_projects(State(app): State<App>, _: AuthUser) -> ApiResult<Json<Vec<Project>>> {
    Ok(Json(app.list_projects().await?))
}
async fn create_project(State(app): State<App>, _: AuthUser, Json(b): Json<ProjectInput>) -> ApiResult<Json<Project>> {
    Ok(Json(app.create_project(b).await?))
}
async fn get_project(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Project>> {
    Ok(Json(app.get_project(&id).await?))
}
async fn update_project(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<ProjectInput>) -> ApiResult<Json<Project>> {
    Ok(Json(app.update_project(&id, b).await?))
}
async fn delete_project(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_project(&id).await?;
    Ok(NO_CONTENT)
}
async fn add_project_server(State(app): State<App>, _: AuthUser, Path((p, s)): Path<(String, String)>) -> ApiResult<StatusCode> {
    app.add_server_to_project(&p, &s).await?;
    Ok(NO_CONTENT)
}
async fn remove_project_server(State(app): State<App>, _: AuthUser, Path((p, s)): Path<(String, String)>) -> ApiResult<StatusCode> {
    app.remove_server_from_project(&p, &s).await?;
    Ok(NO_CONTENT)
}

// ---------- identities ----------

async fn list_identities(State(app): State<App>, _: AuthUser) -> ApiResult<Json<Vec<Identity>>> {
    Ok(Json(app.list_identities().await?))
}
async fn create_identity(State(app): State<App>, _: AuthUser, Json(b): Json<IdentityInput>) -> ApiResult<Json<Identity>> {
    Ok(Json(app.create_identity(b).await?))
}
async fn update_identity(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<IdentityInput>) -> ApiResult<Json<Identity>> {
    Ok(Json(app.update_identity(&id, b).await?))
}
async fn delete_identity(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_identity(&id).await?;
    Ok(NO_CONTENT)
}

// ---------- servers ----------

async fn list_servers(State(app): State<App>, _: AuthUser, Query(f): Query<ServerFilter>) -> ApiResult<Json<Vec<Server>>> {
    Ok(Json(app.list_servers(&f).await?))
}
async fn create_server(State(app): State<App>, _: AuthUser, Json(b): Json<ServerInput>) -> ApiResult<Json<Server>> {
    Ok(Json(app.create_server(b).await?))
}
async fn create_servers(State(app): State<App>, _: AuthUser, Json(b): Json<Vec<ServerInput>>) -> ApiResult<Json<Vec<Server>>> {
    Ok(Json(app.create_servers(b).await?))
}
async fn get_server(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Server>> {
    Ok(Json(app.get_server(&id).await?))
}
async fn update_server(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<ServerInput>) -> ApiResult<Json<Server>> {
    Ok(Json(app.update_server(&id, b).await?))
}
async fn delete_server(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_server(&id).await?;
    Ok(NO_CONTENT)
}
async fn test_server(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<TestResult>> {
    Ok(Json(app.test_server(&id).await?))
}
async fn reset_host_key(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.reset_host_key(&id).await?;
    Ok(NO_CONTENT)
}

// ---------- exec ----------

async fn exec(State(app): State<App>, AuthUser(p): AuthUser, Path(id): Id, Json(b): Json<ExecRequest>) -> ApiResult<Json<ExecOutput>> {
    let r = app.exec(&id, &b.command, b.timeout_secs).await;
    let outcome = match &r {
        Ok(o) => format!("exit {}", o.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())),
        Err(e) => format!("error: {e}"),
    };
    app.audit(
        AuditEvent::new(Some(&p), "exec").target(id).severity(Severity::Warning).details(json!({ "command": b.command })).outcome(outcome),
    );
    Ok(Json(r?))
}
async fn bulk_exec(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<BulkExecRequest>) -> ApiResult<Json<BulkExecResponse>> {
    app.audit(
        AuditEvent::new(Some(&p), "exec:bulk")
            .target(b.project_id.clone().unwrap_or_else(|| format!("{} servers", b.server_ids.as_ref().map_or(0, Vec::len))))
            .severity(Severity::Critical)
            .details(json!({ "command": b.command, "project_id": b.project_id, "server_ids": b.server_ids })),
    );
    Ok(Json(BulkExecResponse { results: app.bulk_exec(b).await? }))
}

// ---------- stats ----------

async fn all_stats(State(app): State<App>, _: AuthUser) -> ApiResult<Json<Vec<StatsSnapshot>>> {
    let ids: Vec<String> = app.list_servers(&ServerFilter::default()).await?.into_iter().map(|s| s.id).collect();
    Ok(Json(app.all_stats(&ids)))
}
async fn server_stats(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<StatsSnapshot>> {
    app.get_server(&id).await?;
    let snap = app.stats.get(&id);
    // Not polled yet: collect now so the server page is not empty.
    if snap.collected_at.is_none() && snap.error.is_none() {
        return Ok(Json(app.collect_stats(&id).await.unwrap_or_else(|_| app.stats.get(&id))));
    }
    Ok(Json(snap))
}
async fn stats_history(
    State(app): State<App>,
    _: AuthUser,
    Path(id): Id,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Vec<StatsPoint>>> {
    Ok(Json(app.stats_history(&id, q.hours.unwrap_or(24)).await?))
}

// ---------- management ----------

async fn processes(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Vec<Process>>> {
    Ok(Json(app.processes(&id).await?))
}
async fn kill(
    State(app): State<App>,
    _: AuthUser,
    Path((id, pid)): Path<(String, u32)>,
    body: Option<Json<KillBody>>,
) -> ApiResult<StatusCode> {
    app.kill_process(&id, pid, body.map(|b| b.0).unwrap_or_default().signal).await?;
    Ok(NO_CONTENT)
}
async fn services(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Vec<Service>>> {
    Ok(Json(app.services(&id).await?))
}
async fn service_action(
    State(app): State<App>,
    _: AuthUser,
    Path((id, name, action)): Path<(String, String, String)>,
) -> ApiResult<Json<ExecOutput>> {
    let action: ServiceAction = action.parse().map_err(|_| ApiError(nodepilot_core::Error::BadRequest("unknown action".into())))?;
    Ok(Json(app.service_action(&id, &name, action).await?))
}
async fn service_logs(
    State(app): State<App>,
    _: AuthUser,
    Path((id, name)): Path<(String, String)>,
    Query(q): Query<LogsQuery>,
) -> ApiResult<Json<LogLines>> {
    Ok(Json(LogLines { lines: app.service_logs(&id, &name, q.lines.unwrap_or(200)).await? }))
}
async fn power(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<PowerBody>) -> ApiResult<StatusCode> {
    app.power(&id, b.action).await?;
    Ok(NO_CONTENT)
}

// ---------- notes ----------

async fn list_notes(State(app): State<App>, _: AuthUser, Query(f): Query<NoteFilter>) -> ApiResult<Json<Vec<Note>>> {
    Ok(Json(app.list_notes(&f).await?))
}
async fn create_note(State(app): State<App>, _: AuthUser, Json(b): Json<NoteInput>) -> ApiResult<Json<Note>> {
    Ok(Json(app.create_note(b).await?))
}
async fn update_note(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<NoteInput>) -> ApiResult<Json<Note>> {
    Ok(Json(app.update_note(&id, b).await?))
}
async fn delete_note(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_note(&id).await?;
    Ok(NO_CONTENT)
}

// ---------- backups ----------

async fn list_storages(State(app): State<App>, _: AuthUser) -> ApiResult<Json<Vec<Storage>>> {
    Ok(Json(app.list_storages().await?))
}
async fn create_storage(State(app): State<App>, _: AuthUser, Json(b): Json<StorageInput>) -> ApiResult<Json<Storage>> {
    Ok(Json(app.create_storage(b).await?))
}
async fn update_storage(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<StorageInput>) -> ApiResult<Json<Storage>> {
    Ok(Json(app.update_storage(&id, b).await?))
}
async fn delete_storage(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_storage(&id).await?;
    Ok(NO_CONTENT)
}
async fn test_storage(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<OkResult>> {
    Ok(Json(match app.test_storage(&id).await {
        Ok(()) => OkResult { ok: true, error: None },
        Err(nodepilot_core::Error::NotFound(w)) => return Err(nodepilot_core::Error::NotFound(w).into()),
        Err(e) => OkResult { ok: false, error: Some(e.to_string()) },
    }))
}
async fn list_jobs(State(app): State<App>, _: AuthUser, Query(q): Query<JobsQuery>) -> ApiResult<Json<Vec<BackupJob>>> {
    Ok(Json(app.list_backup_jobs(q.server_id.as_deref()).await?))
}
async fn create_job(State(app): State<App>, _: AuthUser, Json(b): Json<BackupJobInput>) -> ApiResult<Json<BackupJob>> {
    Ok(Json(app.create_backup_job(b).await?))
}
async fn update_job(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<BackupJobInput>) -> ApiResult<Json<BackupJob>> {
    Ok(Json(app.update_backup_job(&id, b).await?))
}
async fn delete_job(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_backup_job(&id).await?;
    Ok(NO_CONTENT)
}
async fn run_job(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<BackupRun>> {
    Ok(Json(app.run_backup(&id).await?))
}
async fn list_runs(State(app): State<App>, _: AuthUser, Query(f): Query<RunFilter>) -> ApiResult<Json<Vec<BackupRun>>> {
    Ok(Json(app.list_backup_runs(&f).await?))
}
async fn delete_run(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_backup_run(&id).await?;
    Ok(NO_CONTENT)
}
async fn download_run(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<axum::response::Response> {
    let (name, size, stream) = app.download_backup(&id).await?;
    Ok(crate::files::attachment(&name, size, axum::body::Body::from_stream(stream)))
}

// ---------- graphs ----------

async fn list_graphs(State(app): State<App>, _: AuthUser, Query(f): Query<GraphFilter>) -> ApiResult<Json<Vec<GraphSummary>>> {
    Ok(Json(app.list_graphs(&f).await?))
}
async fn create_graph(State(app): State<App>, _: AuthUser, Json(b): Json<GraphInput>) -> ApiResult<Json<Graph>> {
    Ok(Json(app.create_graph(b).await?))
}
async fn get_graph(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Graph>> {
    Ok(Json(app.get_graph(&id).await?))
}
async fn update_graph(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<GraphInput>) -> ApiResult<Json<Graph>> {
    Ok(Json(app.update_graph(&id, b).await?))
}
async fn delete_graph(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.delete_graph(&id).await?;
    Ok(NO_CONTENT)
}

// ---------- get-by-id ----------

async fn get_identity(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Identity>> {
    Ok(Json(app.get_identity(&id).await?))
}
async fn get_note(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Note>> {
    Ok(Json(app.get_note(&id).await?))
}
async fn get_storage(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<Storage>> {
    Ok(Json(app.get_storage(&id).await?))
}
async fn get_job(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<BackupJob>> {
    Ok(Json(app.get_backup_job(&id).await?))
}
async fn get_run(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<BackupRun>> {
    Ok(Json(app.get_backup_run(&id).await?))
}

// ---------- graph nodes & edges ----------

type Pair = Path<(String, String)>;

async fn add_node(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<NodeInput>) -> ApiResult<Json<GraphNode>> {
    Ok(Json(app.add_graph_node(&id, b).await?))
}
async fn update_node(State(app): State<App>, _: AuthUser, Path((id, node)): Pair, Json(b): Json<NodeInput>) -> ApiResult<Json<GraphNode>> {
    Ok(Json(app.update_graph_node(&id, &node, b).await?))
}
async fn remove_node(State(app): State<App>, _: AuthUser, Path((id, node)): Pair) -> ApiResult<StatusCode> {
    app.remove_graph_node(&id, &node).await?;
    Ok(NO_CONTENT)
}
async fn add_edge(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<EdgeInput>) -> ApiResult<Json<GraphEdge>> {
    Ok(Json(app.add_graph_edge(&id, b).await?))
}
async fn update_edge(State(app): State<App>, _: AuthUser, Path((id, edge)): Pair, Json(b): Json<EdgeInput>) -> ApiResult<Json<GraphEdge>> {
    Ok(Json(app.update_graph_edge(&id, &edge, b).await?))
}
async fn remove_edge(State(app): State<App>, _: AuthUser, Path((id, edge)): Pair) -> ApiResult<StatusCode> {
    app.remove_graph_edge(&id, &edge).await?;
    Ok(NO_CONTENT)
}

// ---------- terminal sessions ----------

async fn list_terms(State(app): State<App>, _: AuthUser) -> Json<Vec<TerminalInfo>> {
    Json(app.list_terminals())
}
async fn open_term(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<OpenTerminal>) -> ApiResult<Json<TerminalInfo>> {
    let info = app.open_terminal(b, &p.label()).await?;
    app.audit(
        AuditEvent::new(Some(&p), "terminal:open")
            .target(&info.server_name)
            .severity(Severity::Warning)
            .details(json!({ "session": info.id })),
    );
    Ok(Json(info))
}
async fn get_term(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<Json<TerminalInfo>> {
    Ok(Json(app.get_terminal(&id)?))
}
async fn close_term(State(app): State<App>, _: AuthUser, Path(id): Id) -> ApiResult<StatusCode> {
    app.close_terminal(&id).await?;
    Ok(NO_CONTENT)
}
async fn term_input(
    State(app): State<App>,
    AuthUser(p): AuthUser,
    Path(id): Id,
    Json(b): Json<TerminalInput>,
) -> ApiResult<Json<TerminalOutput>> {
    let shown: String = b.data.chars().take(500).collect();
    app.audit(
        AuditEvent::new(Some(&p), "terminal:input")
            .target(&id)
            .severity(Severity::Warning)
            .details(json!({ "data": shown, "enter": b.enter })),
    );
    Ok(Json(app.terminal_input(&id, b).await?))
}
async fn term_output(State(app): State<App>, _: AuthUser, Path(id): Id, Query(q): Query<ReadQuery>) -> ApiResult<Json<TerminalOutput>> {
    Ok(Json(app.terminal_output(&id, q).await?))
}
async fn term_resize(State(app): State<App>, _: AuthUser, Path(id): Id, Json(b): Json<ResizeTerminal>) -> ApiResult<Json<TerminalInfo>> {
    Ok(Json(app.terminal_resize(&id, b).await?))
}

// ---------- system & updates ----------

async fn version() -> Json<VersionInfo> {
    Json(VersionInfo {
        version: nodepilot_core::updates::VERSION,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        platform_asset: nodepilot_core::updates::platform_asset(),
    })
}
async fn update_info(State(app): State<App>, _: AuthUser, Query(q): Query<RefreshQuery>) -> ApiResult<Json<UpdateInfo>> {
    let refresh = matches!(q.refresh.as_deref(), Some("1" | "true"));
    Ok(Json(app.update_info(refresh).await?))
}
async fn update_settings(State(app): State<App>, _: AuthUser, Json(b): Json<UpdateSettingsInput>) -> ApiResult<Json<UpdateSettings>> {
    Ok(Json(app.set_update_settings(b).await?))
}
async fn install_update(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<(StatusCode, Json<InstallStatus>)> {
    tracing::warn!(by = %p.label(), "update installation requested");
    Ok((StatusCode::ACCEPTED, Json(app.start_update().await?)))
}
async fn install_status(State(app): State<App>, _: AuthUser) -> Json<InstallStatus> {
    Json(app.install_status())
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/{id}", get(get_project).patch(update_project).delete(delete_project))
        .route("/api/projects/{id}/servers/{server_id}", put(add_project_server).delete(remove_project_server))
        .route("/api/identities", get(list_identities).post(create_identity))
        .route("/api/identities/{id}", get(get_identity).patch(update_identity).delete(delete_identity))
        .route("/api/servers", get(list_servers).post(create_server))
        .route("/api/servers/bulk", post(create_servers))
        .route("/api/servers/{id}", get(get_server).patch(update_server).delete(delete_server))
        .route("/api/servers/{id}/test", post(test_server))
        .route("/api/servers/{id}/host-key", delete(reset_host_key))
        .route("/api/servers/{id}/exec", post(exec))
        .route("/api/exec", post(bulk_exec))
        .route("/api/stats", get(all_stats))
        .route("/api/servers/{id}/stats", get(server_stats))
        .route("/api/servers/{id}/stats/history", get(stats_history))
        .route("/api/servers/{id}/processes", get(processes))
        .route("/api/servers/{id}/processes/{pid}/kill", post(kill))
        .route("/api/servers/{id}/services", get(services))
        .route("/api/servers/{id}/services/{name}/logs", get(service_logs))
        .route("/api/servers/{id}/services/{name}/{action}", post(service_action))
        .route("/api/servers/{id}/power", post(power))
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/{id}", get(get_note).patch(update_note).delete(delete_note))
        .route("/api/backup-storages", get(list_storages).post(create_storage))
        .route("/api/backup-storages/{id}", get(get_storage).patch(update_storage).delete(delete_storage))
        .route("/api/backup-storages/{id}/test", post(test_storage))
        .route("/api/backup-jobs", get(list_jobs).post(create_job))
        .route("/api/backup-jobs/{id}", get(get_job).patch(update_job).delete(delete_job))
        .route("/api/backup-jobs/{id}/run", post(run_job))
        .route("/api/backups", get(list_runs))
        .route("/api/backups/{id}", get(get_run).delete(delete_run))
        .route("/api/backups/{id}/download", get(download_run))
        .route("/api/graphs", get(list_graphs).post(create_graph))
        .route("/api/graphs/{id}", get(get_graph).put(update_graph).patch(update_graph).delete(delete_graph))
        .route("/api/graphs/{id}/nodes", post(add_node))
        .route("/api/graphs/{id}/nodes/{node_id}", axum::routing::patch(update_node).delete(remove_node))
        .route("/api/graphs/{id}/edges", post(add_edge))
        .route("/api/graphs/{id}/edges/{edge_id}", axum::routing::patch(update_edge).delete(remove_edge))
        .route("/api/system/version", get(version))
        .route("/api/system/update", get(update_info))
        .route("/api/system/update/settings", axum::routing::patch(update_settings))
        .route("/api/system/update/install", post(install_update))
        .route("/api/system/update/status", get(install_status))
        .route("/api/terminal-sessions", get(list_terms).post(open_term))
        .route("/api/terminal-sessions/{id}", get(get_term).delete(close_term))
        .route("/api/terminal-sessions/{id}/input", post(term_input))
        .route("/api/terminal-sessions/{id}/output", get(term_output))
        .route("/api/terminal-sessions/{id}/resize", post(term_resize))
}
