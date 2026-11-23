use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::crypto::{hash_token, random_bytes, verify_password};
use crate::error::bad;
use crate::{App, Error, Result};

const STEP: u64 = 30;
const DIGITS: u32 = 6;
const RECOVERY_CODES: usize = 10;

// ---------- base32 (RFC 4648, no padding) ----------

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in data {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((buf >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '=') {
        let v = B32.iter().position(|&b| b == c.to_ascii_uppercase() as u8)? as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            out.push((buf >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

fn hotp(secret: &[u8], counter: u64) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("any key length");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]]);
    bin % 10u32.pow(DIGITS)
}

fn current_step() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / STEP).unwrap_or(0)
}

/// Allows ±1 step of clock skew and returns the matched step.
pub fn verify_code(secret: &[u8], code: &str, now_step: u64) -> Option<u64> {
    let code = code.trim().replace(' ', "");
    if code.len() != DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let want: u32 = code.parse().ok()?;
    [now_step.saturating_sub(1), now_step, now_step + 1].into_iter().find(|&s| hotp(secret, s) == want)
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TotpSetup {
    /// Base32 secret for manual entry in the app.
    pub secret: String,
    /// `otpauth://` URL for the QR code.
    pub otpauth_url: String,
}

#[derive(Debug, Serialize, JsonSchema)]
pub struct TwoFactorStatus {
    pub enabled: bool,
    pub recovery_codes_left: usize,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TotpCode {
    pub code: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DisableTwoFactor {
    pub password: String,
    /// Authenticator code or recovery code.
    pub code: String,
}

// ---------- brute-force protection ----------

#[derive(Default)]
struct Attempts {
    failures: u32,
    window_start: Option<Instant>,
    locked_until: Option<Instant>,
    lockouts: u32,
}

#[derive(Default)]
pub struct LoginGuard {
    map: Mutex<HashMap<String, Attempts>>,
    /// Last accepted TOTP step per user, so a code can't be reused.
    last_step: Mutex<HashMap<String, u64>>,
}

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_FAILURES: u32 = 5;

impl LoginGuard {
    pub fn locked(&self, keys: &[String]) -> Option<u64> {
        let map = self.map.lock().unwrap();
        keys.iter()
            .filter_map(|k| map.get(k)?.locked_until)
            .filter(|t| *t > Instant::now())
            .map(|t| t.duration_since(Instant::now()).as_secs().max(1))
            .max()
    }

    /// Returns `true` if this failure just triggered a lockout.
    pub fn fail(&self, keys: &[String]) -> bool {
        let mut map = self.map.lock().unwrap();
        let mut locked_now = false;
        for k in keys {
            let a = map.entry(k.clone()).or_default();
            if a.window_start.is_none_or(|s| s.elapsed() > WINDOW) {
                a.window_start = Some(Instant::now());
                a.failures = 0;
            }
            a.failures += 1;
            if a.failures >= MAX_FAILURES {
                // 5, 10, 20, 40 min, capped at 60.
                let mins = (5u64 << a.lockouts.min(4)).min(60);
                a.locked_until = Some(Instant::now() + Duration::from_secs(mins * 60));
                a.lockouts += 1;
                a.failures = 0;
                locked_now = true;
            }
        }
        // Bound the table under attacks from many IPs.
        if map.len() > 50_000 {
            map.retain(|_, a| a.locked_until.is_some_and(|t| t > Instant::now()));
        }
        locked_now
    }

    pub fn success(&self, keys: &[String]) {
        let mut map = self.map.lock().unwrap();
        for k in keys {
            map.remove(k);
        }
    }

    fn accept_step(&self, user_id: &str, step: u64) -> bool {
        let mut last = self.last_step.lock().unwrap();
        if last.get(user_id).is_some_and(|&s| s >= step) {
            return false;
        }
        last.insert(user_id.to_owned(), step);
        true
    }
}

impl App {
    pub async fn two_factor_status(&self, user_id: &str) -> Result<TwoFactorStatus> {
        let (enabled, codes): (bool, Option<String>) =
            sqlx::query_as("SELECT totp_enabled, recovery_codes FROM users WHERE id = ?").bind(user_id).fetch_one(&self.db).await?;
        let left = codes.and_then(|c| serde_json::from_str::<Vec<String>>(&c).ok()).map(|v| v.len()).unwrap_or(0);
        Ok(TwoFactorStatus { enabled, recovery_codes_left: left })
    }

    /// The new secret stays pending until confirmed with a code.
    pub async fn begin_totp(&self, user_id: &str, username: &str) -> Result<TotpSetup> {
        let secret = random_bytes::<20>();
        sqlx::query("UPDATE users SET totp_pending_enc = ? WHERE id = ?")
            .bind(self.secrets.encrypt(&base32_encode(&secret)))
            .bind(user_id)
            .execute(&self.db)
            .await?;
        let b32 = base32_encode(&secret);
        let label: String = format!("NodePilot:{username}")
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b":-._".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect();
        Ok(TotpSetup { otpauth_url: format!("otpauth://totp/{label}?secret={b32}&issuer=NodePilot&digits=6&period=30"), secret: b32 })
    }

    pub async fn enable_totp(&self, user_id: &str, code: &str) -> Result<Vec<String>> {
        let pending: Option<String> =
            sqlx::query_scalar("SELECT totp_pending_enc FROM users WHERE id = ?").bind(user_id).fetch_one(&self.db).await?;
        let pending = pending.ok_or_else(|| bad("start two-factor setup first"))?;
        let secret = base32_decode(&self.secrets.decrypt(&pending)?).ok_or_else(|| Error::Internal("bad totp secret".into()))?;
        let step = verify_code(&secret, code, current_step()).ok_or_else(|| bad("invalid code — check the time on your phone"))?;
        self.login_guard.accept_step(user_id, step);
        let codes: Vec<String> = (0..RECOVERY_CODES)
            .map(|_| {
                let h = hex::encode(random_bytes::<5>());
                format!("{}-{}", &h[..5], &h[5..])
            })
            .collect();
        let hashes: Vec<String> = codes.iter().map(|c| hash_token(c)).collect();
        sqlx::query("UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = 1, recovery_codes = ? WHERE id = ?")
            .bind(serde_json::to_string(&hashes).unwrap())
            .bind(user_id)
            .execute(&self.db)
            .await?;
        Ok(codes)
    }

    pub async fn disable_totp(&self, user_id: &str, req: DisableTwoFactor) -> Result<()> {
        let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?").bind(user_id).fetch_one(&self.db).await?;
        if !verify_password(&req.password, &hash) {
            return Err(Error::Forbidden("wrong password".into()));
        }
        if !self.check_second_factor(user_id, &req.code).await? {
            return Err(Error::Forbidden("invalid two-factor code".into()));
        }
        sqlx::query(
            "UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, recovery_codes = NULL WHERE id = ?",
        )
        .bind(user_id)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    /// CLI-only reset: console access to the panel host already implies admin access.
    pub async fn reset_two_factor(&self, username: &str) -> Result<()> {
        let r = sqlx::query(
            "UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, recovery_codes = NULL WHERE username = ?",
        )
        .bind(username)
        .execute(&self.db)
        .await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("user"));
        }
        sqlx::query("DELETE FROM tokens WHERE kind = 'session' AND user_id = (SELECT id FROM users WHERE username = ?)")
            .bind(username)
            .execute(&self.db)
            .await?;
        self.audit(crate::audit::AuditEvent {
            actor: username.to_owned(),
            action: "auth:2fa-reset-cli".into(),
            outcome: "ok".into(),
            severity: crate::audit::Severity::Critical,
            ..Default::default()
        });
        Ok(())
    }

    pub async fn regenerate_recovery_codes(&self, user_id: &str, code: &str) -> Result<Vec<String>> {
        if !self.check_second_factor(user_id, code).await? {
            return Err(Error::Forbidden("invalid two-factor code".into()));
        }
        let codes: Vec<String> = (0..RECOVERY_CODES)
            .map(|_| {
                let h = hex::encode(random_bytes::<5>());
                format!("{}-{}", &h[..5], &h[5..])
            })
            .collect();
        let hashes: Vec<String> = codes.iter().map(|c| hash_token(c)).collect();
        sqlx::query("UPDATE users SET recovery_codes = ? WHERE id = ?")
            .bind(serde_json::to_string(&hashes).unwrap())
            .bind(user_id)
            .execute(&self.db)
            .await?;
        Ok(codes)
    }

    /// Recovery codes are single-use and consumed on success.
    pub(crate) async fn check_second_factor(&self, user_id: &str, code: &str) -> Result<bool> {
        let (secret, codes): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT totp_secret_enc, recovery_codes FROM users WHERE id = ?").bind(user_id).fetch_one(&self.db).await?;
        if let Some(enc) = secret {
            let secret = base32_decode(&self.secrets.decrypt(&enc)?).ok_or_else(|| Error::Internal("bad totp secret".into()))?;
            if let Some(step) = verify_code(&secret, code, current_step()) {
                return Ok(self.login_guard.accept_step(user_id, step));
            }
        }
        let normalized = code.trim().to_lowercase();
        if let Some(codes) = codes {
            let mut hashes: Vec<String> = serde_json::from_str(&codes).unwrap_or_default();
            let h = hash_token(&normalized);
            if let Some(i) = hashes.iter().position(|x| *x == h) {
                hashes.remove(i);
                sqlx::query("UPDATE users SET recovery_codes = ? WHERE id = ?")
                    .bind(serde_json::to_string(&hashes).unwrap())
                    .bind(user_id)
                    .execute(&self.db)
                    .await?;
                tracing::warn!(user = %user_id, left = hashes.len(), "recovery code used");
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_vectors() {
        // RFC 6238 SHA-1 test vectors (8 digits), truncated to the last 6.
        let secret = b"12345678901234567890";
        assert_eq!(hotp(secret, 59 / 30), 287082);
        assert_eq!(hotp(secret, 1111111109 / 30), 81804);
        assert_eq!(hotp(secret, 1234567890 / 30), 5924);
        let code = format!("{:06}", hotp(secret, 1000));
        assert_eq!(verify_code(secret, &code, 1001), Some(1000));
        assert_eq!(verify_code(secret, &code, 1003), None);
    }

    #[test]
    fn base32_roundtrip() {
        let data = random_bytes::<20>();
        assert_eq!(base32_decode(&base32_encode(&data)).unwrap(), data);
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn lockout() {
        let g = LoginGuard::default();
        let keys = vec!["ip:1.2.3.4".to_owned()];
        for _ in 0..4 {
            assert!(!g.fail(&keys));
        }
        assert!(g.locked(&keys).is_none());
        assert!(g.fail(&keys));
        assert!(g.locked(&keys).is_some_and(|s| s > 200));
    }
}
