use schemars::JsonSchema;
use std::sync::Arc;

use chrono::DateTime;
use nodepilot_ssh::{SftpSession, shell_quote};
use serde::Serialize;

use crate::error::bad;
use crate::models::Ts;
use crate::{App, Error, Result};

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub mode: String,
    pub modified: Option<Ts>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

pub fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

fn check_path(path: &str) -> Result<()> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(bad("path is required"));
    }
    Ok(())
}

impl App {
    pub async fn sftp(&self, server_id: &str) -> Result<Arc<SftpSession>> {
        Ok(self.connection(server_id).await?.sftp().await?)
    }

    async fn with_sftp<T, F, Fut>(&self, server_id: &str, f: F) -> Result<T>
    where
        F: FnOnce(Arc<SftpSession>) -> Fut,
        Fut: Future<Output = std::result::Result<T, nodepilot_ssh::Error>>,
    {
        let conn = self.connection(server_id).await?;
        let sftp = conn.sftp().await?;
        match f(sftp).await {
            Ok(v) => Ok(v),
            Err(e) => {
                if !matches!(&e, nodepilot_ssh::Error::Sftp(inner) if is_status_error(inner)) {
                    conn.reset_sftp().await;
                }
                Err(e.into())
            }
        }
    }

    pub async fn list_dir(&self, server_id: &str, path: Option<&str>) -> Result<DirListing> {
        let path = path.map(str::to_owned).filter(|p| !p.trim().is_empty());
        self.with_sftp(server_id, |sftp| async move {
            let path = match path {
                Some(p) => p,
                None => sftp.canonicalize(".").await?,
            };
            let mut entries: Vec<FileEntry> = sftp
                .read_dir(path.clone())
                .await?
                .map(|e| {
                    let meta = e.metadata();
                    let ft = e.file_type();
                    let name = e.file_name();
                    FileEntry {
                        path: join_path(&path, &name),
                        name,
                        kind: if ft.is_dir() {
                            "dir"
                        } else if ft.is_symlink() {
                            "symlink"
                        } else if ft.is_file() {
                            "file"
                        } else {
                            "other"
                        },
                        size: meta.size.unwrap_or(0),
                        mode: meta.permissions().to_string(),
                        modified: meta.mtime.and_then(|t| DateTime::from_timestamp(t as i64, 0)),
                    }
                })
                .collect();
            entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.cmp(&b.name)));
            Ok(DirListing { path, entries })
        })
        .await
    }

    pub async fn read_file(&self, server_id: &str, path: &str, max: u64) -> Result<Vec<u8>> {
        check_path(path)?;
        let path = path.to_owned();
        let data = self
            .with_sftp(server_id, |sftp| async move {
                let meta = sftp.metadata(path.clone()).await?;
                if meta.size.unwrap_or(0) > max {
                    return Err(nodepilot_ssh::Error::Other(format!("file is larger than {max} bytes")));
                }
                Ok(sftp.read(path).await?)
            })
            .await?;
        Ok(data)
    }

    pub async fn write_file(&self, server_id: &str, path: &str, data: Vec<u8>) -> Result<()> {
        check_path(path)?;
        let path = path.to_owned();
        self.with_sftp(server_id, |sftp| async move { Ok(sftp.write(path, &data).await?) }).await
    }

    pub async fn make_dir(&self, server_id: &str, path: &str) -> Result<()> {
        check_path(path)?;
        let path = path.to_owned();
        self.with_sftp(server_id, |sftp| async move { Ok(sftp.create_dir(path).await?) }).await
    }

    pub async fn rename_path(&self, server_id: &str, from: &str, to: &str) -> Result<()> {
        check_path(from)?;
        check_path(to)?;
        let (from, to) = (from.to_owned(), to.to_owned());
        self.with_sftp(server_id, |sftp| async move { Ok(sftp.rename(from, to).await?) }).await
    }

    pub async fn delete_path(&self, server_id: &str, path: &str, recursive: bool) -> Result<()> {
        check_path(path)?;
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() || trimmed == "." || trimmed == "~" {
            return Err(bad("refusing to delete this path"));
        }
        if recursive {
            let out = self.exec(server_id, &format!("rm -rf -- {}", shell_quote(path)), Some(600)).await?;
            if out.exit_code != Some(0) {
                return Err(Error::BadRequest(format!("rm failed: {}", out.stderr.trim())));
            }
            return Ok(());
        }
        let path = path.to_owned();
        self.with_sftp(server_id, |sftp| async move {
            let meta = sftp.symlink_metadata(path.clone()).await?;
            if meta.is_dir() {
                sftp.remove_dir(path).await?
            } else {
                sftp.remove_file(path).await?
            }
            Ok(())
        })
        .await
    }
}

/// Status errors (missing file, permission denied) don't mean the session is broken.
fn is_status_error(e: &nodepilot_ssh::russh_sftp::client::error::Error) -> bool {
    matches!(e, nodepilot_ssh::russh_sftp::client::error::Error::Status(_))
}
