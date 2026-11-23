//! Returns raw counters; callers compute rates (CPU %, network) from the difference of two samples.

use schemars::JsonSchema;
use serde::Serialize;

pub const SCRIPT: &str = r#"export LC_ALL=C
echo @@hostname; hostname 2>/dev/null || cat /proc/sys/kernel/hostname
echo @@os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s
echo @@kernel; uname -r
echo @@cores; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@uptime; cat /proc/uptime
echo @@loadavg; cat /proc/loadavg
echo @@stat; head -n1 /proc/stat
echo @@meminfo; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo @@df; df -kPT 2>/dev/null || df -kP
echo @@net; cat /proc/net/dev
"#;

#[derive(Debug, Clone, Default, Serialize, JsonSchema)]
pub struct RawStats {
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub cpu_cores: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub load: Option<[f64; 3]>,
    /// (total jiffies, idle + iowait jiffies) from the first line of /proc/stat.
    pub cpu_ticks: Option<(u64, u64)>,
    pub mem_total: Option<u64>,
    pub mem_used: Option<u64>,
    pub swap_total: Option<u64>,
    pub swap_used: Option<u64>,
    pub disks: Vec<Disk>,
    /// Total rx/tx bytes across physical interfaces.
    pub net_bytes: Option<(u64, u64)>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, JsonSchema)]
pub struct Disk {
    pub mount: String,
    pub fs: String,
    pub total: u64,
    pub used: u64,
}

pub fn parse(output: &str) -> RawStats {
    let mut s = RawStats::default();
    for (name, body) in sections(output) {
        let first = body.lines().next().map(str::trim).filter(|l| !l.is_empty());
        match name {
            "hostname" => s.hostname = first.map(Into::into),
            "os" => s.os = first.map(Into::into),
            "kernel" => s.kernel = first.map(Into::into),
            "cores" => s.cpu_cores = first.and_then(|l| l.parse().ok()),
            "uptime" => s.uptime_secs = first.and_then(|l| l.split_whitespace().next()?.parse::<f64>().ok()).map(|v| v as u64),
            "loadavg" => {
                s.load = first.and_then(|l| {
                    let mut it = l.split_whitespace().map(|v| v.parse::<f64>());
                    Some([it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?])
                })
            }
            "stat" => s.cpu_ticks = first.and_then(parse_cpu_line),
            "meminfo" => parse_meminfo(body, &mut s),
            "df" => s.disks = parse_df(body),
            "net" => s.net_bytes = Some(parse_net(body)),
            _ => {}
        }
    }
    s
}

fn sections(output: &str) -> Vec<(&str, &str)> {
    let mut out = Vec::new();
    let mut rest = output;
    while let Some(start) = rest.find("@@") {
        let after = &rest[start + 2..];
        let name_end = after.find('\n').unwrap_or(after.len());
        let name = after[..name_end].trim();
        let body_start = (name_end + 1).min(after.len());
        let body = &after[body_start..];
        let body_end = body.find("\n@@").map(|i| i + 1).unwrap_or(body.len());
        out.push((name, &body[..body_end]));
        rest = &body[body_end..];
    }
    out
}

fn parse_cpu_line(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "cpu" {
        return None;
    }
    let v: Vec<u64> = parts.filter_map(|p| p.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    // user nice system idle iowait irq softirq steal (guest is already counted in user)
    let total: u64 = v.iter().take(8).sum();
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    Some((total, idle))
}

fn parse_meminfo(body: &str, s: &mut RawStats) {
    let mut kv = std::collections::HashMap::new();
    for line in body.lines() {
        if let Some((k, v)) = line.split_once(':')
            && let Some(n) = v.split_whitespace().next().and_then(|n| n.parse::<u64>().ok())
        {
            kv.insert(k.trim(), n * 1024);
        }
    }
    if let Some(&total) = kv.get("MemTotal") {
        let available = kv.get("MemAvailable").copied().unwrap_or_else(|| {
            kv.get("MemFree").copied().unwrap_or(0) + kv.get("Buffers").copied().unwrap_or(0) + kv.get("Cached").copied().unwrap_or(0)
        });
        s.mem_total = Some(total);
        s.mem_used = Some(total.saturating_sub(available));
    }
    if let (Some(&total), Some(&free)) = (kv.get("SwapTotal"), kv.get("SwapFree")) {
        s.swap_total = Some(total);
        s.swap_used = Some(total.saturating_sub(free));
    }
}

const SKIP_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "squashfs",
    "overlay",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "devpts",
    "efivarfs",
    "nsfs",
    "tracefs",
    "debugfs",
    "securityfs",
    "pstore",
    "bpf",
    "autofs",
    "fusectl",
    "configfs",
    "ramfs",
    "mqueue",
    "hugetlbfs",
];

