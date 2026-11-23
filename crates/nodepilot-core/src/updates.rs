use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures::StreamExt;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::bad;
use crate::models::Ts;
use crate::{App, Error, Result, now};

/// Baked in at release build time; without it updates stay disabled rather than guessing a repository.
pub const BUILTIN_REPO: Option<&str> = option_env!("NODEPILOT_UPDATE_REPO");
pub const BUILTIN_PUBKEY: Option<&str> = option_env!("NODEPILOT_UPDATE_PUBKEY");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const MAX_BINARY: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdateSettings {
    /// Check for updates in the background (every 6 hours). Installing is always manual.
    pub auto_check: bool,
    /// Include pre-releases (beta, rc).
    pub include_prereleases: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self { auto_check: true, include_prereleases: false }
    }
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UpdateSettingsInput {
    pub auto_check: Option<bool>,
    pub include_prereleases: Option<bool>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ReleaseInfo {
    pub version: String,
    pub tag: String,
    pub name: String,
    /// Release notes (Markdown).
    pub notes: String,
    pub url: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    /// Asset for this platform, if the release has one.
    pub asset: Option<String>,
    pub asset_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct UpdateInfo {
    pub current_version: String,
    /// `owner/name`; `null` if no update repository is configured.
    pub repo: Option<String>,
    /// Asset file name looked up in releases for this platform.
    pub platform_asset: String,
    pub latest: Option<ReleaseInfo>,
    pub update_available: bool,
    pub checked_at: Option<Ts>,
    pub error: Option<String>,
    /// Whether installing from here is possible; if not, `install_blocker` says why.
    pub can_install: bool,
    pub install_blocker: Option<String>,
    /// Signatures are verified (a public key is configured).
    pub signature_required: bool,
    pub settings: UpdateSettings,
    pub install: InstallStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    #[default]
    Idle,
    Downloading,
    Verifying,
    Installing,
    Restarting,
    Failed,
}

#[derive(Debug, Clone, Serialize, JsonSchema, Default)]
pub struct InstallStatus {
    pub phase: InstallPhase,
    pub version: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

type LastCheck = (Ts, std::result::Result<Option<ReleaseInfo>, String>);

#[derive(Default)]
pub struct Updater {
    last: Mutex<Option<LastCheck>>,
    install: Mutex<InstallStatus>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
}

/// `nodepilot-linux-x86_64`, `nodepilot-linux-aarch64`, `nodepilot-windows-x86_64.exe`…
pub fn platform_asset() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        o => o,
    };
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("nodepilot-{os}-{}{ext}", std::env::consts::ARCH)
}

fn parse_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("nodepilot-updater/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| Error::Internal(format!("http client: {e}")))
}

fn api_base() -> String {
    std::env::var("NODEPILOT_UPDATE_API_URL").unwrap_or_else(|_| "https://api.github.com".into()).trim_end_matches('/').to_owned()
}
fn download_base() -> String {
    std::env::var("NODEPILOT_UPDATE_DOWNLOAD_URL").unwrap_or_else(|_| "https://github.com".into()).trim_end_matches('/').to_owned()
}

fn in_container() -> bool {
    std::env::var_os("NODEPILOT_IN_DOCKER").is_some() || Path::new("/.dockerenv").exists()
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".nodepilot-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

impl App {
    fn update_repo(&self) -> Option<String> {
        std::env::var("NODEPILOT_UPDATE_REPO")
            .ok()
            .or(BUILTIN_REPO.map(str::to_owned))
            .map(|r| r.trim().to_owned())
            .filter(|r| r.split('/').count() == 2 && !r.starts_with('/') && !r.ends_with('/'))
    }

    fn update_pubkey(&self) -> Option<String> {
        std::env::var("NODEPILOT_UPDATE_PUBKEY").ok().filter(|k| !k.trim().is_empty()).or(BUILTIN_PUBKEY.map(str::to_owned))
    }

    pub async fn update_settings(&self) -> Result<UpdateSettings> {
        let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'updates'").fetch_optional(&self.db).await?;
        Ok(v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
    }

    pub async fn set_update_settings(&self, input: UpdateSettingsInput) -> Result<UpdateSettings> {
        let mut s = self.update_settings().await?;
        if let Some(v) = input.auto_check {
            s.auto_check = v;
        }
        if let Some(v) = input.include_prereleases {
            s.include_prereleases = v;
        }
        sqlx::query("INSERT INTO settings (key, value) VALUES ('updates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(serde_json::to_string(&s).unwrap())
            .execute(&self.db)
            .await?;
        // The release channel changed, so the cached check result is stale.
        self.updater.last.lock().unwrap().take();
        Ok(s)
    }

    async fn fetch_latest(&self, include_prereleases: bool) -> std::result::Result<Option<ReleaseInfo>, String> {
        let Some(repo) = self.update_repo() else {
            return Err("update repository is not configured (NODEPILOT_UPDATE_REPO)".into());
        };
        let url = format!("{}/repos/{repo}/releases?per_page=30", api_base());
        let resp = http()
            .map_err(|e| e.to_string())?
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("cannot reach GitHub: {e}"))?;
        match resp.status().as_u16() {
            200 => {}
            404 => return Err(format!("repository {repo} not found or has no releases yet")),
            403 | 429 => return Err("GitHub API rate limit reached, try again later".into()),
            s => return Err(format!("GitHub API returned HTTP {s}")),
        }
        let releases: Vec<GhRelease> = resp.json().await.map_err(|e| format!("unexpected GitHub response: {e}"))?;
        let wanted = platform_asset();
        let best = releases
            .into_iter()
            .filter(|r| !r.draft && (include_prereleases || !r.prerelease))
            .filter_map(|r| parse_version(&r.tag_name).map(|v| (v, r)))
            .filter(|(v, _)| include_prereleases || v.pre.is_empty())
            .max_by(|a, b| a.0.cmp(&b.0));
        Ok(best.map(|(v, r)| {
            let asset = r.assets.iter().find(|a| a.name == wanted);
            ReleaseInfo {
                version: v.to_string(),
                name: r.name.filter(|n| !n.is_empty()).unwrap_or_else(|| r.tag_name.clone()),
                tag: r.tag_name,
                notes: r.body.unwrap_or_default(),
                url: r.html_url,
                published_at: r.published_at,
                prerelease: r.prerelease,
                asset: asset.map(|a| a.name.clone()),
                asset_size: asset.map(|a| a.size),
            }
        }))
    }

    pub async fn update_info(&self, refresh: bool) -> Result<UpdateInfo> {
        let settings = self.update_settings().await?;
        let cached = self.updater.last.lock().unwrap().clone();
        let (checked_at, result) = match cached {
            Some(c) if !refresh => (Some(c.0), c.1),
            _ => {
                let r = self.fetch_latest(settings.include_prereleases).await;
                let at = now();
                *self.updater.last.lock().unwrap() = Some((at, r.clone()));
                (Some(at), r)
            }
        };
        let current = parse_version(VERSION).expect("crate version is semver");
        let (latest, error) = match result {
            Ok(l) => (l, None),
            Err(e) => (None, Some(e)),
        };
        let update_available = latest.as_ref().and_then(|l| parse_version(&l.version)).is_some_and(|v| v > current);

        let exe = std::env::current_exe().ok();
        let install_blocker = if in_container() {
            Some("running in a container: update by pulling the new image (docker pull / docker compose pull)".to_owned())
        } else if exe.as_deref().and_then(Path::parent).is_none_or(|d| !dir_writable(d)) {
            Some(format!(
                "the panel cannot write to {} — install it into a writable location (packaging/install.sh does this)",
                exe.as_deref().and_then(Path::parent).map(|d| d.display().to_string()).unwrap_or_default()
            ))
        } else if update_available && latest.as_ref().is_some_and(|l| l.asset.is_none()) {
            Some(format!("the release has no file {} for this platform", platform_asset()))
        } else {
            None
        };

        Ok(UpdateInfo {
            current_version: VERSION.to_owned(),
            repo: self.update_repo(),
            platform_asset: platform_asset(),
            update_available,
            can_install: update_available && install_blocker.is_none(),
            install_blocker,
            latest,
            checked_at,
            error,
            signature_required: self.update_pubkey().is_some(),
            settings,
            install: self.updater.install.lock().unwrap().clone(),
        })
    }

    pub fn install_status(&self) -> InstallStatus {
        self.updater.install.lock().unwrap().clone()
    }

    pub async fn start_update(&self) -> Result<InstallStatus> {
        let info = self.update_info(true).await?;
        if !info.update_available {
            return Err(Error::Conflict(format!("already up to date ({VERSION})")));
        }
        if let Some(b) = info.install_blocker {
            return Err(bad(b));
        }
        let release = info.latest.expect("update available implies a release");
        {
            let mut st = self.updater.install.lock().unwrap();
            if matches!(st.phase, InstallPhase::Downloading | InstallPhase::Verifying | InstallPhase::Installing | InstallPhase::Restarting)
            {
                return Err(Error::Conflict("an update is already in progress".into()));
            }
            *st = InstallStatus {
                phase: InstallPhase::Downloading,
                version: Some(release.version.clone()),
                downloaded: 0,
                total: release.asset_size,
                error: None,
            };
        }
        let app = self.clone();
        tokio::spawn(async move {
            if let Err(e) = app.do_update(&release).await {
                tracing::error!(error = %e, "update failed");
                let mut st = app.updater.install.lock().unwrap();
                st.phase = InstallPhase::Failed;
                st.error = Some(e.to_string());
            }
        });
        Ok(self.install_status())
    }

    async fn do_update(&self, release: &ReleaseInfo) -> Result<()> {
        let repo = self.update_repo().ok_or_else(|| bad("update repository is not configured"))?;
        let asset_name = release.asset.clone().ok_or_else(|| bad("no asset for this platform"))?;
        let base = format!("{}/{repo}/releases/download/{}", download_base(), release.tag);
        let client = http()?;
        let exe = std::env::current_exe().map_err(|e| Error::Internal(format!("cannot locate the running binary: {e}")))?;
        let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        let dir = exe.parent().ok_or_else(|| Error::Internal("binary has no parent directory".into()))?.to_owned();
        let tmp = dir.join(format!(".{asset_name}.download"));

        let sums = client
            .get(format!("{base}/SHA256SUMS"))
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| bad(format!("release has no SHA256SUMS: {e}")))?
            .text()
            .await
            .map_err(|e| Error::Internal(e.to_string()))?;
        let expected = sums
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                Some((it.next()?, it.next()?.trim_start_matches('*')))
            })
            .find(|(_, name)| *name == asset_name)
            .map(|(h, _)| h.to_lowercase())
            .ok_or_else(|| bad(format!("SHA256SUMS does not list {asset_name}")))?;

        let resp = client
            .get(format!("{base}/{asset_name}"))
            .timeout(Duration::from_secs(30 * 60))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| Error::Internal(format!("download failed: {e}")))?;
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::Internal(format!("download interrupted: {e}")))?;
            downloaded += chunk.len() as u64;
            if downloaded > MAX_BINARY {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(bad("downloaded file is too large"));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            self.updater.install.lock().unwrap().downloaded = downloaded;
        }
        file.sync_all().await?;
        drop(file);

        self.updater.install.lock().unwrap().phase = InstallPhase::Verifying;
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(bad(format!("checksum mismatch for {asset_name}: expected {expected}, got {actual}")));
        }

        if let Some(key) = self.update_pubkey() {
            let sig = client
                .get(format!("{base}/{asset_name}.sig"))
                .timeout(Duration::from_secs(60))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|e| bad(format!("release has no signature {asset_name}.sig: {e}")))?
                .bytes()
                .await
                .map_err(|e| Error::Internal(e.to_string()))?;
            let data = tokio::fs::read(&tmp).await?;
            if let Err(e) = verify_signature(&key, &data, &sig) {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
        }

        self.updater.install.lock().unwrap().phase = InstallPhase::Installing;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).await?;
        }
        let backup = exe.with_extension("old");
        let _ = tokio::fs::remove_file(&backup).await;
        tokio::fs::rename(&exe, &backup).await.map_err(|e| Error::Internal(format!("cannot move the current binary aside: {e}")))?;
        if let Err(e) = tokio::fs::rename(&tmp, &exe).await {
            let _ = tokio::fs::rename(&backup, &exe).await;
            return Err(Error::Internal(format!("cannot install the new binary: {e}")));
        }
        tracing::warn!(from = VERSION, to = %release.version, "update installed, restarting");
        self.updater.install.lock().unwrap().phase = InstallPhase::Restarting;

        // Give the response time to reach the client before exec'ing the new binary.
        tokio::time::sleep(Duration::from_millis(800)).await;
        restart(&exe)
    }
}

