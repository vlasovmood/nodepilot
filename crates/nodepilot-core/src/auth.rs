use chrono::Duration;

use crate::access::{Permissions, Principal, TokenRef};
use crate::crypto::{hash_password, hash_token, new_token, verify_password};
use crate::error::bad;
use crate::models::{ApiToken, Credentials, TokenInput, Ts, User};
use crate::{App, Error, Result, new_id, now};

const SESSION_DAYS: i64 = 30;

macro_rules! token_sql {
    () => {
        "SELECT id, name, created_at, last_used_at, expires_at, permissions FROM tokens"
    };
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: String,
    name: String,
    created_at: Ts,
    last_used_at: Option<Ts>,
    expires_at: Option<Ts>,
    permissions: Option<String>,
}

impl TokenRow {
    fn into_api(self) -> Result<ApiToken> {
        let permissions = match self.permissions {
            Some(json) => serde_json::from_str(&json).map_err(|e| Error::Internal(format!("corrupt token permissions: {e}")))?,
            None => Permissions::full(),
        };
        Ok(ApiToken {
            id: self.id,
            name: self.name,
            created_at: self.created_at,
            last_used_at: self.last_used_at,
            expires_at: self.expires_at,
            permissions,
        })
    }
}

fn expiry(days: Option<u32>) -> Result<Option<Ts>> {
    match days {
        None | Some(0) => Ok(None),
        Some(d) if d <= 3650 => Ok(Some(now() + Duration::days(d as i64))),
        Some(_) => Err(bad("expires_in_days must be 0..3650")),
    }
}

