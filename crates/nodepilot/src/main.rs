use std::net::SocketAddr;
use std::path::PathBuf;
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
    if let Command::Serve { stats_interval, metrics_retention_days, secure_cookies, cors_origins, .. } = &cli.command {
        config.cors_origins = cors_origins.clone();
        config.stats_interval = Duration::from_secs((*stats_interval).max(5));
        config.metrics_retention_days = *metrics_retention_days;
        config.secure_cookies = *secure_cookies;
    }
    let data_dir = config.data_dir.clone();
    let app = App::open(config).await.with_context(|| format!("cannot open data directory {}", data_dir.display()))?;

    match cli.command {
        Command::Serve { listen, .. } => {
            if app.setup_required().await? {
                tracing::warn!("no users yet — open http://{listen} to create the administrator account");
            }
            app.spawn_background();
            nodepilot_web::serve(listen, app).await.with_context(|| {
                format!("не удалось запустить панель на {listen} (порт занят? укажите другой через --listen или NODEPILOT_LISTEN)")
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
