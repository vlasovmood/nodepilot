import { CheckSquare, Search, Square, SquareTerminal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { useProjects, useServers, useStatsMap } from '../api/queries'
import type { BulkExecResult } from '../api/types'
import { ErrorState, Loading } from '../components/States'
import { StatusDot } from '../components/StatusDot'
import { Segmented } from '../components/Tabs'
import { ExecForm } from '../features/exec/ExecForm'
import { ExecResults } from '../features/exec/ExecResults'
import { intlLocale } from '../i18n'
import { formatDateTime } from '../lib/format'
import { uniq } from '../lib/util'

type Mode = 'servers' | 'project'

export function ExecPage() {
  const { t, i18n } = useTranslation('exec')
  const location = useLocation()
  const preselected = (location.state as { serverIds?: string[] } | null)?.serverIds
  const servers = useServers()
  const projects = useProjects()
  const stats = useStatsMap()
  const [mode, setMode] = useState<Mode>('servers')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected ?? []))
  const [projectId, setProjectId] = useState('')
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [onlyOnline, setOnlyOnline] = useState(false)
  const [runs, setRuns] = useState<{ id: number; cmd: string; at: string; results: BulkExecResult[] }[]>([])

  const allTags = useMemo(() => uniq((servers.data ?? []).flatMap((s) => s.tags)).sort(), [servers.data])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (servers.data ?? [])
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q))
      .filter((s) => !tag || s.tags.includes(tag))
      .filter((s) => !onlyOnline || (stats.get(s.id)?.status ?? s.status) === 'online')
      .sort((a, b) => a.name.localeCompare(b.name, intlLocale(i18n.language), { numeric: true }))
  }, [servers.data, search, tag, onlyOnline, stats, i18n.language])

  const project = projects.data?.find((p) => p.id === projectId)
  const target = mode === 'servers' ? { server_ids: Array.from(selected) } : { project_id: projectId, count: project?.server_count ?? 0 }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1 className="row">
            <SquareTerminal size={18} /> {t('page.title')}
          </h1>
          <span className="muted small">{t('page.subtitle')}</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div className="card">
          <div className="card-header">
            <h3 className="grow">{t('targets.title')}</h3>
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'servers', label: t('targets.servers') },
                { value: 'project', label: t('targets.project') },
              ]}
            />
          </div>
          <div className="card-body stack-sm">
            {mode === 'project' ? (
              <>
                <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">{t('targets.selectProject')}</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.server_count})
                    </option>
                  ))}
                </select>
                <span className="field-hint">{t('targets.projectHint')}</span>
              </>
            ) : servers.isPending ? (
              <Loading />
            ) : servers.isError ? (
              <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
            ) : (
              <>
                <div className="input-icon">
                  <Search size={14} />
                  <input className="input" placeholder={t('targets.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="row">
                  <select className="select select-sm grow" value={tag} onChange={(e) => setTag(e.target.value)}>
                    <option value="">{t('targets.allTags')}</option>
                    {allTags.map((tg) => (
                      <option key={tg} value={tg}>
                        {tg}
                      </option>
                    ))}
                  </select>
                  <label className="checkbox small">
                    <input type="checkbox" checked={onlyOnline} onChange={(e) => setOnlyOnline(e.target.checked)} />
                    {t('targets.onlyOnline')}
                  </label>
                </div>
                <div className="row">
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      setSelected((s) => {
                        const n = new Set(s)
                        visible.forEach((v) => n.add(v.id))
                        return n
                      })
                    }
                  >
                    <CheckSquare size={13} /> {t('targets.selectVisible')}
                  </button>
                  <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
                    <Square size={13} /> {t('targets.clear')}
                  </button>
                  <span className="spacer" />
                  <span className="small muted">{t('targets.selected', { n: selected.size })}</span>
                </div>
                <div className="check-list" style={{ maxHeight: 460 }}>
                  {visible.length === 0 && (
                    <div className="dim small" style={{ padding: 8 }}>
                      {t('targets.noServers')}
                    </div>
                  )}
                  {visible.map((s) => (
                    <label key={s.id} className="checkbox">
                      <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                      <StatusDot status={stats.get(s.id)?.status ?? s.status} />
                      <span className="ellipsis grow">{s.name}</span>
                      <span className="dim mono small ellipsis" style={{ maxWidth: 120 }}>
                        {s.host}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card card-pad">
            <ExecForm
              target={target}
              onResults={(results, cmd) =>
                setRuns((r) => [{ id: Date.now(), cmd, at: new Date().toISOString(), results }, ...r].slice(0, 10))
              }
            />
          </div>
          {runs.length === 0 && <div className="dim small">{t('runs.empty')}</div>}
          {runs.map((r, i) => (
            <div key={r.id} className="card card-pad stack-sm" style={i > 0 ? { opacity: 0.85 } : undefined}>
              <div className="row">
                <code className="grow ellipsis" title={r.cmd}>
                  $ {r.cmd}
                </code>
                <span className="dim small">{formatDateTime(r.at, true)}</span>
                {i > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setRuns((x) => x.filter((y) => y.id !== r.id))}>
                    {t('runs.hide')}
                  </button>
                )}
              </div>
              <ExecResults results={r.results} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
