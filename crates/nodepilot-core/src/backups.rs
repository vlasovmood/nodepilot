use schemars::JsonSchema;
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use nodepilot_ssh::{ChannelMsg, manage::privileged, shell_quote};
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, ObjectStoreExt, WriteMultipart};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::error::bad;
use crate::models::{Ts, double_option};
use crate::{App, Error, Result, new_id, now};

// ---------- models ----------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct LocalConfig {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct S3Config {
    #[serde(default)]
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    #[serde(default)]
    pub prefix: String,
    pub access_key_id: String,
    #[serde(default)]
    pub path_style: bool,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct S3Input {
    #[serde(flatten)]
    pub config: S3Config,
    pub secret_access_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Storage {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub local: Option<LocalConfig>,
    pub s3: Option<S3Config>,
    pub created_at: Ts,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct StorageInput {
    pub name: Option<String>,
    pub kind: Option<String>,
    pub local: Option<LocalConfig>,
    pub s3: Option<S3Input>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DbSource {
    pub database: String,
    #[serde(default)]
    pub user: Option<String>,
    /// Input only; stored encrypted separately.
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub docker_container: Option<String>,
    /// Output only.
    #[serde(default, skip_deserializing)]
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Source {
    Files {
        paths: Vec<String>,
        #[serde(default)]
        excludes: Vec<String>,
    },
    Postgres(DbSource),
    Mysql(DbSource),
}

impl Source {
    fn db_mut(&mut self) -> Option<&mut DbSource> {
        match self {
            Source::Postgres(d) | Source::Mysql(d) => Some(d),
            Source::Files { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct BackupRun {
    pub id: String,
    pub job_id: String,
    pub server_id: String,
    pub status: String,
    pub started_at: Ts,
    pub finished_at: Option<Ts>,
    pub size_bytes: Option<i64>,
    pub file_name: Option<String>,
    pub encrypted: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BackupJob {
    pub id: String,
    pub name: String,
    pub server_id: String,
    pub storage_id: String,
    pub source: Source,
    pub schedule: Option<String>,
    pub retention: i64,
    /// Archives are encrypted (any mode).
    pub encrypt: bool,
    /// `none` | `passphrase` (passphrase stored in the panel) | `recipients` (age public keys; the panel cannot decrypt).
    pub encryption: String,
    /// age public keys (`age1…`) for `recipients` mode.
    pub recipients: Vec<String>,
    pub enabled: bool,
    pub next_run_at: Option<Ts>,
    pub last_run: Option<BackupRun>,
    pub created_at: Ts,
    pub updated_at: Ts,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct BackupJobInput {
    pub name: Option<String>,
    pub server_id: Option<String>,
    pub storage_id: Option<String>,
    pub source: Option<Source>,
    #[serde(default, deserialize_with = "double_option")]
    pub schedule: Option<Option<String>>,
    pub retention: Option<i64>,
    /// Deprecated: use `encryption`. `true` without `encryption` means `passphrase`.
    pub encrypt: Option<bool>,
    /// `none` | `passphrase` | `recipients` (recommended).
    pub encryption: Option<String>,
    /// For `passphrase`; never returned.
    pub passphrase: Option<String>,
    /// For `recipients`: age public keys (`age1…`). The panel never stores private keys.
    pub recipients: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

/// New age key pair for backups. The private key is shown once and not stored by the panel.
#[derive(Debug, Serialize, JsonSchema)]
pub struct BackupKeyPair {
    pub public_key: String,
    /// `AGE-SECRET-KEY-1…`
    pub private_key: String,
    /// Key file contents for `age -d -i <file>`.
    pub identity_file: String,
}

pub(crate) enum Encryption {
    None,
    Passphrase(String),
    Recipients(Vec<age::x25519::Recipient>),
}

fn parse_recipients(list: &[String]) -> Result<Vec<age::x25519::Recipient>> {
    list.iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .map(|r| r.parse::<age::x25519::Recipient>().map_err(|_| bad(format!("invalid age public key: {r} (expected age1…)"))))
        .collect()
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct RunFilter {
    pub job_id: Option<String>,
    pub server_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct StorageRow {
    id: String,
    name: String,
    kind: String,
    config: String,
    secret_enc: Option<String>,
    created_at: Ts,
}

#[derive(sqlx::FromRow, Clone)]
struct JobRow {
    id: String,
    name: String,
    server_id: String,
    storage_id: String,
    source: String,
    source_secret_enc: Option<String>,
    schedule: Option<String>,
    retention: i64,
    encrypt: bool,
    passphrase_enc: Option<String>,
    encryption: Option<String>,
    recipients: Option<String>,
    enabled: bool,
    next_run_at: Option<Ts>,
    created_at: Ts,
    updated_at: Ts,
}

impl JobRow {
    fn mode(&self) -> &str {
        match self.encryption.as_deref() {
            Some(m) => m,
            None if self.encrypt => "passphrase",
            None => "none",
        }
    }
    fn recipient_list(&self) -> Vec<String> {
        self.recipients.as_deref().unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
    }
}

macro_rules! job_select_sql {
    () => {
        "SELECT id, name, server_id, storage_id, source, source_secret_enc, schedule, retention, encrypt,
    passphrase_enc, encryption, recipients, enabled, next_run_at, created_at, updated_at FROM backup_jobs"
    };
}
macro_rules! run_select_sql {
    () => {
        "SELECT id, job_id, server_id, status, started_at, finished_at, size_bytes, file_name, encrypted, error FROM backup_runs"
    };
}

/// Accepts the 6/7-field format of the `cron` crate (seconds first, Quartz day numbers: 1 = Sunday)
/// and the classic 5-field crontab (0 or 7 = Sunday, 1 = Monday).
pub fn parse_schedule(s: &str) -> Result<cron::Schedule> {
    let s = s.trim();
    let fields: Vec<&str> = s.split_whitespace().collect();
    let expr = if let [min, hour, dom, month, dow] = fields[..] {
        format!("0 {min} {hour} {dom} {month} {}", crontab_dow(dow).map_err(|e| bad(format!("invalid cron schedule '{s}': {e}")))?)
    } else {
        s.to_owned()
    };
    cron::Schedule::from_str(&expr).map_err(|e| bad(format!("invalid cron schedule '{s}': {e}")))
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Rewrites a crontab day-of-week field with day names, because the `cron` crate numbers days differently.
fn crontab_dow(field: &str) -> std::result::Result<String, String> {
    if field == "*" || field == "?" {
        return Ok(field.to_owned());
    }
    // 0..=7 with 7 = Sunday, or a three-letter name.
    let day = |t: &str| -> std::result::Result<usize, String> {
        t.parse::<usize>()
            .ok()
            .filter(|n| *n <= 7)
            .or_else(|| DAY_NAMES.iter().position(|d| d.eq_ignore_ascii_case(t)))
            .ok_or_else(|| format!("invalid day of week '{t}'"))
    };
    let mut days = [false; 7];
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((r, st)) => (r, st.parse::<usize>().ok().filter(|n| *n > 0).ok_or_else(|| format!("invalid step in '{part}'"))?),
            None => (part, 1),
        };
        let (from, mut to) = match range.split_once('-') {
            _ if range == "*" => (0, 6),
            Some((a, b)) => (day(a)?, day(b)?),
            None if step > 1 => (day(range)?, 6),
            None => (day(range)?, day(range)?),
        };
        if to < from {
            to += 7;
        }
        for d in (from..=to).step_by(step) {
            days[d % 7] = true;
        }
    }
    if days.iter().all(|d| *d) {
        return Ok("*".into());
    }
    Ok(DAY_NAMES.iter().zip(days).filter(|(_, on)| *on).map(|(n, _)| *n).collect::<Vec<_>>().join(","))
}

fn next_run(schedule: Option<&str>) -> Result<Option<Ts>> {
    schedule.map(|s| Ok(parse_schedule(s)?.upcoming(chrono::Utc).next())).transpose().map(Option::flatten)
}

// ---------- storages ----------

enum Backend {
    Local(PathBuf),
    S3 { store: Arc<dyn ObjectStore>, prefix: String },
}

impl Backend {
    fn s3_path(prefix: &str, key: &str) -> ObjPath {
        let p = prefix.trim_matches('/');
        ObjPath::from(if p.is_empty() { key.to_owned() } else { format!("{p}/{key}") })
    }
}

impl App {
    fn storage_from_row(&self, r: StorageRow) -> Storage {
        let (local, s3) = match r.kind.as_str() {
            "local" => (serde_json::from_str(&r.config).ok(), None),
            _ => (None, serde_json::from_str(&r.config).ok()),
        };
        Storage { id: r.id, name: r.name, kind: r.kind, local, s3, created_at: r.created_at }
    }

    async fn storage_row(&self, id: &str) -> Result<StorageRow> {
        sqlx::query_as("SELECT id, name, kind, config, secret_enc, created_at FROM backup_storages WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("storage"))
    }

    pub async fn list_storages(&self) -> Result<Vec<Storage>> {
        let rows: Vec<StorageRow> =
            sqlx::query_as("SELECT id, name, kind, config, secret_enc, created_at FROM backup_storages ORDER BY name COLLATE NOCASE")
                .fetch_all(&self.db)
                .await?;
        Ok(rows.into_iter().map(|r| self.storage_from_row(r)).collect())
    }

    pub async fn get_storage(&self, id: &str) -> Result<Storage> {
        Ok(self.storage_from_row(self.storage_row(id).await?))
    }

    fn validate_storage(&self, kind: &str, input: &StorageInput, old_secret: Option<String>) -> Result<(String, Option<String>)> {
        match kind {
            "local" => {
                let cfg = input.local.as_ref().ok_or_else(|| bad("local.path is required"))?;
                if cfg.path.trim().is_empty() {
                    return Err(bad("local.path is required"));
                }
                Ok((serde_json::to_string(&LocalConfig { path: cfg.path.trim().to_owned() }).unwrap(), None))
            }
            "s3" => {
                let s3 = input.s3.as_ref().ok_or_else(|| bad("s3 config is required"))?;
                let c = &s3.config;
                if c.bucket.trim().is_empty() || c.region.trim().is_empty() || c.access_key_id.trim().is_empty() {
                    return Err(bad("s3.bucket, s3.region and s3.access_key_id are required"));
                }
                let secret = match s3.secret_access_key.as_deref().filter(|s| !s.is_empty()) {
                    Some(s) => Some(self.secrets.encrypt(s)),
                    None => Some(old_secret.ok_or_else(|| bad("s3.secret_access_key is required"))?),
                };
                Ok((serde_json::to_string(c).unwrap(), secret))
            }
            _ => Err(bad("kind must be 'local' or 's3'")),
        }
    }

    pub async fn create_storage(&self, input: StorageInput) -> Result<Storage> {
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("name is required"))?;
        let kind = input.kind.clone().ok_or_else(|| bad("kind is required"))?;
        let (config, secret) = self.validate_storage(&kind, &input, None)?;
        let id = new_id();
        sqlx::query("INSERT INTO backup_storages (id, name, kind, config, secret_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(name)
            .bind(&kind)
            .bind(config)
            .bind(secret)
            .bind(now())
            .execute(&self.db)
            .await?;
        self.get_storage(&id).await
    }

    pub async fn update_storage(&self, id: &str, input: StorageInput) -> Result<Storage> {
        let cur = self.storage_row(id).await?;
        let name = match input.name.as_deref().map(str::trim) {
            Some("") => return Err(bad("name cannot be empty")),
            Some(n) => n.to_owned(),
            None => cur.name.clone(),
        };
        let kind = input.kind.clone().unwrap_or(cur.kind.clone());
        let (config, secret) = if input.local.is_some() || input.s3.is_some() || kind != cur.kind {
            self.validate_storage(&kind, &input, if kind == cur.kind { cur.secret_enc.clone() } else { None })?
        } else {
            (cur.config.clone(), cur.secret_enc.clone())
        };
        sqlx::query("UPDATE backup_storages SET name = ?, kind = ?, config = ?, secret_enc = ? WHERE id = ?")
            .bind(name)
            .bind(kind)
            .bind(config)
            .bind(secret)
            .bind(id)
            .execute(&self.db)
            .await?;
        self.get_storage(id).await
    }

    pub async fn delete_storage(&self, id: &str) -> Result<()> {
        self.storage_row(id).await?;
        let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup_jobs WHERE storage_id = ?").bind(id).fetch_one(&self.db).await?;
        if used > 0 {
            return Err(Error::Conflict(format!("storage is used by {used} backup job(s)")));
        }
        sqlx::query("DELETE FROM backup_storages WHERE id = ?").bind(id).execute(&self.db).await?;
        Ok(())
    }

    async fn backend(&self, storage_id: &str) -> Result<Backend> {
        let row = self.storage_row(storage_id).await?;
        match row.kind.as_str() {
            "local" => {
                let cfg: LocalConfig = serde_json::from_str(&row.config).map_err(|e| Error::Internal(e.to_string()))?;
                let path = PathBuf::from(&cfg.path);
                let path = if path.is_absolute() { path } else { self.config.data_dir.join(path) };
                Ok(Backend::Local(path))
            }
            _ => {
                let cfg: S3Config = serde_json::from_str(&row.config).map_err(|e| Error::Internal(e.to_string()))?;
                let secret = self.secrets.decrypt(row.secret_enc.as_deref().unwrap_or_default())?;
                let mut b = AmazonS3Builder::new()
                    .with_region(&cfg.region)
                    .with_bucket_name(&cfg.bucket)
                    .with_access_key_id(&cfg.access_key_id)
                    .with_secret_access_key(secret)
                    .with_virtual_hosted_style_request(!cfg.path_style);
                if let Some(ep) = cfg.endpoint.as_deref().filter(|e| !e.is_empty()) {
                    b = b.with_endpoint(ep).with_allow_http(ep.starts_with("http://"));
                }
                let store = b.build().map_err(|e| bad(format!("s3 config: {e}")))?;
                Ok(Backend::S3 { store: Arc::new(store), prefix: cfg.prefix })
            }
        }
    }

    pub async fn test_storage(&self, id: &str) -> Result<()> {
        match self.backend(id).await? {
            Backend::Local(dir) => {
                tokio::fs::create_dir_all(&dir).await?;
                let probe = dir.join(".nodepilot-test");
                tokio::fs::write(&probe, b"ok").await?;
                tokio::fs::remove_file(&probe).await?;
            }
            Backend::S3 { store, prefix } => {
                let path = Backend::s3_path(&prefix, ".nodepilot-test");
                store.put(&path, Bytes::from_static(b"ok").into()).await.map_err(|e| bad(format!("s3 write failed: {e}")))?;
                store.delete(&path).await.map_err(|e| bad(format!("s3 delete failed: {e}")))?;
            }
        }
        Ok(())
    }

    // ---------- jobs ----------

    async fn job_row(&self, id: &str) -> Result<JobRow> {
        sqlx::query_as(concat!(job_select_sql!(), " WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("backup job"))
    }

    async fn to_job(&self, r: JobRow) -> Result<BackupJob> {
        let mut source: Source = serde_json::from_str(&r.source).map_err(|e| Error::Internal(e.to_string()))?;
        if let Some(db) = source.db_mut() {
            db.has_password = r.source_secret_enc.is_some();
        }
        let (mode, recipients) = (r.mode().to_owned(), r.recipient_list());
        let last_run = sqlx::query_as(concat!(run_select_sql!(), " WHERE job_id = ? ORDER BY started_at DESC LIMIT 1"))
            .bind(&r.id)
            .fetch_optional(&self.db)
            .await?;
        Ok(BackupJob {
            id: r.id,
            name: r.name,
            server_id: r.server_id,
            storage_id: r.storage_id,
            source,
            schedule: r.schedule,
            retention: r.retention,
            encrypt: mode != "none",
            encryption: mode,
            recipients,
            enabled: r.enabled,
            next_run_at: r.next_run_at,
            last_run,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }

    pub async fn list_backup_jobs(&self, server_id: Option<&str>) -> Result<Vec<BackupJob>> {
        let rows: Vec<JobRow> =
            sqlx::query_as(concat!(job_select_sql!(), " WHERE (?1 IS NULL OR server_id = ?1) ORDER BY name COLLATE NOCASE"))
                .bind(server_id)
                .fetch_all(&self.db)
                .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(self.to_job(r).await?);
        }
        Ok(out)
    }

    pub async fn get_backup_job(&self, id: &str) -> Result<BackupJob> {
        let row = self.job_row(id).await?;
        self.to_job(row).await
    }

    /// Returns the source JSON without the password, and the new encrypted password (`None` = keep the stored one).
    fn prepare_source(&self, mut source: Source) -> Result<(String, Option<Option<String>>)> {
        let mut secret = None;
        match &mut source {
            Source::Files { paths, excludes } => {
                paths.retain(|p| !p.trim().is_empty());
                excludes.retain(|p| !p.trim().is_empty());
                if paths.is_empty() {
                    return Err(bad("source.paths must contain at least one path"));
                }
            }
            Source::Postgres(db) | Source::Mysql(db) => {
                if db.database.trim().is_empty() {
                    return Err(bad("source.database is required"));
                }
                if let Some(pw) = db.password.take() {
                    secret = Some(self.secrets.encrypt_opt(Some(&pw)));
                }
                db.has_password = false;
            }
        }
        Ok((serde_json::to_string(&source).unwrap(), secret))
    }

    /// Returns (mode, encrypted passphrase, recipients joined by `\n`).
    fn resolve_encryption(&self, input: &BackupJobInput, cur: Option<&JobRow>) -> Result<(&'static str, Option<String>, Option<String>)> {
        let cur_mode = cur.map(JobRow::mode).unwrap_or("none");
        let mode = match (input.encryption.as_deref(), input.encrypt) {
            (Some(m), _) => m,
            (None, Some(false)) => "none",
            (None, Some(true)) if cur_mode == "none" => "passphrase",
            _ => cur_mode,
        };
        match mode {
            "none" => Ok(("none", None, None)),
            "passphrase" => {
                let enc = match input.passphrase.as_deref().filter(|p| !p.is_empty()) {
                    Some(p) => Some(self.secrets.encrypt(p)),
                    None => cur.and_then(|c| c.passphrase_enc.clone()),
                };
                if enc.is_none() {
                    return Err(bad("passphrase is required for passphrase encryption"));
                }
                Ok(("passphrase", enc, None))
            }
            "recipients" => {
                let list = match &input.recipients {
                    Some(l) => l.clone(),
                    None => cur.map(JobRow::recipient_list).unwrap_or_default(),
                };
                let parsed = parse_recipients(&list)?;
                if parsed.is_empty() {
                    return Err(bad("at least one age public key (age1…) is required"));
                }
                let normalized: Vec<String> = parsed.iter().map(|r| r.to_string()).collect();
                Ok(("recipients", None, Some(normalized.join("\n"))))
            }
            other => Err(bad(format!("unknown encryption mode '{other}': use none, passphrase or recipients"))),
        }
    }

    pub fn generate_backup_key(&self) -> BackupKeyPair {
        use age::secrecy::ExposeSecret;
        let id = age::x25519::Identity::generate();
        let public_key = id.to_public().to_string();
        let private_key = id.to_string().expose_secret().to_owned();
        let identity_file = format!("# created: {}\n# public key: {public_key}\n{private_key}\n", now().to_rfc3339());
        BackupKeyPair { public_key, private_key, identity_file }
    }

    pub async fn create_backup_job(&self, input: BackupJobInput) -> Result<BackupJob> {
        let (mode, passphrase_enc, recipients) = self.resolve_encryption(&input, None)?;
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("name is required"))?;
        let server_id = input.server_id.ok_or_else(|| bad("server_id is required"))?;
        let storage_id = input.storage_id.ok_or_else(|| bad("storage_id is required"))?;
        self.get_server(&server_id).await?;
        self.storage_row(&storage_id).await?;
        let (source, secret) = self.prepare_source(input.source.ok_or_else(|| bad("source is required"))?)?;
        let schedule = input.schedule.flatten().filter(|s| !s.trim().is_empty());
        let next = next_run(schedule.as_deref())?;
        let id = new_id();
        sqlx::query(
            "INSERT INTO backup_jobs (id, name, server_id, storage_id, source, source_secret_enc, schedule, retention, encrypt,
                passphrase_enc, encryption, recipients, enabled, next_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(server_id)
        .bind(storage_id)
        .bind(source)
        .bind(secret.flatten())
        .bind(schedule)
        .bind(input.retention.unwrap_or(0).max(0))
        .bind(mode != "none")
        .bind(passphrase_enc)
        .bind(mode)
        .bind(recipients)
        .bind(input.enabled.unwrap_or(true))
        .bind(next)
        .bind(now())
        .bind(now())
        .execute(&self.db)
        .await?;
        self.get_backup_job(&id).await
    }

    pub async fn update_backup_job(&self, id: &str, input: BackupJobInput) -> Result<BackupJob> {
        let cur = self.job_row(id).await?;
        let (mode, passphrase_enc, recipients) = self.resolve_encryption(&input, Some(&cur))?;
        if let Some(s) = &input.server_id {
            self.get_server(s).await?;
        }
        if let Some(s) = &input.storage_id {
            self.storage_row(s).await?;
        }
        let (source, source_secret) = match input.source {
            Some(src) => {
                let (json, secret) = self.prepare_source(src)?;
                (json, secret.unwrap_or(cur.source_secret_enc.clone()))
            }
            None => (cur.source.clone(), cur.source_secret_enc.clone()),
        };
        let schedule = match input.schedule {
            Some(s) => s.filter(|s| !s.trim().is_empty()),
            None => cur.schedule.clone(),
        };
        sqlx::query(
            "UPDATE backup_jobs SET name = ?, server_id = ?, storage_id = ?, source = ?, source_secret_enc = ?, schedule = ?,
                retention = ?, encrypt = ?, passphrase_enc = ?, encryption = ?, recipients = ?, enabled = ?, next_run_at = ?,
                updated_at = ? WHERE id = ?",
        )
        .bind(match input.name.as_deref().map(str::trim) {
            Some("") => return Err(bad("name cannot be empty")),
            Some(n) => n.to_owned(),
            None => cur.name,
        })
        .bind(input.server_id.unwrap_or(cur.server_id))
        .bind(input.storage_id.unwrap_or(cur.storage_id))
        .bind(source)
        .bind(source_secret)
        .bind(&schedule)
        .bind(input.retention.unwrap_or(cur.retention).max(0))
        .bind(mode != "none")
        .bind(passphrase_enc)
        .bind(mode)
        .bind(recipients)
        .bind(input.enabled.unwrap_or(cur.enabled))
        .bind(next_run(schedule.as_deref())?)
        .bind(now())
        .bind(id)
        .execute(&self.db)
        .await?;
        self.get_backup_job(id).await
    }

    pub async fn delete_backup_job(&self, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM backup_jobs WHERE id = ?").bind(id).execute(&self.db).await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("backup job"));
        }
        Ok(())
    }

    // ---------- runs ----------

    pub async fn list_backup_runs(&self, f: &RunFilter) -> Result<Vec<BackupRun>> {
        Ok(sqlx::query_as(concat!(
            run_select_sql!(),
            " WHERE (?1 IS NULL OR job_id = ?1) AND (?2 IS NULL OR server_id = ?2) ORDER BY started_at DESC LIMIT 500"
        ))
        .bind(&f.job_id)
        .bind(&f.server_id)
        .fetch_all(&self.db)
        .await?)
    }

    pub async fn get_backup_run(&self, id: &str) -> Result<BackupRun> {
        sqlx::query_as(concat!(run_select_sql!(), " WHERE id = ?"))
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("backup"))
    }

    pub async fn run_backup(&self, job_id: &str) -> Result<BackupRun> {
        let job = self.job_row(job_id).await?;
        let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup_runs WHERE job_id = ? AND status = 'running'")
            .bind(job_id)
            .fetch_one(&self.db)
            .await?;
        if running > 0 {
            return Err(Error::Conflict("this backup job is already running".into()));
        }
        let run_id = new_id();
        sqlx::query(
            "INSERT INTO backup_runs (id, job_id, server_id, storage_id, status, started_at, encrypted) VALUES (?, ?, ?, ?, 'running', ?, ?)",
        )
        .bind(&run_id)
        .bind(&job.id)
        .bind(&job.server_id)
        .bind(&job.storage_id)
        .bind(now())
        .bind(job.mode() != "none")
        .execute(&self.db)
        .await?;

        let app = self.clone();
        let rid = run_id.clone();
        tokio::spawn(async move {
            let result = app.execute_backup(&job, &rid).await;
            let update = match &result {
                Ok((size, file, key)) => sqlx::query(
                    "UPDATE backup_runs SET status = 'success', finished_at = ?, size_bytes = ?, file_name = ?, object_key = ? WHERE id = ?",
                )
                .bind(now())
                .bind(*size as i64)
                .bind(file)
                .bind(key)
                .bind(&rid),
                Err(e) => {
                    tracing::warn!(job = %job.name, error = %e, "backup failed");
                    sqlx::query("UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
                        .bind(now())
                        .bind(e.to_string())
                        .bind(&rid)
                }
            };
            if let Err(e) = update.execute(&app.db).await {
                tracing::error!(error = %e, "cannot record backup result");
            }
            if result.is_ok()
                && let Err(e) = app.apply_retention(&job).await
            {
                tracing::warn!(job = %job.name, error = %e, "backup retention failed");
            }
        });
        self.get_backup_run(&run_id).await
    }

    fn remote_command(&self, job: &JobRow, username: &str) -> Result<(String, &'static str, bool)> {
        let source: Source = serde_json::from_str(&job.source).map_err(|e| Error::Internal(e.to_string()))?;
        let password = self.secrets.decrypt_opt(job.source_secret_enc.as_deref())?;
        const FAIL_MARK: &str = "NODEPILOT_DUMP_FAILED";
        Ok(match source {
            Source::Files { paths, excludes } => {
                let mut cmd = String::from("tar -czf -");
                for e in &excludes {
                    cmd.push_str(&format!(" --exclude={}", shell_quote(e)));
                }
                cmd.push_str(" --");
                for p in &paths {
                    cmd.push(' ');
                    cmd.push_str(&shell_quote(p));
                }
                (privileged(username, &cmd), "tar.gz", true)
            }
            Source::Postgres(db) => {
                let mut args = String::from("pg_dump -Fc");
                if let Some(h) = &db.host {
                    args.push_str(&format!(" -h {}", shell_quote(h)));
                }
                if let Some(p) = db.port {
                    args.push_str(&format!(" -p {p}"));
                }
                if let Some(u) = &db.user {
                    args.push_str(&format!(" -U {}", shell_quote(u)));
                }
                args.push_str(&format!(" -- {}", shell_quote(&db.database)));
                let pw = password.as_deref().map(|p| format!("PGPASSWORD={}", shell_quote(p)));
                let cmd = match &db.docker_container {
                    Some(c) => format!("docker exec {} {} {args}", pw.map(|p| format!("-e {p}")).unwrap_or_default(), shell_quote(c)),
                    None => format!("{} {args}", pw.unwrap_or_default()),
                };
                (cmd, "pgdump", false)
            }
            Source::Mysql(db) => {
                let mut args = String::from("mysqldump --single-transaction --routines --triggers --events");
                if let Some(h) = &db.host {
                    args.push_str(&format!(" -h {}", shell_quote(h)));
                }
                if let Some(p) = db.port {
                    args.push_str(&format!(" -P {p}"));
                }
                if let Some(u) = &db.user {
                    args.push_str(&format!(" -u {}", shell_quote(u)));
                }
                args.push_str(&format!(" -- {}", shell_quote(&db.database)));
                let pw = password.as_deref().map(|p| format!("MYSQL_PWD={}", shell_quote(p)));
                let dump = match &db.docker_container {
                    Some(c) => format!("docker exec {} {} {args}", pw.map(|p| format!("-e {p}")).unwrap_or_default(), shell_quote(c)),
                    None => format!("{} {args}", pw.unwrap_or_default()),
                };
                // The pipeline's exit code is gzip's, so dump failures are flagged on stderr.
                (format!("( {dump} || echo {FAIL_MARK} >&2 ) | gzip -c"), "sql.gz", false)
            }
        })
    }

    async fn execute_backup(&self, job: &JobRow, run_id: &str) -> Result<(u64, String, String)> {
        let username = self.server_username(&job.server_id).await?;
        let (cmd, ext, is_tar) = self.remote_command(job, &username)?;
        let encryption = match job.mode() {
            "passphrase" => Encryption::Passphrase(self.secrets.decrypt(job.passphrase_enc.as_deref().unwrap_or_default())?),
            "recipients" => Encryption::Recipients(parse_recipients(&job.recipient_list())?),
            _ => Encryption::None,
        };
        let encrypted = !matches!(encryption, Encryption::None);

        let server_name: String =
            sqlx::query_scalar("SELECT name FROM servers WHERE id = ?").bind(&job.server_id).fetch_one(&self.db).await?;
        let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
        let file_name = format!("{}-{}-{stamp}.{ext}{}", slug(&server_name), slug(&job.name), if encrypted { ".age" } else { "" });
        let key = format!("{}/{file_name}", job.id);

        let backend = self.backend(&job.storage_id).await?;
        let (tmp_path, final_path) = match &backend {
            Backend::Local(dir) => {
                let d = dir.join(&job.id);
                tokio::fs::create_dir_all(&d).await?;
                (d.join(format!(".{file_name}.partial")), Some(d.join(&file_name)))
            }
            Backend::S3 { .. } => {
                let d = self.config.data_dir.join("tmp");
                tokio::fs::create_dir_all(&d).await?;
                (d.join(format!("{run_id}.partial")), None)
            }
        };

        let streamed = self.stream_to_file(&job.server_id, &cmd, is_tar, encryption, &tmp_path).await;
        let size = match streamed {
            Ok(size) => size,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                return Err(e);
            }
        };

        match backend {
            Backend::Local(_) => {
                tokio::fs::rename(&tmp_path, final_path.unwrap()).await?;
            }
            Backend::S3 { store, prefix } => {
                let r = upload_file(store.as_ref(), &Backend::s3_path(&prefix, &key), &tmp_path).await;
                let _ = tokio::fs::remove_file(&tmp_path).await;
                r?;
            }
        }
        Ok((size, file_name, key))
    }

    async fn stream_to_file(&self, server_id: &str, cmd: &str, is_tar: bool, encryption: Encryption, path: &FsPath) -> Result<u64> {
        let conn = self.connection(server_id).await?;
        let _hold = self.ssh.hold(server_id);
        let mut channel = conn.exec_stream(cmd).await?;

        let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(32);
        let path_owned = path.to_owned();
        let writer = tokio::task::spawn_blocking(move || write_archive(&path_owned, encryption, rx));

        let mut stderr = Vec::new();
        let mut exit = None;
        let mut writer_gone = false;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => {
                    if !writer_gone && tx.send(data).await.is_err() {
                        writer_gone = true;
                        let _ = channel.close().await;
                    }
                }
                ChannelMsg::ExtendedData { data, .. } if stderr.len() < 64 * 1024 => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        drop(tx);
        let size =
            writer.await.map_err(|e| Error::Internal(e.to_string()))?.map_err(|e| Error::Internal(format!("writing archive: {e}")))?;

        let stderr = String::from_utf8_lossy(&stderr);
        // tar exits 1 when files changed while being read; the archive is still valid.
        let ok_exit = matches!(exit, Some(0)) || (is_tar && exit == Some(1));
        if !ok_exit || stderr.contains("NODEPILOT_DUMP_FAILED") {
            let tail: String = stderr.lines().filter(|l| !l.contains("NODEPILOT_DUMP_FAILED")).collect::<Vec<_>>().join("\n");
            let tail = tail.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>();
            return Err(Error::Internal(format!(
                "remote command failed (exit {}): {}",
                exit.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()),
                if tail.trim().is_empty() { "no error output" } else { tail.trim() }
            )));
        }
        if size == 0 {
            return Err(Error::Internal("backup produced no data".into()));
        }
        Ok(size)
    }

    async fn delete_archive(&self, storage_id: &str, key: &str) -> Result<()> {
        match self.backend(storage_id).await? {
            Backend::Local(dir) => match tokio::fs::remove_file(dir.join(key)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
            Backend::S3 { store, prefix } => match store.delete(&Backend::s3_path(&prefix, key)).await {
                Err(object_store::Error::NotFound { .. }) | Ok(()) => Ok(()),
                Err(e) => Err(Error::Internal(format!("s3 delete failed: {e}"))),
            },
        }
    }

    async fn apply_retention(&self, job: &JobRow) -> Result<()> {
        if job.retention <= 0 {
            return Ok(());
        }
        let old: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT id, storage_id, object_key FROM backup_runs WHERE job_id = ? AND status = 'success'
             ORDER BY started_at DESC LIMIT -1 OFFSET ?",
        )
        .bind(&job.id)
        .bind(job.retention)
        .fetch_all(&self.db)
        .await?;
        for (id, storage_id, key) in old {
            if let Some(key) = key {
                self.delete_archive(&storage_id, &key).await?;
            }
            sqlx::query("DELETE FROM backup_runs WHERE id = ?").bind(id).execute(&self.db).await?;
        }
        Ok(())
    }

    pub async fn delete_backup_run(&self, id: &str) -> Result<()> {
        let (storage_id, key, status): (String, Option<String>, String) =
            sqlx::query_as("SELECT storage_id, object_key, status FROM backup_runs WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.db)
                .await?
                .ok_or(Error::NotFound("backup"))?;
        if status == "running" {
            return Err(Error::Conflict("backup is still running".into()));
        }
        if let Some(key) = key {
            self.delete_archive(&storage_id, &key).await?;
        }
        sqlx::query("DELETE FROM backup_runs WHERE id = ?").bind(id).execute(&self.db).await?;
        Ok(())
    }

    /// Streams the archive as stored (still encrypted if the job encrypts).
    pub async fn download_backup(&self, id: &str) -> Result<(String, Option<u64>, BoxStream<'static, std::io::Result<Bytes>>)> {
        let (storage_id, key, file_name): (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT storage_id, object_key, file_name FROM backup_runs WHERE id = ? AND status = 'success'")
                .bind(id)
                .fetch_optional(&self.db)
                .await?
                .ok_or(Error::NotFound("backup"))?;
        let key = key.ok_or(Error::NotFound("backup archive"))?;
        let name = file_name.unwrap_or_else(|| "backup".into());
        match self.backend(&storage_id).await? {
            Backend::Local(dir) => {
                let file = tokio::fs::File::open(dir.join(&key)).await.map_err(|_| Error::NotFound("backup archive"))?;
                let size = file.metadata().await.ok().map(|m| m.len());
                Ok((name, size, tokio_util::io::ReaderStream::new(file).boxed()))
            }
            Backend::S3 { store, prefix } => {
                let res = store.get(&Backend::s3_path(&prefix, &key)).await.map_err(|e| match e {
                    object_store::Error::NotFound { .. } => Error::NotFound("backup archive"),
                    e => Error::Internal(format!("s3: {e}")),
                })?;
                let size = Some(res.meta.size);
                Ok((name, size, res.into_stream().map(|r| r.map_err(std::io::Error::other)).boxed()))
            }
        }
    }

    pub async fn recover_backups(&self) -> Result<()> {
        sqlx::query(
            "UPDATE backup_runs SET status = 'failed', finished_at = ?, error = 'interrupted: panel restarted' WHERE status = 'running'",
        )
        .bind(now())
        .execute(&self.db)
        .await?;
        let jobs: Vec<(String, String)> =
            sqlx::query_as("SELECT id, schedule FROM backup_jobs WHERE schedule IS NOT NULL AND next_run_at IS NULL")
                .fetch_all(&self.db)
                .await?;
        for (id, schedule) in jobs {
            if let Ok(next) = next_run(Some(&schedule)) {
                sqlx::query("UPDATE backup_jobs SET next_run_at = ? WHERE id = ?").bind(next).bind(id).execute(&self.db).await?;
            }
        }
        Ok(())
    }

    async fn run_due_backups(&self) -> Result<()> {
        let due: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, schedule FROM backup_jobs WHERE enabled = 1 AND schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?",
        )
        .bind(now())
        .fetch_all(&self.db)
        .await?;
        for (id, schedule) in due {
            // Advance next_run_at first so a failing job isn't retried in a loop.
            let next = next_run(Some(&schedule)).unwrap_or(None);
            sqlx::query("UPDATE backup_jobs SET next_run_at = ? WHERE id = ?").bind(next).bind(&id).execute(&self.db).await?;
            match self.run_backup(&id).await {
                Ok(_) => tracing::info!(job = %id, "scheduled backup started"),
                Err(e) => tracing::warn!(job = %id, error = %e, "scheduled backup not started"),
            }
        }
        Ok(())
    }
}

pub fn spawn_scheduler(app: App) {
    tokio::spawn(async move {
        if let Err(e) = app.recover_backups().await {
            tracing::warn!(error = %e, "backup recovery failed");
        }
        let mut tick = tokio::time::interval(Duration::from_secs(20));
        loop {
            tick.tick().await;
            if let Err(e) = app.run_due_backups().await {
                tracing::warn!(error = %e, "backup scheduler failed");
            }
        }
    });
}

fn slug(s: &str) -> String {
    let s: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_owned();
    if s.is_empty() { "backup".into() } else { s.chars().take(40).collect() }
}

fn write_archive(path: &FsPath, encryption: Encryption, mut rx: tokio::sync::mpsc::Receiver<Bytes>) -> std::io::Result<u64> {
    let file = std::fs::File::create(path)?;
    let buf = std::io::BufWriter::with_capacity(1 << 20, file);
    let encryptor = match encryption {
        Encryption::Passphrase(p) => Some(age::Encryptor::with_user_passphrase(age::secrecy::SecretString::from(p))),
        Encryption::Recipients(list) => Some(
            age::Encryptor::with_recipients(list.iter().map(|r| r as &dyn age::Recipient))
                .map_err(|e| std::io::Error::other(format!("age: {e}")))?,
        ),
        Encryption::None => None,
    };
    let mut inner = match encryptor {
        Some(enc) => {
            let mut w = enc.wrap_output(buf)?;
            while let Some(chunk) = rx.blocking_recv() {
                w.write_all(&chunk)?;
            }
            w.finish()?
        }
        None => {
            let mut w = buf;
            while let Some(chunk) = rx.blocking_recv() {
                w.write_all(&chunk)?;
            }
            w
        }
    };
    inner.flush()?;
    let file = inner.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    Ok(file.metadata()?.len())
}

async fn upload_file(store: &dyn ObjectStore, path: &ObjPath, file: &FsPath) -> Result<()> {
    let upload = store.put_multipart(path).await.map_err(|e| Error::Internal(format!("s3 upload: {e}")))?;
    let mut writer = WriteMultipart::new_with_chunk_size(upload, 16 * 1024 * 1024);
    let mut f = tokio::fs::File::open(file).await?;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        writer.wait_for_capacity(4).await.map_err(|e| Error::Internal(format!("s3 upload: {e}")))?;
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write(&buf[..n]);
    }
    writer.finish().await.map_err(|e| Error::Internal(format!("s3 upload: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules() {
        assert!(parse_schedule("0 0 3 * * *").is_ok());
        assert!(parse_schedule("0 3 * * *").is_ok(), "5-field crontab is accepted");
        assert!(parse_schedule("nonsense").is_err());
    }

    /// Weekdays of the next two weeks of runs.
    fn weekdays(expr: &str) -> std::collections::BTreeSet<String> {
        use chrono::Datelike;
        parse_schedule(expr).unwrap().upcoming(chrono::Utc).take(14).map(|t| t.weekday().to_string()).collect()
    }

    #[test]
    fn crontab_day_of_week_uses_crontab_numbers() {
        let set = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(weekdays("0 3 * * 1"), set(&["Mon"]));
        assert_eq!(weekdays("0 3 * * 0"), set(&["Sun"]));
        assert_eq!(weekdays("0 3 * * 7"), set(&["Sun"]));
        assert_eq!(weekdays("0 3 * * 1-5"), set(&["Mon", "Tue", "Wed", "Thu", "Fri"]));
        assert_eq!(weekdays("0 3 * * 5-7"), set(&["Fri", "Sat", "Sun"]));
        assert_eq!(weekdays("0 3 * * 0,6"), set(&["Sat", "Sun"]));
        assert_eq!(weekdays("0 3 * * */2"), set(&["Sun", "Tue", "Thu", "Sat"]));
        assert_eq!(weekdays("0 3 * * mon-fri"), set(&["Mon", "Tue", "Wed", "Thu", "Fri"]));
        assert_eq!(weekdays("30 2 * * sun"), set(&["Sun"]));
        // The 6-field format keeps the cron crate's own numbering (1 = Sunday) and names.
        assert_eq!(weekdays("0 0 3 * * Mon"), set(&["Mon"]));
        assert!(parse_schedule("0 3 * * 8").is_err());
        assert!(parse_schedule("0 3 * * 1/0").is_err());
    }

    #[test]
    fn age_recipients_roundtrip() {
        let id = age::x25519::Identity::generate();
        let dir = std::env::temp_dir().join(format!("np-age-r-{}", hex::encode(crate::crypto::random_bytes::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.age");
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.try_send(Bytes::from_static(b"secret dump")).unwrap();
        drop(tx);
        write_archive(&path, Encryption::Recipients(vec![id.to_public()]), rx).unwrap();
        let data = std::fs::read(&path).unwrap();
        assert_eq!(age::decrypt(&id, &data).unwrap(), b"secret dump");
        assert!(age::decrypt(&age::x25519::Identity::generate(), &data).is_err());
        assert!(parse_recipients(&["not-a-key".into()]).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn age_roundtrip() {
        let dir = std::env::temp_dir().join(format!("np-age-{}", hex::encode(crate::crypto::random_bytes::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.age");
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.try_send(Bytes::from_static(b"hello ")).unwrap();
        tx.try_send(Bytes::from_static(b"world")).unwrap();
        drop(tx);
        write_archive(&path, Encryption::Passphrase("pw".into()), rx).unwrap();
        let data = std::fs::read(&path).unwrap();
        let id = age::scrypt::Identity::new(age::secrecy::SecretString::from("pw".to_owned()));
        let plain = age::decrypt(&id, &data).unwrap();
        assert_eq!(plain, b"hello world");
        std::fs::remove_dir_all(dir).ok();
    }
}
