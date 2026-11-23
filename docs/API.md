# NodePilot HTTP API (v1)

> **The authoritative, always up-to-date reference is the OpenAPI 3.1 spec served by the panel at
> `GET /api/openapi.json`** (generated from the Rust types, so it never drifts from the code), and the
> interactive reference in the panel: **API → Reference**. Use the spec to generate clients
> (e.g. `openapi-generator`, `openapi-typescript`) for mobile apps or scripts.
> This file is a human-oriented overview.

## Access control (API tokens)

Every endpoint requires a permission `<area>:<level>` (shown as `x-permission` in the spec).
Browser sessions have full access; API tokens have what they were granted:

```ts
type Permissions = { full: boolean; areas: { [area: string]: "read" | "write" } };  // write ⊇ read
```

| Area | Covers |
|---|---|
| `servers` | servers, stats, connection test |
| `projects` | projects and membership |
| `identities` | keychain (secrets are never returned) |
| `exec` | exec, bulk exec, WebSocket terminal, terminal sessions (write only) |
| `system` | processes, systemd services, logs, power |
| `files` | SFTP files |
| `notes` | notes |
| `graphs` | infrastructure graphs |
| `backups` | storages, jobs, archives |
| `admin` | API tokens |

A token can never issue or grant more than it has itself (403). Endpoints not listed in the catalog are denied to tokens.
`GET /api/auth/me` returns the current user and the token's permissions — use it in clients to hide unavailable actions.

Tokens: `GET/POST /api/tokens`, `PATCH/DELETE /api/tokens/{id}`, body
`{ name?, permissions?: Permissions /* default full */, expires_in_days?: number /* 0 = never */ }`;
`POST` returns `{ token: "np_…" (shown once), info: ApiToken }`.

Base path: `/api`. JSON everywhere unless stated otherwise. IDs are UUID strings.
Timestamps are RFC 3339 strings (UTC). Sizes are bytes.

Errors: non-2xx status with body `{"error": "message"}`.
Status codes: 400 bad input, 401 not authenticated, 404 not found, 409 conflict, 502 SSH/remote failure.

## Auth

All endpoints except `/api/health`, `/api/openapi.json`, `/api/auth/status`, `/api/auth/setup`, `/api/auth/login`
require auth: either the `np_session` HttpOnly cookie (set by login) or `Authorization: Bearer <token>`.
WebSocket endpoints additionally accept `?token=<token>` (cookie also works).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | | `{status, version}` |
| GET | `/api/auth/status` | | `{setup_required: bool, user: User \| null}` |
| POST | `/api/auth/setup` | `{username, password}` (only when no users exist) | `{token, user}` + cookie |
| POST | `/api/auth/login` | `{username, password}` | `{token, user}` + cookie |
| POST | `/api/auth/logout` | | 204 |
| GET | `/api/auth/me` | | `{user, token: {id, name} \| null, permissions}` |
| GET | `/api/tokens` | | `ApiToken[]` |
| POST | `/api/tokens` | `TokenInput` | `{token: "np_...", info: ApiToken}` — token shown once |
| PATCH | `/api/tokens/{id}` | `TokenInput` | `ApiToken` |
| DELETE | `/api/tokens/{id}` | | 204 |

```ts
type User = { id: string; username: string; created_at: string };
type ApiToken = {
  id: string; name: string; created_at: string; last_used_at: string | null;
  expires_at: string | null; permissions: Permissions;
};
type TokenInput = { name?: string; permissions?: Permissions; expires_in_days?: number /* 0 = never */ };
```

## Projects

