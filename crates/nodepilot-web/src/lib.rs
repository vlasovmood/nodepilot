mod api;
mod api_types;
mod auth;
pub mod catalog;
mod error;
mod files;
pub mod openapi;
mod security_api;
mod terminal;

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use nodepilot_core::App;
use serde_json::{Value, json};

pub use auth::AuthUser;

#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Assets;

pub fn router(app: App) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/openapi.json", get(openapi_json))
        .route("/api/mcp", post(mcp))
        .merge(auth::routes())
        .merge(api::routes())
        .merge(files::routes())
        .merge(terminal::routes())
        .merge(security_api::routes())
        .route_layer(axum::middleware::from_fn_with_state(app.clone(), auth::guard));
    let router = Router::new().merge(api).fallback(static_files).layer(tower_http::trace::TraceLayer::new_for_http());
    let router = match cors(&app.config.cors_origins) {
        Some(layer) => router.layer(layer),
        None => router,
    };
    router.with_state(app)
}

/// Only listed origins, and only with a Bearer token (no cookies).
fn cors(origins: &[String]) -> Option<tower_http::cors::CorsLayer> {
    use tower_http::cors::{AllowOrigin, CorsLayer};
    let list: Vec<HeaderValue> = origins.iter().filter_map(|o| HeaderValue::from_str(o.trim().trim_end_matches('/')).ok()).collect();
    if list.is_empty() {
        return None;
    }
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(list))
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::PATCH,
                axum::http::Method::DELETE,
            ])
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
            .expose_headers([header::CONTENT_DISPOSITION, header::CONTENT_LENGTH])
            .max_age(std::time::Duration::from_secs(3600)),
    )
}

pub async fn serve(addr: SocketAddr, app: App) -> std::io::Result<()> {
    let listener = bind(addr).await?;
    tracing::info!("NodePilot panel listening on http://{addr}");
    axum::serve(listener, router(app).into_make_service_with_connect_info::<SocketAddr>()).await
}

/// After a self-update on Windows the new process starts before the old one has released the port,
/// so in that case keep retrying for a few seconds instead of failing.
async fn bind(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let deadline =
        std::env::var_os(nodepilot_core::updates::BIND_RETRY_ENV).map(|_| std::time::Instant::now() + std::time::Duration::from_secs(10));
    loop {
        match tokio::net::TcpListener::bind(addr).await {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && deadline.is_some_and(|d| std::time::Instant::now() < d) => {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            r => return r,
        }
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

async fn openapi_json() -> Json<&'static Value> {
    Json(openapi::spec())
}

async fn mcp(State(app): State<App>, AuthUser(principal): AuthUser, Json(req): Json<Value>) -> Response {
    tracing::debug!(by = %principal.label(), method = ?req.get("method"), "mcp request");
    match nodepilot_mcp::handle(&app, &principal, req).await {
        Some(resp) => Json(resp).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn static_files(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    let (file, path) = match Assets::get(path).filter(|_| !path.is_empty()) {
        Some(f) => (f, path),
        None => match Assets::get("index.html") {
            Some(f) => (f, "index.html"),
            None => return Response::new(Body::from(PLACEHOLDER)).with_html(),
        },
    };
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut resp = Response::new(Body::from(file.data.into_owned()));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    resp
}

trait WithHtml {
    fn with_html(self) -> Self;
}
impl WithHtml for Response {
    fn with_html(mut self) -> Self {
        self.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        self
    }
}

const PLACEHOLDER: &str = r#"<!doctype html><html lang="en"><meta charset="utf-8"><title>NodePilot</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>NodePilot</h1><p>The API is running, but the web UI was not built. Run <code>npm install && npm run build</code> in <code>web/</code>
and rebuild the binary.</p></body></html>"#;
