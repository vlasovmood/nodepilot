use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use nodepilot_ssh::{AuthMethod, ConnectSpec, Connection, ExecOutput};
use sqlx::{Sqlite, Transaction};

use crate::error::bad;
use crate::identities::validate_secret;
use crate::models::{AuthInput, BulkExecRequest, BulkExecResult, Server, ServerFilter, ServerInput, TestResult, Ts};
use crate::{App, Error, Result, new_id, now};

pub const MAX_OUTPUT: usize = 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const BULK_CONCURRENCY: usize = 32;

#[derive(sqlx::FromRow)]
struct ServerRow {
    id: String,
    name: String,
    host: String,
    port: i64,
    username: String,
    auth_type: String,
    identity_id: Option<String>,
    secret_enc: Option<String>,
    passphrase_enc: Option<String>,
    tags: String,
    description: String,
    host_key: Option<String>,
    created_at: Ts,
    updated_at: Ts,
}

macro_rules! select_sql {
    () => {
        "SELECT id, name, host, port, username, auth_type, identity_id, secret_enc, passphrase_enc,
    tags, description, host_key, created_at, updated_at FROM servers"
    };
}

struct Prepared {
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_type: &'static str,
    identity_id: Option<String>,
    secret_enc: Option<String>,
    passphrase_enc: Option<String>,
    tags: Vec<String>,
    description: String,
    project_ids: Option<Vec<String>>,
}

fn required(v: Option<String>, field: &str) -> Result<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).ok_or_else(|| bad(format!("{field} is required")))
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = tags.into_iter().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).collect();
    out.sort();
    out.dedup();
    out
}