fn parse_df(body: &str) -> Vec<Disk> {
    let mut lines = body.lines();
    let Some(header) = lines.next() else { return Vec::new() };
    let typed = header.split_whitespace().nth(1).is_some_and(|h| h.eq_ignore_ascii_case("type"));
    let mut disks: Vec<Disk> = Vec::new();
    for line in lines {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (fs, rest) = if typed { (cols.get(1).copied().unwrap_or(""), cols.get(2..)) } else { ("", cols.get(1..)) };
        // rest: total used avail capacity mount...
        let Some(rest) = rest.filter(|r| r.len() >= 5) else { continue };
        let (Ok(total), Ok(used)) = (rest[0].parse::<u64>(), rest[1].parse::<u64>()) else { continue };
        let mount = rest[4..].join(" ");
        let device = cols[0];
        if total == 0 || SKIP_FS.contains(&fs) || device == "none" || mount.starts_with("/snap/") || mount.starts_with("/run") {
            continue;
        }
        if disks.iter().any(|d| d.mount == mount) {
            continue;
        }
        disks.push(Disk { mount, fs: fs.to_owned(), total: total * 1024, used: used * 1024 });
    }
    disks
}

fn is_virtual_iface(name: &str) -> bool {
    name == "lo"
        || ["veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "kube", "tap", "lxc"].iter().any(|p| name.starts_with(p))
}

fn parse_net(body: &str) -> (u64, u64) {
    let (mut rx, mut tx) = (0u64, 0u64);
    for line in body.lines() {
        let Some((iface, data)) = line.split_once(':') else { continue };
        let iface = iface.trim();
        if is_virtual_iface(iface) {
            continue;
        }
        let v: Vec<u64> = data.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 9 {
            rx += v[0];
            tx += v[8];
        }
    }
    (rx, tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@hostname\nweb-1\n@@os\nUbuntu 24.04.1 LTS\n@@kernel\n6.8.0-45-generic\n@@cores\n4\n\
@@uptime\n12345.67 40000.00\n@@loadavg\n0.15 0.20 0.25 1/234 5678\n@@stat\ncpu  100 0 50 800 50 0 0 0 0 0\n\
@@meminfo\nMemTotal:        4000000 kB\nMemFree:          500000 kB\nMemAvailable:    3000000 kB\nSwapTotal:       1000000 kB\nSwapFree:         900000 kB\n\
@@df\nFilesystem     Type     1024-blocks     Used Available Capacity Mounted on\n\
/dev/sda1      ext4        40000000 10000000  30000000      25% /\n\
tmpfs          tmpfs        2000000        0   2000000       0% /dev/shm\n\
/dev/sdb1      xfs        100000000 50000000  50000000      50% /mnt/data disk\n\
@@net\nInter-|   Receive                                                |  Transmit\n\
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n\
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0\n\
veth12: 999 9 0 0 0 0 0 0 999 9 0 0 0 0 0 0\n";

    #[test]
    fn parses_sample() {
        let s = parse(SAMPLE);
        assert_eq!(s.hostname.as_deref(), Some("web-1"));
        assert_eq!(s.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(s.cpu_cores, Some(4));
        assert_eq!(s.uptime_secs, Some(12345));
        assert_eq!(s.load, Some([0.15, 0.20, 0.25]));
        assert_eq!(s.cpu_ticks, Some((1000, 850)));
        assert_eq!(s.mem_total, Some(4_000_000 * 1024));
        assert_eq!(s.mem_used, Some(1_000_000 * 1024));
        assert_eq!(s.swap_used, Some(100_000 * 1024));
        assert_eq!(s.disks.len(), 2);
        assert_eq!(s.disks[1].mount, "/mnt/data disk");
        assert_eq!(s.net_bytes, Some((5000, 7000)));
    }
}
