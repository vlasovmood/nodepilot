//! Web terminal: WebSocket <-> SSH PTY.
//! Binary frames carry raw terminal bytes; text frames carry JSON commands (`resize`) and events (`ready`, `exit`, `error`).

use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use nodepilot_core::App;
use nodepilot_core::ssh::ChannelMsg;
use serde::Deserialize;
use serde_json::json;

use crate::api_types::TermQuery;
use crate::auth::AuthUser;
use crate::error::ApiResult;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Control {
    Resize { cols: u32, rows: u32 },
}

fn clamp(cols: u32, rows: u32) -> (u32, u32) {
    (cols.clamp(10, 1000), rows.clamp(5, 500))
}

async fn terminal(
    State(app): State<App>,
    AuthUser(principal): AuthUser,
    Path(id): Path<String>,
    Query(q): Query<TermQuery>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let server = app.get_server(&id).await?;
    tracing::info!(by = %principal.label(), server = %server.name, "terminal opened");
    app.audit(
        nodepilot_core::audit::AuditEvent::new(Some(&principal), "terminal:open")
            .target(&server.name)
            .severity(nodepilot_core::audit::Severity::Warning),
    );
    let (cols, rows) = clamp(q.cols.unwrap_or(120), q.rows.unwrap_or(32));
    Ok(ws.on_upgrade(move |socket| run(app, id, socket, cols, rows)))
}

async fn run(app: App, id: String, socket: WebSocket, cols: u32, rows: u32) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let event = |v: serde_json::Value| Message::Text(v.to_string().into());

    let shell = async {
        let conn = app.connection(&id).await?;
        Ok::<_, nodepilot_core::Error>(conn.shell(cols, rows).await?)
    }
    .await;
    let shell = match shell {
        Ok(s) => s,
        Err(e) => {
            let _ = ws_tx.send(event(json!({ "type": "error", "message": e.to_string() }))).await;
            let _ = ws_tx.close().await;
            return;
        }
    };
    let _hold = app.ssh.hold(&id);
    let (mut ch_rx, ch_tx) = shell.channel.split();
    if ws_tx.send(event(json!({ "type": "ready" }))).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            msg = ch_rx.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if ws_tx.send(Message::Binary(data)).await.is_err() { break; }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    let _ = ws_tx.send(event(json!({ "type": "exit", "code": exit_status }))).await;
                }
                Some(_) => {}
                None => break,
            },
            msg = ws_rx.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    if ch_tx.data_bytes(data).await.is_err() { break; }
                }
                Some(Ok(Message::Text(text))) => {
                    if let Ok(Control::Resize { cols, rows }) = serde_json::from_str(text.as_str()) {
                        let (cols, rows) = clamp(cols, rows);
                        let _ = ch_tx.window_change(cols, rows, 0, 0).await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = ch_tx.close().await;
    let _ = ws_tx.close().await;
}

pub fn routes() -> Router<App> {
    Router::new().route("/api/servers/{id}/terminal", get(terminal))
}
