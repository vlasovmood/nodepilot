import type {
  ApiToken,
  AuditEntry,
  AuditFilter,
  AuditSettings,
  AuditSettingsInput,
  AuthStatus,
  BackupKeyPair,
  BackupJob,
  BackupJobInput,
  BackupRun,
  BulkExecRequest,
  BulkExecResponse,
  CreateTokenResponse,
  Credentials,
  DirListing,
  ExecRequest,
  ExecResult,
  Graph,
  GraphInput,
  GraphSummary,
  InstallStatus,
  UpdateInfo,
  UpdateSettings,
  Health,
  Identity,
  IdentityInput,
  KillSignal,
  LoginResponse,
  Me,
  Note,
  NoteInput,
  OkResult,
  PanelKeyDeployRequest,
  PanelKeyInfo,
  PanelKeyInput,
  PowerAction,
  Process,
  Project,
  ProjectInput,
  RecoveryCodes,
  SecurityStatus,
  Server,
  ServerInput,
  ServerOpResult,
  Service,
  ServiceAction,
  ServiceLogs,
  StatsPoint,
  StatsSnapshot,
  Storage,
  StorageInput,
  StoragePatch,
  TestConnectionResult,
  TokenInput,
  TotpSetup,
  TwoFactorStatus,
} from './types'
import i18n from '../i18n'

/** `/api`, or `<base>/api` when built for a sub-path (NODEPILOT_BASE_PATH). */
export const API_BASE = `${import.meta.env.BASE_URL}api`

/** Error thrown for any non-2xx response. `message` is the `{error}` body when present. */
export class ApiRequestError extends Error {
  readonly status: number
  /** Parsed JSON body of the error response (e.g. `{error, two_factor_required}`), if any. */
  readonly body: unknown
  /** `Retry-After` in seconds (429), if the server sent it. */
  readonly retryAfter: number | null
  constructor(status: number, message: string, body: unknown = null, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.body = body
    this.retryAfter = retryAfter
  }
}

/** Login answered 401 because the account has 2FA and no code was sent. */
export function isTwoFactorRequired(e: unknown): boolean {
  return (
    e instanceof ApiRequestError &&
    e.status === 401 &&
    !!e.body &&
    typeof e.body === 'object' &&
    (e.body as { two_factor_required?: unknown }).two_factor_required === true
  )
}

type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue>

type RequestOptions = {
  query?: Query
  /** JSON-serialisable body, or a raw BodyInit (Blob/File/ArrayBuffer/string) when `raw` is true. */
  body?: unknown
  raw?: boolean
  signal?: AbortSignal
  /** Do not trigger the global 401 handler (used by login/setup). */
  skipAuthRedirect?: boolean
  /** How to parse the response body. */
  responseType?: 'json' | 'text' | 'blob' | 'none'
}

let unauthorizedHandler: (() => void) | null = null

/** Registered by the app shell: called whenever an authenticated request returns 401. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

export function buildUrl(path: string, query?: Query): string {
  let url = API_BASE + path
  if (query) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      params.set(k, String(v))
    }
    const qs = params.toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  }
  return url
}

/** HTTP statuses that have translations under `common:apiErrors.http`. */
const KNOWN_STATUSES = new Set([400, 401, 403, 404, 409, 413, 500, 502, 503, 504])

function statusText(status: number): string {
  return KNOWN_STATUSES.has(status) ? i18n.t(`common:apiErrors.http.${status}`) : `HTTP ${status}`
}

async function extractError(res: Response): Promise<{ message: string; body: unknown }> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const e = (parsed as { error: unknown }).error
        if (typeof e === 'string' && e) return { message: e, body: parsed }
      }
      return { message: statusText(res.status), body: parsed }
    } catch {
      if (text.length < 300 && !text.trimStart().startsWith('<')) return { message: text, body: null }
    }
  }
  return { message: statusText(res.status), body: null }
}

