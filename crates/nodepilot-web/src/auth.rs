use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts, MatchedPath, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::get, routing::post};
use nodepilot_core::access::Principal;
use nodepilot_core::audit::{AuditEvent, Severity};
use nodepilot_core::models::{ApiToken, Credentials, TokenInput, User};
use nodepilot_core::{App, Error};

use crate::api_types::{AuthStatus, CreatedToken, Me, TokenBrief};
use crate::catalog::{self, Access};
use crate::error::{ApiError, ApiResult};

pub const COOKIE: &str = "np_session";

/// Authenticated caller. Endpoint permissions are already checked by the [`guard`] middleware.
pub struct AuthUser(pub Principal);

pub fn token_from_parts(parts: &Parts) -> Option<String> {
    if let Some(v) = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())
        && let Some(t) = v.strip_prefix("Bearer ")
    {
        return Some(t.trim().to_owned());
    }
    if let Some(t) = cookie(&parts.headers, COOKIE) {
        return Some(t);
    }
    // Browsers cannot set headers on WebSocket requests, so accept a query token only for upgrades.
    let is_ws = parts.headers.get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if is_ws {
        return parts.uri.query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=").map(percent_decode)));
    }
    None
}

/// `X-Forwarded-For` is trusted only from a reverse proxy on this machine.
pub fn client_ip(parts: &Parts) -> Option<String> {
    let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    if peer.is_some_and(|p| p.is_loopback())
        && let Some(xff) = parts.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = xff.split(',').next().map(str::trim).filter(|s| !s.is_empty())
    {
        return Some(first.to_owned());
    }
    peer.map(|p| p.to_string())
}

fn severity_for(method: &str, path: &str) -> Severity {
    const CRITICAL: &[&str] = &[
        "/api/tokens",
        "/api/security",
        "/api/auth/2fa",
        "/api/system/update/install",
        "/power",
        "/host-key",
        "/api/identities",
        "/api/audit/settings",
    ];
    if CRITICAL.iter().any(|p| path.contains(p)) {
        Severity::Critical
    } else if method == "DELETE" || path.contains("/services/") || path.contains("/kill") || path.contains("/files") {
        Severity::Warning
    } else {
        Severity::Info
    }
}

/// Endpoints that write their own detailed audit entries; the middleware skips them.
const SELF_AUDITED: &[&str] =
    &["/api/mcp", "/api/auth/login", "/api/auth/setup", "/api/servers/{id}/exec", "/api/exec", "/api/terminal-sessions/{id}/input"];

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == name).then(|| v.to_owned())
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl FromRequestParts<App> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        if let Some(p) = parts.extensions.get::<Principal>() {
            return Ok(AuthUser(p.clone()));
        }
        let token = token_from_parts(parts).ok_or(Error::Unauthorized)?;
        Ok(AuthUser(app.authenticate(&token).await?))
    }
}

/// Endpoints missing from the catalog are denied for API tokens (fail-closed)
/// and allowed for sessions with a logged warning.
pub async fn guard(State(app): State<App>, matched: Option<MatchedPath>, request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_owned();
    let path = matched.as_ref().map(|m| m.as_str().to_owned()).unwrap_or_default();
    let endpoint = catalog::find(&method, &path);
    if matches!(endpoint.map(|e| e.access), Some(Access::Public)) {
        return next.run(request).await;
    }

    let (mut parts, body) = request.into_parts();
    let ip = client_ip(&parts);
    let mut principal = match token_from_parts(&parts) {
        Some(t) => match app.authenticate(&t).await {
            Ok(p) => p,
            Err(e) => return ApiError(e).into_response(),
        },
        None => return ApiError(Error::Unauthorized).into_response(),
    };
    principal.ip = ip;
    match endpoint.map(|e| e.access) {
        Some(Access::Scoped(area, level)) => {
            if let Err(e) = principal.require(area, level) {
                app.audit(
                    AuditEvent::new(Some(&principal), format!("{method} {path}"))
                        .target(parts.uri.path())
                        .severity(Severity::Warning)
                        .outcome("denied"),
                );
                return ApiError(e).into_response();
            }
        }
        Some(Access::Authenticated | Access::Public) => {}
        None => {
            if principal.token.is_some() {
                return ApiError(Error::Forbidden(format!("{method} {path} is not available for API tokens"))).into_response();
            }
            tracing::warn!(%method, %path, "endpoint is missing from the API catalog");
        }
    }
    let audit = (method != "GET" && !SELF_AUDITED.contains(&path.as_str())).then(|| (principal.clone(), parts.uri.path().to_owned()));
    parts.extensions.insert(principal);
    let response = next.run(Request::from_parts(parts, body)).await;
    if let Some((principal, uri)) = audit {
        let status = response.status();
        let outcome = if status.is_success() { "ok".to_owned() } else { format!("error: HTTP {}", status.as_u16()) };
        app.audit(
            AuditEvent::new(Some(&principal), format!("{method} {path}"))
                .target(uri)
                .severity(severity_for(&method, &path))
                .outcome(outcome),
        );
    }
    response
}

