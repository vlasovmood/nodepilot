import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { invalidateSecurity, invalidateServers, useProjects, useServers, useStatsMap } from '../../api/queries'
import type { PanelKeyDeployRequest, PanelKeyInfo, ServerOpResult } from '../../api/types'
import { Modal } from '../../components/Modal'
import { InlineError, Spinner } from '../../components/States'
import { StatusDot } from '../../components/StatusDot'
import { Segmented } from '../../components/Tabs'
import { intlLocale } from '../../i18n'
import { matchesFilter } from '../servers/model'
import { OpResultsTable } from './OpResults'

type Mode = 'servers' | 'project'

/** Install the panel key on chosen servers (or a project), verify it and optionally switch them to it. */
export function DeployDialog({ info, onClose }: { info: PanelKeyInfo; onClose: () => void }) {
  const { t, i18n } = useTranslation('security')
  const qc = useQueryClient()
  const servers = useServers()
  const projects = useProjects()
  const stats = useStatsMap()
  const [mode, setMode] = useState<Mode>('servers')
  const [q, setQ] = useState('')
  const [onlyNotOnKey, setOnlyNotOnKey] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [projectId, setProjectId] = useState('')
  const [switchAuth, setSwitchAuth] = useState(true)
  const [results, setResults] = useState<ServerOpResult[] | null>(null)

  const panelIdentity = info.identity_id
  const onKey = (identityId: string | null) => !!panelIdentity && identityId === panelIdentity

  const list = useMemo(
    () =>
      (servers.data ?? [])
        .filter((s) => matchesFilter(s, q.trim()) && (!onlyNotOnKey || !panelIdentity || s.identity_id !== panelIdentity))
        .sort((a, b) => a.name.localeCompare(b.name, intlLocale(i18n.language), { numeric: true })),
    [servers.data, q, onlyNotOnKey, panelIdentity, i18n.language],
  )

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const m = useMutation({
    mutationFn: () => {
      const body: PanelKeyDeployRequest = { switch_auth: switchAuth }
      if (mode === 'project') body.project_id = projectId
      else body.server_ids = [...selected]
      return api.security.deployPanelKey(body)
    },
    onSuccess: (r) => {
      setResults(r)
      invalidateSecurity(qc)
      invalidateServers(qc)
    },
  })

  const project = projects.data?.find((p) => p.id === projectId)
  const count = mode === 'project' ? (project?.server_count ?? 0) : selected.size
  const canRun = !m.isPending && (mode === 'project' ? !!projectId : selected.size > 0)

  return (
    <Modal
      open
      onClose={onClose}
      locked={m.isPending}
      size="lg"
      title={t('panelKey.deploy.title')}
      footer={
        results ? (
          <>
            <button className="btn" onClick={() => setResults(null)}>
              {t('panelKey.deploy.again')}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              {t('common:actions.close')}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={m.isPending}>
              {t('common:actions.cancel')}
            </button>
            <button className="btn btn-primary" disabled={!canRun} onClick={() => m.mutate()}>
              {m.isPending ? <Spinner /> : <Play size={14} />} {t('panelKey.deploy.run', { count })}
            </button>
          </>
        )
      }
    >
      {results ? (
        <div className="stack">
          {switchAuth ? (
            <div className="muted small">{t('panelKey.deploy.resultsSwitched')}</div>
          ) : (
            <div className="muted small">{t('panelKey.deploy.resultsInstalled')}</div>
          )}
          <OpResultsTable results={results} />
        </div>
      ) : (
        <div className="stack">
          <div className="muted">{t('panelKey.deploy.text')}</div>
          <div className="row-wrap">
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'servers', label: t('panelKey.deploy.modeServers') },
                { value: 'project', label: t('panelKey.deploy.modeProject') },
              ]}
            />
          </div>
          {mode === 'project' ? (
            <select
              className="select"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label={t('common:fields.project')}
            >
              <option value="">{t('panelKey.deploy.pickProject')}</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.server_count})
                </option>
              ))}
            </select>
          ) : (
            <>
              <div className="row-wrap">
                <div className="input-icon grow">
                  <Search size={14} />
                  <input
                    className="input"
                    autoFocus
                    placeholder={t('panelKey.deploy.search')}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <label className="checkbox small">
                  <input type="checkbox" checked={onlyNotOnKey} onChange={(e) => setOnlyNotOnKey(e.target.checked)} />
                  {t('panelKey.deploy.onlyNotOnKey')}
                </label>
              </div>
              <div className="row small">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSelected(new Set([...selected, ...list.map((s) => s.id)]))}
                  disabled={list.length === 0}
                >
                  {t('panelKey.deploy.selectAll', { count: list.length })}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                  {t('panelKey.deploy.clear')}
                </button>
                <span className="spacer" />
                <span className="muted">{t('panelKey.deploy.selected', { count: selected.size })}</span>
              </div>
              <div className="picker-list" data-testid="deploy-servers">
                {servers.isPending && (
                  <div className="muted small" style={{ padding: 12 }}>
                    {t('common:state.loading')}
                  </div>
                )}
                {!servers.isPending && list.length === 0 && (
                  <div className="muted small" style={{ padding: 12 }}>
                    {t('common:state.nothingFound')}
                  </div>
                )}
                {list.map((s) => (
                  <label key={s.id} className="picker-item">
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                    <StatusDot status={stats.get(s.id)?.status ?? s.status} />
                    <span className="ellipsis" style={{ fontWeight: 600 }}>
                      {s.name}
                    </span>
                    <span className="dim mono ellipsis small">
                      {s.username}@{s.host}
                    </span>
                    {onKey(s.identity_id) && (
                      <span className="badge badge-ok" style={{ marginInlineStart: 'auto' }}>
                        {t('panelKey.deploy.onKey')}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={switchAuth} onChange={(e) => setSwitchAuth(e.target.checked)} />
            {t('panelKey.deploy.switchAuth')}
          </label>
          <div className="muted small">{switchAuth ? t('panelKey.deploy.switchAuthHint') : t('panelKey.deploy.noSwitchHint')}</div>
          {m.isPending && (
            <div className="row muted small">
              <Spinner /> {t('panelKey.working')}
            </div>
          )}
          <InlineError error={m.error} />
        </div>
      )}
    </Modal>
  )
}