pub fn verify_signature(pubkey_b64: &str, data: &[u8], sig: &[u8]) -> Result<()> {
    let key: [u8; 32] = B64
        .decode(pubkey_b64.trim())
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| Error::Internal("update public key must be 32 bytes, base64".into()))?;
    let raw: Vec<u8> = if sig.len() == 64 { sig.to_vec() } else { B64.decode(String::from_utf8_lossy(sig).trim()).unwrap_or_default() };
    let sig: [u8; 64] = raw.try_into().map_err(|_| bad("invalid signature file"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| Error::Internal("invalid update public key".into()))?;
    key.verify_strict(data, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| bad("signature verification failed — the file was not signed by the official key"))
}

/// Set for the process started by a self-update that cannot `exec` (Windows): its port may still be held briefly.
pub const BIND_RETRY_ENV: &str = "NODEPILOT_BIND_RETRY";

fn restart(exe: &PathBuf) -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // exec keeps the PID, which systemd expects; sockets are CLOEXEC so they close.
        let err = std::process::Command::new(exe).args(&args).exec();
        Err(Error::Internal(format!("restart failed: {err}")))
    }
    #[cfg(not(unix))]
    {
        std::process::Command::new(exe)
            .args(&args)
            .env(BIND_RETRY_ENV, "1")
            .spawn()
            .map_err(|e| Error::Internal(format!("restart failed: {e}")))?;
        std::process::exit(0)
    }
}