A server can belong to many projects.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/projects` | | `Project[]` |
| POST | `/api/projects` | `{name, description?, color?}` | `Project` |
| GET | `/api/projects/{id}` | | `Project` |
| PATCH | `/api/projects/{id}` | `{name?, description?, color?}` | `Project` |
| DELETE | `/api/projects/{id}` | | 204 (servers are kept) |
| PUT | `/api/projects/{id}/servers/{server_id}` | | 204 — add server to project |
| DELETE | `/api/projects/{id}/servers/{server_id}` | | 204 — remove from project |

```ts
type Project = {
  id: string; name: string; description: string; color: string | null;
  server_count: number; created_at: string; updated_at: string;
};
```

## Identities (keychain)

Reusable credentials. Secrets are write-only and never returned.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/identities` | | `Identity[]` |
| POST | `/api/identities` | `IdentityInput` | `Identity` |
| PATCH | `/api/identities/{id}` | partial `IdentityInput` | `Identity` |
| DELETE | `/api/identities/{id}` | | 204 (409 if used by servers) |

```ts
type Identity = { id: string; name: string; kind: "password" | "key"; server_count: number; created_at: string };
type IdentityInput = { name: string; kind: "password" | "key"; password?: string; private_key?: string; passphrase?: string };
```

## Servers

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/servers?project_id=&q=&tag=` | | `Server[]` (`q` matches name/host) |
| POST | `/api/servers` | `ServerInput` | `Server` |
| POST | `/api/servers/bulk` | `ServerInput[]` | `Server[]` |
| GET | `/api/servers/{id}` | | `Server` |
| PATCH | `/api/servers/{id}` | partial `ServerInput` | `Server` |
| DELETE | `/api/servers/{id}` | | 204 |
| POST | `/api/servers/{id}/test` | | `{ok, latency_ms, error: string \| null}` |
| DELETE | `/api/servers/{id}/host-key` | | 204 — forget pinned host key (TOFU reset) |

```ts
type Auth =
  | { type: "password"; password: string }
  | { type: "key"; private_key: string; passphrase?: string }
  | { type: "identity"; identity_id: string };

type ServerInput = {
  name: string; host: string; port?: number /* 22 */; username: string;
  auth: Auth; tags?: string[]; project_ids?: string[]; description?: string;
};

type Server = {
  id: string; name: string; host: string; port: number; username: string;
  auth_type: "password" | "key" | "identity"; identity_id: string | null;
  tags: string[]; project_ids: string[]; description: string;
  host_key_fingerprint: string | null;   // pinned on first connect (SHA256:...)
  status: "online" | "offline" | "unknown";
  created_at: string; updated_at: string;
};
```

## Exec (run commands)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/servers/{id}/exec` | `{command, timeout_secs?}` | `ExecResult` |
| POST | `/api/exec` | `{command, server_ids?, project_id?, timeout_secs?}` | `{results: BulkExecResult[]}` |

```ts
type ExecResult = { exit_code: number | null; stdout: string; stderr: string; duration_ms: number; truncated: boolean };
type BulkExecResult = { server_id: string; server_name: string; ok: boolean; error: string | null; result: ExecResult | null };
```
Output is capped at 1 MiB per stream (`truncated: true`).

## Terminal (WebSocket)

`GET /api/servers/{id}/terminal?cols=120&rows=32[&token=...]` → WebSocket upgrade.

- **Binary frames** both ways: raw terminal bytes (client → keystrokes, server → output).
- **Text frames**, JSON control messages:
  - client → server: `{"type":"resize","cols":120,"rows":40}`
  - server → client: `{"type":"ready"}`, `{"type":"exit","code":0}`, `{"type":"error","message":"..."}`

## Stats (agentless, polled over SSH)

| Method | Path | Response |
|---|---|---|
| GET | `/api/stats` | `StatsSnapshot[]` — latest for every server (dashboard) |
| GET | `/api/servers/{id}/stats` | `StatsSnapshot` |
| GET | `/api/servers/{id}/stats/history?hours=24` | `StatsPoint[]` |

