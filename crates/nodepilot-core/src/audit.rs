use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::access::Principal;
use crate::error::bad;
use crate::models::Ts;
use crate::{App, Result, now};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    #[default]
    Info,
    Warning,
    Critical,
}

impl Severity {
    fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
    /// RFC 5424 severity.
    fn syslog_level(self) -> u8 {
        match self {
            Severity::Info => 6,
            Severity::Warning => 4,
            Severity::Critical => 2,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AuditEvent {
    pub severity: Severity,
    pub actor: String,
    pub token: Option<String>,
    pub ip: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub details: Option<Value>,
    pub outcome: String,
}

impl AuditEvent {
    pub fn new(principal: Option<&Principal>, action: impl Into<String>) -> Self {
        Self {
            actor: principal.map(|p| p.user.username.clone()).unwrap_or_else(|| "-".into()),
            token: principal.and_then(|p| p.token.as_ref().map(|t| t.name.clone())),
            ip: principal.and_then(|p| p.ip.clone()),
            action: action.into(),
            outcome: "ok".into(),
            ..Default::default()
        }
    }
    pub fn severity(mut self, s: Severity) -> Self {
        self.severity = s;
        self
    }
    pub fn target(mut self, t: impl Into<String>) -> Self {
        self.target = Some(t.into());
        self
    }
    pub fn details(mut self, mut v: Value) -> Self {
        redact(&mut v);
        self.details = Some(v);
        self
    }
    pub fn outcome(mut self, o: impl Into<String>) -> Self {
        self.outcome = o.into();
        self
    }
    pub fn ip(mut self, ip: Option<String>) -> Self {
        self.ip = ip;
        self
    }
}

pub fn redact(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let k = k.to_lowercase();
                let sensitive = k == "token" || ["password", "passphrase", "secret", "private_key"].iter().any(|s| k.contains(s));
                if sensitive && !val.is_null() {
                    *val = Value::String("***".into());
                } else {
                    redact(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow, JsonSchema)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: Ts,
    pub severity: String,
    pub actor: String,
    pub token: Option<String>,
    pub ip: Option<String>,
    pub action: String,
    pub target: Option<String>,
    /// JSON string with details (secrets redacted).
    pub details: Option<String>,
    pub outcome: String,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct AuditFilter {
    pub actor: Option<String>,
    /// Substring of the action or target.
    pub q: Option<String>,
    /// Minimum severity.
    pub severity: Option<Severity>,
    /// Only entries before this id (for paging backwards).
    pub before_id: Option<i64>,
    /// Default 200, max 1000.
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AuditSettings {
    /// `udp://host:514` or `tcp://host:514`.
    pub syslog: Option<String>,
    /// URL that receives each event as a JSON POST.
    pub webhook_url: Option<String>,
    /// Whether a webhook signing secret is set (header `X-NodePilot-Signature: sha256=<hmac>`).
    #[serde(default)]
    pub webhook_secret_set: bool,
    /// Forward only events at or above this severity.
    pub min_severity: Severity,
    /// How many days the panel keeps the log.
    pub retention_days: u32,
}

impl Default for AuditSettings {
    fn default() -> Self {
        Self { syslog: None, webhook_url: None, webhook_secret_set: false, min_severity: Severity::Info, retention_days: 180 }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct AuditSettingsInput {
    /// Empty string disables it.
    pub syslog: Option<String>,
    pub webhook_url: Option<String>,
    /// HMAC signing secret; empty string removes it.
    pub webhook_secret: Option<String>,
    pub min_severity: Option<Severity>,
    pub retention_days: Option<u32>,
}

#[derive(Serialize, Deserialize, Default)]
struct StoredSettings {
    #[serde(default)]
    public: AuditSettings,
    #[serde(default)]
    webhook_secret_enc: Option<String>,
}

fn validate_syslog(s: &str) -> Result<()> {
    let rest = s
        .strip_prefix("udp://")
        .or_else(|| s.strip_prefix("tcp://"))
        .ok_or_else(|| bad("syslog must be udp://host:port or tcp://host:port"))?;
    if rest.rsplit_once(':').and_then(|(_, p)| p.parse::<u16>().ok()).is_none() {
        return Err(bad("syslog address must include a port, e.g. udp://10.0.0.5:514"));
    }
    Ok(())
}

impl App {
    async fn audit_stored(&self) -> StoredSettings {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'audit'").fetch_optional(&self.db).await.ok().flatten();
        raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default()
    }

    pub async fn audit_settings(&self) -> AuditSettings {
        let st = self.audit_stored().await;
        let mut s = st.public;
        s.webhook_secret_set = st.webhook_secret_enc.is_some();
        s
    }

    pub async fn set_audit_settings(&self, input: AuditSettingsInput) -> Result<AuditSettings> {
        let mut st = self.audit_stored().await;
        let mut s = std::mem::take(&mut st.public);
        if let Some(v) = input.syslog {
            let v = v.trim().to_owned();
            if !v.is_empty() {
                validate_syslog(&v)?;
            }
            s.syslog = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = input.webhook_url {
            let v = v.trim().to_owned();
            if !v.is_empty() && !(v.starts_with("https://") || v.starts_with("http://")) {
                return Err(bad("webhook_url must be an http(s) URL"));
            }
            s.webhook_url = (!v.is_empty()).then_some(v);
        }
        if let Some(v) = input.webhook_secret {
            st.webhook_secret_enc = self.secrets.encrypt_opt(Some(&v));
        }
        if let Some(v) = input.min_severity {
            s.min_severity = v;
        }
        if let Some(v) = input.retention_days {
            s.retention_days = v.clamp(7, 3650);
        }
        st.public = s;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('audit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(serde_json::to_string(&st).unwrap())
            .execute(&self.db)
            .await?;
        Ok(self.audit_settings().await)
    }

    pub fn audit(&self, ev: AuditEvent) {
        let app = self.clone();
        tokio::spawn(async move {
            let ts = now();
            let details = ev.details.as_ref().map(|d| d.to_string());
            let r = sqlx::query(
                "INSERT INTO audit_log (ts, severity, actor, token, ip, action, target, details, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(ts)
            .bind(ev.severity.as_str())
            .bind(&ev.actor)
            .bind(&ev.token)
            .bind(&ev.ip)
            .bind(&ev.action)
            .bind(&ev.target)
            .bind(&details)
            .bind(&ev.outcome)
            .execute(&app.db)
            .await;
            if let Err(e) = r {
                tracing::error!(error = %e, "cannot write audit log");
            }
            app.forward_audit(&ev, ts).await;
        });
    }

    async fn forward_audit(&self, ev: &AuditEvent, ts: Ts) {
        let st = self.audit_stored().await;
        let s = &st.public;
        if ev.severity < s.min_severity || (s.syslog.is_none() && s.webhook_url.is_none()) {
            return;
        }
        let payload = serde_json::json!({
            "ts": ts, "severity": ev.severity.as_str(), "actor": ev.actor, "token": ev.token, "ip": ev.ip,
            "action": ev.action, "target": ev.target, "details": ev.details, "outcome": ev.outcome,
            "source": "nodepilot",
        });
        if let Some(addr) = &s.syslog
            && let Err(e) = send_syslog(addr, ev.severity, &payload.to_string()).await
        {
            tracing::warn!(error = %e, "audit syslog forwarding failed");
        }
        if let Some(url) = &s.webhook_url {
            let secret = st.webhook_secret_enc.as_deref().and_then(|e| self.secrets.decrypt(e).ok());
            if let Err(e) = send_webhook(url, secret.as_deref(), &payload).await {
                tracing::warn!(error = %e, "audit webhook forwarding failed");
            }
        }
    }

    pub async fn test_audit_forwarding(&self) -> Result<Vec<String>> {
        let st = self.audit_stored().await;
        let s = &st.public;
        let payload =
            serde_json::json!({ "ts": now(), "severity": "info", "action": "audit:test", "source": "nodepilot", "outcome": "ok" });
        let mut errors = Vec::new();
        if s.syslog.is_none() && s.webhook_url.is_none() {
            return Err(bad("no forwarding destination is configured"));
        }
        if let Some(addr) = &s.syslog
            && let Err(e) = send_syslog(addr, Severity::Info, &payload.to_string()).await
        {
            errors.push(format!("syslog: {e}"));
        }
        if let Some(url) = &s.webhook_url {
            let secret = st.webhook_secret_enc.as_deref().and_then(|e| self.secrets.decrypt(e).ok());
            if let Err(e) = send_webhook(url, secret.as_deref(), &payload).await {
                errors.push(format!("webhook: {e}"));
            }
        }
        Ok(errors)
    }

    pub async fn list_audit(&self, f: &AuditFilter) -> Result<Vec<AuditEntry>> {
        let limit = f.limit.unwrap_or(200).clamp(1, 1000) as i64;
        let min = match f.severity.unwrap_or_default() {
            Severity::Info => 0,
            Severity::Warning => 1,
            Severity::Critical => 2,
        };
        let q = f.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| format!("%{q}%"));
        Ok(sqlx::query_as(
            "SELECT id, ts, severity, actor, token, ip, action, target, details, outcome FROM audit_log
             WHERE (?1 IS NULL OR actor = ?1)
               AND (?2 IS NULL OR action LIKE ?2 OR target LIKE ?2 OR details LIKE ?2)
               AND (CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) >= ?3
               AND (?4 IS NULL OR id < ?4)
             ORDER BY id DESC LIMIT ?5",
        )
        .bind(&f.actor)
        .bind(&q)
        .bind(min)
        .bind(f.before_id)
        .bind(limit)
        .fetch_all(&self.db)
        .await?)
    }

    async fn purge_audit(&self) -> Result<()> {
        let days = self.audit_settings().await.retention_days.max(7) as i64;
        sqlx::query("DELETE FROM audit_log WHERE ts < ?").bind(now() - chrono::Duration::days(days)).execute(&self.db).await?;
        Ok(())
    }
}

async fn send_syslog(addr: &str, sev: Severity, msg: &str) -> std::io::Result<()> {
    // Facility 10 (authpriv). RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APP PROCID MSGID SD MSG
    let host = std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| "nodepilot".into());
    let line = format!("<{}>1 {} {host} nodepilot {} audit - {msg}", 10 * 8 + sev.syslog_level(), now().to_rfc3339(), std::process::id());
    let fut = async {
        if let Some(a) = addr.strip_prefix("udp://") {
            let sock = tokio::net::UdpSocket::bind("0.0.0.0:0").await?;
            sock.send_to(line.as_bytes(), a).await?;
        } else if let Some(a) = addr.strip_prefix("tcp://") {
            use tokio::io::AsyncWriteExt;
            let mut s = tokio::net::TcpStream::connect(a).await?;
            // Octet counting (RFC 6587)
            s.write_all(format!("{} {line}", line.len()).as_bytes()).await?;
            s.flush().await?;
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(5), fut).await.unwrap_or_else(|_| Err(std::io::Error::other("timed out")))
}

async fn send_webhook(url: &str, secret: Option<&str>, payload: &Value) -> std::result::Result<(), String> {
    let body = payload.to_string();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let mut req = client.post(url).header("content-type", "application/json").header("user-agent", "nodepilot-audit");
    if let Some(secret) = secret {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
        mac.update(body.as_bytes());
        req = req.header("X-NodePilot-Signature", format!("sha256={}", hex::encode(mac.finalize().into_bytes())));
    }
    let resp = req.body(body).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

pub fn spawn_purger(app: App) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        loop {
            tick.tick().await;
            if let Err(e) = app.purge_audit().await {
                tracing::warn!(error = %e, "audit purge failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secrets() {
        let mut v = serde_json::json!({ "name": "web", "auth": { "type": "password", "password": "hunter2" },
            "items": [{ "private_key": "-----BEGIN" }], "source": { "passphrase": "x", "database": "app" }, "token_name": "ci", "token": "np_x" });
        redact(&mut v);
        assert_eq!(v["auth"]["password"], "***");
        assert_eq!(v["items"][0]["private_key"], "***");
        assert_eq!(v["source"]["passphrase"], "***");
        assert_eq!(v["source"]["database"], "app");
        assert_eq!(v["name"], "web");
        assert_eq!(v["token_name"], "ci");
        assert_eq!(v["token"], "***");
    }
}
