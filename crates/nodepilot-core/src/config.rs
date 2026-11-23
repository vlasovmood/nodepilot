use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub stats_interval: Duration,
    pub stats_concurrency: usize,
    pub metrics_retention_days: u32,
    pub secure_cookies: bool,
    /// Exact origins, e.g. `https://app.example.com`.
    pub cors_origins: Vec<String>,
    /// Reverse proxies (besides loopback) whose `X-Forwarded-For` is trusted for the client address.
    pub trusted_proxies: Vec<ipnet::IpNet>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("data"),
            stats_interval: Duration::from_secs(30),
            stats_concurrency: 32,
            metrics_retention_days: 7,
            secure_cookies: false,
            cors_origins: Vec::new(),
            trusted_proxies: Vec::new(),
        }
    }
}

impl Config {
    /// Loopback is always trusted; other proxies only when configured.
    pub fn is_trusted_proxy(&self, ip: std::net::IpAddr) -> bool {
        ip.is_loopback() || self.trusted_proxies.iter().any(|n| n.contains(&ip))
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("nodepilot.db")
    }
    pub fn master_key_path(&self) -> PathBuf {
        self.data_dir.join("master.key")
    }
    pub fn local_backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }
}
