// Types mirroring docs/API.md (NodePilot HTTP API v1).
// Keep in sync with the backend contract. IDs are UUID strings, timestamps RFC 3339 (UTC), sizes in bytes.

export type ApiError = { error: string };

// ---------- Health / Auth ----------

export type Health = { status: string; version: string };

export type User = { id: string; username: string; created_at: string };

export type AuthStatus = { setup_required: boolean; user: User | null };

export type Credentials = {
  username: string;
  password: string;
  /** 6-digit TOTP code or a recovery code (when 2FA is enabled). */
  code?: string;
};

export type LoginResponse = { token: string; user: User };

/** Permission areas of the API (keys of `Permissions.areas`). */
export type PermissionArea =
  | 'servers'
  | 'projects'
  | 'identities'
  | 'exec'
  | 'system'
  | 'files'
  | 'notes'
  | 'graphs'
  | 'backups'
  | 'admin';

/** `write` implies read. */
export type PermissionLevel = 'read' | 'write';

/** `full: true` — everything, including areas added in the future. A missing area = no access. */
export type Permissions = {
  full: boolean;
  areas: Partial<Record<PermissionArea, PermissionLevel>>;
};

export type ApiToken = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  /** `null` — never expires. */
  expires_at: string | null;
  permissions: Permissions;
};

/** Create/update a token. In PATCH every field is optional; `expires_in_days` counts from now, `0` = never. */
export type TokenInput = {
  name?: string;
  permissions?: Permissions;
  expires_in_days?: number;
};

export type CreateTokenResponse = { token: string; info: ApiToken };

export type Me = {
  user: User;
  /** `null` — browser session (full access). */
  token: { id: string; name: string } | null;
  permissions: Permissions;
};

// ---------- Projects ----------

export type Project = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  server_count: number;
  created_at: string;
  updated_at: string;
};

export type ProjectInput = { name: string; description?: string; color?: string | null };

// ---------- Identities ----------

export type IdentityKind = 'password' | 'key';

export type Identity = {
  id: string;
  name: string;
  kind: IdentityKind;
  server_count: number;
  created_at: string;
};

export type IdentityInput = {
  name: string;
  kind: IdentityKind;
  password?: string;
  private_key?: string;
  passphrase?: string;
};

// ---------- Servers ----------

export type Auth =
  | { type: 'password'; password: string }
  | { type: 'key'; private_key: string; passphrase?: string }
  | { type: 'identity'; identity_id: string };

export type AuthType = Auth['type'];

export type ServerInput = {
  name: string;
  host: string;
  port?: number;
  username: string;
  auth: Auth;
  tags?: string[];
  project_ids?: string[];
  description?: string;
};

export type ServerStatus = 'online' | 'offline' | 'unknown';

export type Server = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  identity_id: string | null;
  tags: string[];
  project_ids: string[];
  description: string;
  host_key_fingerprint: string | null;
  status: ServerStatus;
  created_at: string;
  updated_at: string;
};

export type TestConnectionResult = { ok: boolean; latency_ms: number; error: string | null };

// ---------- Exec ----------

export type ExecRequest = { command: string; timeout_secs?: number };

export type BulkExecRequest = {
  command: string;
  server_ids?: string[];
  project_id?: string;
  timeout_secs?: number;
};

export type ExecResult = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  truncated: boolean;
};

export type BulkExecResult = {
  server_id: string;
  server_name: string;
  ok: boolean;
  error: string | null;
  result: ExecResult | null;
};

export type BulkExecResponse = { results: BulkExecResult[] };

// ---------- Terminal (WebSocket control messages) ----------

export type TerminalClientMessage = { type: 'resize'; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: 'ready' }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

// ---------- Stats ----------

export type DiskUsage = { mount: string; fs: string; total: number; used: number };

export type StatsSnapshot = {
  server_id: string;
  status: ServerStatus;
  collected_at: string | null;
  error: string | null;
  hostname: string | null;
  os: string | null;
  kernel: string | null;
  cpu_cores: number | null;
  uptime_secs: number | null;
  cpu_percent: number | null;
  load: [number, number, number] | null;
  mem_total: number | null;
  mem_used: number | null;
  swap_total: number | null;
  swap_used: number | null;
  disks: DiskUsage[];
  net_rx_bps: number | null;
  net_tx_bps: number | null;
};

export type StatsPoint = {
  ts: string;
  cpu_percent: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  load1: number | null;
};

// ---------- Management ----------

export type Process = {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
};

export type KillSignal = 'TERM' | 'KILL' | 'HUP';

export type Service = {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
};

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable';

export type PowerAction = 'reboot' | 'shutdown';