```ts
type StatsSnapshot = {
  server_id: string; status: "online" | "offline" | "unknown";
  collected_at: string | null; error: string | null;
  hostname: string | null; os: string | null; kernel: string | null; cpu_cores: number | null;
  uptime_secs: number | null; cpu_percent: number | null; load: [number, number, number] | null;
  mem_total: number | null; mem_used: number | null; swap_total: number | null; swap_used: number | null;
  disks: { mount: string; fs: string; total: number; used: number }[];
  net_rx_bps: number | null; net_tx_bps: number | null;
};
type StatsPoint = {
  ts: string; cpu_percent: number | null; mem_used: number | null; mem_total: number | null;
  disk_used: number | null; disk_total: number | null; net_rx_bps: number | null; net_tx_bps: number | null; load1: number | null;
};
```

## Management

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/servers/{id}/processes` | | `Process[]` (top 200 by CPU) |
| POST | `/api/servers/{id}/processes/{pid}/kill` | `{signal?: "TERM" \| "KILL" \| "HUP"}` | 204 |
| GET | `/api/servers/{id}/services` | | `Service[]` (systemd) |
| POST | `/api/servers/{id}/services/{name}/{action}` | action: start\|stop\|restart\|reload\|enable\|disable | `ExecResult` |
| GET | `/api/servers/{id}/services/{name}/logs?lines=200` | | `{lines: string[]}` |
| POST | `/api/servers/{id}/power` | `{action: "reboot" \| "shutdown"}` | 204 |

```ts
type Process = { pid: number; user: string; cpu: number; mem: number; rss: number; command: string };
type Service = { name: string; load: string; active: string; sub: string; description: string };
```

## Files (SFTP)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/servers/{id}/files?path=/root` | | `{path, entries: FileEntry[]}` |
| GET | `/api/servers/{id}/files/content?path=...[&download=1]` | | raw bytes |
| PUT | `/api/servers/{id}/files/content?path=...` | raw bytes (upload / save) | 204 |
| POST | `/api/servers/{id}/files/mkdir` | `{path}` | 204 |
| POST | `/api/servers/{id}/files/rename` | `{from, to}` | 204 |
| DELETE | `/api/servers/{id}/files?path=...&recursive=1` | | 204 |

```ts
type FileEntry = {
  name: string; path: string; kind: "file" | "dir" | "symlink" | "other";
  size: number; mode: string /* "rwxr-xr-x" */; modified: string | null;
};
```
`path` defaults to the user's home directory. Upload limit: 512 MiB.

## Notes

Markdown notes attached to a project, a server, or neither (global).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/notes?project_id=&server_id=` | | `Note[]` |
| POST | `/api/notes` | `{title, body?, project_id?, server_id?, pinned?}` | `Note` |
| PATCH | `/api/notes/{id}` | partial | `Note` |
| DELETE | `/api/notes/{id}` | | 204 |

```ts
type Note = {
  id: string; title: string; body: string; project_id: string | null; server_id: string | null;
  pinned: boolean; created_at: string; updated_at: string;
};
```

## Backups

Storages are where archives go; jobs define what to back up, from which server, when.
Archives can be encrypted with [age](https://age-encryption.org) (passphrase); decrypt with `age -d`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/backup-storages` | | `Storage[]` |
| POST | `/api/backup-storages` | `StorageInput` | `Storage` |
| PATCH | `/api/backup-storages/{id}` | partial | `Storage` |
| DELETE | `/api/backup-storages/{id}` | | 204 (409 if used) |
| POST | `/api/backup-storages/{id}/test` | | `{ok, error}` |
| GET | `/api/backup-jobs?server_id=` | | `BackupJob[]` |
| POST | `/api/backup-jobs` | `BackupJobInput` | `BackupJob` |
| PATCH | `/api/backup-jobs/{id}` | partial | `BackupJob` |
| DELETE | `/api/backup-jobs/{id}` | | 204 |
| POST | `/api/backup-jobs/{id}/run` | | `BackupRun` (status `running`) |
| GET | `/api/backups?job_id=&server_id=` | | `BackupRun[]` (newest first) |
| GET | `/api/backups/{id}/download` | | raw archive bytes (as stored, encrypted if job encrypts) |
| DELETE | `/api/backups/{id}` | | 204 (deletes the archive too) |

