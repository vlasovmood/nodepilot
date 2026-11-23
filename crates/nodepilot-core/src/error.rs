#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("not authenticated")]
    Unauthorized,
    #[error("{0}")]
    Forbidden(String),
    #[error("two-factor code required")]
    TwoFactorRequired,
    #[error("too many failed attempts, try again in {0} s")]
    TooManyAttempts(u64),
    #[error(transparent)]
    Ssh(#[from] nodepilot_ssh::Error),
    #[error("database error: {0}")]
    Db(sqlx::Error),
    #[error("{0}")]
    Internal(String),
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &e {
            if db.is_foreign_key_violation() {
                return Error::Conflict("object is referenced by other objects or refers to a missing one".into());
            }
            if db.is_unique_violation() {
                return Error::Conflict("already exists".into());
            }
        }
        if matches!(e, sqlx::Error::RowNotFound) {
            return Error::NotFound("object");
        }
        Error::Db(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn bad(msg: impl Into<String>) -> Error {
    Error::BadRequest(msg.into())
}