impl App {
    pub async fn setup_required(&self) -> Result<bool> {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&self.db).await?;
        Ok(n == 0)
    }

    pub async fn create_user(&self, creds: &Credentials) -> Result<User> {
        let username = creds.username.trim();
        if username.is_empty() {
            return Err(bad("username is required"));
        }
        if creds.password.chars().count() < 8 {
            return Err(bad("password must be at least 8 characters"));
        }
        let user = User { id: new_id(), username: username.to_owned(), created_at: now() };
        sqlx::query("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
            .bind(&user.id)
            .bind(&user.username)
            .bind(hash_password(&creds.password)?)
            .bind(user.created_at)
            .execute(&self.db)
            .await?;
        Ok(user)
    }

    pub async fn setup(&self, creds: &Credentials) -> Result<(String, User)> {
        // Serialize concurrent setup requests so two admins can't be created.
        static SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = SETUP.lock().await;
        if !self.setup_required().await? {
            return Err(Error::Conflict("setup already completed".into()));
        }
        let user = self.create_user(creds).await?;
        let token = self.issue_token(&user.id, "session", "").await?;
        Ok((token, user))
    }

    pub async fn login(&self, creds: &Credentials, ip: Option<&str>) -> Result<(String, User)> {
        let keys: Vec<String> =
            [Some(format!("user:{}", creds.username.trim().to_lowercase())), ip.map(|i| format!("ip:{i}"))].into_iter().flatten().collect();
        if let Some(wait) = self.login_guard.locked(&keys) {
            return Err(Error::TooManyAttempts(wait));
        }
        let fail = |app: &App| {
            if app.login_guard.fail(&keys) {
                tracing::warn!(user = %creds.username, ?ip, "login locked after repeated failures");
            }
            Error::Unauthorized
        };
        let row: Option<(String, String, String, crate::models::Ts, bool)> =
            sqlx::query_as("SELECT id, username, password_hash, created_at, totp_enabled FROM users WHERE username = ?")
                .bind(creds.username.trim())
                .fetch_optional(&self.db)
                .await?;
        // Hash anyway when the user doesn't exist so response timing doesn't reveal valid usernames.
        let Some((id, username, hash, created_at, totp)) = row else {
            let _ =
                verify_password(&creds.password, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
            return Err(fail(self));
        };
        if !verify_password(&creds.password, &hash) {
            return Err(fail(self));
        }
        if totp {
            match creds.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                None => return Err(Error::TwoFactorRequired),
                Some(code) => {
                    if !self.check_second_factor(&id, code).await? {
                        return Err(fail(self));
                    }
                }
            }
        }
        self.login_guard.success(&keys);
        let token = self.issue_token(&id, "session", "").await?;
        Ok((token, User { id, username, created_at }))
    }

    async fn issue_token(&self, user_id: &str, kind: &str, name: &str) -> Result<String> {
        let token = new_token();
        let expires = (kind == "session").then(|| now() + Duration::days(SESSION_DAYS));
        sqlx::query("INSERT INTO tokens (id, user_id, kind, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(new_id())
            .bind(user_id)
            .bind(kind)
            .bind(name)
            .bind(hash_token(&token))
            .bind(now())
            .bind(expires)
            .execute(&self.db)
            .await?;
        Ok(token)
    }

    pub async fn authenticate(&self, token: &str) -> Result<Principal> {
        let hash = hash_token(token);
        type Row = (String, String, Ts, String, String, String, Option<String>);
        let row: Option<Row> = sqlx::query_as(
            "SELECT u.id, u.username, u.created_at, t.id, t.kind, t.name, t.permissions FROM tokens t JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)",
        )
        .bind(&hash)
        .bind(now())
        .fetch_optional(&self.db)
        .await?;
        let (uid, username, created_at, token_id, kind, name, perms) = row.ok_or(Error::Unauthorized)?;
        // Update last_used_at at most once a minute to avoid a DB write on every request.
        sqlx::query("UPDATE tokens SET last_used_at = ? WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < ?)")
            .bind(now())
            .bind(&hash)
            .bind(now() - Duration::minutes(1))
            .execute(&self.db)
            .await?;
        let user = User { id: uid, username, created_at };
        if kind == "session" {
            return Ok(Principal { user, token: None, perms: Permissions::full(), ip: None });
        }
        let perms = match perms {
            Some(json) => serde_json::from_str(&json).map_err(|e| Error::Internal(format!("corrupt token permissions: {e}")))?,
            None => Permissions::full(),
        };
        Ok(Principal { user, token: Some(TokenRef { id: token_id, name }), perms, ip: None })
    }

    pub async fn logout(&self, token: &str) -> Result<()> {
        sqlx::query("DELETE FROM tokens WHERE token_hash = ? AND kind = 'session'").bind(hash_token(token)).execute(&self.db).await?;
        Ok(())
    }

    pub async fn list_api_tokens(&self, user_id: &str) -> Result<Vec<ApiToken>> {
        let rows: Vec<TokenRow> = sqlx::query_as(concat!(token_sql!(), " WHERE user_id = ? AND kind = 'api' ORDER BY created_at DESC"))
            .bind(user_id)
            .fetch_all(&self.db)
            .await?;
        rows.into_iter().map(TokenRow::into_api).collect()
    }

    async fn get_api_token(&self, user_id: &str, id: &str) -> Result<ApiToken> {
        let row: TokenRow = sqlx::query_as(concat!(token_sql!(), " WHERE id = ? AND user_id = ? AND kind = 'api'"))
            .bind(id)
            .bind(user_id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("token"))?;
        row.into_api()
    }

    pub async fn create_api_token(&self, issuer: &Principal, input: TokenInput) -> Result<(String, ApiToken)> {
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("token name is required"))?;
        let perms = input.permissions.unwrap_or_else(Permissions::full).normalized();
        if !issuer.perms.covers(&perms) {
            return Err(Error::Forbidden("cannot issue a token with more access than your own".into()));
        }
        let expires = expiry(input.expires_in_days)?;
        let token = new_token();
        let id = new_id();
        sqlx::query(
            "INSERT INTO tokens (id, user_id, kind, name, token_hash, created_at, expires_at, permissions) VALUES (?, ?, 'api', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&issuer.user.id)
        .bind(name)
        .bind(hash_token(&token))
        .bind(now())
        .bind(expires)
        .bind(serde_json::to_string(&perms).unwrap())
        .execute(&self.db)
        .await?;
        Ok((token, self.get_api_token(&issuer.user.id, &id).await?))
    }

    pub async fn update_api_token(&self, issuer: &Principal, id: &str, input: TokenInput) -> Result<ApiToken> {
        let cur = self.get_api_token(&issuer.user.id, id).await?;
        let name = match input.name.as_deref().map(str::trim) {
            Some("") => return Err(bad("token name cannot be empty")),
            Some(n) => n.to_owned(),
            None => cur.name,
        };
        let perms = input.permissions.map(Permissions::normalized).unwrap_or(cur.permissions);
        if !issuer.perms.covers(&perms) {
            return Err(Error::Forbidden("cannot grant more access than your own".into()));
        }
        let expires = match input.expires_in_days {
            Some(days) => expiry(Some(days))?,
            None => cur.expires_at,
        };
        sqlx::query("UPDATE tokens SET name = ?, permissions = ?, expires_at = ? WHERE id = ?")
            .bind(name)
            .bind(serde_json::to_string(&perms).unwrap())
            .bind(expires)
            .bind(id)
            .execute(&self.db)
            .await?;
        self.get_api_token(&issuer.user.id, id).await
    }

    pub async fn delete_api_token(&self, user_id: &str, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM tokens WHERE id = ? AND user_id = ? AND kind = 'api'")
            .bind(id)
            .bind(user_id)
            .execute(&self.db)
            .await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("token"));
        }
        Ok(())
    }

    pub async fn user_principal(&self, username: &str) -> Result<Principal> {
        let user: User = sqlx::query_as("SELECT id, username, created_at FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("user"))?;
        Ok(Principal { user, token: None, perms: Permissions::full(), ip: None })
    }

    pub async fn local_principal(&self) -> Result<Principal> {
        let user: User = sqlx::query_as("SELECT id, username, created_at FROM users ORDER BY created_at LIMIT 1")
            .fetch_optional(&self.db)
            .await?
            .ok_or_else(|| bad("no users yet: open the panel and create the administrator first"))?;
        Ok(Principal { user, token: None, perms: Permissions::full(), ip: None })
    }

    pub async fn user_id(&self, username: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar("SELECT id FROM users WHERE username = ?").bind(username).fetch_optional(&self.db).await?)
    }

    pub async fn set_password(&self, username: &str, password: &str) -> Result<()> {
        if password.chars().count() < 8 {
            return Err(bad("password must be at least 8 characters"));
        }
        let r = sqlx::query("UPDATE users SET password_hash = ? WHERE username = ?")
            .bind(hash_password(password)?)
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
        Ok(())
    }
}
