pub mod access;
pub mod audit;
mod auth;
pub mod backups;
pub mod config;
pub mod crypto;
mod error;
pub mod files;
pub mod graphs;
mod identities;
mod manage;
pub mod models;
mod notes;
pub mod panel_key;
mod projects;
pub mod security;
mod servers;
pub mod stats;
pub mod terminals;
pub mod totp;
pub mod updates;

use std::ops::Deref;
use std::str::FromStr;
use std::sync::Arc;

use nodepilot_ssh::{PoolConfig, SshPool};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};

pub use config::Config;
pub use error::{Error, Result};
pub use nodepilot_ssh as ssh;

#[derive(Clone)]
pub struct App(Arc<Inner>);

pub struct Inner {
    pub config: Config,
    pub db: SqlitePool,
    pub secrets: crypto::Secrets,
    pub ssh: Arc<SshPool>,
    pub stats: stats::StatsStore,
    pub terminals: terminals::TerminalSessions,
    pub updater: updates::Updater,
    pub login_guard: totp::LoginGuard,
}

impl Deref for App {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl App {
    pub async fn open(config: Config) -> Result<Self> {
        std::fs::create_dir_all(&config.data_dir)?;
        let db_existed = config.db_path().exists();
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", config.db_path().display()))
            .map_err(Error::Db)?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(10));
        let db = SqlitePoolOptions::new().max_connections(8).connect_with(opts).await.map_err(Error::Db)?;
        sqlx::migrate!("./migrations").run(&db).await.map_err(|e| Error::Internal(format!("migration failed: {e}")))?;

        // A new master key may only be created for an empty database; otherwise stored secrets become unreadable.
        let has_data: bool = db_existed
            && sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM identities) OR EXISTS(SELECT 1 FROM servers)",
            )
            .fetch_one(&db)
            .await
            .map_err(Error::Db)?;
        let secrets = crypto::Secrets::load(&config.master_key_path(), !has_data)?;
        verify_key_check(&db, &secrets).await?;

        Ok(Self(Arc::new(Inner {
            config,
            db,
            secrets,
            ssh: SshPool::new(PoolConfig::default()),
            stats: stats::StatsStore::default(),
            terminals: terminals::TerminalSessions::default(),
            updater: updates::Updater::default(),
            login_guard: totp::LoginGuard::default(),
        })))
    }

    pub fn spawn_background(&self) {
        self.ssh.spawn_reaper();
        stats::spawn_poller(self.clone());
        backups::spawn_scheduler(self.clone());
        terminals::spawn_reaper(self.clone());
        updates::spawn_checker(self.clone());
        audit::spawn_purger(self.clone());
    }
}

async fn verify_key_check(db: &SqlitePool, secrets: &crypto::Secrets) -> Result<()> {
    const PLAIN: &str = "nodepilot-master-key-check";
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'key_check'").fetch_optional(db).await.map_err(Error::Db)?;
    match stored {
        Some(v) => match secrets.decrypt(&v) {
            Ok(p) if p == PLAIN => Ok(()),
            _ => Err(Error::Internal(format!(
                "the master key ({}: {}) does not match this database — wrong key file or credential",
                secrets.source.kind, secrets.source.path
            ))),
        },
        None => {
            sqlx::query("INSERT INTO settings (key, value) VALUES ('key_check', ?)")
                .bind(secrets.encrypt(PLAIN))
                .execute(db)
                .await
                .map_err(Error::Db)?;
            Ok(())
        }
    }
}

pub(crate) fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
