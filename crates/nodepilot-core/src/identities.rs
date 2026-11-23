use crate::error::bad;
use crate::models::{Identity, IdentityInput};
use crate::{App, Error, Result, new_id, now};

macro_rules! select_sql {
    () => {
        "SELECT i.id, i.name, i.kind, i.created_at,
    (SELECT COUNT(*) FROM servers s WHERE s.identity_id = i.id) AS server_count
    FROM identities i"
    };
}

pub(crate) fn validate_secret(
    kind: &str,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
) -> Result<(String, Option<String>)> {
    match kind {
        "password" => {
            let p = password.filter(|p| !p.is_empty()).ok_or_else(|| bad("password is required"))?;
            Ok((p, None))
        }
        "key" => {
            let key =
                private_key.map(|k| k.trim().to_owned() + "\n").filter(|k| k.len() > 1).ok_or_else(|| bad("private_key is required"))?;
            let passphrase = passphrase.filter(|p| !p.is_empty());
            nodepilot_ssh::check_private_key(&key, passphrase.as_deref()).map_err(|e| bad(e.to_string()))?;
            Ok((key, passphrase))
        }
        _ => Err(bad("kind must be 'password' or 'key'")),
    }
}

impl App {
    pub async fn list_identities(&self) -> Result<Vec<Identity>> {
        Ok(sqlx::query_as(concat!(select_sql!(), " ORDER BY i.name COLLATE NOCASE")).fetch_all(&self.db).await?)
    }

    pub async fn get_identity(&self, id: &str) -> Result<Identity> {
        sqlx::query_as(concat!(select_sql!(), " WHERE i.id = ?"))
            .bind(id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(Error::NotFound("identity"))
    }

    pub async fn create_identity(&self, input: IdentityInput) -> Result<Identity> {
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("name is required"))?;
        let kind = input.kind.as_deref().unwrap_or("password");
        let (secret, passphrase) = validate_secret(kind, input.password, input.private_key, input.passphrase)?;
        let id = new_id();
        sqlx::query("INSERT INTO identities (id, name, kind, secret_enc, passphrase_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(name)
            .bind(kind)
            .bind(self.secrets.encrypt(&secret))
            .bind(self.secrets.encrypt_opt(passphrase.as_deref()))
            .bind(now())
            .execute(&self.db)
            .await?;
        self.get_identity(&id).await
    }

    pub async fn update_identity(&self, id: &str, input: IdentityInput) -> Result<Identity> {
        let cur = self.get_identity(id).await?;
        if let Some(name) = input.name.as_deref().map(str::trim) {
            if name.is_empty() {
                return Err(bad("name cannot be empty"));
            }
            sqlx::query("UPDATE identities SET name = ? WHERE id = ?").bind(name).bind(id).execute(&self.db).await?;
        }
        // Secrets are write-only: omitted means keep the stored ones.
        let has_secret = |s: &Option<String>| s.as_deref().is_some_and(|v| !v.is_empty());
        let new_secret = has_secret(&input.password) || has_secret(&input.private_key);
        if !new_secret && input.kind.as_deref().is_some_and(|k| k != cur.kind) {
            return Err(bad("changing kind requires a new password or private_key"));
        }
        if new_secret {
            let kind = input.kind.unwrap_or(cur.kind);
            let (secret, passphrase) = validate_secret(&kind, input.password, input.private_key, input.passphrase)?;
            sqlx::query("UPDATE identities SET kind = ?, secret_enc = ?, passphrase_enc = ? WHERE id = ?")
                .bind(&kind)
                .bind(self.secrets.encrypt(&secret))
                .bind(self.secrets.encrypt_opt(passphrase.as_deref()))
                .bind(id)
                .execute(&self.db)
                .await?;
            let servers: Vec<String> =
                sqlx::query_scalar("SELECT id FROM servers WHERE identity_id = ?").bind(id).fetch_all(&self.db).await?;
            for s in servers {
                self.ssh.invalidate(&s).await;
            }
        }
        self.get_identity(id).await
    }

    pub async fn delete_identity(&self, id: &str) -> Result<()> {
        let cur = self.get_identity(id).await?;
        if cur.server_count > 0 {
            return Err(Error::Conflict(format!("identity is used by {} server(s)", cur.server_count)));
        }
        sqlx::query("DELETE FROM identities WHERE id = ?").bind(id).execute(&self.db).await?;
        Ok(())
    }
}
