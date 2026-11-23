use schemars::JsonSchema;
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use nodepilot_ssh::stats::{self as raw, Disk, RawStats};
use serde::Serialize;

use crate::models::{Status, Ts};
use crate::{App, Error, Result, now};

#[derive(Debug, Clone, Serialize, Default, JsonSchema)]
pub struct StatsSnapshot {
    pub server_id: String,
    pub status: Status,
    pub collected_at: Option<Ts>,
    pub error: Option<String>,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub cpu_cores: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub mem_total: Option<u64>,
    pub mem_used: Option<u64>,
    pub swap_total: Option<u64>,
    pub swap_used: Option<u64>,
    pub disks: Vec<Disk>,
    pub net_rx_bps: Option<f64>,
    pub net_tx_bps: Option<f64>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct StatsPoint {
    pub ts: Ts,
    pub cpu_percent: Option<f64>,
    pub mem_used: Option<u64>,
    pub mem_total: Option<u64>,
    pub disk_used: Option<u64>,
    pub disk_total: Option<u64>,
    pub net_rx_bps: Option<f64>,
    pub net_tx_bps: Option<f64>,
    pub load1: Option<f64>,
}

/// Previous sample: time, CPU ticks (total, idle), network bytes (rx, tx).
type PrevSample = (Instant, Option<(u64, u64)>, Option<(u64, u64)>);

#[derive(Default)]
struct Entry {
    snap: StatsSnapshot,
    prev: Option<PrevSample>,
    failures: u32,
    next_attempt: Option<Instant>,
}

#[derive(Default)]
pub struct StatsStore {
    entries: RwLock<HashMap<String, Entry>>,
}

impl StatsStore {
    pub fn status(&self, id: &str) -> Status {
        self.entries.read().unwrap().get(id).map(|e| e.snap.status).unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> StatsSnapshot {
        self.entries
            .read()
            .unwrap()
            .get(id)
            .map(|e| e.snap.clone())
            .unwrap_or_else(|| StatsSnapshot { server_id: id.to_owned(), ..Default::default() })
    }

    pub fn remove(&self, id: &str) {
        self.entries.write().unwrap().remove(id);
    }

    fn due(&self, id: &str, at: Instant) -> bool {
        self.entries.read().unwrap().get(id).and_then(|e| e.next_attempt).is_none_or(|n| at >= n)
    }

    fn record_ok(&self, id: &str, raw: RawStats) -> StatsSnapshot {
        let mut map = self.entries.write().unwrap();
        let e = map.entry(id.to_owned()).or_default();
        let at = Instant::now();

        let (mut cpu_percent, mut rx_bps, mut tx_bps) = (None, None, None);
        if let Some((prev_at, prev_cpu, prev_net)) = e.prev {
            if let (Some((t0, i0)), Some((t1, i1))) = (prev_cpu, raw.cpu_ticks) {
                let (dt, di) = (t1.saturating_sub(t0), i1.saturating_sub(i0));
                if dt > 0 {
                    cpu_percent = Some((100.0 * (dt.saturating_sub(di)) as f64 / dt as f64 * 10.0).round() / 10.0);
                }
            }
            let secs = at.duration_since(prev_at).as_secs_f64();
            if let (Some((r0, t0)), Some((r1, t1)), true) = (prev_net, raw.net_bytes, secs > 0.5) {
                // Counters reset on reboot; skip this sample.
                if r1 >= r0 && t1 >= t0 {
                    rx_bps = Some(((r1 - r0) as f64 / secs).round());
                    tx_bps = Some(((t1 - t0) as f64 / secs).round());
                }
            }
        }
        e.prev = Some((at, raw.cpu_ticks, raw.net_bytes));
        e.failures = 0;
        e.next_attempt = None;
        e.snap = StatsSnapshot {
            server_id: id.to_owned(),
            status: Status::Online,
            collected_at: Some(now()),
            error: None,
            hostname: raw.hostname,
            os: raw.os,
            kernel: raw.kernel,
            cpu_cores: raw.cpu_cores,
            uptime_secs: raw.uptime_secs,
            cpu_percent,
            load: raw.load,
            mem_total: raw.mem_total,
            mem_used: raw.mem_used,
            swap_total: raw.swap_total,
            swap_used: raw.swap_used,
            disks: raw.disks,
            net_rx_bps: rx_bps,
            net_tx_bps: tx_bps,
        };
        e.snap.clone()
    }

    fn record_err(&self, id: &str, err: String, interval: Duration) {
        let mut map = self.entries.write().unwrap();
        let e = map.entry(id.to_owned()).or_default();
        e.failures += 1;
        let backoff = interval.saturating_mul(1 << e.failures.min(4)).min(Duration::from_secs(300));
        e.next_attempt = Some(Instant::now() + backoff);
        e.prev = None;
        e.snap.server_id = id.to_owned();
        e.snap.status = Status::Offline;
        e.snap.error = Some(err);
    }
}

struct MetricRow {
    server_id: String,
    ts: i64,
    snap: StatsSnapshot,
}

impl App {
    pub fn all_stats(&self, ids: &[String]) -> Vec<StatsSnapshot> {
        ids.iter().map(|id| self.stats.get(id)).collect()
    }