/** `Retry-After` header in seconds (number of seconds or an HTTP date). */
function retryAfterSecs(res: Response): number | null {
  const v = res.headers.get('Retry-After')
  if (!v) return null
  const n = Number(v)
  if (Number.isFinite(n)) return Math.max(0, Math.round(n))
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000))
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    if (opts.raw) {
      body = opts.body as BodyInit
      headers['Content-Type'] = 'application/octet-stream'
    } else {
      body = JSON.stringify(opts.body)
      headers['Content-Type'] = 'application/json'
    }
  }

  let res: Response
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiRequestError(0, i18n.t('common:apiErrors.panelUnreachable'))
  }

  if (!res.ok) {
    const { message, body } = await extractError(res)
    if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.()
    throw new ApiRequestError(res.status, message, body, retryAfterSecs(res))
  }

  const type = opts.responseType ?? 'json'
  if (type === 'none' || res.status === 204) return undefined as T
  if (type === 'text') return (await res.text()) as T
  if (type === 'blob') return (await res.blob()) as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal })
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body })
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { body })
const put = (path: string) => request<void>('PUT', path, { responseType: 'none' })
const del = (path: string, query?: Query) => request<void>('DELETE', path, { query, responseType: 'none' })

const enc = encodeURIComponent

/** Upload raw bytes with progress (XHR, because fetch has no upload progress). */
export function uploadRaw(
  path: string,
  query: Query,
  data: Blob,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', buildUrl(path, query))
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let msg = statusText(xhr.status)
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string }
        if (parsed.error) msg = parsed.error
      } catch {
        /* ignore */
      }
      if (xhr.status === 401) unauthorizedHandler?.()
      reject(new ApiRequestError(xhr.status, msg))
    }
    xhr.onerror = () => reject(new ApiRequestError(0, i18n.t('common:apiErrors.uploadNetwork')))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(data)
  })
}

