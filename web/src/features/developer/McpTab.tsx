import { useQuery } from '@tanstack/react-query'
import { Bot, Search, ShieldAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { API_BASE, request } from '../../api/client'
import { ErrorState, Loading } from '../../components/States'
import { AREA_BY_KEY, AREAS, areaLabel, permissionArea } from './permissions'
import { PermissionBadge } from './ReferenceTab'
import { CopyValue, Snippet } from './Snippet'

type McpTool = {
  name: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
  _meta?: Record<string, unknown>
}

type RpcResponse<T> = { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string } }

async function listTools(): Promise<McpTool[]> {
  const r = await request<RpcResponse<{ tools: McpTool[] }>>('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  if (r.error) throw new Error(`MCP: ${r.error.message}`)
  return r.result?.tools ?? []
}

const toolPerm = (t: McpTool) => {
  const p = t._meta?.['nodepilot/permission']
  return typeof p === 'string' ? p : undefined
}

export function McpTab() {
  const { t } = useTranslation('developer')
  const tools = useQuery({ queryKey: ['mcp-tools'], queryFn: listTools, staleTime: 5 * 60_000 })
  const [q, setQ] = useState('')
  const base = window.location.origin
  const endpoint = `${base}${API_BASE}/mcp`

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    const list = (tools.data ?? []).filter((tool) => !term || `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(term))
    const order = AREAS.map((a) => a.key as string)
    const map = new Map<string, McpTool[]>()
    for (const tool of list) {
      const area = permissionArea(toolPerm(tool)) ?? 'other'
      map.set(area, [...(map.get(area) ?? []), tool])
    }
    const rank = (k: string) => (order.indexOf(k) === -1 ? order.length : order.indexOf(k))
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b))
  }, [tools.data, q])

  return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <Bot size={15} />
          <h3>Model Context Protocol</h3>
        </div>
        <div className="card-body stack">
          <div>{t('mcp.intro')}</div>
          <div className="ref-head-item">
            <span className="muted small">{t('mcp.endpoint')}</span>
            <CopyValue value={endpoint} />
          </div>
          <div className="mcp-snippets">
            <Snippet
              title="Claude Code"
              code={`claude mcp add --transport http nodepilot ${endpoint} --header "Authorization: Bearer np_…"`}
            />
            <Snippet
              title={t('mcp.jsonConfig')}
              hint={t('mcp.jsonConfigHint')}
              code={JSON.stringify(
                { mcpServers: { nodepilot: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer np_…' } } } },
                null,
                2,
              )}
            />
            <Snippet title={t('mcp.stdio')} hint={t('mcp.stdioHint')} code="nodepilot mcp --data-dir /var/lib/nodepilot --token np_…" />
          </div>
          <div className="alert alert-info">
            <ShieldAlert size={15} />
            <div className="grow">
              <Trans t={t} i18nKey="mcp.scopeInfo" components={{ link: <Link to="/developer/tokens" />, code: <code /> }} />
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <Wrench size={15} />
          <h3 className="grow">
            {t('mcp.tools')}
            {tools.data && <span className="dim"> · {t('mcp.toolCount', { count: tools.data.length })}</span>}
          </h3>
          <div className="input-icon mcp-search">
            <Search size={14} />
            <input className="input input-sm" placeholder={t('mcp.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="card-body">
          {tools.isPending ? (
            <Loading label={t('mcp.loading')} />
          ) : tools.isError ? (
            <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
          ) : groups.length === 0 ? (
            <div className="dim small">{t('mcp.nothingFound')}</div>
          ) : (
            <div className="stack">
              {groups.map(([area, list]) => (
                <div key={area} className="mcp-group">
                  <div className="mcp-group-head">
                    <span>{AREA_BY_KEY.has(area) ? areaLabel(AREA_BY_KEY.get(area)!) : t('mcp.otherGroup')}</span>
                    <span className="dim small">{list.length}</span>
                  </div>
                  <div className="mcp-tools">
                    {list.map((tool) => {
                      const args = Object.keys(tool.inputSchema?.properties ?? {})
                      const req = new Set(tool.inputSchema?.required ?? [])
                      return (
                        <div key={tool.name} className="mcp-tool">
                          <div className="row-wrap">
                            <code className="mcp-tool-name">{tool.name}</code>
                            <PermissionBadge perm={toolPerm(tool)} />
                            {tool.annotations?.destructiveHint && <span className="badge badge-warn">{t('mcp.destructive')}</span>}
                          </div>
                          {tool.description && <div className="muted small">{tool.description}</div>}
                          {args.length > 0 && (
                            <div className="dim small mono mcp-args">{args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ')}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
