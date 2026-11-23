//! The panel's own SSH key. Its `authorized_keys` line is restricted with `from="<panel IP>"` and no-forwarding options,
//! so a stolen key is useless from another host. The `nodepilot-panel-key:<marker>` comment enables rotation and
//! emergency revocation, even without the panel: `sed -i '/nodepilot-panel-key:/d' ~/.ssh/authorized_keys`.

use std::time::Duration;

use futures::StreamExt;
use nodepilot_ssh::{AuthMethod, shell_quote};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::crypto::random_bytes;
use crate::error::bad;
use crate::models::{ServerFilter, Ts};
use crate::{App, Error, Result, new_id, now};

pub const MARKER_PREFIX: &str = "nodepilot-panel-key:";
const CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct State {
    identity_id: String,
    marker: String,
    public_key: String,
    allowed_from: Vec<String>,
    created_at: Ts,
    /// Servers that got the key line, switched or not; rotation and revocation cover all of them.
    #[serde(default)]
    deployed: Vec<String>,
    /// Earlier panel identities that servers still use because a rotation failed for them.
    #[serde(default)]
    retired: Vec<String>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct PanelKeyInfo {
    pub configured: bool,
    pub identity_id: Option<String>,
    pub public_key: Option<String>,
    /// Addresses/networks servers accept the key from (`from=`). Empty means unrestricted (not recommended).
    pub allowed_from: Vec<String>,
    /// Ready-made line for `~/.ssh/authorized_keys`.
    pub authorized_keys_line: Option<String>,
    /// Command that adds the line to a server manually.
    pub install_command: Option<String>,
    /// Emergency command that revokes all panel keys (run on each server, without the panel).
    pub emergency_revoke_command: String,
    pub servers_using: i64,
    pub servers_total: i64,
    pub created_at: Option<Ts>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct PanelKeyInput {
    /// Panel IP addresses or CIDR networks as servers see them (`203.0.113.10`, `10.0.0.0/8`).
    pub allowed_from: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeployRequest {
    pub server_ids: Option<Vec<String>>,
    pub project_id: Option<String>,
    /// Switch servers to the panel key after a successful check (default: true).
    #[serde(default = "yes")]
    pub switch_auth: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct ServerOpResult {
    pub server_id: String,
    pub server_name: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DetectIpRequest {
    pub server_id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DetectedIp {
    /// Panel address as the server sees it (from `$SSH_CLIENT`).
    pub ip: String,
}

fn valid_from(entry: &str) -> bool {
    !entry.is_empty() && entry.len() <= 64 && entry.chars().all(|c| c.is_ascii_hexdigit() || ":./*?!".contains(c))
}

fn authorized_line(public_key: &str, allowed_from: &[String]) -> String {
    let mut opts = Vec::new();
    if !allowed_from.is_empty() {
        opts.push(format!("from=\"{}\"", allowed_from.join(",")));
    }
    opts.extend(["no-port-forwarding", "no-agent-forwarding", "no-X11-forwarding"].map(String::from));
    format!("{} {public_key}", opts.join(","))
}

/// Replaces the line with this marker idempotently, keeping other keys.
fn install_cmd(line: &str, marker: &str) -> String {
    let f = "\"$HOME/.ssh/authorized_keys\"";
    format!(
        "umask 077 && mkdir -p \"$HOME/.ssh\" && touch {f} && \
         sed -i.nodepilot.bak '/{MARKER_PREFIX}{marker}/d' {f} && \
         if [ -s {f} ] && [ -n \"$(tail -c1 {f})\" ]; then echo >> {f}; fi && \
         printf '%s\\n' {} >> {f} && \
         (command -v restorecon >/dev/null 2>&1 && restorecon {f} || true)",
        shell_quote(line)
    )
}

/// An empty `marker` removes every panel key.
fn remove_cmd(marker: &str) -> String {
    let f = "\"$HOME/.ssh/authorized_keys\"";
    format!("if [ -f {f} ]; then sed -i.nodepilot.bak '/{MARKER_PREFIX}{marker}/d' {f}; fi")
}

/// Removes every panel key line except the current one (covers lines left by earlier failed rotations).
fn remove_others_cmd(keep_marker: &str) -> String {
    let f = "\"$HOME/.ssh/authorized_keys\"";
    format!("if [ -f {f} ]; then sed -i.nodepilot.bak '/{MARKER_PREFIX}/{{/{MARKER_PREFIX}{keep_marker}/!d;}}' {f}; fi")
}

impl App {
    async fn panel_state(&self) -> Result<Option<State>> {
        let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'panel_key'").fetch_optional(&self.db).await?;
        Ok(v.and_then(|v| serde_json::from_str(&v).ok()))
    }

    async fn save_panel_state(&self, st: Option<&State>) -> Result<()> {
        match st {
            Some(st) => {
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES ('panel_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(serde_json::to_string(st).unwrap())
                .execute(&self.db)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM settings WHERE key = 'panel_key'").execute(&self.db).await?;
            }
        }
        Ok(())
    }

    pub async fn panel_key_info(&self) -> Result<PanelKeyInfo> {
        let st = self.panel_state().await?;
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers").fetch_one(&self.db).await?;
        let using: i64 = match &st {
            Some(s) => {
                sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE identity_id = ?").bind(&s.identity_id).fetch_one(&self.db).await?
            }
            None => 0,
        };
        let line = st.as_ref().map(|s| authorized_line(&s.public_key, &s.allowed_from));
        Ok(PanelKeyInfo {
            configured: st.is_some(),
            identity_id: st.as_ref().map(|s| s.identity_id.clone()),
            public_key: st.as_ref().map(|s| s.public_key.clone()),
            allowed_from: st.as_ref().map(|s| s.allowed_from.clone()).unwrap_or_default(),
            install_command: st.as_ref().zip(line.as_ref()).map(|(s, l)| install_cmd(l, &s.marker)),
            authorized_keys_line: line,
            emergency_revoke_command: remove_cmd(""),
            servers_using: using,
            servers_total: total,
            created_at: st.map(|s| s.created_at),
        })
    }

    fn check_from(list: &[String]) -> Result<Vec<String>> {
        let list: Vec<String> = list.iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
        if let Some(bad_entry) = list.iter().find(|e| !valid_from(e)) {
            return Err(bad(format!("invalid address '{bad_entry}': use IP addresses or CIDR networks")));
        }
        Ok(list)
    }

    async fn new_panel_identity(&self, allowed_from: Vec<String>) -> Result<State> {
        let marker = hex::encode(random_bytes::<6>());
        let (private, public) = nodepilot_ssh::generate_ed25519(&random_bytes::<32>(), &format!("{MARKER_PREFIX}{marker}"))?;
        let id = new_id();
        sqlx::query("INSERT INTO identities (id, name, kind, secret_enc, passphrase_enc, created_at) VALUES (?, ?, 'key', ?, NULL, ?)")
            .bind(&id)
            .bind(format!("NodePilot panel key {marker}"))
            .bind(self.secrets.encrypt(&private))
            .bind(now())
            .execute(&self.db)
            .await?;
        Ok(State {
            identity_id: id,
            marker,
            public_key: public,
            allowed_from,
            created_at: now(),
            deployed: Vec::new(),
            retired: Vec::new(),
        })
    }

    pub async fn create_panel_key(&self, input: PanelKeyInput) -> Result<PanelKeyInfo> {
        if self.panel_state().await?.is_some() {
            return Err(Error::Conflict("panel key already exists; rotate it instead".into()));
        }
        let from = Self::check_from(&input.allowed_from.unwrap_or_default())?;
        let st = self.new_panel_identity(from).await?;
        self.save_panel_state(Some(&st)).await?;
        self.panel_key_info().await
    }

    /// Servers get the updated line only on the next deploy.
    pub async fn update_panel_key(&self, input: PanelKeyInput) -> Result<PanelKeyInfo> {
        let mut st = self.panel_state().await?.ok_or(Error::NotFound("panel key"))?;
        if let Some(list) = input.allowed_from {
            st.allowed_from = Self::check_from(&list)?;
        }
        self.save_panel_state(Some(&st)).await?;
        self.panel_key_info().await
    }

    pub async fn detect_panel_ip(&self, server_id: &str) -> Result<DetectedIp> {
        let out = self.exec(server_id, "printf '%s' \"$SSH_CLIENT\"", Some(15)).await?;
        let ip = out.stdout.split_whitespace().next().unwrap_or_default().to_owned();
        if !valid_from(&ip) {
            return Err(bad("could not detect the panel address on this server ($SSH_CLIENT is empty)"));
        }
        Ok(DetectedIp { ip })
    }

    async fn targets(&self, server_ids: Option<Vec<String>>, project_id: Option<String>) -> Result<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        if let Some(p) = project_id {
            for s in self.list_servers(&ServerFilter { project_id: Some(p), ..Default::default() }).await? {
                out.push((s.id, s.name));
            }
        }
        for id in server_ids.unwrap_or_default() {
            if !out.iter().any(|(i, _)| *i == id) {
                let s = self.get_server(&id).await?;
                out.push((s.id, s.name));
            }
        }
        if out.is_empty() {
            return Err(bad("no target servers"));
        }
        Ok(out)
    }

    async fn probe_with_identity(&self, server_id: &str, identity_id: &str) -> Result<()> {
        let (mut spec, _) = self.connect_spec(server_id).await?;
        let enc: String =
            sqlx::query_scalar("SELECT secret_enc FROM identities WHERE id = ?").bind(identity_id).fetch_one(&self.db).await?;
        spec.auth = AuthMethod::Key { private_key: self.secrets.decrypt(&enc)?, passphrase: None };
        spec.connect_timeout = Duration::from_secs(10);
        Ok(self.ssh.probe(&spec).await?)
    }

    async fn switch_to_identity(&self, server_id: &str, identity_id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE servers SET auth_type = 'identity', identity_id = ?, secret_enc = NULL, passphrase_enc = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(identity_id)
        .bind(now())
        .bind(server_id)
        .execute(&self.db)
        .await?;
        self.ssh.invalidate(server_id).await;
        Ok(())
    }

    async fn run_cmd_ok(&self, server_id: &str, cmd: &str) -> Result<()> {
        let out = self.exec(server_id, cmd, Some(30)).await?;
        if out.exit_code != Some(0) {
            let msg = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
            return Err(Error::BadRequest(format!("command failed (exit {:?}): {msg}", out.exit_code)));
        }
        Ok(())
    }

    pub async fn deploy_panel_key(&self, req: DeployRequest) -> Result<Vec<ServerOpResult>> {
        let st = self.panel_state().await?.ok_or_else(|| bad("create the panel key first"))?;
        let line = authorized_line(&st.public_key, &st.allowed_from);
        let targets = self.targets(req.server_ids, req.project_id).await?;
        let cmd = install_cmd(&line, &st.marker);
        let done: Vec<(ServerOpResult, bool)> = futures::stream::iter(targets)
            .map(|(id, name)| {
                let (cmd, st) = (cmd.clone(), &st);
                async move {
                    let mut installed = false;
                    let r = async {
                        self.run_cmd_ok(&id, &cmd).await?;
                        installed = true;
                        self.probe_with_identity(&id, &st.identity_id).await?;
                        if req.switch_auth {
                            self.switch_to_identity(&id, &st.identity_id).await?;
                        }
                        Ok::<_, Error>(())
                    }
                    .await;
                    (ServerOpResult { server_id: id, server_name: name, ok: r.is_ok(), error: r.err().map(|e| e.to_string()) }, installed)
                }
            })
            .buffered(CONCURRENCY)
            .collect()
            .await;
        // Re-read the state: it may have changed during the deploy.
        if let Some(mut cur) = self.panel_state().await?
            && cur.identity_id == st.identity_id
        {
            for (r, installed) in &done {
                if *installed && !cur.deployed.contains(&r.server_id) {
                    cur.deployed.push(r.server_id.clone());
                }
            }
            self.save_panel_state(Some(&cur)).await?;
        }
        Ok(done.into_iter().map(|(r, _)| r).collect())
    }

    /// Servers switched to the panel key (`true`) and those that only got the key line (`false`).
    async fn key_servers(&self, st: &State) -> Result<Vec<(String, String, bool)>> {
        // Servers authenticating with the current panel key, or still with an earlier one after a failed rotation.
        let mut out: Vec<(String, String, bool)> = Vec::new();
        for identity in std::iter::once(&st.identity_id).chain(&st.retired) {
            let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM servers WHERE identity_id = ? ORDER BY name")
                .bind(identity)
                .fetch_all(&self.db)
                .await?;
            out.extend(rows.into_iter().map(|(id, name)| (id, name, true)));
        }
        for id in &st.deployed {
            if out.iter().any(|(i, _, _)| i == id) {
                continue;
            }
            if let Some(name) =
                sqlx::query_scalar::<_, String>("SELECT name FROM servers WHERE id = ?").bind(id).fetch_optional(&self.db).await?
            {
                out.push((id.clone(), name, false));
            }
        }
        Ok(out)
    }

    pub async fn rotate_panel_key(&self) -> Result<Vec<ServerOpResult>> {
        let old = self.panel_state().await?.ok_or_else(|| bad("create the panel key first"))?;
        let new = self.new_panel_identity(old.allowed_from.clone()).await?;
        let line = authorized_line(&new.public_key, &new.allowed_from);
        let servers = self.key_servers(&old).await?;
        let mut new = new;
        // Keep every server under rotation/revocation, even where replacement fails (they keep the old line).
        new.deployed = servers.iter().map(|(id, _, _)| id.clone()).collect();
        let install = install_cmd(&line, &new.marker);
        let remove_old = remove_others_cmd(&new.marker);
        let results: Vec<ServerOpResult> = futures::stream::iter(servers)
            .map(|(id, name, switched)| {
                let (install, remove_old, new) = (install.clone(), remove_old.clone(), &new);
                async move {
                    let r = async {
                        self.run_cmd_ok(&id, &install).await?;
                        self.probe_with_identity(&id, &new.identity_id).await?;
                        if switched {
                            self.switch_to_identity(&id, &new.identity_id).await?;
                        }
                        self.run_cmd_ok(&id, &remove_old).await?;
                        Ok::<_, Error>(())
                    }
                    .await;
                    ServerOpResult { server_id: id, server_name: name, ok: r.is_ok(), error: r.err().map(|e| e.to_string()) }
                }
            })
            .buffered(CONCURRENCY)
            .collect()
            .await;
        // Earlier keys that some server still uses stay listed, so the next rotation or a revoke covers them.
        let mut retired = Vec::new();
        for id in old.retired.iter().chain(std::iter::once(&old.identity_id)) {
            if retired.contains(id) {
                continue;
            }
            let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE identity_id = ?").bind(id).fetch_one(&self.db).await?;
            if used > 0 {
                retired.push(id.clone());
            } else if id != &old.identity_id {
                sqlx::query("DELETE FROM identities WHERE id = ?").bind(id).execute(&self.db).await?;
            }
        }
        new.retired = retired;
        self.save_panel_state(Some(&new)).await?;
        self.retire_identity(&old.identity_id, "retired").await?;
        Ok(results)
    }

    /// The panel loses access to servers that rely on the panel key.
    pub async fn revoke_panel_key(&self) -> Result<Vec<ServerOpResult>> {
        let st = self.panel_state().await?.ok_or(Error::NotFound("panel key"))?;
        let servers = self.key_servers(&st).await?;
        let cmd = remove_cmd("");
        let results: Vec<ServerOpResult> = futures::stream::iter(servers)
            .map(|(id, name, _)| {
                let cmd = cmd.clone();
                async move {
                    let r = self.run_cmd_ok(&id, &cmd).await;
                    self.ssh.invalidate(&id).await;
                    ServerOpResult { server_id: id, server_name: name, ok: r.is_ok(), error: r.err().map(|e| e.to_string()) }
                }
            })
            .buffered(CONCURRENCY)
            .collect()
            .await;
        self.save_panel_state(None).await?;
        self.retire_identity(&st.identity_id, "revoked").await?;
        Ok(results)
    }

    async fn retire_identity(&self, id: &str, label: &str) -> Result<()> {
        let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE identity_id = ?").bind(id).fetch_one(&self.db).await?;
        if used == 0 {
            sqlx::query("DELETE FROM identities WHERE id = ?").bind(id).execute(&self.db).await?;
        } else {
            sqlx::query("UPDATE identities SET name = name || ' (' || ? || ')' WHERE id = ?")
                .bind(label)
                .bind(id)
                .execute(&self.db)
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_and_commands() {
        let line = authorized_line("ssh-ed25519 AAAAC3 nodepilot-panel-key:abc", &["203.0.113.10".into(), "10.0.0.0/8".into()]);
        assert_eq!(
            line,
            "from=\"203.0.113.10,10.0.0.0/8\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3 nodepilot-panel-key:abc"
        );
        assert!(valid_from("2001:db8::/32"));
        assert!(!valid_from("1.2.3.4\",command=\"x"));
        assert!(!valid_from("evil host"));
        let cmd = install_cmd(&line, "abc");
        assert!(cmd.contains("/nodepilot-panel-key:abc/d"));
        assert!(cmd.contains("'from=\"203.0.113.10,10.0.0.0/8\""));
        assert_eq!(
            remove_others_cmd("new1"),
            "if [ -f \"$HOME/.ssh/authorized_keys\" ]; then sed -i.nodepilot.bak '/nodepilot-panel-key:/{/nodepilot-panel-key:new1/!d;}' \"$HOME/.ssh/authorized_keys\"; fi"
        );
        assert_eq!(
            remove_cmd(""),
            "if [ -f \"$HOME/.ssh/authorized_keys\" ]; then sed -i.nodepilot.bak '/nodepilot-panel-key:/d' \"$HOME/.ssh/authorized_keys\"; fi"
        );
    }
}
