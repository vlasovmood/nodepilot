use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use nodepilot_core::audit::{AuditEntry, AuditEvent, AuditFilter, AuditSettings, AuditSettingsInput, Severity};
use nodepilot_core::backups::BackupKeyPair;
use nodepilot_core::panel_key::{DeployRequest, DetectIpRequest, DetectedIp, PanelKeyInfo, PanelKeyInput, ServerOpResult};
use nodepilot_core::security::SecurityStatus;
use nodepilot_core::totp::{DisableTwoFactor, TotpCode, TotpSetup, TwoFactorStatus};
use nodepilot_core::{App, Error};
use serde_json::json;

use crate::api_types::{OkResult, RecoveryCodes};
use crate::auth::AuthUser;
use crate::error::ApiResult;

fn session_only(p: &nodepilot_core::access::Principal) -> Result<(), Error> {
    if p.token.is_some() { Err(Error::Forbidden("two-factor settings can only be changed from a browser session".into())) } else { Ok(()) }
}

fn summary(results: &[ServerOpResult]) -> serde_json::Value {
    let failed: Vec<_> = results.iter().filter(|r| !r.ok).map(|r| json!({ "server": r.server_name, "error": r.error })).collect();
    json!({ "servers": results.len(), "failed": failed })
}

// ---------- 2FA ----------

async fn tfa_status(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<TwoFactorStatus>> {
    Ok(Json(app.two_factor_status(&p.user.id).await?))
}
async fn tfa_setup(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<TotpSetup>> {
    session_only(&p)?;
    Ok(Json(app.begin_totp(&p.user.id, &p.user.username).await?))
}
async fn tfa_enable(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<TotpCode>) -> ApiResult<Json<RecoveryCodes>> {
    session_only(&p)?;
    let codes = app.enable_totp(&p.user.id, &b.code).await?;
    app.audit(AuditEvent::new(Some(&p), "auth:2fa-enable").severity(Severity::Critical));
    Ok(Json(RecoveryCodes { recovery_codes: codes }))
}
async fn tfa_disable(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<DisableTwoFactor>) -> ApiResult<StatusCode> {
    session_only(&p)?;
    let r = app.disable_totp(&p.user.id, b).await;
    app.audit(AuditEvent::new(Some(&p), "auth:2fa-disable").severity(Severity::Critical).outcome(if r.is_ok() { "ok" } else { "denied" }));
    r?;
    Ok(StatusCode::NO_CONTENT)
}
async fn tfa_recovery(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<TotpCode>) -> ApiResult<Json<RecoveryCodes>> {
    session_only(&p)?;
    let codes = app.regenerate_recovery_codes(&p.user.id, &b.code).await?;
    app.audit(AuditEvent::new(Some(&p), "auth:2fa-recovery-codes").severity(Severity::Critical));
    Ok(Json(RecoveryCodes { recovery_codes: codes }))
}

// ---------- summary ----------

async fn status(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<SecurityStatus>> {
    Ok(Json(app.security_status(&p.user.id).await?))
}

// ---------- panel key ----------

async fn pk_info(State(app): State<App>, _: AuthUser) -> ApiResult<Json<PanelKeyInfo>> {
    Ok(Json(app.panel_key_info().await?))
}
async fn pk_create(State(app): State<App>, _: AuthUser, Json(b): Json<PanelKeyInput>) -> ApiResult<Json<PanelKeyInfo>> {
    Ok(Json(app.create_panel_key(b).await?))
}
async fn pk_update(State(app): State<App>, _: AuthUser, Json(b): Json<PanelKeyInput>) -> ApiResult<Json<PanelKeyInfo>> {
    Ok(Json(app.update_panel_key(b).await?))
}
async fn pk_detect(State(app): State<App>, _: AuthUser, Json(b): Json<DetectIpRequest>) -> ApiResult<Json<DetectedIp>> {
    Ok(Json(app.detect_panel_ip(&b.server_id).await?))
}
async fn pk_deploy(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<DeployRequest>) -> ApiResult<Json<Vec<ServerOpResult>>> {
    let r = app.deploy_panel_key(b).await?;
    app.audit(AuditEvent::new(Some(&p), "panel-key:deploy").severity(Severity::Critical).details(summary(&r)));
    Ok(Json(r))
}
async fn pk_rotate(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<Vec<ServerOpResult>>> {
    let r = app.rotate_panel_key().await?;
    app.audit(AuditEvent::new(Some(&p), "panel-key:rotate").severity(Severity::Critical).details(summary(&r)));
    Ok(Json(r))
}
async fn pk_revoke(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<Vec<ServerOpResult>>> {
    let r = app.revoke_panel_key().await?;
    app.audit(AuditEvent::new(Some(&p), "panel-key:revoke").severity(Severity::Critical).details(summary(&r)));
    Ok(Json(r))
}

// ---------- audit log ----------

async fn audit_list(State(app): State<App>, _: AuthUser, Query(f): Query<AuditFilter>) -> ApiResult<Json<Vec<AuditEntry>>> {
    Ok(Json(app.list_audit(&f).await?))
}
async fn audit_settings(State(app): State<App>, _: AuthUser) -> Json<AuditSettings> {
    Json(app.audit_settings().await)
}
async fn audit_update(State(app): State<App>, _: AuthUser, Json(b): Json<AuditSettingsInput>) -> ApiResult<Json<AuditSettings>> {
    Ok(Json(app.set_audit_settings(b).await?))
}
async fn audit_test(State(app): State<App>, _: AuthUser) -> ApiResult<Json<OkResult>> {
    let errors = app.test_audit_forwarding().await?;
    Ok(Json(OkResult { ok: errors.is_empty(), error: (!errors.is_empty()).then(|| errors.join("; ")) }))
}

// ---------- backup keys ----------

async fn backup_keygen(State(app): State<App>, AuthUser(p): AuthUser) -> Json<BackupKeyPair> {
    app.audit(AuditEvent::new(Some(&p), "backups:generate-key").severity(Severity::Info));
    Json(app.generate_backup_key())
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/auth/2fa", get(tfa_status))
        .route("/api/auth/2fa/setup", post(tfa_setup))
        .route("/api/auth/2fa/enable", post(tfa_enable))
        .route("/api/auth/2fa/disable", post(tfa_disable))
        .route("/api/auth/2fa/recovery-codes", post(tfa_recovery))
        .route("/api/security/status", get(status))
        .route("/api/security/panel-key", get(pk_info).post(pk_create).patch(pk_update))
        .route("/api/security/panel-key/detect-ip", post(pk_detect))
        .route("/api/security/panel-key/deploy", post(pk_deploy))
        .route("/api/security/panel-key/rotate", post(pk_rotate))
        .route("/api/security/panel-key/revoke", post(pk_revoke))
        .route("/api/audit", get(audit_list))
        .route("/api/audit/settings", get(audit_settings).patch(audit_update))
        .route("/api/audit/test", post(audit_test))
        .route("/api/backup-keys/generate", post(backup_keygen))
}
