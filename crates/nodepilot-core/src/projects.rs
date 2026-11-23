use crate::error::bad;
use crate::models::{Project, ProjectInput};
use crate::{App, Error, Result, new_id, now};

macro_rules! select_sql {
    () => {
        "SELECT p.id, p.name, p.description, p.color, p.created_at, p.updated_at,
    (SELECT COUNT(*) FROM project_servers ps WHERE ps.project_id = p.id) AS server_count
    FROM projects p"
    };
}

impl App {
    pub async fn list_projects(&self) -> Result<Vec<Project>> {
        Ok(sqlx::query_as(concat!(select_sql!(), " ORDER BY p.name COLLATE NOCASE")).fetch_all(&self.db).await?)
    }

    pub async fn get_project(&self, id: &str) -> Result<Project> {
        sqlx::query_as(concat!(select_sql!(), " WHERE p.id = ?")).bind(id).fetch_optional(&self.db).await?.ok_or(Error::NotFound("project"))
    }

    pub async fn create_project(&self, input: ProjectInput) -> Result<Project> {
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("name is required"))?;
        let id = new_id();
        sqlx::query("INSERT INTO projects (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(name)
            .bind(input.description.unwrap_or_default())
            .bind(input.color)
            .bind(now())
            .bind(now())
            .execute(&self.db)
            .await?;
        self.get_project(&id).await
    }

    pub async fn update_project(&self, id: &str, input: ProjectInput) -> Result<Project> {
        let cur = self.get_project(id).await?;
        let name = match input.name {
            Some(n) if n.trim().is_empty() => return Err(bad("name cannot be empty")),
            Some(n) => n.trim().to_owned(),
            None => cur.name,
        };
        sqlx::query("UPDATE projects SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(input.description.unwrap_or(cur.description))
            .bind(input.color.or(cur.color))
            .bind(now())
            .bind(id)
            .execute(&self.db)
            .await?;
        self.get_project(id).await
    }

    pub async fn delete_project(&self, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM projects WHERE id = ?").bind(id).execute(&self.db).await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("project"));
        }
        Ok(())
    }

    pub async fn add_server_to_project(&self, project_id: &str, server_id: &str) -> Result<()> {
        self.get_project(project_id).await?;
        self.get_server(server_id).await?;
        sqlx::query("INSERT OR IGNORE INTO project_servers (project_id, server_id) VALUES (?, ?)")
            .bind(project_id)
            .bind(server_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }

    pub async fn remove_server_from_project(&self, project_id: &str, server_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM project_servers WHERE project_id = ? AND server_id = ?")
            .bind(project_id)
            .bind(server_id)
            .execute(&self.db)
            .await?;
        Ok(())
    }
}
