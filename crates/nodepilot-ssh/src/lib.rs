mod conn;
pub mod manage;
mod pool;
pub mod stats;

use std::time::Duration;

pub use conn::{Connection, ExecOutput, Shell};
pub use pool::{Hold, PoolConfig, SshPool};
pub use russh::client::Msg as ClientMsg;
pub use russh::{ChannelMsg, ChannelWriteHalf};
pub use russh_sftp;
pub use russh_sftp::client::SftpSession;

#[derive(Clone)]
pub struct ConnectSpec {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Expected host key fingerprint (`SHA256:...`). `None` trusts on first use (TOFU).
    pub host_key: Option<String>,
    pub connect_timeout: Duration,
}

impl ConnectSpec {
    /// Changes when connection settings change, so the pool reconnects after a server edit.
    pub(crate) fn identity(&self) -> String {
        format!("{}@{}:{}#{}", self.username, self.host, self.port, self.auth.kind())
    }
}

#[derive(Clone)]
pub enum AuthMethod {
    Password(String),
    Key { private_key: String, passphrase: Option<String> },
}

impl AuthMethod {
    fn kind(&self) -> &'static str {
        match self {
            AuthMethod::Password(_) => "password",
            AuthMethod::Key { .. } => "key",
        }
    }
}

// Never print secrets in logs.
impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.kind())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("connection timed out")]
    Timeout,
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("host key mismatch: expected {expected}, got {actual} (possible MITM; reset the pinned key if the server was reinstalled)")]
    HostKeyMismatch { expected: String, actual: String },
    #[error("authentication failed")]
    AuthFailed,
    #[error("invalid private key: {0}")]
    BadKey(String),
    #[error("ssh: {0}")]
    Ssh(#[from] russh::Error),
    #[error("sftp: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("command timed out after {0:?}")]
    CommandTimeout(Duration),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn check_private_key(pem: &str, passphrase: Option<&str>) -> Result<()> {
    russh::keys::decode_secret_key(pem, passphrase).map(|_| ()).map_err(|e| Error::BadKey(e.to_string()))
}

pub fn generate_ed25519(seed: &[u8; 32], comment: &str) -> Result<(String, String)> {
    use russh::keys::ssh_key::{LineEnding, PrivateKey, private::Ed25519Keypair};
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(seed));
    key.set_comment(comment);
    let private = key.to_openssh(LineEnding::LF).map_err(|e| Error::Other(e.to_string()))?.to_string();
    let public = key.public_key().to_openssh().map_err(|e| Error::Other(e.to_string()))?;
    Ok((private, public))
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn keygen() {
        let (private, public) = super::generate_ed25519(&[9u8; 32], "nodepilot-panel-key:abc").unwrap();
        assert!(private.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(public.starts_with("ssh-ed25519 AAAA") && public.ends_with(" nodepilot-panel-key:abc"));
        assert!(super::check_private_key(&private, None).is_ok());
    }

    #[test]
    fn quoting() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }
}