pub fn spawn_checker(app: App) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if app.update_repo().is_some() && app.update_settings().await.is_ok_and(|s| s.auto_check) {
                match app.update_info(true).await {
                    Ok(i) if i.update_available => {
                        tracing::info!(current = VERSION, latest = ?i.latest.map(|l| l.version), "a new NodePilot version is available")
                    }
                    Ok(i) => {
                        if let Some(e) = i.error {
                            tracing::debug!(error = %e, "update check failed");
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "update check failed"),
                }
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_assets() {
        assert!(parse_version("v0.2.0").unwrap() > parse_version("0.1.9").unwrap());
        assert!(parse_version("v1.0.0-rc.1").unwrap() < parse_version("1.0.0").unwrap());
        assert!(parse_version("latest").is_none());
        assert!(platform_asset().starts_with("nodepilot-"));
    }

    #[test]
    fn signatures() {
        use ed25519_dalek::{Signer, SigningKey};
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = B64.encode(sk.verifying_key().to_bytes());
        let data = b"binary contents";
        let sig = sk.sign(data).to_bytes();
        assert!(verify_signature(&pk, data, &sig).is_ok());
        assert!(verify_signature(&pk, data, B64.encode(sig).as_bytes()).is_ok(), "base64 signature file");
        assert!(verify_signature(&pk, b"tampered", &sig).is_err());
    }
}