```ts
type Storage = {
  id: string; name: string; kind: "local" | "s3";
  local: { path: string } | null;   // directory on the panel host
  s3: { endpoint: string | null; region: string; bucket: string; prefix: string; access_key_id: string; path_style: boolean } | null;
  created_at: string;
};
type StorageInput = {
  name: string; kind: "local" | "s3";
  local?: { path: string };
  s3?: { endpoint?: string; region: string; bucket: string; prefix?: string; access_key_id: string; secret_access_key: string; path_style?: boolean };
};

type BackupSource =
  | { type: "files"; paths: string[]; excludes?: string[] }
  | { type: "postgres"; database: string; user?: string; password?: string; host?: string; port?: number; docker_container?: string }
  | { type: "mysql"; database: string; user?: string; password?: string; host?: string; port?: number; docker_container?: string };
  // password is write-only; responses contain `has_password: boolean` instead

type BackupJob = {
  id: string; name: string; server_id: string; storage_id: string; source: BackupSource;
  schedule: string | null;          // cron in UTC: 6 fields with seconds ("0 0 3 * * *" = daily 03:00; use day names: "0 0 4 * * Sun")
                                    // or classic 5-field crontab ("0 3 * * 1" = Mondays 03:00, 0 and 7 = Sunday)
  retention: number;                // keep last N successful archives, 0 = keep all
  encrypt: boolean;                 // passphrase is write-only
  enabled: boolean; next_run_at: string | null; last_run: BackupRun | null;
  created_at: string; updated_at: string;
};
type BackupJobInput = {
  name: string; server_id: string; storage_id: string; source: BackupSource;
  schedule?: string | null; retention?: number; encrypt?: boolean; passphrase?: string; enabled?: boolean;
};
type BackupRun = {
  id: string; job_id: string; server_id: string; status: "running" | "success" | "failed";
  started_at: string; finished_at: string | null; size_bytes: number | null;
  file_name: string | null; encrypted: boolean; error: string | null;
};
```

## MCP (for AI agents)

`POST /api/mcp` — Model Context Protocol over HTTP (JSON-RPC 2.0 request in body, JSON response).
Auth: `Authorization: Bearer <api token>`. Notifications (no `id`) return 202.
Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Tool list: see README.

## Graphs (infrastructure diagrams)

A graph is a canvas with nodes (optionally bound to panel servers), typed connections and notes.
The whole document is saved atomically; `version` protects against overwriting changes made in another tab.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/graphs?project_id=` | | `GraphSummary[]` |
| POST | `/api/graphs` | `{name, description?, project_id?, doc?}` | `Graph` |
| GET | `/api/graphs/{id}` | | `Graph` |
| PATCH/PUT | `/api/graphs/{id}` | `{name?, description?, project_id?, doc?, version?}` | `Graph` (409 if `version` is stale) |
| DELETE | `/api/graphs/{id}` | | 204 |

```ts
type GraphDocNode = {
  id: string; type: "node" | "note"; x: number; y: number; width?: number; height?: number;
  label: string; role?: "server"|"api"|"web"|"db"|"cache"|"queue"|"storage"|"lb"|"vpn"|"internet"|"other";
  server_id?: string; color?: string; note: string;   // note: node note, or the text of a canvas note
};
type GraphDocEdge = {
  id: string; source: string; target: string; label: string;
  kind: "link"|"depends"|"cascade"|"vpn"|"replication"|"other"; directed: boolean; color?: string; note: string;
};
type GraphDoc = { nodes: GraphDocNode[]; edges: GraphDocEdge[]; viewport?: { x: number; y: number; zoom: number } };
type GraphSummary = { id; name; description; project_id: string | null; node_count; edge_count; version; created_at; updated_at };
type Graph = GraphSummary & { doc: GraphDoc };
```
Limits: 5000 nodes, 20000 edges, 4 MiB per document.


## Terminal sessions (persistent PTY over plain HTTP)

For clients that can't keep a WebSocket open (mobile apps, AI agents). The shell keeps cwd/env between calls;
output is buffered (1 MiB ring) with absolute offsets so polling never loses data. Requires `exec:write`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/terminal-sessions` | | `TerminalInfo[]` |
| POST | `/api/terminal-sessions` | `{server_id, cols?, rows?}` | `TerminalInfo` |
| GET | `/api/terminal-sessions/{id}` | | `TerminalInfo` |
| DELETE | `/api/terminal-sessions/{id}` | | 204 |
| POST | `/api/terminal-sessions/{id}/input` | `{data, enter?, wait_ms?, strip_ansi?}` | `TerminalOutput` (output produced after the input) |
| GET | `/api/terminal-sessions/{id}/output?since=&wait_ms=&strip_ansi=` | | `TerminalOutput` |
| POST | `/api/terminal-sessions/{id}/resize` | `{cols, rows}` | `TerminalInfo` |