export type ServiceLogs = { lines: string[] };

// ---------- Files (SFTP) ----------

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export type FileEntry = {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  mode: string;
  modified: string | null;
};

export type DirListing = { path: string; entries: FileEntry[] };

// ---------- Notes ----------

export type Note = {
  id: string;
  title: string;
  body: string;
  project_id: string | null;
  server_id: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

export type NoteInput = {
  title: string;
  body?: string;
  project_id?: string | null;
  server_id?: string | null;
  pinned?: boolean;
};

// ---------- Backups ----------

export type StorageKind = 'local' | 's3';

export type S3Config = {
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  path_style: boolean;
};

export type Storage = {
  id: string;
  name: string;
  kind: StorageKind;
  local: { path: string } | null;
  s3: S3Config | null;
  created_at: string;
};

export type S3ConfigInput = {
  endpoint?: string;
  region: string;
  bucket: string;
  prefix?: string;
  access_key_id: string;
  secret_access_key: string;
  path_style?: boolean;
};

export type StorageInput = {
  name: string;
  kind: StorageKind;
  local?: { path: string };
  s3?: S3ConfigInput;
};

/** PATCH body for storages: everything optional, `secret_access_key` may be omitted to keep the stored one. */
export type StoragePatch = {
  name?: string;
  kind?: StorageKind;
  local?: { path: string };
  s3?: Omit<S3ConfigInput, 'secret_access_key'> & { secret_access_key?: string };
};

export type DbSourceInput = {
  database: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  docker_container?: string;
};

/** Source as sent to the API (password write-only). */
export type BackupSourceInput =
  | { type: 'files'; paths: string[]; excludes?: string[] }
  | ({ type: 'postgres' } & DbSourceInput)
  | ({ type: 'mysql' } & DbSourceInput);

/** Source as returned by the API: `password` is replaced by `has_password`. */
export type DbSource = Omit<DbSourceInput, 'password'> & { has_password?: boolean };

export type BackupSource =
  | { type: 'files'; paths: string[]; excludes?: string[] }
  | ({ type: 'postgres' } & DbSource)
  | ({ type: 'mysql' } & DbSource);

export type BackupRunStatus = 'running' | 'success' | 'failed';

export type BackupRun = {
  id: string;
  job_id: string;
  server_id: string;
  status: BackupRunStatus;
  started_at: string;
  finished_at: string | null;
  size_bytes: number | null;
  file_name: string | null;
  encrypted: boolean;
  error: string | null;
};

/** `passphrase` — the passphrase is stored in the panel; `recipients` — age public keys, the panel can't decrypt. */
export type BackupEncryption = 'none' | 'passphrase' | 'recipients';

export type BackupJob = {
  id: string;
  name: string;
  server_id: string;
  storage_id: string;
  source: BackupSource;
  schedule: string | null;
  retention: number;
  /** Archives are encrypted (any mode). Deprecated: use `encryption`. */
  encrypt: boolean;
  encryption: BackupEncryption;
  /** age public keys (`age1…`) for the `recipients` mode. */
  recipients: string[];
  enabled: boolean;
  next_run_at: string | null;
  last_run: BackupRun | null;
  created_at: string;
  updated_at: string;
};

export type BackupJobInput = {
  name: string;
  server_id: string;
  storage_id: string;
  source: BackupSourceInput;
  schedule?: string | null;
  retention?: number;
  /** Deprecated: use `encryption`. */
  encrypt?: boolean;
  encryption?: BackupEncryption;
  /** For `passphrase`; write-only, omit to keep the stored one. */
  passphrase?: string;
  /** For `recipients`: age public keys. */
  recipients?: string[];
  enabled?: boolean;
};

/** A fresh age key pair. The private key is shown once and never stored by the panel. */
export type BackupKeyPair = {
  /** `age1…` */
  public_key: string;
  /** `AGE-SECRET-KEY-1…` */
  private_key: string;
  /** Contents of a key file for `age -d -i <file>`. */
  identity_file: string;
};

export type OkResult = { ok: boolean; error: string | null };

// ---------- graphs (infrastructure diagrams) ----------

export type GraphDocNode = {
  id: string;
  type: 'node' | 'note';
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  label: string;
  role?: string | null;
  server_id?: string | null;
  color?: string | null;
  note: string;
};

export type GraphDocEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  directed: boolean;
  color?: string | null;
  note: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type GraphDoc = {
  nodes: GraphDocNode[];
  edges: GraphDocEdge[];
  viewport?: { x: number; y: number; zoom: number } | null;
};

export type GraphSummary = {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  node_count: number;
  edge_count: number;
  version: number;
  created_at: string;
  updated_at: string;
};

export type Graph = GraphSummary & { doc: GraphDoc };

export type GraphInput = {
  name?: string;
  description?: string;
  project_id?: string | null;
  doc?: GraphDoc;
  /** Version the client edited; a mismatch returns 409. */
  version?: number;
};

// ---------- system updates ----------

export type UpdateSettings = { auto_check: boolean; include_prereleases: boolean };

export type ReleaseInfo = {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  published_at: string | null;
  prerelease: boolean;
  asset: string | null;
  asset_size: number | null;
};

export type InstallStatus = {
  phase: 'idle' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'failed';
  version: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
};

export type UpdateInfo = {
  current_version: string;
  /** null when no update repository is configured. */
  repo: string | null;
  platform_asset: string;
  latest: ReleaseInfo | null;
  update_available: boolean;
  checked_at: string | null;
  error: string | null;
  can_install: boolean;
  install_blocker: string | null;
  signature_required: boolean;
  settings: UpdateSettings;
  install: InstallStatus;
};

// ---------- security: 2FA ----------

export type TwoFactorStatus = { enabled: boolean; recovery_codes_left: number };

export type TotpSetup = {
  /** base32, for manual entry */
  secret: string;
  /** `otpauth://…` — for the QR code */
  otpauth_url: string;
};

export type RecoveryCodes = { recovery_codes: string[] };

/** Body of the 401 returned by login when a second factor is needed. */
export type TwoFactorRequiredError = { error: string; two_factor_required: true };

// ---------- security: overview ----------

export type MasterKeyKind = 'systemd-credential' | 'file' | 'data-dir';

export type MasterKeySource = {
  kind: MasterKeyKind;
  path: string;
  /** A plaintext copy of the key is still in the data directory. */
  plaintext_copy_on_disk: boolean;
};

export type SecurityStatus = {
  master_key: MasterKeySource;
  tpm_available: boolean;
  systemd_creds_available: boolean;
  two_factor: TwoFactorStatus;
  panel_key_configured: boolean;
  panel_key_from_restricted: boolean;
  servers_total: number;
  servers_on_panel_key: number;
  backup_jobs_total: number;
  backup_jobs_unencrypted: number;
  backup_jobs_passphrase: number;
  backup_jobs_recipients: number;
  api_tokens_total: number;
  api_tokens_full_access: number;
  api_tokens_without_expiry: number;
  audit_forwarding: boolean;
  secure_cookies: boolean;
};

// ---------- security: panel SSH key ----------

export type PanelKeyInfo = {
  configured: boolean;
  identity_id: string | null;
  public_key: string | null;
  /** Addresses/networks the servers accept the key from (`from=`). Empty — no restriction. */
  allowed_from: string[];
  authorized_keys_line: string | null;
  install_command: string | null;
  /** Removes every panel key from a server; run it without the panel (ssh/ansible). */
  emergency_revoke_command: string;
  servers_using: number;
  servers_total: number;
  created_at: string | null;
};

export type PanelKeyInput = { allowed_from?: string[] };

export type PanelKeyDeployRequest = {
  server_ids?: string[];
  project_id?: string;
  /** Switch the servers to the panel key after a successful check (default true). */
  switch_auth?: boolean;
};

export type ServerOpResult = { server_id: string; server_name: string; ok: boolean; error: string | null };

// ---------- audit log ----------

export type AuditSeverity = 'info' | 'warning' | 'critical';

export type AuditEntry = {
  id: number;
  ts: string;
  severity: AuditSeverity;
  actor: string;
  /** Name of the API token, if the action was made with one. */
  token: string | null;
  ip: string | null;
  /** e.g. `exec`, `mcp:create_server`, `auth:login`, `POST /api/servers` */
  action: string;
  target: string | null;
  /** JSON string; secrets are already replaced by `***`. */
  details: string | null;
  /** `ok` | `denied` | `locked` | `error: …` | `exit 0` */
  outcome: string;
};

export type AuditFilter = {
  actor?: string;
  /** Substring of the action or target. */
  q?: string;
  /** Minimal severity. */
  severity?: AuditSeverity;
  before_id?: number;
  /** Default 200, max 1000. */
  limit?: number;
};

export type AuditSettings = {
  /** `udp://host:514` or `tcp://host:514` */
  syslog: string | null;
  webhook_url: string | null;
  webhook_secret_set: boolean;
  min_severity: AuditSeverity;
  /** 7…3650 */
  retention_days: number;
};

/** Empty string clears a field. */
export type AuditSettingsInput = {
  syslog?: string;
  webhook_url?: string;
  webhook_secret?: string;
  min_severity?: AuditSeverity;
  retention_days?: number;
};
