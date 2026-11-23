import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Download, FileJson, Search, Send, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { API_BASE, request } from '../../api/client'
import { useConfirm } from '../../components/Confirm'
import { CopyButton } from '../../components/CopyButton'
import { ErrorState, InlineError, Loading, Spinner } from '../../components/States'
import { formatBytes, formatDuration } from '../../lib/format'
import { cx } from '../../lib/util'
import {
  cleanDescription,
  exampleFor,
  groupEndpoints,
  isBinaryBody,
  isBinaryDownload,
  isPublic,
  isWebSocket,
  jsonBodySchema,
  listEndpoints,
  tagLabel,
  viewSchema,
  type Endpoint,
  type OpenApiSpec,
} from './openapi'
import { AREA_BY_KEY, areaLabel, permissionLabel } from './permissions'
import { RichText, SchemaTree } from './SchemaTree'
import { CopyValue, Snippet } from './Snippet'

function useOpenApi() {
  return useQuery({
    queryKey: ['openapi'],
    queryFn: () => request<OpenApiSpec>('GET', '/openapi.json'),
    staleTime: Infinity,
  })
}

export function MethodPill({ method }: { method: string }) {
  return <span className={cx('method', `method-${method}`)}>{method === 'delete' ? 'DEL' : method.toUpperCase()}</span>
}

export function PermissionBadge({ perm, isPublic: pub }: { perm: string | undefined; isPublic?: boolean }) {
  const { t } = useTranslation('developer')
  const label = pub ? t('perm.public') : permissionLabel(perm)
  const write = !!perm && perm.endsWith(':write')
  return (
    <span className={cx('badge', write && 'badge-perm-write')} title={perm ? `x-permission: ${perm}` : undefined}>
      {label}
    </span>
  )
}

export function ReferenceTab() {
  const { t } = useTranslation('developer')
  const spec = useOpenApi()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const selectedKey = params.get('op')

  const endpoints = useMemo(() => (spec.data ? listEndpoints(spec.data) : []), [spec.data])
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = term
      ? endpoints.filter((e) =>
          [e.method, e.path, e.op.summary ?? '', e.op.operationId ?? '', e.tag, tagLabel(e.tag), e.op['x-permission'] ?? '']
            .join(' ')
            .toLowerCase()
            .includes(term),
        )
      : endpoints
    return groupEndpoints(list)
  }, [endpoints, q, t]) // t: tag labels in the search text depend on the language
  const selected = endpoints.find((e) => e.key === selectedKey) ?? null

  const listRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  useEffect(() => {
    if (scrolled.current || !selected || !listRef.current) return
    scrolled.current = true
    listRef.current.querySelector('.ep-item.active')?.scrollIntoView({ block: 'center' })
  }, [selected])

  const select = (e: Endpoint) => {
    const next = new URLSearchParams(params)
    next.set('op', e.key)
    setParams(next, { replace: true })
  }

  if (spec.isPending) return <Loading label={t('reference.loading')} />
  if (spec.isError) return <ErrorState error={spec.error} onRetry={() => void spec.refetch()} />

  const base = `${window.location.origin}${API_BASE}`
  const searching = !!q.trim()

  return (
    <div className="ref-shell">
      <div className="card ref-head">
        <div className="ref-head-main">
          <div className="ref-head-item">
            <span className="muted small">{t('reference.baseUrl')}</span>
            <CopyValue value={base} />
          </div>
          <div className="ref-head-item">
            <span className="muted small">{t('reference.auth')}</span>
            <code>Authorization: Bearer np_…</code>
          </div>
          <span className="spacer" />
          <a className="btn btn-sm" href={`${API_BASE}/openapi.json`} download="nodepilot-openapi.json">
            <Download size={14} /> openapi.json
          </a>
        </div>
        <div className="muted small">
          <Trans
            t={t}
            i18nKey="reference.specInfo"
            values={{ version: spec.data.openapi, endpoints: t('reference.endpoints', { count: endpoints.length }) }}
            components={{ code: <code /> }}
          />
        </div>
      </div>

      <div className="ref-grid">
        <div className="ref-list card">
          <div className="ref-search">
            <div className="input-icon">
              <Search size={14} />
              <input className="input" placeholder={t('reference.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {searching && (
              <button className="btn btn-ghost btn-icon btn-sm" title={t('reference.clear')} onClick={() => setQ('')}>
                <X size={14} />
              </button>
            )}
          </div>
          <div className="ref-list-scroll" ref={listRef}>
            {groups.length === 0 && (
              <div className="dim small" style={{ padding: 14 }}>
                {t('reference.nothingFound')}
              </div>
            )}
            {groups.map((g) => {
              const isOpen = searching || !collapsed.has(g.tag)
              return (
                <div key={g.tag} className="ep-group">
                  <button
                    className="ep-group-head"
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c)
                        if (n.has(g.tag)) n.delete(g.tag)
                        else n.add(g.tag)
                        return n
                      })
                    }
                    aria-expanded={isOpen}
                  >
                    <ChevronDown size={14} style={{ transform: isOpen ? undefined : 'rotate(-90deg)' }} />
                    <span className="grow">{tagLabel(g.tag)}</span>
                    <span className="count">{g.items.length}</span>
                  </button>
                  {isOpen &&
                    g.items.map((e) => (
                      <button
                        key={e.key}
                        className={cx('ep-item', selected?.key === e.key && 'active')}
                        onClick={() => select(e)}
                        title={e.op.summary}
                      >
                        <MethodPill method={e.method} />
                        <span className="ep-text">
                          <span className="ep-path">{e.path}</span>
                          <span className="ep-summary">{e.op.summary}</span>
                        </span>
                      </button>
                    ))}
                </div>
              )
            })}
          </div>
        </div>

        <div className="ref-detail card">
          {selected ? <EndpointDetails key={selected.key} spec={spec.data} ep={selected} /> : <Overview spec={spec.data} />}
        </div>
      </div>
    </div>
  )
}