```ts
type TerminalOutput = { data: string; next: number /* pass as `since` next time */; truncated: boolean; closed: boolean; exit_code: number | null };
```
Idle sessions are closed after 30 minutes.

## Graph editing operations

Besides replacing the whole document (`PATCH /api/graphs/{id}` with `doc` + `version`), single elements can be edited;
these retry automatically on concurrent edits (e.g. the graph is open in a browser):

| Method | Path | Body |
|---|---|---|
| POST | `/api/graphs/{id}/nodes` | `NodeInput` — `{type?: "node"|"note", label?, role?, server_id?, color?, note?, x?, y?}` (position auto if omitted) |
| PATCH | `/api/graphs/{id}/nodes/{node_id}` | partial `NodeInput` (`null` clears role/server/color) |
| DELETE | `/api/graphs/{id}/nodes/{node_id}` | removes the node and its edges |
| POST | `/api/graphs/{id}/edges` | `EdgeInput` — `{source, target, kind?, label?, directed?, color?, note?}` |
| PATCH | `/api/graphs/{id}/edges/{edge_id}` | partial `EdgeInput` |
| DELETE | `/api/graphs/{id}/edges/{edge_id}` | |

Also available: `GET /api/identities/{id}`, `GET /api/notes/{id}`, `GET /api/backup-storages/{id}`,
`GET /api/backup-jobs/{id}`, `GET /api/backups/{id}`.

## Security

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/auth/2fa` | | `{enabled, recovery_codes_left}` |
| POST | `/api/auth/2fa/setup` | | `{secret, otpauth_url}` (browser session only) |
| POST | `/api/auth/2fa/enable` | `{code}` | `{recovery_codes}` |
| POST | `/api/auth/2fa/disable` | `{password, code}` | 204 |
| POST | `/api/auth/2fa/recovery-codes` | `{code}` | `{recovery_codes}` |
| GET | `/api/security/status` | | security overview |
| GET/POST/PATCH | `/api/security/panel-key` | `{allowed_from?}` | panel SSH key info (`authorized_keys_line`, `install_command`, `emergency_revoke_command`) |
| POST | `/api/security/panel-key/detect-ip` | `{server_id}` | `{ip}` |
| POST | `/api/security/panel-key/deploy` | `{server_ids?, project_id?, switch_auth?}` | per-server results |
| POST | `/api/security/panel-key/rotate` | | per-server results |
| POST | `/api/security/panel-key/revoke` | | per-server results (emergency) |
| GET | `/api/audit?actor=&q=&severity=&before_id=&limit=` | | `AuditEntry[]` |
| GET/PATCH | `/api/audit/settings` | `{syslog?, webhook_url?, webhook_secret?, min_severity?, retention_days?}` | settings |
| POST | `/api/audit/test` | | `{ok, error}` |
| POST | `/api/backup-keys/generate` | | `{public_key, private_key, identity_file}` (not stored) |

Login with 2FA: `POST /api/auth/login {username, password, code?}` → 401 `{two_factor_required: true}` when the code is missing;
429 with `Retry-After` after 5 failed attempts (per IP and per username) within 15 minutes.
Backup jobs: `encryption: "none" | "passphrase" | "recipients"`, `recipients: ["age1…"]`.
