-- Timestamps are RFC 3339 TEXT (UTC), except metrics, which use unix seconds for compactness.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('session', 'api')),
    name         TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    expires_at   TEXT
);

CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE identities (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('password', 'key')),
    secret_enc     TEXT NOT NULL,
    passphrase_enc TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE servers (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    host           TEXT NOT NULL,
    port           INTEGER NOT NULL DEFAULT 22,
    username       TEXT NOT NULL,
    auth_type      TEXT NOT NULL CHECK (auth_type IN ('password', 'key', 'identity')),
    identity_id    TEXT REFERENCES identities(id) ON DELETE RESTRICT,
    secret_enc     TEXT,
    passphrase_enc TEXT,
    tags           TEXT NOT NULL DEFAULT '[]',
    description    TEXT NOT NULL DEFAULT '',
    host_key       TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX servers_name ON servers(name);

CREATE TABLE project_servers (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, server_id)
);
CREATE INDEX project_servers_server ON project_servers(server_id);

CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    server_id  TEXT REFERENCES servers(id) ON DELETE CASCADE,
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX notes_project ON notes(project_id);
CREATE INDEX notes_server ON notes(server_id);

CREATE TABLE metrics (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts         INTEGER NOT NULL,
    cpu        REAL,
    mem_used   INTEGER,
    mem_total  INTEGER,
    disk_used  INTEGER,
    disk_total INTEGER,
    net_rx     REAL,
    net_tx     REAL,
    load1      REAL,
    PRIMARY KEY (server_id, ts)
) WITHOUT ROWID;
CREATE INDEX metrics_ts ON metrics(ts);

CREATE TABLE backup_storages (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('local', 's3')),
    config     TEXT NOT NULL,
    secret_enc TEXT,                   -- S3 secret access key
    created_at TEXT NOT NULL
);

CREATE TABLE backup_jobs (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    storage_id        TEXT NOT NULL REFERENCES backup_storages(id) ON DELETE RESTRICT,
    source            TEXT NOT NULL,
    source_secret_enc TEXT,
    schedule          TEXT,
    retention         INTEGER NOT NULL DEFAULT 0,
    encrypt           INTEGER NOT NULL DEFAULT 0,
    passphrase_enc    TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    next_run_at       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE backup_runs (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL,
    storage_id  TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    size_bytes  INTEGER,
    file_name   TEXT,
    object_key  TEXT,
    encrypted   INTEGER NOT NULL DEFAULT 0,
    error       TEXT
);
CREATE INDEX backup_runs_job ON backup_runs(job_id, started_at);
