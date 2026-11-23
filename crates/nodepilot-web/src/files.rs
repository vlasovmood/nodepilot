use crate::api_types::{DeleteQuery, DownloadQuery, ListQuery, MkdirBody, RenameBody, UploadQuery};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::TryStreamExt;
use nodepilot_core::files::DirListing;
use nodepilot_core::{App, Error};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::auth::AuthUser;
use crate::error::ApiResult;

const UPLOAD_LIMIT: usize = 512 * 1024 * 1024;

fn flag(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1" | "true" | "yes"))
}

fn required(path: &str) -> Result<&str, Error> {
    if path.is_empty() { Err(Error::BadRequest("path is required".into())) } else { Ok(path) }
}

pub fn attachment(name: &str, size: Option<u64>, body: Body) -> Response {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' { c } else { '_' }).collect();
    let encoded: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let mut resp = body.into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    if let Some(size) = size {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    }
    resp
}

async fn list(State(app): State<App>, _: AuthUser, Path(id): Path<String>, Query(q): Query<ListQuery>) -> ApiResult<Json<DirListing>> {
    Ok(Json(app.list_dir(&id, q.path.as_deref()).await?))
}

async fn download(State(app): State<App>, _: AuthUser, Path(id): Path<String>, Query(q): Query<DownloadQuery>) -> ApiResult<Response> {
    let path = required(&q.path)?.to_owned();
    let hold = app.ssh.hold(&id);
    let sftp = app.sftp(&id).await?;
    let file = sftp.open(path.clone()).await.map_err(|e| Error::BadRequest(format!("cannot open {path}: {e}")))?;
    let size = file.metadata().await.ok().and_then(|m| m.size);
    // Keep the connection held while the transfer runs.
    let stream = ReaderStream::with_capacity(file, 256 * 1024).map_ok(move |b| {
        let _ = &hold;
        b
    });
    let body = Body::from_stream(stream);
    if flag(&q.download) {
        let name = path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("file");
        return Ok(attachment(name, size, body));
    }
    let mut resp = body.into_response();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    // Never let the browser run HTML/JS from a managed server in the panel's origin.
    let safe = if mime.type_() == "text" || mime.essence_str() == "application/json" {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(safe));
    resp.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(size) = size {
        resp.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    }
    Ok(resp)
}

async fn upload(
    State(app): State<App>,
    _: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> ApiResult<StatusCode> {
    let path = required(&q.path)?.to_owned();
    let _hold = app.ssh.hold(&id);
    let sftp = app.sftp(&id).await?;
    let mut file = sftp.create(path.clone()).await.map_err(|e| Error::BadRequest(format!("cannot write {path}: {e}")))?;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.try_next().await.map_err(|e| Error::BadRequest(format!("upload interrupted: {e}")))? {
        file.write_all(&chunk).await.map_err(|e| Error::Internal(format!("sftp write: {e}")))?;
    }
    file.shutdown().await.map_err(|e| Error::Internal(format!("sftp close: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mkdir(State(app): State<App>, _: AuthUser, Path(id): Path<String>, Json(b): Json<MkdirBody>) -> ApiResult<StatusCode> {
    app.make_dir(&id, &b.path).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn rename(State(app): State<App>, _: AuthUser, Path(id): Path<String>, Json(b): Json<RenameBody>) -> ApiResult<StatusCode> {
    app.rename_path(&id, &b.from, &b.to).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(State(app): State<App>, _: AuthUser, Path(id): Path<String>, Query(q): Query<DeleteQuery>) -> ApiResult<StatusCode> {
    app.delete_path(&id, required(&q.path)?, flag(&q.recursive)).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/servers/{id}/files", get(list).delete(remove))
        .route("/api/servers/{id}/files/content", get(download).put(upload).layer(DefaultBodyLimit::max(UPLOAD_LIMIT)))
        .route("/api/servers/{id}/files/mkdir", post(mkdir))
        .route("/api/servers/{id}/files/rename", post(rename))
}
