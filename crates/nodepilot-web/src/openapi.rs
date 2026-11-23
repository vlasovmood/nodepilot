use std::sync::OnceLock;

use nodepilot_core::access::{Area, Level};
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value, json};

use crate::catalog::{Access, Body, ENDPOINTS, Reply};

pub fn spec() -> &'static Value {
    static SPEC: OnceLock<Value> = OnceLock::new();
    SPEC.get_or_init(build)
}

fn level_str(l: Level) -> &'static str {
    match l {
        Level::Read => "read",
        Level::Write => "write",
    }
}

fn area_doc(a: Area) -> &'static str {
    match a {
        Area::Servers => "Servers, their details and stats",
        Area::Projects => "Projects and their servers",
        Area::Identities => "Identities in the keychain (secrets are never returned)",
        Area::Exec => "Command execution and terminal sessions (write only)",
        Area::System => "Processes, systemd services, logs, power",
        Area::Files => "Files on servers (SFTP)",
        Area::Notes => "Notes",
        Area::Graphs => "Infrastructure graphs",
        Area::Backups => "Backup storages, backup jobs and archives",
        Area::Admin => "API tokens",
    }
}

fn build() -> Value {
    let mut settings = SchemaSettings::draft2020_12();
    settings.definitions_path = "/components/schemas".into();
    let mut generator = settings.into_generator();

    let error = json!({ "description": "Error", "content": { "application/json": { "schema": {
        "type": "object", "properties": { "error": { "type": "string" } }, "required": ["error"] } } } });

    let mut paths: Map<String, Value> = Map::new();
    for e in ENDPOINTS {
        let mut op = Map::new();
        op.insert("summary".into(), json!(e.summary));
        op.insert("tags".into(), json!([e.group]));
        op.insert("operationId".into(), json!(operation_id(e.method, e.path)));

        match e.access {
            Access::Public => {
                op.insert("security".into(), json!([]));
            }
            Access::Authenticated => {
                op.insert("x-permission".into(), json!("authenticated"));
            }
            Access::Scoped(a, l) => {
                let perm = format!("{}:{}", a.as_str(), level_str(l));
                op.insert("x-permission".into(), json!(perm));
                op.insert("description".into(), json!(format!("Required token permission: `{perm}`.")));
            }
        }

        let mut params: Vec<Value> = e
            .path
            .split('/')
            .filter_map(|seg| seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
            .map(|name| json!({ "name": name, "in": "path", "required": true, "schema": { "type": "string" } }))
            .collect();
        if let Some(q) = e.query {
            let schema = q(&mut generator);
            let schema = resolve(&generator, schema.as_value());
            let required: Vec<String> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if let Some(props) = schema.get("properties").and_then(Value::as_object) {
                for (name, prop) in props {
                    let mut p = json!({ "name": name, "in": "query", "required": required.contains(name), "schema": prop });
                    if let Some(d) = prop.get("description") {
                        p["description"] = d.clone();
                    }
                    params.push(p);
                }
            }
        }
        if !params.is_empty() {
            op.insert("parameters".into(), Value::Array(params));
        }

        match e.body {
            Body::None => {}
            Body::Json(f) => {
                let schema = f(&mut generator);
                op.insert("requestBody".into(), json!({ "required": true, "content": { "application/json": { "schema": schema } } }));
            }
            Body::Binary => {
                op.insert(
                    "requestBody".into(),
                    json!({ "required": true, "content": { "application/octet-stream": { "schema": { "type": "string", "format": "binary" } } } }),
                );
            }
        }

        let ok = match e.reply {
            Reply::NoContent => ("204", json!({ "description": "Done" })),
            Reply::Json(f) => ("200", json!({ "description": "OK", "content": { "application/json": { "schema": f(&mut generator) } } })),
            Reply::Binary => (
                "200",
                json!({ "description": "File", "content": { "application/octet-stream": { "schema": { "type": "string", "format": "binary" } } } }),
            ),
            Reply::WebSocket => ("101", json!({ "description": "Switching to WebSocket" })),
        };
        let mut responses = Map::new();
        responses.insert(ok.0.into(), ok.1);
        responses.insert("4XX".into(), error.clone());
        op.insert("responses".into(), Value::Object(responses));

        let path_item = paths.entry(e.path.trim_start_matches("/api").to_owned()).or_insert_with(|| json!({}));
        path_item[e.method.to_lowercase()] = Value::Object(op);
    }

    let schemas = generator.take_definitions(true);
    let areas: Vec<Value> = Area::ALL.iter().map(|a| json!({ "name": a.as_str(), "description": area_doc(*a) })).collect();

    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "NodePilot API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Full control of the NodePilot panel: servers, projects, identities, commands and terminals, files, \
                system, notes, graphs, backups. Authentication: `Authorization: Bearer <API token>` (tokens are issued \
                in the panel's API section) or a session cookie. Each endpoint requires the permission in `x-permission` \
                (`<area>:read|write`; write includes read). Errors are JSON `{\"error\": \"...\"}`: \
                400 bad request, 401 not signed in, 403 permission denied, 404 not found, 409 conflict, 502 SSH error.",
        },
        "servers": [{ "url": "/api" }],
        "x-permission-areas": areas,
        "components": {
            "schemas": schemas,
            "securitySchemes": {
                "bearer": { "type": "http", "scheme": "bearer", "description": "API token `np_…` or session token" },
                "cookie": { "type": "apiKey", "in": "cookie", "name": "np_session" },
            },
        },
        "security": [{ "bearer": [] }, { "cookie": [] }],
        "paths": paths,
    })
}

fn resolve(generator: &schemars::SchemaGenerator, schema: &Value) -> Value {
    if let Some(r) = schema.get("$ref").and_then(Value::as_str)
        && let Some(name) = r.rsplit('/').next()
        && let Some(def) = generator.definitions().get(name)
    {
        return def.clone();
    }
    schema.clone()
}

/// `GET /api/servers/{id}/stats` → `getServersIdStats`
fn operation_id(method: &str, path: &str) -> String {
    let mut out = method.to_lowercase();
    for seg in path.trim_start_matches("/api/").split(['/', '-', '.', '_']) {
        let seg = seg.trim_start_matches('{').trim_end_matches('}');
        let mut c = seg.chars();
        if let Some(f) = c.next() {
            out.extend(f.to_uppercase());
            out.push_str(c.as_str());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn spec_builds() {
        let s = super::spec();
        assert_eq!(s["openapi"], "3.1.0");
        assert!(s["paths"]["/servers"]["get"]["parameters"].as_array().is_some_and(|p| p.iter().any(|x| x["name"] == "project_id")));
        assert!(s["components"]["schemas"]["Server"].is_object());
        assert_eq!(s["paths"]["/graphs/{id}/nodes"]["post"]["x-permission"], "graphs:write");
    }
}