    pub async fn collect_stats(&self, id: &str) -> Result<StatsSnapshot> {
        let result = async {
            let conn = self.connection(id).await?;
            let out = conn.exec(raw::SCRIPT, Duration::from_secs(20), 256 * 1024).await?;
            Ok::<_, Error>(raw::parse(&out.stdout))
        }
        .await;
        match result {
            Ok(raw) => Ok(self.stats.record_ok(id, raw)),
            Err(e) => {
                self.stats.record_err(id, e.to_string(), self.config.stats_interval);
                Err(e)
            }
        }
    }

    pub async fn stats_history(&self, id: &str, hours: u32) -> Result<Vec<StatsPoint>> {
        let hours = hours.clamp(1, 24 * 31) as i64;
        let since = Utc::now().timestamp() - hours * 3600;
        // At most ~600 points per chart.
        let bucket = (self.config.stats_interval.as_secs() as i64).max(hours * 3600 / 600).max(1);
        type Row = (i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT (ts / ?1) * ?1 AS bucket, AVG(cpu), AVG(mem_used), AVG(mem_total), AVG(disk_used), AVG(disk_total),
                    AVG(net_rx), AVG(net_tx), AVG(load1)
             FROM metrics WHERE server_id = ?2 AND ts >= ?3 GROUP BY bucket ORDER BY bucket",
        )
        .bind(bucket)
        .bind(id)
        .bind(since)
        .fetch_all(&self.db)
        .await?;
        let r1 = |v: Option<f64>| v.map(|x| (x * 10.0).round() / 10.0);
        let u = |v: Option<f64>| v.map(|x| x as u64);
        Ok(rows
            .into_iter()
            .map(|(ts, cpu, mu, mt, du, dt, rx, tx, l1)| StatsPoint {
                ts: DateTime::from_timestamp(ts, 0).unwrap_or_default(),
                cpu_percent: r1(cpu),
                mem_used: u(mu),
                mem_total: u(mt),
                disk_used: u(du),
                disk_total: u(dt),
                net_rx_bps: rx.map(f64::round),
                net_tx_bps: tx.map(f64::round),
                load1: l1.map(|x| (x * 100.0).round() / 100.0),
            })
            .collect())
    }

    async fn save_metrics(&self, rows: Vec<MetricRow>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut tx = self.db.begin().await?;
        for r in rows {
            let disk_total: u64 = r.snap.disks.iter().map(|d| d.total).sum();
            let disk_used: u64 = r.snap.disks.iter().map(|d| d.used).sum();
            sqlx::query(
                "INSERT OR REPLACE INTO metrics (server_id, ts, cpu, mem_used, mem_total, disk_used, disk_total, net_rx, net_tx, load1)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&r.server_id)
            .bind(r.ts)
            .bind(r.snap.cpu_percent)
            .bind(r.snap.mem_used.map(|v| v as i64))
            .bind(r.snap.mem_total.map(|v| v as i64))
            .bind((disk_total > 0).then_some(disk_used as i64))
            .bind((disk_total > 0).then_some(disk_total as i64))
            .bind(r.snap.net_rx_bps)
            .bind(r.snap.net_tx_bps)
            .bind(r.snap.load.map(|l| l[0]))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    async fn poll_all(&self) -> Result<()> {
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM servers").fetch_all(&self.db).await?;
        let at = Instant::now();
        let due: Vec<String> = ids.into_iter().filter(|id| self.stats.due(id, at)).collect();
        let ts = Utc::now().timestamp();
        let rows: Vec<MetricRow> = futures::stream::iter(due)
            .map(|id| async move {
                match self.collect_stats(&id).await {
                    Ok(snap) => Some(MetricRow { server_id: id, ts, snap }),
                    Err(e) => {
                        tracing::debug!(server = %id, error = %e, "stats poll failed");
                        None
                    }
                }
            })
            .buffer_unordered(self.config.stats_concurrency.max(1))
            .filter_map(|r| async { r })
            .collect()
            .await;
        self.save_metrics(rows).await
    }

    async fn purge_metrics(&self) -> Result<()> {
        let cutoff = Utc::now().timestamp() - self.config.metrics_retention_days as i64 * 86400;
        sqlx::query("DELETE FROM metrics WHERE ts < ?").bind(cutoff).execute(&self.db).await?;
        Ok(())
    }
}

pub fn spawn_poller(app: App) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(app.config.stats_interval);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_purge = Instant::now() - Duration::from_secs(3600);
        loop {
            tick.tick().await;
            if let Err(e) = app.poll_all().await {
                tracing::warn!(error = %e, "stats polling failed");
            }
            if last_purge.elapsed() >= Duration::from_secs(3600) {
                last_purge = Instant::now();
                if let Err(e) = app.purge_metrics().await {
                    tracing::warn!(error = %e, "metrics purge failed");
                }
            }
        }
    });
}