impl App {
    fn to_server(&self, row: ServerRow, project_ids: Vec<String>) -> Server {
        Server {
            status: self.stats.status(&row.id),
            id: row.id,
            name: row.name,
            host: row.host,
            port: row.port as u16,
            username: row.username,
            auth_type: row.auth_type,
            identity_id: row.identity_id,
            tags: serde_json::from_str(&row.tags).unwrap_or_default(),
            project_ids,
            description: row.description,
            host_key_fingerprint: row.host_key,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }

    async fn project_map(&self) -> Result<HashMap<String, Vec<String>>> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT server_id, project_id FROM project_servers").fetch_all(&self.db).await?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for (s, p) in rows {
            map.entry(s).or_default().push(p);
        }
        Ok(map)
    }

    pub async fn list_servers(&self, f: &ServerFilter) -> Result<Vec<Server>> {
        let q = f.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| format!("%{q}%"));
        let rows: Vec<ServerRow> = sqlx::query_as(concat!(
            select_sql!(),
            " WHERE (?1 IS NULL OR id IN (SELECT server_id FROM project_servers WHERE project_id = ?1))
               AND (?2 IS NULL OR name LIKE ?2 OR host LIKE ?2)
             ORDER BY name COLLATE NOCASE"
        ))
        .bind(&f.project_id)
        .bind(&q)
        .fetch_all(&self.db)
        .await?;
        let mut projects = self.project_map().await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                let p = projects.remove(&r.id).unwrap_or_default();
                self.to_server(r, p)
            })
            .filter(|s| f.tag.as_ref().is_none_or(|t| s.tags.contains(t)))
            .collect())
    }

    async fn server_row(&self, id: &str) -> Result<ServerRow> {
        sqlx::query_as(concat!(select_sql!(), " WHERE id = ?")).bind(id).fetch_optional(&self.db).await?.ok_or(Error::NotFound("server"))
    }

    pub async fn get_server(&self, id: &str) -> Result<Server> {
        let row = self.server_row(id).await?;
        let projects =
            sqlx::query_scalar("SELECT project_id FROM project_servers WHERE server_id = ?").bind(id).fetch_all(&self.db).await?;
        Ok(self.to_server(row, projects))
    }

    async fn resolve_auth(&self, auth: AuthInput) -> Result<(&'static str, Option<String>, Option<String>, Option<String>)> {
        Ok(match auth {
            AuthInput::Password { password } => {
                let (secret, _) = validate_secret("password", Some(password), None, None)?;
                ("password", None, Some(self.secrets.encrypt(&secret)), None)
            }
            AuthInput::Key { private_key, passphrase } => {
                let (secret, pass) = validate_secret("key", None, Some(private_key), passphrase)?;
                ("key", None, Some(self.secrets.encrypt(&secret)), self.secrets.encrypt_opt(pass.as_deref()))
            }
            AuthInput::Identity { identity_id } => {
                self.get_identity(&identity_id).await?;
                ("identity", Some(identity_id), None, None)
            }
        })
    }

    async fn prepare(&self, input: ServerInput) -> Result<Prepared> {
        let (auth_type, identity_id, secret_enc, passphrase_enc) =
            self.resolve_auth(input.auth.ok_or_else(|| bad("auth is required"))?).await?;
        let port = input.port.unwrap_or(22);
        if port == 0 {
            return Err(bad("port must be 1-65535"));
        }
        Ok(Prepared {
            name: required(input.name, "name")?,
            host: required(input.host, "host")?,
            port,
            username: required(input.username, "username")?,
            auth_type,
            identity_id,
            secret_enc,
            passphrase_enc,
            tags: clean_tags(input.tags.unwrap_or_default()),
            description: input.description.unwrap_or_default(),
            project_ids: input.project_ids,
        })
    }

    async fn insert(tx: &mut Transaction<'_, Sqlite>, p: &Prepared) -> Result<String> {
        let id = new_id();
        sqlx::query(
            "INSERT INTO servers (id, name, host, port, username, auth_type, identity_id, secret_enc, passphrase_enc,
                tags, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&p.name)
        .bind(&p.host)
        .bind(p.port as i64)
        .bind(&p.username)
        .bind(p.auth_type)
        .bind(&p.identity_id)
        .bind(&p.secret_enc)
        .bind(&p.passphrase_enc)
        .bind(serde_json::to_string(&p.tags).unwrap())
        .bind(&p.description)
        .bind(now())
        .bind(now())
        .execute(&mut **tx)
        .await?;
        Self::set_projects(tx, &id, p.project_ids.as_deref().unwrap_or_default()).await?;
        Ok(id)
    }

    async fn set_projects(tx: &mut Transaction<'_, Sqlite>, server_id: &str, project_ids: &[String]) -> Result<()> {
        sqlx::query("DELETE FROM project_servers WHERE server_id = ?").bind(server_id).execute(&mut **tx).await?;
        for p in project_ids {
            sqlx::query("INSERT OR IGNORE INTO project_servers (project_id, server_id) VALUES (?, ?)")
                .bind(p)
                .bind(server_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| match Error::from(e) {
                    Error::Conflict(_) => bad(format!("project {p} does not exist")),
                    e => e,
                })?;
        }
        Ok(())
    }

    pub async fn create_server(&self, input: ServerInput) -> Result<Server> {
        let p = self.prepare(input).await?;
        let mut tx = self.db.begin().await?;
        let id = Self::insert(&mut tx, &p).await?;
        tx.commit().await?;
        self.get_server(&id).await
    }

    pub async fn create_servers(&self, inputs: Vec<ServerInput>) -> Result<Vec<Server>> {
        let mut prepared = Vec::with_capacity(inputs.len());
        for (i, input) in inputs.into_iter().enumerate() {
            prepared.push(self.prepare(input).await.map_err(|e| bad(format!("item {i}: {e}")))?);
        }
        let mut tx = self.db.begin().await?;
        let mut ids = Vec::new();
        for p in &prepared {
            ids.push(Self::insert(&mut tx, p).await?);
        }
        tx.commit().await?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            out.push(self.get_server(&id).await?);
        }
        Ok(out)
    }

    pub async fn update_server(&self, id: &str, input: ServerInput) -> Result<Server> {
        let cur = self.server_row(id).await?;
        let (auth_type, identity_id, secret_enc, passphrase_enc) = match input.auth {
            Some(auth) => {
                let (t, i, s, p) = self.resolve_auth(auth).await?;
                (t.to_owned(), i, s, p)
            }
            None => (cur.auth_type.clone(), cur.identity_id.clone(), cur.secret_enc.clone(), cur.passphrase_enc.clone()),
        };
        let host = match input.host {
            Some(h) => required(Some(h), "host")?,
            None => cur.host.clone(),
        };
        let port = input.port.map(i64::from).unwrap_or(cur.port);
        // A new address invalidates the pinned host key.
        let host_key = if host != cur.host || port != cur.port { None } else { cur.host_key.clone() };
        let tags = input.tags.map(clean_tags).map(|t| serde_json::to_string(&t).unwrap()).unwrap_or(cur.tags);

        let mut tx = self.db.begin().await?;
        sqlx::query(
            "UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, identity_id = ?, secret_enc = ?,
                passphrase_enc = ?, tags = ?, description = ?, host_key = ?, updated_at = ? WHERE id = ?",
        )
        .bind(match input.name {
            Some(n) => required(Some(n), "name")?,
            None => cur.name,
        })
        .bind(&host)
        .bind(port)
        .bind(match input.username {
            Some(u) => required(Some(u), "username")?,
            None => cur.username,
        })
        .bind(auth_type)
        .bind(identity_id)
        .bind(secret_enc)
        .bind(passphrase_enc)
        .bind(tags)
        .bind(input.description.unwrap_or(cur.description))
        .bind(host_key)
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
        if let Some(projects) = &input.project_ids {
            Self::set_projects(&mut tx, id, projects).await?;
        }
        tx.commit().await?;
        self.ssh.invalidate(id).await;
        self.get_server(id).await
    }

    pub async fn delete_server(&self, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM servers WHERE id = ?").bind(id).execute(&self.db).await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("server"));
        }
        self.ssh.invalidate(id).await;
        self.stats.remove(id);
        Ok(())
    }

    pub async fn reset_host_key(&self, id: &str) -> Result<()> {
        self.server_row(id).await?;
        sqlx::query("UPDATE servers SET host_key = NULL WHERE id = ?").bind(id).execute(&self.db).await?;
        self.ssh.invalidate(id).await;
        Ok(())
    }

    // ---------- SSH ----------

    pub async fn connect_spec(&self, id: &str) -> Result<(ConnectSpec, String)> {
        let row = self.server_row(id).await?;
        let (kind, secret, passphrase) = if row.auth_type == "identity" {
            let identity_id = row.identity_id.as_deref().ok_or_else(|| Error::Internal("server has no identity".into()))?;
            let (kind, s, p): (String, String, Option<String>) =
                sqlx::query_as("SELECT kind, secret_enc, passphrase_enc FROM identities WHERE id = ?")
                    .bind(identity_id)
                    .fetch_optional(&self.db)
                    .await?
                    .ok_or(Error::NotFound("identity"))?;
            (kind, s, p)
        } else {
            let s = row.secret_enc.clone().ok_or_else(|| Error::Internal("server has no credentials".into()))?;
            (row.auth_type.clone(), s, row.passphrase_enc.clone())
        };
        let secret = self.secrets.decrypt(&secret)?;
        let auth = if kind == "key" {
            AuthMethod::Key { private_key: secret, passphrase: self.secrets.decrypt_opt(passphrase.as_deref())? }
        } else {
            AuthMethod::Password(secret)
        };
        let spec = ConnectSpec {
            host: row.host,
            port: row.port as u16,
            username: row.username.clone(),
            auth,
            host_key: row.host_key,
            connect_timeout: Duration::from_secs(10),
        };
        Ok((spec, row.username))
    }

    /// Pins the host key on first connect (TOFU).
    pub async fn connection(&self, id: &str) -> Result<Arc<Connection>> {
        let (spec, _) = self.connect_spec(id).await?;
        let pinned = spec.host_key.is_some();
        let conn = self.ssh.get(id, &spec).await?;
        if !pinned {
            sqlx::query("UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL")
                .bind(conn.host_key())
                .bind(id)
                .execute(&self.db)
                .await?;
        }
        Ok(conn)
    }

    pub async fn server_username(&self, id: &str) -> Result<String> {
        sqlx::query_scalar("SELECT username FROM servers WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("server"))
    }

    pub async fn exec(&self, id: &str, command: &str, timeout_secs: Option<u64>) -> Result<ExecOutput> {
        if command.trim().is_empty() {
            return Err(bad("command is required"));
        }
        let timeout = timeout_secs.map(Duration::from_secs).unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
        let conn = self.connection(id).await?;
        Ok(conn.exec(command, timeout, MAX_OUTPUT).await?)
    }

    pub async fn bulk_exec(&self, req: BulkExecRequest) -> Result<Vec<BulkExecResult>> {
        if req.command.trim().is_empty() {
            return Err(bad("command is required"));
        }
        let mut targets: Vec<(String, String)> = Vec::new();
        if let Some(pid) = &req.project_id {
            self.get_project(pid).await?;
            let servers = self.list_servers(&ServerFilter { project_id: Some(pid.clone()), ..Default::default() }).await?;
            targets.extend(servers.into_iter().map(|s| (s.id, s.name)));
        }
        for id in req.server_ids.unwrap_or_default() {
            if !targets.iter().any(|(t, _)| *t == id) {
                let s = self.get_server(&id).await?;
                targets.push((s.id, s.name));
            }
        }
        if targets.is_empty() {
            return Err(bad("no target servers: pass server_ids or project_id"));
        }

        let command = req.command;
        let results = futures::stream::iter(targets)
            .map(|(id, name)| {
                let command = command.clone();
                async move {
                    match self.exec(&id, &command, req.timeout_secs).await {
                        Ok(out) => BulkExecResult { server_id: id, server_name: name, ok: true, error: None, result: Some(out) },
                        Err(e) => BulkExecResult { server_id: id, server_name: name, ok: false, error: Some(e.to_string()), result: None },
                    }
                }
            })
            .buffered(BULK_CONCURRENCY)
            .collect()
            .await;
        Ok(results)
    }

    pub async fn test_server(&self, id: &str) -> Result<TestResult> {
        self.ssh.invalidate(id).await;
        let started = Instant::now();
        let result = async {
            let conn = self.connection(id).await?;
            conn.exec("true", Duration::from_secs(10), 1024).await?;
            Ok::<_, Error>(())
        }
        .await;
        Ok(TestResult { ok: result.is_ok(), latency_ms: started.elapsed().as_millis() as u64, error: result.err().map(|e| e.to_string()) })
    }
}
