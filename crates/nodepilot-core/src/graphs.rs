use schemars::JsonSchema;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::bad;
use crate::models::{Ts, double_option};
use crate::{App, Error, Result, new_id, now};

const MAX_DOC_BYTES: usize = 4 * 1024 * 1024;
const MAX_NODES: usize = 5000;
const MAX_EDGES: usize = 20000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, JsonSchema)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphNode {
    pub id: String,
    /// `node` is a service or server, `note` is a canvas note.
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default)]
    pub label: String,
    /// api | db | vpn | lb | cache | queue | storage | web | internet | other
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub label: String,
    /// link | depends | cascade | vpn | replication | other
    #[serde(default = "default_edge_kind")]
    pub kind: String,
    #[serde(default)]
    pub directed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "sourceHandle")]
    pub source_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "targetHandle")]
    pub target_handle: Option<String>,
}

fn default_edge_kind() -> String {
    "link".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, JsonSchema)]
pub struct GraphDoc {
    #[serde(default)]
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub edges: Vec<GraphEdge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<Viewport>,
}

impl GraphDoc {
    fn validate(&self) -> Result<()> {
        if self.nodes.len() > MAX_NODES || self.edges.len() > MAX_EDGES {
            return Err(bad(format!("graph is too large (max {MAX_NODES} nodes, {MAX_EDGES} edges)")));
        }
        let mut ids = HashSet::new();
        for n in &self.nodes {
            if n.id.is_empty() || !ids.insert(n.id.as_str()) {
                return Err(bad(format!("duplicate or empty node id '{}'", n.id)));
            }
            if n.kind != "node" && n.kind != "note" {
                return Err(bad(format!("node {}: type must be 'node' or 'note'", n.id)));
            }
            if !n.x.is_finite() || !n.y.is_finite() {
                return Err(bad(format!("node {}: invalid position", n.id)));
            }
        }
        let mut edge_ids = HashSet::new();
        for e in &self.edges {
            if e.id.is_empty() || !edge_ids.insert(e.id.as_str()) {
                return Err(bad(format!("duplicate or empty edge id '{}'", e.id)));
            }
            if !ids.contains(e.source.as_str()) || !ids.contains(e.target.as_str()) {
                return Err(bad(format!("edge {} refers to a missing node", e.id)));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct GraphSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_id: Option<String>,
    pub node_count: usize,
    pub edge_count: usize,
    pub version: i64,
    pub created_at: Ts,
    pub updated_at: Ts,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct Graph {
    #[serde(flatten)]
    pub summary: GraphSummary,
    pub doc: GraphDoc,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GraphInput {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub project_id: Option<Option<String>>,
    pub doc: Option<GraphDoc>,
    /// For PUT/PATCH: the version the client edited. A mismatch returns 409.
    pub version: Option<i64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GraphFilter {
    pub project_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct GraphRow {
    id: String,
    name: String,
    description: String,
    project_id: Option<String>,
    doc: String,
    version: i64,
    created_at: Ts,
    updated_at: Ts,
}

impl GraphRow {
    fn into_graph(self) -> Result<Graph> {
        let doc: GraphDoc = serde_json::from_str(&self.doc).map_err(|e| Error::Internal(format!("corrupt graph {}: {e}", self.id)))?;
        Ok(Graph {
            summary: GraphSummary {
                id: self.id,
                name: self.name,
                description: self.description,
                project_id: self.project_id,
                node_count: doc.nodes.len(),
                edge_count: doc.edges.len(),
                version: self.version,
                created_at: self.created_at,
                updated_at: self.updated_at,
            },
            doc,
        })
    }
}

fn encode(doc: &GraphDoc) -> Result<String> {
    doc.validate()?;
    let json = serde_json::to_string(doc).map_err(|e| Error::Internal(e.to_string()))?;
    if json.len() > MAX_DOC_BYTES {
        return Err(bad("graph document is too large (max 4 MiB)"));
    }
    Ok(json)
}

impl App {
    pub async fn list_graphs(&self, f: &GraphFilter) -> Result<Vec<GraphSummary>> {
        let rows: Vec<GraphRow> = sqlx::query_as(
            "SELECT id, name, description, project_id, doc, version, created_at, updated_at FROM graphs
             WHERE (?1 IS NULL OR project_id = ?1) ORDER BY name COLLATE NOCASE",
        )
        .bind(&f.project_id)
        .fetch_all(&self.db)
        .await?;
        rows.into_iter().map(|r| r.into_graph().map(|g| g.summary)).collect()
    }

    pub async fn get_graph(&self, id: &str) -> Result<Graph> {
        let row: GraphRow =
            sqlx::query_as("SELECT id, name, description, project_id, doc, version, created_at, updated_at FROM graphs WHERE id = ?")
                .bind(id)
                .fetch_optional(&self.db)
                .await?
                .ok_or(Error::NotFound("graph"))?;
        row.into_graph()
    }

    pub async fn create_graph(&self, input: GraphInput) -> Result<Graph> {
        let name = input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad("name is required"))?;
        let project_id = input.project_id.flatten();
        if let Some(p) = &project_id {
            self.get_project(p).await?;
        }
        let doc = encode(&input.doc.unwrap_or_default())?;
        let id = new_id();
        sqlx::query(
            "INSERT INTO graphs (id, name, description, project_id, doc, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(input.description.unwrap_or_default())
        .bind(project_id)
        .bind(doc)
        .bind(now())
        .bind(now())
        .execute(&self.db)
        .await?;
        self.get_graph(&id).await
    }

    pub async fn update_graph(&self, id: &str, input: GraphInput) -> Result<Graph> {
        let cur = self.get_graph(id).await?;
        if let Some(v) = input.version
            && v != cur.summary.version
        {
            return Err(Error::Conflict(format!(
                "graph was changed elsewhere (your version {v}, current {}); reload it",
                cur.summary.version
            )));
        }
        let name = match input.name.as_deref().map(str::trim) {
            Some("") => return Err(bad("name cannot be empty")),
            Some(n) => n.to_owned(),
            None => cur.summary.name,
        };
        let project_id = match input.project_id {
            Some(Some(p)) => {
                self.get_project(&p).await?;
                Some(p)
            }
            Some(None) => None,
            None => cur.summary.project_id,
        };
        let doc = match &input.doc {
            Some(d) => encode(d)?,
            None => encode(&cur.doc)?,
        };
        let r = sqlx::query(
            "UPDATE graphs SET name = ?, description = ?, project_id = ?, doc = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?",
        )
        .bind(name)
        .bind(input.description.unwrap_or(cur.summary.description))
        .bind(project_id)
        .bind(doc)
        .bind(now())
        .bind(id)
        .bind(cur.summary.version)
        .execute(&self.db)
        .await?;
        if r.rows_affected() == 0 {
            return Err(Error::Conflict("graph was changed concurrently; reload it".into()));
        }
        self.get_graph(id).await
    }

    pub async fn delete_graph(&self, id: &str) -> Result<()> {
        let r = sqlx::query("DELETE FROM graphs WHERE id = ?").bind(id).execute(&self.db).await?;
        if r.rows_affected() == 0 {
            return Err(Error::NotFound("graph"));
        }
        Ok(())
    }
}

// ---------- node and edge operations (API and AI agents) ----------

pub const NODE_ROLES: &[&str] = &["server", "api", "web", "db", "cache", "queue", "storage", "lb", "vpn", "internet", "other"];
pub const EDGE_KINDS: &[&str] = &["link", "depends", "cascade", "vpn", "replication", "other"];

/// Node to add or update. In PATCH send only changed fields; `null` clears optional ones.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct NodeInput {
    /// `node` (default) or `note` (a canvas note).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub label: Option<String>,
    /// server | api | web | db | cache | queue | storage | lb | vpn | internet | other
    #[serde(default, deserialize_with = "double_option")]
    pub role: Option<Option<String>>,
    /// Linked panel server.
    #[serde(default, deserialize_with = "double_option")]
    pub server_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    /// Node note, or the text of a canvas note.
    pub note: Option<String>,
    /// Position; if omitted when adding, the node is placed in free space.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct EdgeInput {
    /// Source node id (optional when updating).
    pub source: Option<String>,
    pub target: Option<String>,
    pub label: Option<String>,
    /// link | depends | cascade | vpn | replication | other
    pub kind: Option<String>,
    pub directed: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    pub note: Option<String>,
}

fn check_role(role: &Option<String>) -> Result<()> {
    match role {
        Some(r) if !NODE_ROLES.contains(&r.as_str()) => Err(bad(format!("unknown role '{r}', expected one of: {}", NODE_ROLES.join(", ")))),
        _ => Ok(()),
    }
}

fn check_kind(kind: &str) -> Result<()> {
    if EDGE_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(bad(format!("unknown edge kind '{kind}', expected one of: {}", EDGE_KINDS.join(", "))))
    }
}

fn free_position(doc: &GraphDoc, w: f64, h: f64) -> (f64, f64) {
    const GAP: f64 = 80.0;
    let rects: Vec<(f64, f64, f64, f64)> = doc
        .nodes
        .iter()
        .map(|n| (n.x, n.y, n.width.unwrap_or(220.0), n.height.unwrap_or(if n.kind == "note" { 140.0 } else { 80.0 })))
        .collect();
    let free = |x: f64, y: f64| {
        rects.iter().all(|&(rx, ry, rw, rh)| x + w + GAP <= rx || rx + rw + GAP <= x || y + h + GAP <= ry || ry + rh + GAP <= y)
    };
    for i in 0..10_000 {
        let (col, row) = (i % 6, i / 6);
        let (x, y) = (col as f64 * (220.0 + GAP), row as f64 * (h.max(80.0) + GAP));
        if free(x, y) {
            return (x, y);
        }
    }
    (0.0, 0.0)
}

impl App {
    /// Retries on concurrent edits (e.g. the graph is open in a browser).
    async fn mutate_graph<T>(&self, id: &str, mut f: impl FnMut(&mut GraphDoc) -> Result<T>) -> Result<T> {
        for _ in 0..5 {
            let g = self.get_graph(id).await?;
            let mut doc = g.doc;
            let out = f(&mut doc)?;
            let input = GraphInput { doc: Some(doc), version: Some(g.summary.version), ..Default::default() };
            match self.update_graph(id, input).await {
                Ok(_) => return Ok(out),
                Err(Error::Conflict(_)) => continue,
                Err(e) => return Err(e),
            }
        }
        Err(Error::Conflict("graph is being edited concurrently, try again".into()))
    }

    async fn check_server_ref(&self, server_id: &Option<Option<String>>) -> Result<()> {
        if let Some(Some(sid)) = server_id {
            self.get_server(sid).await?;
        }
        Ok(())
    }

    pub async fn add_graph_node(&self, graph_id: &str, input: NodeInput) -> Result<GraphNode> {
        let kind = input.kind.clone().unwrap_or_else(|| "node".into());
        if kind != "node" && kind != "note" {
            return Err(bad("type must be 'node' or 'note'"));
        }
        let role = input.role.clone().flatten().or_else(|| (kind == "node").then(|| "other".to_owned()));
        check_role(&role)?;
        self.check_server_ref(&input.server_id).await?;
        let mut label = input.label.clone().unwrap_or_default();
        if label.is_empty()
            && let Some(Some(sid)) = &input.server_id
        {
            label = self.get_server(sid).await?.name;
        }
        self.mutate_graph(graph_id, |doc| {
            let (w, h) = if kind == "note" { (input.width.unwrap_or(220.0), input.height.unwrap_or(140.0)) } else { (220.0, 80.0) };
            let (x, y) = match (input.x, input.y) {
                (Some(x), Some(y)) => (x, y),
                _ => free_position(doc, w, h),
            };
            let node = GraphNode {
                id: format!("n-{}", &new_id()[..8]),
                kind: kind.clone(),
                x,
                y,
                width: (kind == "note").then_some(w),
                height: (kind == "note").then_some(h),
                label: label.clone(),
                role: role.clone(),
                server_id: input.server_id.clone().flatten(),
                color: input.color.clone().flatten(),
                note: input.note.clone().unwrap_or_default(),
            };
            doc.nodes.push(node.clone());
            Ok(node)
        })
        .await
    }

    pub async fn update_graph_node(&self, graph_id: &str, node_id: &str, input: NodeInput) -> Result<GraphNode> {
        if let Some(r) = &input.role {
            check_role(r)?;
        }
        self.check_server_ref(&input.server_id).await?;
        self.mutate_graph(graph_id, |doc| {
            let n = doc.nodes.iter_mut().find(|n| n.id == node_id).ok_or(Error::NotFound("graph node"))?;
            if let Some(k) = &input.kind {
                if k != "node" && k != "note" {
                    return Err(bad("type must be 'node' or 'note'"));
                }
                n.kind = k.clone();
            }
            if let Some(v) = &input.label {
                n.label = v.clone();
            }
            if let Some(v) = &input.role {
                n.role = v.clone();
            }
            if let Some(v) = &input.server_id {
                n.server_id = v.clone();
            }
            if let Some(v) = &input.color {
                n.color = v.clone();
            }
            if let Some(v) = &input.note {
                n.note = v.clone();
            }
            if let Some(v) = input.x {
                n.x = v;
            }
            if let Some(v) = input.y {
                n.y = v;
            }
            if input.width.is_some() {
                n.width = input.width;
            }
            if input.height.is_some() {
                n.height = input.height;
            }
            Ok(n.clone())
        })
        .await
    }

    pub async fn remove_graph_node(&self, graph_id: &str, node_id: &str) -> Result<()> {
        self.mutate_graph(graph_id, |doc| {
            let before = doc.nodes.len();
            doc.nodes.retain(|n| n.id != node_id);
            if doc.nodes.len() == before {
                return Err(Error::NotFound("graph node"));
            }
            doc.edges.retain(|e| e.source != node_id && e.target != node_id);
            Ok(())
        })
        .await
    }

    pub async fn add_graph_edge(&self, graph_id: &str, input: EdgeInput) -> Result<GraphEdge> {
        let source = input.source.clone().ok_or_else(|| bad("source is required"))?;
        let target = input.target.clone().ok_or_else(|| bad("target is required"))?;
        if source == target {
            return Err(bad("source and target must be different nodes"));
        }
        let kind = input.kind.clone().unwrap_or_else(|| "link".into());
        check_kind(&kind)?;
        self.mutate_graph(graph_id, |doc| {
            for nid in [&source, &target] {
                if !doc.nodes.iter().any(|n| &n.id == nid) {
                    return Err(bad(format!("node '{nid}' does not exist in this graph")));
                }
            }
            let edge = GraphEdge {
                id: format!("e-{}", &new_id()[..8]),
                source: source.clone(),
                target: target.clone(),
                label: input.label.clone().unwrap_or_default(),
                directed: input.directed.unwrap_or(matches!(kind.as_str(), "depends" | "cascade" | "replication")),
                kind: kind.clone(),
                color: input.color.clone().flatten(),
                note: input.note.clone().unwrap_or_default(),
                source_handle: None,
                target_handle: None,
            };
            doc.edges.push(edge.clone());
            Ok(edge)
        })
        .await
    }

    pub async fn update_graph_edge(&self, graph_id: &str, edge_id: &str, input: EdgeInput) -> Result<GraphEdge> {
        if let Some(k) = &input.kind {
            check_kind(k)?;
        }
        self.mutate_graph(graph_id, |doc| {
            for nid in [&input.source, &input.target].into_iter().flatten() {
                if !doc.nodes.iter().any(|n| &n.id == nid) {
                    return Err(bad(format!("node '{nid}' does not exist in this graph")));
                }
            }
            let e = doc.edges.iter_mut().find(|e| e.id == edge_id).ok_or(Error::NotFound("graph edge"))?;
            if let Some(v) = &input.source {
                e.source = v.clone();
                e.source_handle = None;
            }
            if let Some(v) = &input.target {
                e.target = v.clone();
                e.target_handle = None;
            }
            if e.source == e.target {
                return Err(bad("source and target must be different nodes"));
            }
            if let Some(v) = &input.label {
                e.label = v.clone();
            }
            if let Some(v) = &input.kind {
                e.kind = v.clone();
            }
            if let Some(v) = input.directed {
                e.directed = v;
            }
            if let Some(v) = &input.color {
                e.color = v.clone();
            }
            if let Some(v) = &input.note {
                e.note = v.clone();
            }
            Ok(e.clone())
        })
        .await
    }

    pub async fn remove_graph_edge(&self, graph_id: &str, edge_id: &str) -> Result<()> {
        self.mutate_graph(graph_id, |doc| {
            let before = doc.edges.len();
            doc.edges.retain(|e| e.id != edge_id);
            if doc.edges.len() == before {
                return Err(Error::NotFound("graph edge"));
            }
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> GraphNode {
        GraphNode {
            id: id.into(),
            kind: "node".into(),
            x: 0.0,
            y: 0.0,
            width: None,
            height: None,
            label: id.into(),
            role: None,
            server_id: None,
            color: None,
            note: String::new(),
        }
    }

    #[test]
    fn validation() {
        let edge = |s: &str, t: &str| GraphEdge {
            id: format!("{s}-{t}"),
            source: s.into(),
            target: t.into(),
            label: String::new(),
            kind: "cascade".into(),
            directed: true,
            color: None,
            note: "через VPN".into(),
            source_handle: None,
            target_handle: None,
        };
        let ok = GraphDoc { nodes: vec![node("api"), node("db")], edges: vec![edge("api", "db")], viewport: None };
        assert!(ok.validate().is_ok());
        let dangling = GraphDoc { nodes: vec![node("api")], edges: vec![edge("api", "db")], viewport: None };
        assert!(dangling.validate().is_err());
        let dup = GraphDoc { nodes: vec![node("a"), node("a")], edges: vec![], viewport: None };
        assert!(dup.validate().is_err());
        // Unknown fields from the frontend are ignored.
        let parsed: GraphDoc = serde_json::from_str(r#"{"nodes":[{"id":"x","type":"note","x":1,"y":2,"note":"hi","extra":1}]}"#).unwrap();
        assert_eq!(parsed.nodes[0].note, "hi");
    }
}
