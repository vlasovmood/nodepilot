use nodepilot_ssh::ExecOutput;
use nodepilot_ssh::manage::{self as m, PowerAction, Process, Service, ServiceAction, Signal};

use crate::error::bad;
use crate::{App, Error, Result};

impl App {
    pub async fn processes(&self, id: &str) -> Result<Vec<Process>> {
        let out = self.exec(id, m::PROCESSES_CMD, Some(30)).await?;
        Ok(m::parse_processes(&out.stdout))
    }

    pub async fn kill_process(&self, id: &str, pid: u32, signal: Signal) -> Result<()> {
        if pid <= 1 {
            return Err(bad("refusing to signal pid 0/1"));
        }
        let user = self.server_username(id).await?;
        let out = self.exec(id, &m::kill_cmd(&user, pid, signal), Some(30)).await?;
        check(out)
    }

    pub async fn services(&self, id: &str) -> Result<Vec<Service>> {
        let out = self.exec(id, m::SERVICES_CMD, Some(30)).await?;
        Ok(m::parse_services(&out.stdout))
    }

    pub async fn service_action(&self, id: &str, name: &str, action: ServiceAction) -> Result<ExecOutput> {
        let user = self.server_username(id).await?;
        let cmd = m::service_cmd(&user, name, action).ok_or_else(|| bad("invalid service name"))?;
        self.exec(id, &cmd, Some(120)).await
    }

    pub async fn service_logs(&self, id: &str, name: &str, lines: u32) -> Result<Vec<String>> {
        let user = self.server_username(id).await?;
        let cmd = m::service_logs_cmd(&user, name, lines).ok_or_else(|| bad("invalid service name"))?;
        let out = self.exec(id, &cmd, Some(60)).await?;
        Ok(out.stdout.lines().map(str::to_owned).collect())
    }

    pub async fn power(&self, id: &str, action: PowerAction) -> Result<()> {
        let user = self.server_username(id).await?;
        let out = self.exec(id, &m::power_cmd(&user, action), Some(30)).await?;
        check(out)?;
        self.ssh.invalidate(id).await;
        Ok(())
    }
}

fn check(out: ExecOutput) -> Result<()> {
    if out.exit_code == Some(0) {
        Ok(())
    } else {
        let msg = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
        Err(Error::BadRequest(format!("command failed (exit {:?}): {msg}", out.exit_code)))
    }
}
