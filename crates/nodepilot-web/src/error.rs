use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use nodepilot_core::Error;
use serde_json::json;

pub struct ApiError(pub Error);

impl<E: Into<Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            Error::NotFound(_) => StatusCode::NOT_FOUND,
            Error::BadRequest(_) => StatusCode::BAD_REQUEST,
            Error::Conflict(_) => StatusCode::CONFLICT,
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden(_) => StatusCode::FORBIDDEN,
            Error::TwoFactorRequired => StatusCode::UNAUTHORIZED,
            Error::TooManyAttempts(_) => StatusCode::TOO_MANY_REQUESTS,
            Error::Ssh(_) => StatusCode::BAD_GATEWAY,
            Error::Db(_) | Error::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if status.is_server_error() {
            tracing::error!(error = %self.0, "request failed");
        }
        let mut body = json!({ "error": self.0.to_string() });
        if matches!(self.0, Error::TwoFactorRequired) {
            body["two_factor_required"] = json!(true);
        }
        let mut resp = (status, Json(body)).into_response();
        if let Error::TooManyAttempts(secs) = self.0 {
            resp.headers_mut().insert(axum::http::header::RETRY_AFTER, axum::http::HeaderValue::from(secs));
        }
        resp
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