export const api = {
  health: () => get<Health>('/health'),

  auth: {
    status: () => request<AuthStatus>('GET', '/auth/status', { skipAuthRedirect: true }),
    setup: (c: Credentials) => request<LoginResponse>('POST', '/auth/setup', { body: c, skipAuthRedirect: true }),
    login: (c: Credentials) => request<LoginResponse>('POST', '/auth/login', { body: c, skipAuthRedirect: true }),
    logout: () => request<void>('POST', '/auth/logout', { responseType: 'none', skipAuthRedirect: true }),
    me: () => get<Me>('/auth/me'),
  },

  /** 2FA of the current user (browser sessions only; API tokens get 403). */
  twoFactor: {
    status: () => get<TwoFactorStatus>('/auth/2fa'),
    setup: () => post<TotpSetup>('/auth/2fa/setup'),
    enable: (code: string) => post<RecoveryCodes>('/auth/2fa/enable', { code }),
    disable: (password: string, code: string) =>
      request<void>('POST', '/auth/2fa/disable', { body: { password, code }, responseType: 'none' }),
    regenerateCodes: (code: string) => post<RecoveryCodes>('/auth/2fa/recovery-codes', { code }),
  },

  security: {
    status: () => get<SecurityStatus>('/security/status'),
    panelKey: () => get<PanelKeyInfo>('/security/panel-key'),
    createPanelKey: (k: PanelKeyInput) => post<PanelKeyInfo>('/security/panel-key', k),
    updatePanelKey: (k: PanelKeyInput) => patch<PanelKeyInfo>('/security/panel-key', k),
    detectIp: (serverId: string) => post<{ ip: string }>('/security/panel-key/detect-ip', { server_id: serverId }),
    deployPanelKey: (r: PanelKeyDeployRequest) => post<ServerOpResult[]>('/security/panel-key/deploy', r),
    rotatePanelKey: () => post<ServerOpResult[]>('/security/panel-key/rotate'),
    revokePanelKey: () => post<ServerOpResult[]>('/security/panel-key/revoke'),
  },

  audit: {
    list: (f: AuditFilter, signal?: AbortSignal) => get<AuditEntry[]>('/audit', f, signal),
    settings: () => get<AuditSettings>('/audit/settings'),
    updateSettings: (s: AuditSettingsInput) => patch<AuditSettings>('/audit/settings', s),
    test: () => post<OkResult>('/audit/test'),
  },

  tokens: {
    list: () => get<ApiToken[]>('/tokens'),
    create: (t: TokenInput) => post<CreateTokenResponse>('/tokens', t),
    update: (id: string, t: TokenInput) => patch<ApiToken>(`/tokens/${enc(id)}`, t),
    remove: (id: string) => del(`/tokens/${enc(id)}`),
  },

  projects: {
    list: () => get<Project[]>('/projects'),
    get: (id: string) => get<Project>(`/projects/${enc(id)}`),
    create: (p: ProjectInput) => post<Project>('/projects', p),
    update: (id: string, p: Partial<ProjectInput>) => patch<Project>(`/projects/${enc(id)}`, p),
    remove: (id: string) => del(`/projects/${enc(id)}`),
    addServer: (id: string, serverId: string) => put(`/projects/${enc(id)}/servers/${enc(serverId)}`),
    removeServer: (id: string, serverId: string) => del(`/projects/${enc(id)}/servers/${enc(serverId)}`),
  },

  identities: {
    list: () => get<Identity[]>('/identities'),
    create: (i: IdentityInput) => post<Identity>('/identities', i),
    update: (id: string, i: Partial<IdentityInput>) => patch<Identity>(`/identities/${enc(id)}`, i),
    remove: (id: string) => del(`/identities/${enc(id)}`),
  },

  servers: {
    list: (q?: { project_id?: string; q?: string; tag?: string }) => get<Server[]>('/servers', q),
    get: (id: string) => get<Server>(`/servers/${enc(id)}`),
    create: (s: ServerInput) => post<Server>('/servers', s),
    bulkCreate: (s: ServerInput[]) => post<Server[]>('/servers/bulk', s),
    update: (id: string, s: Partial<ServerInput>) => patch<Server>(`/servers/${enc(id)}`, s),
    remove: (id: string) => del(`/servers/${enc(id)}`),
    test: (id: string) => post<TestConnectionResult>(`/servers/${enc(id)}/test`),
    forgetHostKey: (id: string) => del(`/servers/${enc(id)}/host-key`),
    exec: (id: string, r: ExecRequest) => post<ExecResult>(`/servers/${enc(id)}/exec`, r),
    stats: (id: string) => get<StatsSnapshot>(`/servers/${enc(id)}/stats`),
    statsHistory: (id: string, hours: number) => get<StatsPoint[]>(`/servers/${enc(id)}/stats/history`, { hours }),
    processes: (id: string) => get<Process[]>(`/servers/${enc(id)}/processes`),
    kill: (id: string, pid: number, signal: KillSignal) =>
      request<void>('POST', `/servers/${enc(id)}/processes/${pid}/kill`, { body: { signal }, responseType: 'none' }),
    services: (id: string) => get<Service[]>(`/servers/${enc(id)}/services`),
    serviceAction: (id: string, name: string, action: ServiceAction) =>
      post<ExecResult>(`/servers/${enc(id)}/services/${enc(name)}/${action}`),
    serviceLogs: (id: string, name: string, lines: number) => get<ServiceLogs>(`/servers/${enc(id)}/services/${enc(name)}/logs`, { lines }),
    power: (id: string, action: PowerAction) =>
      request<void>('POST', `/servers/${enc(id)}/power`, { body: { action }, responseType: 'none' }),
  },

  exec: {
    bulk: (r: BulkExecRequest) => post<BulkExecResponse>('/exec', r),
  },

  stats: {
    all: () => get<StatsSnapshot[]>('/stats'),
  },

  files: {
    list: (serverId: string, path?: string) => get<DirListing>(`/servers/${enc(serverId)}/files`, { path }),
    readText: (serverId: string, path: string, signal?: AbortSignal) =>
      request<string>('GET', `/servers/${enc(serverId)}/files/content`, { query: { path }, responseType: 'text', signal }),
    readBlob: (serverId: string, path: string, signal?: AbortSignal) =>
      request<Blob>('GET', `/servers/${enc(serverId)}/files/content`, { query: { path }, responseType: 'blob', signal }),
    downloadUrl: (serverId: string, path: string) => buildUrl(`/servers/${enc(serverId)}/files/content`, { path, download: 1 }),
    write: (serverId: string, path: string, data: Blob | string) =>
      request<void>('PUT', `/servers/${enc(serverId)}/files/content`, {
        query: { path },
        body: data,
        raw: true,
        responseType: 'none',
      }),
    upload: (serverId: string, path: string, file: Blob, onProgress?: (l: number, t: number) => void, signal?: AbortSignal) =>
      uploadRaw(`/servers/${enc(serverId)}/files/content`, { path }, file, onProgress, signal),
    mkdir: (serverId: string, path: string) =>
      request<void>('POST', `/servers/${enc(serverId)}/files/mkdir`, { body: { path }, responseType: 'none' }),
    rename: (serverId: string, from: string, to: string) =>
      request<void>('POST', `/servers/${enc(serverId)}/files/rename`, { body: { from, to }, responseType: 'none' }),
    remove: (serverId: string, path: string, recursive: boolean) =>
      del(`/servers/${enc(serverId)}/files`, { path, recursive: recursive ? 1 : undefined }),
  },

  notes: {
    list: (q?: { project_id?: string; server_id?: string }) => get<Note[]>('/notes', q),
    create: (n: NoteInput) => post<Note>('/notes', n),
    update: (id: string, n: Partial<NoteInput>) => patch<Note>(`/notes/${enc(id)}`, n),
    remove: (id: string) => del(`/notes/${enc(id)}`),
  },

  system: {
    update: (refresh: boolean) => get<UpdateInfo>('/system/update', { refresh: refresh ? 1 : undefined }),
    updateSettings: (s: Partial<UpdateSettings>) => patch<UpdateSettings>('/system/update/settings', s),
    installUpdate: () => post<InstallStatus>('/system/update/install'),
    installStatus: () => get<InstallStatus>('/system/update/status'),
  },

  graphs: {
    list: (q?: { project_id?: string }) => get<GraphSummary[]>('/graphs', q),
    get: (id: string) => get<Graph>(`/graphs/${enc(id)}`),
    create: (g: GraphInput) => post<Graph>('/graphs', g),
    update: (id: string, g: GraphInput) => patch<Graph>(`/graphs/${enc(id)}`, g),
    remove: (id: string) => del(`/graphs/${enc(id)}`),
  },

  backups: {
    storages: () => get<Storage[]>('/backup-storages'),
    createStorage: (s: StorageInput) => post<Storage>('/backup-storages', s),
    updateStorage: (id: string, s: StoragePatch) => patch<Storage>(`/backup-storages/${enc(id)}`, s),
    removeStorage: (id: string) => del(`/backup-storages/${enc(id)}`),
    testStorage: (id: string) => post<OkResult>(`/backup-storages/${enc(id)}/test`),
    jobs: (q?: { server_id?: string }) => get<BackupJob[]>('/backup-jobs', q),
    createJob: (j: BackupJobInput) => post<BackupJob>('/backup-jobs', j),
    updateJob: (id: string, j: Partial<BackupJobInput>) => patch<BackupJob>(`/backup-jobs/${enc(id)}`, j),
    removeJob: (id: string) => del(`/backup-jobs/${enc(id)}`),
    runJob: (id: string) => post<BackupRun>(`/backup-jobs/${enc(id)}/run`),
    runs: (q?: { job_id?: string; server_id?: string }) => get<BackupRun[]>('/backups', q),
    downloadUrl: (id: string) => buildUrl(`/backups/${enc(id)}/download`),
    removeRun: (id: string) => del(`/backups/${enc(id)}`),
    /** New age key pair; the panel does not keep the private key. */
    generateKey: () => post<BackupKeyPair>('/backup-keys/generate'),
  },
}

/** Absolute ws(s):// URL for a server terminal. Auth via the session cookie (same origin). */
export function terminalUrl(serverId: string, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${buildUrl(`/servers/${enc(serverId)}/terminal`, { cols, rows })}`
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
