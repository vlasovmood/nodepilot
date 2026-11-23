use std::path::Path;

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random number generator is unavailable");
    buf
}

/// Where the master key was loaded from.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
pub struct KeySource {
    /// `systemd-credential` (including TPM-sealed via `LoadCredentialEncrypted`), `file` (`NODEPILOT_MASTER_KEY_FILE`)
    /// or `data-dir` (plaintext file next to the database).
    pub kind: &'static str,
    pub path: String,
    /// A plaintext copy of the key is still in the data directory.
    pub plaintext_copy_on_disk: bool,
}

pub struct Secrets {
    cipher: XChaCha20Poly1305,
    pub source: KeySource,
}

fn read_key(path: &Path) -> Result<Vec<u8>> {
    let text = std::fs::read_to_string(path).map_err(|e| Error::Internal(format!("cannot read master key {}: {e}", path.display())))?;
    B64.decode(text.trim()).map_err(|e| Error::Internal(format!("corrupt master key {}: {e}", path.display())))
}

impl Secrets {
    pub fn load(data_dir_key: &Path, allow_create: bool) -> Result<Self> {
        let credential = std::env::var_os("CREDENTIALS_DIRECTORY").map(|d| Path::new(&d).join("master.key")).filter(|p| p.exists());
        let explicit = std::env::var_os("NODEPILOT_MASTER_KEY_FILE").map(std::path::PathBuf::from);
        let plaintext_copy = data_dir_key.exists();

        let (key, kind, path) = if let Some(p) = credential {
            (read_key(&p)?, "systemd-credential", p)
        } else if let Some(p) = explicit {
            if !p.exists() {
                return Err(Error::Internal(format!("NODEPILOT_MASTER_KEY_FILE={} does not exist", p.display())));
            }
            (read_key(&p)?, "file", p)
        } else if plaintext_copy {
            (read_key(data_dir_key)?, "data-dir", data_dir_key.to_owned())
        } else if !allow_create {
            return Err(Error::Internal(format!(
                "master key not found (systemd credential, NODEPILOT_MASTER_KEY_FILE or {}), but the database already contains encrypted data. Refusing to create a new key: restore the key (or unseal it) and start again.",
                data_dir_key.display()
            )));
        } else {
            let key = random_bytes::<32>().to_vec();
            write_private(data_dir_key, B64.encode(&key).as_bytes())?;
            tracing::info!("generated new master key at {}", data_dir_key.display());
            (key, "data-dir", data_dir_key.to_owned())
        };
        let cipher = XChaCha20Poly1305::new_from_slice(&key)
            .map_err(|_| Error::Internal(format!("master key {} must be 32 bytes", path.display())))?;
        let source = KeySource { kind, path: path.display().to_string(), plaintext_copy_on_disk: kind != "data-dir" && plaintext_copy };
        if source.plaintext_copy_on_disk {
            tracing::warn!("master key is loaded from {kind}, but a plaintext copy is still at {} — remove it", data_dir_key.display());
        }
        Ok(Self { cipher, source })
    }

    pub fn load_or_create(path: &Path) -> Result<Self> {
        Self::load(path, true)
    }

    pub fn encrypt(&self, plaintext: &str) -> String {
        let nonce_bytes = random_bytes::<24>();
        let nonce = XNonce::from(nonce_bytes);
        let ct = self.cipher.encrypt(&nonce, plaintext.as_bytes()).expect("encryption cannot fail");
        let mut out = nonce_bytes.to_vec();
        out.extend_from_slice(&ct);
        B64.encode(out)
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String> {
        let fail = || Error::Internal("cannot decrypt secret (wrong master key?)".into());
        let raw = B64.decode(encoded).map_err(|_| fail())?;
        if raw.len() < 24 {
            return Err(fail());
        }
        let (nonce, ct) = raw.split_at(24);
        let nonce = XNonce::try_from(nonce).map_err(|_| fail())?;
        let pt = self.cipher.decrypt(&nonce, ct).map_err(|_| fail())?;
        String::from_utf8(pt).map_err(|_| fail())
    }

    pub fn encrypt_opt(&self, plaintext: Option<&str>) -> Option<String> {
        plaintext.filter(|s| !s.is_empty()).map(|s| self.encrypt(s))
    }

    pub fn decrypt_opt(&self, encoded: Option<&str>) -> Result<Option<String>> {
        encoded.map(|e| self.decrypt(e)).transpose()
    }
}

pub fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        f.write_all(data)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, data)
    }
}

pub fn hash_password(password: &str) -> Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| Error::Internal(format!("password hashing failed: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

pub fn new_token() -> String {
    format!("np_{}", hex::encode(random_bytes::<32>()))
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_roundtrip() {
        let dir = std::env::temp_dir().join(format!("np-test-{}", hex::encode(random_bytes::<8>())));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("master.key");
        let s = Secrets::load_or_create(&path).unwrap();
        let enc = s.encrypt("hunter2");
        assert_ne!(enc, s.encrypt("hunter2"), "nonce must be random");
        let s2 = Secrets::load_or_create(&path).unwrap();
        assert_eq!(s2.decrypt(&enc).unwrap(), "hunter2");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn passwords() {
        let h = hash_password("correct horse").unwrap();
        assert!(verify_password("correct horse", &h));
        assert!(!verify_password("wrong", &h));
    }
}
