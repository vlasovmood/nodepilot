use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nodepilot_ssh::{ChannelMsg, ChannelWriteHalf, ClientMsg, Hold};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::models::Ts;
use crate::{App, Error, Result, new_id, now};

const BUFFER_CAP: usize = 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_SESSIONS: usize = 64;
const MAX_WAIT: Duration = Duration::from_secs(30);
/// Output counts as settled after this long without new data.
const QUIET: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TerminalInfo {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub created_by: String,
    pub created_at: Ts,
    pub cols: u32,
    pub rows: u32,
    pub closed: bool,
    pub exit_code: Option<u32>,
    /// End-of-output offset; pass it as `since` to read only new output.
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TerminalOutput {
    /// Output from `since` (UTF-8, invalid bytes replaced).
    pub data: String,
    /// Offset to read from next time.
    pub next: u64,
    /// Part of the output was evicted from the buffer (1 MiB) and lost.
    pub truncated: bool,
    pub closed: bool,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenTerminal {
    pub server_id: String,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TerminalInput {
    /// Bytes to send. Control characters as-is: `\u0003` = Ctrl+C, `\u0004` = Ctrl+D, `\t` = Tab.
    pub data: String,
    /// Append a newline (press Enter). Default `false`.
    #[serde(default)]
    pub enter: bool,
    /// Wait up to N ms (max 30000) for output and return it.
    #[serde(default)]
    pub wait_ms: Option<u64>,
    /// Strip ANSI escape sequences (colors, cursor) from the response.
    #[serde(default)]
    pub strip_ansi: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReadQuery {
    #[serde(default)]
    pub since: u64,
    #[serde(default)]
    pub wait_ms: Option<u64>,
    #[serde(default)]
    pub strip_ansi: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ResizeTerminal {
    pub cols: u32,
    pub rows: u32,
}

struct Buffer {
    data: VecDeque<u8>,
    /// Absolute offset of the first byte in `data`.
    start: u64,
    closed: bool,
    exit_code: Option<u32>,
    last_data: Instant,
}

impl Buffer {
    fn end(&self) -> u64 {
        self.start + self.data.len() as u64
    }

    fn push(&mut self, bytes: &[u8]) {
        self.data.extend(bytes);
        while self.data.len() > BUFFER_CAP {
            let drop = self.data.len() - BUFFER_CAP;
            self.data.drain(..drop);
            self.start += drop as u64;
        }
        self.last_data = Instant::now();
    }

    fn read(&self, since: u64) -> (Vec<u8>, u64, bool) {
        let truncated = since < self.start;
        let from = since.clamp(self.start, self.end());
        let skip = (from - self.start) as usize;
        (self.data.iter().skip(skip).copied().collect(), self.end(), truncated)
    }
}

struct Session {
    info: Mutex<TerminalInfo>,
    writer: AsyncMutex<ChannelWriteHalf<ClientMsg>>,
    buf: Mutex<Buffer>,
    notify: Notify,
    last_activity: Mutex<Instant>,
    _hold: Hold,
}

impl Session {
    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    fn snapshot(&self) -> TerminalInfo {
        let mut info = self.info.lock().unwrap().clone();
        let b = self.buf.lock().unwrap();
        info.closed = b.closed;
        info.exit_code = b.exit_code;
        info.offset = b.end();
        info
    }

    fn output(&self, since: u64, strip: bool) -> TerminalOutput {
        let b = self.buf.lock().unwrap();
        let (bytes, next, truncated) = b.read(since);
        let text = String::from_utf8_lossy(&bytes).into_owned();
        TerminalOutput { data: if strip { strip_ansi(&text) } else { text }, next, truncated, closed: b.closed, exit_code: b.exit_code }
    }

    async fn wait_output(&self, since: u64, wait: Duration) {
        let deadline = Instant::now() + wait.min(MAX_WAIT);
        loop {
            let notified = self.notify.notified();
            let (has_new, quiet_for, closed) = {
                let b = self.buf.lock().unwrap();
                (b.end() > since, b.last_data.elapsed(), b.closed)
            };
            if closed || (has_new && quiet_for >= QUIET) {
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            let sleep = if has_new { QUIET.saturating_sub(quiet_for) } else { deadline - now };
            let _ = tokio::time::timeout(sleep.min(deadline - now), notified).await;
        }
    }
}

#[derive(Default)]
pub struct TerminalSessions {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalSessions {
    fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.map.lock().unwrap().get(id).cloned().ok_or(Error::NotFound("terminal session"))
    }
}

impl App {
    pub fn list_terminals(&self) -> Vec<TerminalInfo> {
        let mut v: Vec<_> = self.terminals.map.lock().unwrap().values().map(|s| s.snapshot()).collect();
        v.sort_by_key(|t| std::cmp::Reverse(t.created_at));
        v
    }

    pub fn get_terminal(&self, id: &str) -> Result<TerminalInfo> {
        Ok(self.terminals.get(id)?.snapshot())
    }

    pub async fn open_terminal(&self, req: OpenTerminal, created_by: &str) -> Result<TerminalInfo> {
        if self.terminals.map.lock().unwrap().len() >= MAX_SESSIONS {
            return Err(Error::Conflict(format!("too many open terminal sessions (max {MAX_SESSIONS}); close some first")));
        }
        let server = self.get_server(&req.server_id).await?;
        let cols = req.cols.unwrap_or(160).clamp(20, 1000);
        let rows = req.rows.unwrap_or(48).clamp(5, 500);
        let conn = self.connection(&req.server_id).await?;
        let shell = conn.shell(cols, rows).await?;
        let (mut reader, writer) = shell.channel.split();

        let id = new_id();
        let session = Arc::new(Session {
            info: Mutex::new(TerminalInfo {
                id: id.clone(),
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                created_by: created_by.to_owned(),
                created_at: now(),
                cols,
                rows,
                closed: false,
                exit_code: None,
                offset: 0,
            }),
            writer: AsyncMutex::new(writer),
            buf: Mutex::new(Buffer { data: VecDeque::new(), start: 0, closed: false, exit_code: None, last_data: Instant::now() }),
            notify: Notify::new(),
            last_activity: Mutex::new(Instant::now()),
            _hold: self.ssh.hold(&server.id),
        });
        self.terminals.map.lock().unwrap().insert(id.clone(), session.clone());

        let weak = Arc::downgrade(&session);
        tokio::spawn(async move {
            while let Some(msg) = reader.wait().await {
                let Some(s) = weak.upgrade() else { return };
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => s.buf.lock().unwrap().push(&data),
                    ChannelMsg::ExitStatus { exit_status } => s.buf.lock().unwrap().exit_code = Some(exit_status),
                    _ => continue,
                }
                s.notify.notify_waiters();
            }
            if let Some(s) = weak.upgrade() {
                s.buf.lock().unwrap().closed = true;
                s.notify.notify_waiters();
            }
        });
        tracing::info!(server = %server.name, by = created_by, "terminal session opened");
        Ok(session.snapshot())
    }

    pub async fn terminal_input(&self, id: &str, input: TerminalInput) -> Result<TerminalOutput> {
        let s = self.terminals.get(id)?;
        s.touch();
        let since = s.buf.lock().unwrap().end();
        if s.buf.lock().unwrap().closed {
            return Err(Error::Conflict("terminal session is closed".into()));
        }
        let mut data = input.data.into_bytes();
        if input.enter {
            data.push(b'\r');
        }
        if !data.is_empty() {
            s.writer.lock().await.data_bytes(data).await.map_err(|e| Error::Internal(format!("terminal write failed: {e}")))?;
        }
        if let Some(ms) = input.wait_ms.filter(|ms| *ms > 0) {
            s.wait_output(since, Duration::from_millis(ms)).await;
        }
        Ok(s.output(since, input.strip_ansi))
    }

    pub async fn terminal_output(&self, id: &str, q: ReadQuery) -> Result<TerminalOutput> {
        let s = self.terminals.get(id)?;
        s.touch();
        if let Some(ms) = q.wait_ms.filter(|ms| *ms > 0) {
            s.wait_output(q.since, Duration::from_millis(ms)).await;
        }
        Ok(s.output(q.since, q.strip_ansi))
    }

    pub async fn terminal_resize(&self, id: &str, r: ResizeTerminal) -> Result<TerminalInfo> {
        let s = self.terminals.get(id)?;
        let (cols, rows) = (r.cols.clamp(20, 1000), r.rows.clamp(5, 500));
        s.writer.lock().await.window_change(cols, rows, 0, 0).await.map_err(|e| Error::Internal(e.to_string()))?;
        {
            let mut info = s.info.lock().unwrap();
            info.cols = cols;
            info.rows = rows;
        }
        Ok(s.snapshot())
    }

    pub async fn close_terminal(&self, id: &str) -> Result<()> {
        let s = self.terminals.map.lock().unwrap().remove(id).ok_or(Error::NotFound("terminal session"))?;
        let _ = s.writer.lock().await.close().await;
        Ok(())
    }

    async fn reap_terminals(&self) {
        let stale: Vec<String> = self
            .terminals
            .map
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, s)| {
                let idle = s.last_activity.lock().unwrap().elapsed();
                let closed = s.buf.lock().unwrap().closed;
                idle > IDLE_TIMEOUT || (closed && idle > Duration::from_secs(5 * 60))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            let _ = self.close_terminal(&id).await;
        }
    }
}

pub fn spawn_reaper(app: App) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            app.reap_terminals().await;
        }
    });
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if c != '\u{7}' {
                out.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: ESC [ params final_byte(@..~)
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL | ESC \
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Charset selection: ESC ( B etc.
            Some('(' | ')' | '*' | '+') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi() {
        assert_eq!(strip_ansi("\u{1b}[1;32mok\u{1b}[0m done"), "ok done");
        assert_eq!(strip_ansi("\u{1b}]0;user@host: ~\u{7}$ ls"), "$ ls");
        assert_eq!(strip_ansi("\u{1b}(Bplain"), "plain");
    }

    #[test]
    fn ring_buffer_offsets() {
        let mut b = Buffer { data: VecDeque::new(), start: 0, closed: false, exit_code: None, last_data: Instant::now() };
        b.push(b"hello ");
        b.push(b"world");
        let (d, next, trunc) = b.read(6);
        assert_eq!((d.as_slice(), next, trunc), (&b"world"[..], 11, false));
        b.push(&vec![b'x'; BUFFER_CAP]);
        let (_, _, trunc) = b.read(0);
        assert!(trunc);
        assert_eq!(b.end(), 11 + BUFFER_CAP as u64);
    }
}
