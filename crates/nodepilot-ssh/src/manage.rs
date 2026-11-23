//! User-supplied values are validated or shell-quoted: input comes from the API and AI agents.

use schemars::JsonSchema;
use serde::Serialize;

use crate::shell_quote;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub rss: u64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Service {
    pub name: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

pub fn privileged(username: &str, cmd: &str) -> String {
    if username == "root" { cmd.to_owned() } else { format!("sudo -n {cmd}") }
}

pub const PROCESSES_CMD: &str = "LC_ALL=C ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 200";

pub fn parse_processes(out: &str) -> Vec<Process> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let user = it.next()?.to_owned();
            let cpu = it.next()?.parse().ok()?;
            let mem = it.next()?.parse().ok()?;
            let rss = it.next()?.parse::<u64>().ok()? * 1024;
            let command = it.collect::<Vec<_>>().join(" ");
            Some(Process { pid, user, cpu, mem, rss, command })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, serde::Deserialize, Default, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum Signal {
    #[default]
    Term,
    Kill,
    Hup,
}

pub fn kill_cmd(username: &str, pid: u32, signal: Signal) -> String {
    let sig = match signal {
        Signal::Term => "TERM",
        Signal::Kill => "KILL",
        Signal::Hup => "HUP",
    };
    privileged(username, &format!("kill -s {sig} {pid}"))
}

pub const SERVICES_CMD: &str = "LC_ALL=C systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null";

pub fn parse_services(out: &str) -> Vec<Service> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let unit = it.next()?;
            let name = unit.strip_suffix(".service").unwrap_or(unit).to_owned();
            Some(Service {
                name,
                load: it.next()?.to_owned(),
                active: it.next()?.to_owned(),
                sub: it.next()?.to_owned(),
                description: it.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

pub fn valid_unit_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-\\".contains(c))
}

#[derive(Debug, Clone, Copy, serde::Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

impl std::str::FromStr for ServiceAction {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "start" => Self::Start,
            "stop" => Self::Stop,
            "restart" => Self::Restart,
            "reload" => Self::Reload,
            "enable" => Self::Enable,
            "disable" => Self::Disable,
            _ => return Err(()),
        })
    }
}

pub fn service_cmd(username: &str, name: &str, action: ServiceAction) -> Option<String> {
    if !valid_unit_name(name) {
        return None;
    }
    let verb = match action {
        ServiceAction::Start => "start",
        ServiceAction::Stop => "stop",
        ServiceAction::Restart => "restart",
        ServiceAction::Reload => "reload",
        ServiceAction::Enable => "enable",
        ServiceAction::Disable => "disable",
    };
    Some(privileged(username, &format!("systemctl {verb} -- {}", shell_quote(name))))
}

pub fn service_logs_cmd(username: &str, name: &str, lines: u32) -> Option<String> {
    if !valid_unit_name(name) {
        return None;
    }
    let lines = lines.clamp(1, 5000);
    Some(privileged(username, &format!("journalctl -u {} -n {lines} --no-pager -o short-iso 2>&1", shell_quote(name))))
}

#[derive(Debug, Clone, Copy, serde::Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PowerAction {
    Reboot,
    Shutdown,
}

pub fn power_cmd(username: &str, action: PowerAction) -> String {
    // Delayed so the command returns before the connection drops.
    let cmd = match action {
        PowerAction::Reboot => "sh -c 'sleep 1; systemctl reboot || reboot' >/dev/null 2>&1 &",
        PowerAction::Shutdown => "sh -c 'sleep 1; systemctl poweroff || poweroff' >/dev/null 2>&1 &",
    };
    privileged(username, cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processes() {
        let p = parse_processes("    1 root      0.1  0.2  12000 /sbin/init splash\n  42 www-data 12.5  3.0 300 nginx: worker\n");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].rss, 12000 * 1024);
        assert_eq!(p[1].command, "nginx: worker");
    }

    #[test]
    fn services() {
        let s = parse_services("nginx.service loaded active running A high performance web server\n");
        assert_eq!(s[0].name, "nginx");
        assert_eq!(s[0].description, "A high performance web server");
    }

    #[test]
    fn unit_names() {
        assert!(valid_unit_name("getty@tty1"));
        assert!(!valid_unit_name("nginx; rm -rf /"));
        assert!(!valid_unit_name("--help"));
        assert!(service_cmd("root", "a b", ServiceAction::Start).is_none());
        assert_eq!(service_cmd("deploy", "nginx", ServiceAction::Restart).unwrap(), "sudo -n systemctl restart -- 'nginx'");
    }
}
