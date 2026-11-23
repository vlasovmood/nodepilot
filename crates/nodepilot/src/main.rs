use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use nodepilot_core::access::Permissions;
use nodepilot_core::models::{Credentials, TokenInput};
use nodepilot_core::{App, Config};
use tracing_subscriber::EnvFilter;

/// NodePilot: a self-hosted server management panel with access for AI agents.
#[derive(Parser)]
#[command(name = "nodepilot", version, about)]
struct Cli {
    #[command(flatten)]
    common: Common,
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Common {
    /// Data directory: database, master key, local backups.
    #[arg(long, global = true, env = "NODEPILOT_DATA", default_value = "data")]
    data_dir: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Run the web panel (UI + REST API + MCP over HTTP).
    Serve {
        #[arg(long, env = "NODEPILOT_LISTEN", default_value = "127.0.0.1:7780")]
        listen: SocketAddr,
        /// Stats polling interval, in seconds.
        #[arg(long, env = "NODEPILOT_STATS_INTERVAL", default_value_t = 30)]
        stats_interval: u64,
        /// How many days to keep metrics history.
        #[arg(long, env = "NODEPILOT_METRICS_RETENTION_DAYS", default_value_t = 7)]
        metrics_retention_days: u32,
        /// Set the Secure flag on cookies (enable when the panel is behind HTTPS).
        #[arg(long, env = "NODEPILOT_SECURE_COOKIES")]
        secure_cookies: bool,
        /// Allowed CORS origins for third-party web clients, comma-separated: https://app.example.com,https://admin.example.com
        #[arg(long, env = "NODEPILOT_CORS_ORIGINS", value_delimiter = ',')]
        cors_origins: Vec<String>,
        /// Reverse proxies on other hosts whose X-Forwarded-For is trusted, comma-separated IPs or CIDRs
        /// (loopback is always trusted): 10.0.0.5,192.168.1.0/24
        #[arg(long, env = "NODEPILOT_TRUSTED_PROXIES", value_delimiter = ',', value_parser = parse_net)]
        trusted_proxies: Vec<ipnet::IpNet>,
    },
    /// Run an MCP server on stdio (for Claude, Cursor, etc.) using the same database.
    Mcp {
        /// Limit permissions to those of this API token (default: full access).
        #[arg(long, env = "NODEPILOT_TOKEN")]
        token: Option<String>,
    },
    /// Manage panel users.
    #[command(subcommand)]
    User(UserCmd),
    /// API tokens for CLI, MCP and agents.
    #[command(subcommand)]
    Token(TokenCmd),
}

#[derive(Subcommand)]
enum UserCmd {
    /// Create a user.
    Create {
        username: String,
        #[arg(long, env = "NODEPILOT_PASSWORD")]
        password: String,
    },
    /// Reset 2FA (lost phone and recovery codes). Ends all of the user's sessions.
    #[command(name = "reset-2fa", alias = "reset2fa")]
    Reset2fa { username: String },
    /// Change the password (ends all of the user's sessions).
    Passwd {
        username: String,
        #[arg(long, env = "NODEPILOT_PASSWORD")]
        password: String,
    },
}

#[derive(Subcommand)]
enum TokenCmd {
    /// Issue an API token (printed only once).
    Create {
        #[arg(long)]
        user: String,
        #[arg(long)]
        name: String,
        /// Read-only (no command execution or administration).
        #[arg(long)]
        read_only: bool,
        /// Lifetime in days (0 = never expires).
        #[arg(long, default_value_t = 0)]
        expires_in_days: u32,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Log to stderr: in MCP mode stdout carries the protocol.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn,russh=warn".into()))
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let mut config = Config { data_dir: cli.common.data_dir, ..Config::default() };
    if let Command::Serve { stats_interval, metrics_retention_days, secure_cookies, cors_origins, trusted_proxies, .. } = &cli.command {
        config.cors_origins = cors_origins.clone();
        config.trusted_proxies = trusted_proxies.clone();
        config.stats_interval = Duration::from_secs((*stats_interval).max(5));
        config.metrics_retention_days = *metrics_retention_days;
        config.secure_cookies = *secure_cookies;
    }
    let data_dir = config.data_dir.clone();
    if !matches!(cli.command, Command::Serve { .. })
        && let Some(code) = run_with_sealed_key(&data_dir)?
    {
        std::process::exit(code);
    }
    let app = App::open(config).await.with_context(|| format!("cannot open data directory {}", data_dir.display()))?;

    match cli.command {
        Command::Serve { listen, .. } => {
            if app.setup_required().await? {
                tracing::warn!("no users yet — open http://{listen} to create the administrator account");
            }
            app.spawn_background();
            nodepilot_web::serve(listen, app).await.with_context(|| {
                format!("cannot start the panel on {listen} (port in use? choose another one with --listen or NODEPILOT_LISTEN)")
            })?;
        }
        Command::Mcp { token } => {
            let principal = match token {
                Some(t) => app.authenticate(&t).await.context("invalid API token")?,
                None => app.local_principal().await?,
            };
            nodepilot_mcp::serve_stdio(app, principal).await?
        }
        Command::User(UserCmd::Create { username, password }) => {
            let user = app.create_user(&Credentials { username, password, code: None }).await?;
            println!("created user {}", user.username);
        }
        Command::User(UserCmd::Reset2fa { username }) => {
            app.reset_two_factor(&username).await?;
            println!("two-factor authentication disabled for {username}");
        }
        Command::User(UserCmd::Passwd { username, password }) => {
            app.set_password(&username, &password).await?;
            println!("password updated for {username}");
        }
        Command::Token(TokenCmd::Create { user, name, read_only, expires_in_days }) => {
            let issuer = app.user_principal(&user).await.with_context(|| format!("user {user} not found"))?;
            let permissions = Some(if read_only { Permissions::read_only() } else { Permissions::full() });
            let input = TokenInput { name: Some(name), permissions, expires_in_days: Some(expires_in_days) };
            let (token, _) = app.create_api_token(&issuer, input).await?;
            println!("{token}");
        }
    }
    Ok(())
}

/// An IP address or a CIDR network.
fn parse_net(s: &str) -> Result<ipnet::IpNet, String> {
    let s = s.trim();
    s.parse::<ipnet::IpNet>()
        .or_else(|_| s.parse::<std::net::IpAddr>().map(ipnet::IpNet::from))
        .map_err(|_| format!("expected an IP address or CIDR, got '{s}'"))
}

/// Set on the copy started by `systemd-run`, so it never re-runs itself again.
const SEALED_REEXEC_ENV: &str = "NODEPILOT_SEALED_REEXEC";
/// Where `packaging/seal-master-key.sh` puts the TPM-sealed key.
const DEFAULT_SEALED_KEY: &str = "/etc/nodepilot/master.key.cred";

/// After `seal-master-key.sh`, only systemd can decrypt the master key. CLI commands started from a shell
/// (`user`, `token`, `mcp`) therefore run themselves again through `systemd-run`, with the credential attached
/// and as the owner of the data directory, so database files keep the service's ownership.
/// Returns the exit code of that run, or `None` when the key is available directly.
fn run_with_sealed_key(data_dir: &Path) -> anyhow::Result<Option<i32>> {
    if std::env::var_os("CREDENTIALS_DIRECTORY").is_some()
        || std::env::var_os("NODEPILOT_MASTER_KEY_FILE").is_some()
        || std::env::var_os(SEALED_REEXEC_ENV).is_some()
        || data_dir.join("master.key").exists()
    {
        return Ok(None);
    }
    let cred = std::env::var_os("NODEPILOT_MASTER_KEY_CRED").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(DEFAULT_SEALED_KEY));
    if !cfg!(target_os = "linux") || !cred.exists() {
        return Ok(None);
    }
    let Some((euid, owner)) = uids(data_dir) else { return Ok(None) };
    if euid != 0 {
        anyhow::bail!("the master key is sealed in the TPM ({}); run this command with sudo", cred.display());
    }
    let args =
        sealed_key_command(owner, &std::env::current_dir()?, &cred, std::env::current_exe()?.as_os_str(), std::env::args_os().skip(1));
    let status = std::process::Command::new("systemd-run")
        .args(&args)
        .status()
        .context("cannot run systemd-run to decrypt the sealed master key")?;
    Ok(Some(status.code().unwrap_or(1)))
}

/// Arguments for `systemd-run` that run `exe args` with the sealed key as a credential.
fn sealed_key_command(uid: u32, cwd: &Path, cred: &Path, exe: &std::ffi::OsStr, args: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut out: Vec<OsString> = ["--quiet", "--wait", "--pipe", "--collect", "--service-type=exec"].map(OsString::from).into();
    out.push(format!("--uid={uid}").into());
    out.push(format!("--working-directory={}", cwd.display()).into());
    out.push(format!("--property=LoadCredentialEncrypted=master.key:{}", cred.display()).into());
    out.push(format!("--setenv={SEALED_REEXEC_ENV}=1").into());
    out.push("--".into());
    out.push(exe.to_owned());
    out.extend(args);
    out
}

/// (effective uid of this process, owner of the data directory).
#[cfg(unix)]
fn uids(data_dir: &Path) -> Option<(u32, u32)> {
    use std::os::unix::fs::MetadataExt;
    Some((std::fs::metadata("/proc/self").ok()?.uid(), std::fs::metadata(data_dir).ok()?.uid()))
}

#[cfg(not(unix))]
fn uids(_: &Path) -> Option<(u32, u32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_key_reexec_arguments() {
        let args = sealed_key_command(
            997,
            Path::new("/root"),
            Path::new("/etc/nodepilot/master.key.cred"),
            std::ffi::OsStr::new("/var/lib/nodepilot/bin/nodepilot"),
            ["user", "reset-2fa", "admin"].map(OsString::from),
        );
        let args: Vec<String> = args.into_iter().map(|a| a.into_string().unwrap()).collect();
        let expected = [
            "--quiet --wait --pipe --collect --service-type=exec --uid=997 --working-directory=/root",
            "--property=LoadCredentialEncrypted=master.key:/etc/nodepilot/master.key.cred --setenv=NODEPILOT_SEALED_REEXEC=1",
            "-- /var/lib/nodepilot/bin/nodepilot user reset-2fa admin",
        ];
        assert_eq!(args.join(" "), expected.join(" "));
    }

    #[test]
    fn trusted_proxy_values() {
        assert_eq!(parse_net("10.0.0.5").unwrap().to_string(), "10.0.0.5/32");
        assert_eq!(parse_net(" 192.168.1.0/24 ").unwrap().to_string(), "192.168.1.0/24");
        assert!(parse_net("proxy.local").is_err());
    }
}
