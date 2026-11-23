-- `doc` is saved atomically as a whole; `version` guards against overwrites from two tabs.
CREATE TABLE graphs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    doc         TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX graphs_project ON graphs(project_id);
