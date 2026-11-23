use schemars::JsonSchema;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::{AuthMethod, ConnectSpec, Error, Result};

/// OpenSSH defaults to MaxSessions=10; leave headroom for terminals and SFTP.
const EXEC_CHANNELS_PER_CONN: usize = 6;

pub(crate) struct ClientHandler {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
        };
        let ok = self.expected.as_ref().is_none_or(|e| *e == fp);
        *self.seen.lock().unwrap() = Some(fp);
        Ok(ok)
    }
}

pub struct Connection {
    handle: Handle<ClientHandler>,
    host_key: String,
    exec_slots: Semaphore,
    sftp: AsyncMutex<Option<Arc<SftpSession>>>,
    pub(crate) identity: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ExecOutput {
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub truncated: bool,
}

impl Connection {
    pub async fn connect(spec: &ConnectSpec, config: Arc<client::Config>) -> Result<Self> {
        let seen = Arc::new(Mutex::new(None));
        let handler = ClientHandler { expected: spec.host_key.clone(), seen: seen.clone() };

        let connecting = client::connect(config, (spec.host.as_str(), spec.port), handler);
        let result = tokio::time::timeout(spec.connect_timeout, connecting).await.map_err(|_| Error::Timeout)?;
        let seen = seen.lock().unwrap().clone();

        let mut handle = match result {
            Ok(h) => h,
            Err(e) => {
                if let (Some(expected), Some(actual)) = (&spec.host_key, &seen)
                    && expected != actual
                {
                    return Err(Error::HostKeyMismatch { expected: expected.clone(), actual: actual.clone() });
                }
                return Err(Error::Connect(e.to_string()));
            }
        };
        let host_key = seen.ok_or_else(|| Error::Connect("server did not present a host key".into()))?;

        let auth = match &spec.auth {
            AuthMethod::Password(password) => handle.authenticate_password(&spec.username, password).await?,
            AuthMethod::Key { private_key, passphrase } => {
                let key = decode_secret_key(private_key, passphrase.as_deref()).map_err(|e| Error::BadKey(e.to_string()))?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
                handle.authenticate_publickey(&spec.username, key).await?
            }
        };
        if !auth.success() {
            return Err(Error::AuthFailed);
        }

        Ok(Self {
            handle,
            host_key,
            exec_slots: Semaphore::new(EXEC_CHANNELS_PER_CONN),
            sftp: AsyncMutex::new(None),
            identity: spec.identity(),
        })
    }

    pub fn host_key(&self) -> &str {
        &self.host_key
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }

    pub async fn open_channel(&self) -> Result<Channel<Msg>> {
        Ok(self.handle.channel_open_session().await?)
    }

    pub async fn exec(&self, command: &str, timeout: Duration, max_output: usize) -> Result<ExecOutput> {
        let _slot = self.exec_slots.acquire().await.map_err(|_| Error::Other("connection closed".into()))?;
        let started = Instant::now();
        let mut channel = self.open_channel().await?;
        channel.exec(true, command).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut truncated = false;
        let mut exit_code = None;

        let collect = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => truncated |= push_capped(&mut stdout, &data, max_output),
                    ChannelMsg::ExtendedData { data, .. } => truncated |= push_capped(&mut stderr, &data, max_output),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    _ => {}
                }
            }
        };
        if tokio::time::timeout(timeout, collect).await.is_err() {
            let _ = channel.close().await;
            return Err(Error::CommandTimeout(timeout));
        }

        Ok(ExecOutput {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            duration_ms: started.elapsed().as_millis() as u64,
            truncated,
        })
    }

    pub async fn exec_stream(&self, command: &str) -> Result<Channel<Msg>> {
        let channel = self.open_channel().await?;
        channel.exec(true, command).await?;
        Ok(channel)
    }

    pub async fn shell(&self, cols: u32, rows: u32) -> Result<Shell> {
        let channel = self.open_channel().await?;
        channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
        Ok(Shell { channel })
    }

    pub async fn sftp(&self) -> Result<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = self.open_channel().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = Arc::new(SftpSession::new(channel.into_stream()).await?);
        session.set_timeout(30);
        *guard = Some(session.clone());
        Ok(session)
    }

    pub async fn reset_sftp(&self) {
        self.sftp.lock().await.take();
    }
}

fn push_capped(buf: &mut Vec<u8>, data: &[u8], cap: usize) -> bool {
    let room = cap.saturating_sub(buf.len());
    buf.extend_from_slice(&data[..data.len().min(room)]);
    data.len() > room
}

pub struct Shell {
    pub channel: Channel<Msg>,
}
