use crate::error::bad;
use crate::models::{Note, NoteFilter, NoteInput};
use crate::{App, Error, Result, new_id, now};

macro_rules! select_sql {
    () => {
        "SELECT id, title, body, project_id, server_id, pinned, created_at, updated_at FROM notes"
    };
}

impl App {
    pub async fn list_notes(&self, f: &NoteFilter) -> Result<Vec<Note>> {
        Ok(sqlx::query_as(concat!(
            select_sql!(),
            " WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR server_id = ?2)
             ORDER BY pinned DESC, updated_at DESC"
        ))
        .bind(&f.project_id)
        .bind(&f.server_id)
        .fetch_all(&self.db)
        .await?)
    }

    pub async fn get_note(&self, id: &str) -> Result<Note> {
        sqlx::query_as(concat!(select_sql!(), " WHERE id = ?")).bind(id).fetch_optional(&self.db).await?.ok_or(Error::NotFound("note"))
    }

    pub async fn create_note(&self, input: NoteInput) -> Result<Note> {
        let title = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| bad("title is required"))?;
        let id = new_id();
        sqlx::query(
            "INSERT INTO notes (id, title, body, project_id, server_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(title)
        .bind(input.body.unwrap_or_default())
        .bind(input.project_id.flatten())
        .bind(input.server_id.flatten())
        .bind(input.pinned.unwrap_or(false))
        .bind(now())
        .bind(now())
        .execute(&self.db)
        .await?;
        self.get_note(&id).await
    }

    pub async fn update_note(&self, id: &str, input: NoteInput) -> Result<Note> {
        let cur = self.get_note(id).await?;
        let title = match input.title {
            Some(t) if t.trim().is_empty() => return Err(bad("title cannot be empty")),
            Some(t) => t.trim().to_owned(),
            None => cur.title,
        };
        sqlx::query("UPDATE notes SET title = ?, body = ?, project_id = ?, server_id = ?, pinned = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(input.body.unwrap_or(cur.body))
            .bind(input.project_id.unwrap_or(cur.project_id))
            .bind(input.server_id.unwrap_or(cur.server_id))
            .bind(input.pinned.unwrap_or(cur.pinned))
            .bind(now())
            .bind(id)
            .execute(&self.db)
            .await?;
        self.get_note(id).await
    }

    pub async fn delete_note(&self, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM notes WHERE id = ?").bind(id).execute(&self.db).await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("note"));
        }
        Ok(())
    }
}
