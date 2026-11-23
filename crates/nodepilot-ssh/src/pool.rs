use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::client;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

use crate::{ConnectSpec, Connection, Error, Result};

#[derive(Debug, Clone)]
pub struct PoolConfig {
    pub max_concurrent_connects: usize,
    pub idle_timeout: Duration,
    pub keepalive: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self { max_concurrent_connects: 32, idle_timeout: Duration::from_secs(10 * 60), keepalive: Duration::from_secs(30) }
    }
}

#[derive(Default)]
struct Entry {
    conn: AsyncMutex<Option<Arc<Connection>>>,
    last_used: AtomicU64,
    holds: AtomicUsize,
}

/// While a `Hold` is alive, the connection is not closed as idle.
pub struct Hold(Arc<Entry>);

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.touch();
        self.0.holds.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Entry {
    fn touch(&self) {
        self.last_used.store(now_secs(), Ordering::Relaxed);
    }
}

pub struct SshPool {
    cfg: PoolConfig,
    ssh_config: Arc<client::Config>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    connect_slots: Semaphore,
}

impl SshPool {
    pub fn new(cfg: PoolConfig) -> Arc<Self> {
        let ssh_config = client::Config {
            keepalive_interval: Some(cfg.keepalive),
            keepalive_max: 3,
            inactivity_timeout: None,
            nodelay: true,
            ..Default::default()
        };
        Arc::new(Self {
            connect_slots: Semaphore::new(cfg.max_concurrent_connects),
            cfg,
            ssh_config: Arc::new(ssh_config),
            entries: Mutex::new(HashMap::new()),
        })
    }

    pub async fn get(&self, id: &str, spec: &ConnectSpec) -> Result<Arc<Connection>> {
        let entry = self.entries.lock().unwrap().entry(id.to_owned()).or_default().clone();
        entry.touch();

        let mut slot = entry.conn.lock().await;
        if let Some(conn) = slot.as_ref()
            && !conn.is_closed()
            && conn.identity == spec.identity()
        {
            return Ok(conn.clone());
        }
        if let Some(old) = slot.take() {
            tokio::spawn(async move { old.close().await });
        }

        let _permit = self.connect_slots.acquire().await.map_err(|_| Error::Other("pool closed".into()))?;
        let conn = Arc::new(Connection::connect(spec, self.ssh_config.clone()).await?);
        *slot = Some(conn.clone());
        Ok(conn)
    }

    pub fn hold(&self, id: &str) -> Hold {
        let entry = self.entries.lock().unwrap().entry(id.to_owned()).or_default().clone();
        entry.holds.fetch_add(1, Ordering::Relaxed);
        Hold(entry)
    }

    pub async fn probe(&self, spec: &ConnectSpec) -> Result<()> {
        let _permit = self.connect_slots.acquire().await.map_err(|_| Error::Other("pool closed".into()))?;
        let conn = Connection::connect(spec, self.ssh_config.clone()).await?;
        let out = conn.exec("true", Duration::from_secs(15), 1024).await;
        conn.close().await;
        match out?.exit_code {
            Some(0) => Ok(()),
            code => Err(Error::Other(format!("test command exited with {code:?}"))),
        }
    }

    pub async fn invalidate(&self, id: &str) {
        let entry = self.entries.lock().unwrap().remove(id);
        if let Some(entry) = entry
            && let Some(conn) = entry.conn.lock().await.take()
        {
            conn.close().await;
        }
    }

    pub fn connected_count(&self) -> usize {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.conn.try_lock().map(|c| c.as_ref().is_some_and(|c| !c.is_closed())).unwrap_or(true))
            .count()
    }

    pub fn spawn_reaper(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let pool = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                let Some(pool) = pool.upgrade() else { break };
                let idle = pool.cfg.idle_timeout.as_secs();
                let now = now_secs();
                let stale: Vec<String> = pool
                    .entries
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, e)| e.holds.load(Ordering::Relaxed) == 0)
                    .filter(|(_, e)| now.saturating_sub(e.last_used.load(Ordering::Relaxed)) > idle)
                    .map(|(k, _)| k.clone())
                    .collect();
                for id in stale {
                    tracing::debug!(server = %id, "closing idle ssh connection");
                    pool.invalidate(&id).await;
                }
            }
        })
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