fn session_response(app: &App, token: String, user: User) -> Response {
    let secure = if app.config.secure_cookies { "; Secure" } else { "" };
    let cookie = format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}", 30 * 24 * 3600);
    let mut resp = Json(serde_json::json!({ "token": token, "user": user })).into_response();
    resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("valid cookie"));
    resp
}

async fn status(State(app): State<App>, parts: Parts) -> ApiResult<Json<AuthStatus>> {
    let user = match token_from_parts(&parts) {
        Some(t) => app.authenticate(&t).await.ok().map(|p| p.user),
        None => None,
    };
    Ok(Json(AuthStatus { setup_required: app.setup_required().await?, user }))
}

async fn setup(State(app): State<App>, parts: Parts, Json(creds): Json<Credentials>) -> ApiResult<Response> {
    let (token, user) = app.setup(&creds).await?;
    app.audit(AuditEvent {
        actor: user.username.clone(),
        ip: client_ip(&parts),
        action: "auth:setup".into(),
        outcome: "ok".into(),
        severity: Severity::Critical,
        ..Default::default()
    });
    Ok(session_response(&app, token, user))
}

async fn login(State(app): State<App>, parts: Parts, Json(creds): Json<Credentials>) -> ApiResult<Response> {
    let ip = client_ip(&parts);
    let ev = |outcome: &str, severity: Severity| AuditEvent {
        actor: creds.username.trim().to_owned(),
        ip: ip.clone(),
        action: "auth:login".into(),
        outcome: outcome.into(),
        severity,
        ..Default::default()
    };
    match app.login(&creds, ip.as_deref()).await {
        Ok((token, user)) => {
            tracing::info!(user = %user.username, ?ip, "login");
            app.audit(ev("ok", Severity::Info));
            Ok(session_response(&app, token, user))
        }
        Err(e @ Error::TwoFactorRequired) => Err(e.into()),
        Err(e @ Error::TooManyAttempts(_)) => {
            app.audit(ev("locked", Severity::Critical));
            Err(e.into())
        }
        Err(e) => {
            app.audit(ev("denied", Severity::Warning));
            Err(e.into())
        }
    }
}

async fn logout(State(app): State<App>, parts: Parts) -> ApiResult<Response> {
    if let Some(t) = token_from_parts(&parts) {
        app.logout(&t).await?;
    }
    let mut resp = StatusCode::NO_CONTENT.into_response();
    resp.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("np_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"));
    Ok(resp)
}

async fn me(AuthUser(p): AuthUser) -> Json<Me> {
    Json(Me { token: p.token.map(|t| TokenBrief { id: t.id, name: t.name }), permissions: p.perms, user: p.user })
}

async fn list_tokens(State(app): State<App>, AuthUser(p): AuthUser) -> ApiResult<Json<Vec<ApiToken>>> {
    Ok(Json(app.list_api_tokens(&p.user.id).await?))
}

async fn create_token(State(app): State<App>, AuthUser(p): AuthUser, Json(b): Json<TokenInput>) -> ApiResult<Json<CreatedToken>> {
    let (token, info) = app.create_api_token(&p, b).await?;
    tracing::info!(by = %p.label(), token = %info.name, "api token created");
    Ok(Json(CreatedToken { token, info }))
}

async fn update_token(
    State(app): State<App>,
    AuthUser(p): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<TokenInput>,
) -> ApiResult<Json<ApiToken>> {
    Ok(Json(app.update_api_token(&p, &id, b).await?))
}

async fn delete_token(State(app): State<App>, AuthUser(p): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    app.delete_api_token(&p.user.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/tokens", get(list_tokens).post(create_token))
        .route("/api/tokens/{id}", axum::routing::patch(update_token).delete(delete_token))
}
