use std::path::Path;

use schemars::JsonSchema;
use serde::Serialize;

use crate::crypto::KeySource;
use crate::totp::TwoFactorStatus;
use crate::{App, Result};

#[derive(Debug, Serialize, JsonSchema)]
pub struct SecurityStatus {
    pub master_key: KeySource,
    /// TPM 2.0 is present (`/dev/tpmrm0`).
    pub tpm_available: bool,
    /// `systemd-creds` is installed (needed to seal the key into the TPM).
    pub systemd_creds_available: bool,
    /// 2FA status of the current user.
    pub two_factor: TwoFactorStatus,
    pub panel_key_configured: bool,
    pub panel_key_from_restricted: bool,
    pub servers_total: i64,
    pub servers_on_panel_key: i64,
    pub backup_jobs_total: i64,
    pub backup_jobs_unencrypted: i64,
    /// Encrypted with a passphrase stored in the panel (recoverable if the panel is compromised).
    pub backup_jobs_passphrase: i64,
    /// Encrypted to public keys; the panel cannot decrypt them.
    pub backup_jobs_recipients: i64,
    pub api_tokens_total: i64,
    pub api_tokens_full_access: i64,
    pub api_tokens_without_expiry: i64,
    pub audit_forwarding: bool,
    pub secure_cookies: bool,
}

impl App {
    pub async fn security_status(&self, user_id: &str) -> Result<SecurityStatus> {
        let pk = self.panel_key_info().await?;
        let jobs: Vec<(Option<String>, bool)> = sqlx::query_as("SELECT encryption, encrypt FROM backup_jobs").fetch_all(&self.db).await?;
        let mode = |(m, e): &(Option<String>, bool)| m.clone().unwrap_or_else(|| if *e { "passphrase".into() } else { "none".into() });
        let count = |want: &str| jobs.iter().filter(|j| mode(j) == want).count() as i64;
        let tokens: Vec<(Option<String>, Option<crate::models::Ts>)> =
            sqlx::query_as("SELECT permissions, expires_at FROM tokens WHERE kind = 'api'").fetch_all(&self.db).await?;
        let full = tokens.iter().filter(|(p, _)| p.as_deref().is_none_or(|p| p.contains("\"full\":true"))).count() as i64;
        let audit = self.audit_settings().await;
        Ok(SecurityStatus {
            master_key: self.secrets.source.clone(),
            tpm_available: Path::new("/dev/tpmrm0").exists() || Path::new("/dev/tpm0").exists(),
            systemd_creds_available: ["/usr/bin/systemd-creds", "/bin/systemd-creds"].iter().any(|p| Path::new(p).exists()),
            two_factor: self.two_factor_status(user_id).await?,
            panel_key_configured: pk.configured,
            panel_key_from_restricted: !pk.allowed_from.is_empty(),
            servers_total: pk.servers_total,
            servers_on_panel_key: pk.servers_using,
            backup_jobs_total: jobs.len() as i64,
            backup_jobs_unencrypted: count("none"),
            backup_jobs_passphrase: count("passphrase"),
            backup_jobs_recipients: count("recipients"),
            api_tokens_total: tokens.len() as i64,
            api_tokens_full_access: full,
            api_tokens_without_expiry: tokens.iter().filter(|(_, e)| e.is_none()).count() as i64,
            audit_forwarding: audit.syslog.is_some() || audit.webhook_url.is_some(),
            secure_cookies: self.config.secure_cookies,
        })
    }
}