function Overview({ spec }: { spec: OpenApiSpec }) {
  const { t } = useTranslation('developer')
  const areas = spec['x-permission-areas'] ?? []
  return (
    <div className="ref-detail-scroll stack">
      <div className="stack-sm">
        <h2 className="row">
          <FileJson size={16} /> {spec.info.title} <span className="badge">v{spec.info.version}</span>
        </h2>
        {spec.info.description && (
          <div className="muted">
            <RichText text={spec.info.description} />
          </div>
        )}
      </div>
      <div className="muted small">{t('reference.overviewHint')}</div>
      {areas.length > 0 && (
        <div className="stack-sm">
          <h3>{t('reference.areasTitle')}</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('reference.areasTable.area')}</th>
                  <th>{t('reference.areasTable.key')}</th>
                  <th>{t('reference.areasTable.contents')}</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.name}>
                    <td className="nowrap">{AREA_BY_KEY.has(a.name) ? areaLabel(AREA_BY_KEY.get(a.name)!) : a.name}</td>
                    <td>
                      <code>{a.name}</code>
                    </td>
                    <td className="wrap muted">{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- endpoint details ----------

type TryResult = { status: number; statusText: string; ms: number; size: number; contentType: string; body: string; json: boolean }

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function EndpointDetails({ spec, ep }: { spec: OpenApiSpec; ep: Endpoint }) {
  const { t } = useTranslation('developer')
  const confirm = useConfirm()
  const { op, method, path } = ep
  const pathParams = ep.parameters.filter((p) => p.in === 'path')
  const queryParams = ep.parameters.filter((p) => p.in === 'query')
  const bodySchema = jsonBodySchema(op)
  const binaryBody = isBinaryBody(op)
  const ws = isWebSocket(op)
  const download = isBinaryDownload(op)
  const pub = isPublic(op)
  const description = cleanDescription(op)

  const [values, setValues] = useState<Record<string, string>>({})
  const [body, setBody] = useState(() => (bodySchema ? JSON.stringify(exampleFor(spec, bodySchema), null, 2) : ''))
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<TryResult | null>(null)
  const [error, setError] = useState<unknown>(null)

  const val = (name: string, where: string) => values[`${where}:${name}`] ?? ''
  const setVal = (name: string, where: string, v: string) => setValues((cur) => ({ ...cur, [`${where}:${name}`]: v }))

  const builtPath = path.replace(/\{([^}]+)\}/g, (m, name: string) => {
    const v = val(name, 'path')
    return v ? encodeURIComponent(v) : m
  })
  const qs = new URLSearchParams()
  for (const p of queryParams) {
    const v = val(p.name, 'query')
    if (v !== '') qs.set(p.name, v)
  }
  const query = qs.toString()
  const relUrl = `${API_BASE}${builtPath}${query ? `?${query}` : ''}`
  const absUrl = `${window.location.origin}${relUrl}`
  const wsUrl = absUrl.replace(/^http/, 'ws')
  const missing = pathParams.filter((p) => !val(p.name, 'path').trim())
  const sendsBody = !!bodySchema && method !== 'get' && method !== 'head'

  let bodyError: string | null = null
  let compactBody = body
  if (sendsBody && body.trim()) {
    try {
      compactBody = JSON.stringify(JSON.parse(body))
    } catch (e) {
      bodyError = e instanceof Error ? e.message : String(e)
    }
  }

  const curl = useMemo(() => {
    const lines = [`curl${method === 'get' ? '' : ` -X ${method.toUpperCase()}`} ${shellQuote(ws ? wsUrl : absUrl)}`]
    if (!pub) lines.push(`-H 'Authorization: Bearer np_…'`)
    if (sendsBody) lines.push(`-H 'Content-Type: application/json'`, `-d ${shellQuote(compactBody || '{}')}`)
    if (binaryBody) lines.push(`-H 'Content-Type: application/octet-stream'`, `--data-binary @${t('reference.curlFile')}`)
    if (download) lines.push(`-o ${t('reference.curlFile')}`)
    return lines.join(' \\\n  ')
  }, [method, ws, wsUrl, absUrl, pub, sendsBody, compactBody, binaryBody, download, t])

  const send = async () => {
    const risky = method === 'delete' || path.includes('/power') || path === '/auth/logout'
    if (risky) {
      const ok = await confirm({
        title: t('reference.confirm.title', { method: method.toUpperCase() }),
        message: (
          <>
            <Trans
              t={t}
              i18nKey="reference.confirm.message"
              values={{ request: `${method.toUpperCase()} ${relUrl}` }}
              components={{ code: <code /> }}
            />
            {path.includes('/power') && ` ${t('reference.confirm.power')}`}
            {path === '/auth/logout' && ` ${t('reference.confirm.logout')}`}
          </>
        ),
        confirmText: t('common:actions.send'),
        danger: true,
      })
      if (!ok) return
    }
    setSending(true)
    setError(null)
    setResult(null)
    const t0 = performance.now()
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (sendsBody) headers['Content-Type'] = 'application/json'
      const res = await fetch(relUrl, {
        method: method.toUpperCase(),
        headers,
        body: sendsBody ? compactBody || '{}' : undefined,
        credentials: 'include',
      })
      const text = await res.text()
      const ms = performance.now() - t0
      const contentType = res.headers.get('content-type') ?? ''
      let out = text
      let json = false
      if (text && (contentType.includes('json') || /^[[{]/.test(text.trim()))) {
        try {
          out = JSON.stringify(JSON.parse(text), null, 2)
          json = true
        } catch {
          /* keep as text */
        }
      }
      setResult({ status: res.status, statusText: res.statusText, ms, size: new Blob([text]).size, contentType, body: out, json })
    } catch (e) {
      setError(e instanceof Error ? new Error(t('reference.requestFailed', { message: e.message })) : e)
    } finally {
      setSending(false)
    }
  }

  const responses = Object.entries(op.responses ?? {})

  return (
    <div className="ref-detail-scroll">
      <div className="ep-head">
        <div className="row" style={{ gap: 10 }}>
          <MethodPill method={method} />
          <code className="ep-full-path grow">/api{path}</code>
          <CopyButton text={`${API_BASE}${path}`} />
        </div>
        <h2>{op.summary ?? op.operationId}</h2>
        <div className="row-wrap">
          <PermissionBadge perm={op['x-permission']} isPublic={pub} />
          <span className="badge">{tagLabel(ep.tag)}</span>
          {op.operationId && <span className="dim small mono">{op.operationId}</span>}
        </div>
        {description && (
          <div className="muted">
            <RichText text={description} />
          </div>
        )}
      </div>

      {ep.parameters.length > 0 && (
        <section className="ep-section">
          <h3>{t('reference.params')}</h3>
          <div className="table-wrap">
            <table className="table params-table">
              <thead>
                <tr>
                  <th>{t('reference.paramsTable.name')}</th>
                  <th>{t('reference.paramsTable.in')}</th>
                  <th>{t('reference.paramsTable.type')}</th>
                  <th>{t('reference.paramsTable.description')}</th>
                </tr>
              </thead>
              <tbody>
                {ep.parameters.map((p) => {
                  const v = viewSchema(spec, p.schema)
                  return (
                    <tr key={`${p.in}:${p.name}`}>
                      <td className="nowrap">
                        <code>{p.name}</code>
                        {p.required && <span className="sch-req">{t('reference.required')}</span>}
                      </td>
                      <td className="dim">{p.in}</td>
                      <td className="nowrap mono small">
                        {v.typeLabel}
                        {v.notes.length > 0 && <span className="dim"> · {v.notes.join(', ')}</span>}
                      </td>
                      <td className="wrap muted">
                        {(p.description ?? v.description) ? (
                          <RichText text={(p.description ?? v.description)!} />
                        ) : (
                          <span className="dim">—</span>
                        )}
                        {v.enumValues && (
                          <div className="small">
                            {t('reference.oneOfList', { values: v.enumValues.map((x) => JSON.stringify(x)).join(', ') })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {op.requestBody && (
        <section className="ep-section">
          <h3>
            {t('reference.requestBody')}{' '}
            <span className="dim small mono">
              {Object.keys(op.requestBody.content ?? {}).join(', ')}
              {op.requestBody.required ? '' : ` · ${t('reference.optional')}`}
            </span>
          </h3>
          {bodySchema ? <SchemaTree spec={spec} schema={bodySchema} /> : <div className="muted small">{t('reference.rawBody')}</div>}
        </section>
      )}

      <section className="ep-section">
        <h3>{t('reference.responses')}</h3>
        <div className="stack-sm">
          {responses.map(([code, r]) => {
            const json = r.content?.['application/json']?.schema
            const types = Object.keys(r.content ?? {})
            const err = code.startsWith('4') || code.startsWith('5')
            return (
              <div key={code} className="resp">
                <div className="resp-head">
                  <span className={cx('status-code', code.startsWith('2') ? 'ok' : err ? 'err' : 'info')}>{code}</span>
                  <span>{r.description}</span>
                  {types.length > 0 && <span className="dim small mono">{types.join(', ')}</span>}
                </div>
                {json && !err && <SchemaTree spec={spec} schema={json} />}
                {json && err && (
                  <div className="dim small">
                    <code>{t('reference.errorShape')}</code>
                  </div>
                )}
                {code === '101' && <div className="dim small">{t('reference.switchingProtocols')}</div>}
              </div>
            )
          })}
        </div>
      </section>

      <section className="ep-section try">
        <h3>{t('reference.tryIt')}</h3>
        {(pathParams.length > 0 || queryParams.length > 0) && (
          <div className="try-grid">
            {[...pathParams, ...queryParams].map((p) => (
              <label key={`${p.in}:${p.name}`} className="field">
                <span className="field-label">
                  <code>{p.name}</code> <span className="dim">· {p.in}</span>
                  {p.required && <span className="sch-req">{t('reference.required')}</span>}
                </span>
                <input
                  className="input input-sm mono"
                  value={val(p.name, p.in)}
                  placeholder={viewSchema(spec, p.schema).typeLabel}
                  onChange={(e) => setVal(p.name, p.in, e.target.value)}
                />
              </label>
            ))}
          </div>
        )}

        {ws ? (
          <div className="stack-sm">
            <div className="muted small">
              <Trans t={t} i18nKey="reference.wsInfo" components={{ code: <code /> }} />
            </div>
            <CopyValue value={wsUrl} />
          </div>
        ) : binaryBody ? (
          <div className="muted small">
            <Trans t={t} i18nKey="reference.binaryInfo" components={{ code: <code /> }} />
          </div>
        ) : download ? (
          <div className="stack-sm">
            <div className="muted small">{t('reference.downloadInfo')}</div>
            <div className="row-wrap">
              <CopyValue value={absUrl} />
              {missing.length === 0 ? (
                <a className="btn btn-sm" href={relUrl} target="_blank" rel="noreferrer">
                  <Download size={14} /> {t('common:actions.download')}
                </a>
              ) : (
                <span className="dim small">{t('reference.fillIn', { names: missing.map((p) => p.name).join(', ') })}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="stack-sm">
            {sendsBody && (
              <div className="field">
                <span className="field-label row">
                  <span className="grow">{t('reference.bodyJson')}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setBody(JSON.stringify(exampleFor(spec, bodySchema), null, 2))}
                  >
                    {t('reference.example')}
                  </button>
                </span>
                <textarea
                  className="textarea mono try-body"
                  spellCheck={false}
                  rows={Math.min(16, Math.max(4, body.split('\n').length + 1))}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                {bodyError && <span className="field-error">{t('reference.invalidJson', { error: bodyError })}</span>}
              </div>
            )}
            <div className="row-wrap">
              <button className="btn btn-primary" disabled={sending || missing.length > 0 || !!bodyError} onClick={() => void send()}>
                {sending ? <Spinner /> : <Send size={14} />} {t('common:actions.send')}
              </button>
              <span className="dim small">
                {missing.length > 0
                  ? t('reference.fillInSentence', { names: missing.map((p) => p.name).join(', ') })
                  : t('reference.liveNote')}
              </span>
            </div>
            <InlineError error={error} />
            {result && (
              <div className="try-result">
                <div className="try-result-head">
                  <span className={cx('status-code', result.status < 300 ? 'ok' : result.status < 400 ? 'info' : 'err')}>
                    {result.status}
                  </span>
                  <span>{result.statusText}</span>
                  <span className="dim small">{formatDuration(result.ms)}</span>
                  <span className="dim small">{formatBytes(result.size)}</span>
                  {result.contentType && <span className="dim small mono ellipsis">{result.contentType}</span>}
                  <span className="spacer" />
                  {result.body && <CopyButton text={result.body} />}
                </div>
                {result.body ? (
                  <pre className="output try-output">{result.body}</pre>
                ) : (
                  <div className="dim small">{t('reference.emptyResponse')}</div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="ep-section">
        <Snippet title="curl" code={curl} hint={pub ? undefined : t('reference.curlHint')} />
      </section>
    </div>
  )
}
