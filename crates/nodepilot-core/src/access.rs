use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::models::User;
use crate::{Error, Result};

/// Permission area.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Area {
    /// Servers: list, details, stats; write adds, edits and deletes them.
    Servers,
    /// Projects and their server membership.
    Projects,
    /// Keychain (passwords and SSH keys). Secrets are never returned.
    Identities,
    /// Command execution and terminal sessions. `write` level only.
    Exec,
    /// Processes, systemd services, logs; write allows kill, start/stop and reboot.
    System,
    /// Files on servers (SFTP).
    Files,
    Notes,
    Graphs,
    /// Backup storages, jobs and archives.
    Backups,
    /// API tokens and panel users.
    Admin,
}

impl Area {
    pub const ALL: [Area; 10] = [
        Area::Servers,
        Area::Projects,
        Area::Identities,
        Area::Exec,
        Area::System,
        Area::Files,
        Area::Notes,
        Area::Graphs,
        Area::Backups,
        Area::Admin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Area::Servers => "servers",
            Area::Projects => "projects",
            Area::Identities => "identities",
            Area::Exec => "exec",
            Area::System => "system",
            Area::Files => "files",
            Area::Notes => "notes",
            Area::Graphs => "graphs",
            Area::Backups => "backups",
            Area::Admin => "admin",
        }
    }
}

/// Access level. `write` includes read, create, update and delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Read,
    Write,
}

/// Token permissions. `full: true` grants everything, including areas added later.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Permissions {
    #[serde(default)]
    pub full: bool,
    /// Level per area; a missing area means no access.
    #[serde(default)]
    pub areas: BTreeMap<Area, Level>,
}

impl Permissions {
    pub fn full() -> Self {
        Self { full: true, areas: BTreeMap::new() }
    }

    pub fn read_only() -> Self {
        let areas = Area::ALL.into_iter().filter(|a| !matches!(a, Area::Exec | Area::Admin)).map(|a| (a, Level::Read)).collect();
        Self { full: false, areas }
    }

    pub fn level(&self, area: Area) -> Option<Level> {
        if self.full { Some(Level::Write) } else { self.areas.get(&area).copied() }
    }

    pub fn allows(&self, area: Area, level: Level) -> bool {
        self.level(area).is_some_and(|l| l >= level)
    }

    /// True if `other` grants nothing beyond `self`, so a token can't issue broader rights than its own.
    pub fn covers(&self, other: &Permissions) -> bool {
        if self.full {
            return true;
        }
        if other.full {
            return false;
        }
        other.areas.iter().all(|(a, l)| self.allows(*a, *l))
    }

    pub fn normalized(mut self) -> Self {
        if let Some(l) = self.areas.get_mut(&Area::Exec) {
            *l = Level::Write;
        }
        if self.full {
            self.areas.clear();
        }
        self
    }
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub user: User,
    /// `None` for a browser session.
    pub token: Option<TokenRef>,
    pub perms: Permissions,
    pub ip: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TokenRef {
    pub id: String,
    pub name: String,
}

impl Principal {
    pub fn require(&self, area: Area, level: Level) -> Result<()> {
        if self.perms.allows(area, level) {
            return Ok(());
        }
        let what = match level {
            Level::Read => "read",
            Level::Write => "write",
        };
        Err(Error::Forbidden(format!("this API token has no '{what}' access to '{}'", area.as_str())))
    }

    pub fn label(&self) -> String {
        match &self.token {
            Some(t) => format!("{} (token {})", self.user.username, t.name),
            None => self.user.username.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_and_cover() {
        let ro = Permissions::read_only();
        assert!(ro.allows(Area::Servers, Level::Read));
        assert!(!ro.allows(Area::Servers, Level::Write));
        assert!(!ro.allows(Area::Exec, Level::Write));
        assert!(Permissions::full().covers(&ro));
        assert!(!ro.covers(&Permissions::full()));
        let mut notes = Permissions::default();
        notes.areas.insert(Area::Notes, Level::Write);
        assert!(!ro.covers(&notes));
        assert!(notes.allows(Area::Notes, Level::Read));
        let json = serde_json::to_string(&notes).unwrap();
        assert_eq!(json, r#"{"full":false,"areas":{"notes":"write"}}"#);
    }
}
