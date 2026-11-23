import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Play, Power, PowerOff, RefreshCw, RotateCw, ScrollText, Search, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk } from '../../api/queries'
import type { Server, Service, ServiceAction } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { CopyButton } from '../../components/CopyButton'
import { Menu } from '../../components/Menu'
import { Modal } from '../../components/Modal'
import { ErrorState, Loading, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { useToast } from '../../components/Toast'

type StateFilter = 'all' | 'active' | 'failed' | 'inactive'

function activeBadge(s: Service) {
  const cls =
    s.active === 'active'
      ? 'badge badge-ok'
      : s.active === 'failed'
        ? 'badge badge-danger'
        : s.active === 'activating' || s.active === 'deactivating'
          ? 'badge badge-warn'
          : 'badge'
  return <span className={cls}>{s.active}</span>
}

export function ServicesTab({ server }: { server: Server }) {
  const { t } = useTranslation('server')
  const actionLabel = (a: ServiceAction) => t(`services.actions.${a}`)
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [filter, setFilter] = useState('')
  const [state, setState] = useState<StateFilter>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)

  const services = useQuery({ queryKey: qk.services(server.id), queryFn: () => api.servers.services(server.id) })

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return (services.data ?? [])
      .filter((s) => !term || s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term))
      .filter((s) => state === 'all' || (state === 'inactive' ? s.active !== 'active' && s.active !== 'failed' : s.active === state))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [services.data, filter, state])

  const counts = useMemo(() => {
    const c = { active: 0, failed: 0 }
    for (const s of services.data ?? []) {
      if (s.active === 'active') c.active++
      else if (s.active === 'failed') c.failed++
    }
    return c
  }, [services.data])

  const run = async (s: Service, action: ServiceAction) => {
    if (action === 'stop' || action === 'disable' || action === 'restart') {
      const ok = await confirm({
        title: t('services.confirmTitle', { action: actionLabel(action), name: s.name }),
        message: action === 'stop' ? t('services.stopMessage') : undefined,
        confirmText: actionLabel(action),
        danger: action === 'stop',
      })
      if (!ok) return
    }
    setBusy(s.name)
    try {
      const r = await api.servers.serviceAction(server.id, s.name, action)
      if (r.exit_code === 0)
        toast.success(t('services.done', { action: actionLabel(action), name: s.name }), r.stdout.trim() || t('services.doneDetail'))
      else
        toast.error(
          t('services.exitCode', { action, name: s.name, code: r.exit_code ?? '—' }),
          r.stderr.trim() || r.stdout.trim() || undefined,
        )
      void qc.invalidateQueries({ queryKey: qk.services(server.id) })
    } catch (e) {
      toast.error(t('services.failed', { action }), e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <div className="input-icon" style={{ width: 280 }}>
          <Search size={14} />
          <input
            className="input"
            placeholder={t('services.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <Segmented<StateFilter>
          value={state}
          onChange={setState}
          options={[
            { value: 'all', label: t('services.filter.all') },
            { value: 'active', label: t('services.filter.active', { n: counts.active }) },
            { value: 'failed', label: t('services.filter.failed', { n: counts.failed }) },
            { value: 'inactive', label: t('services.filter.inactive') },
          ]}
        />
        <span className="spacer" />
        <button className="btn" onClick={() => void services.refetch()} disabled={services.isFetching}>
          <RefreshCw size={14} className={services.isFetching ? 'spin' : undefined} /> {t('common:actions.refresh')}
        </button>
      </div>
      {services.isPending ? (
        <Loading label={t('services.loading')} />
      ) : services.isError ? (
        <ErrorState error={services.error} onRetry={() => void services.refetch()} />
      ) : (
        <div className="table-wrap" style={{ flex: 1 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('services.service')}</th>
                <th>Load</th>
                <th>Active</th>
                <th>Sub</th>
                <th>{t('common:fields.description')}</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name}>
                  <td className="mono small">{s.name}</td>
                  <td className="dim small">{s.load}</td>
                  <td>{activeBadge(s)}</td>
                  <td className="dim small">{s.sub}</td>
                  <td className="small" style={{ maxWidth: 0, width: '45%' }}>
                    <div className="ellipsis" title={s.description}>
                      {s.description}
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      {busy === s.name && <Spinner />}
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('services.logs')} onClick={() => setLogsFor(s.name)}>
                        <ScrollText size={14} />
                      </button>
                      {s.active === 'active' ? (
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title={actionLabel('restart')}
                          disabled={busy === s.name}
                          onClick={() => void run(s, 'restart')}
                        >
                          <RotateCw size={14} />
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title={actionLabel('start')}
                          disabled={busy === s.name}
                          onClick={() => void run(s, 'start')}
                        >
                          <Play size={14} />
                        </button>
                      )}
                      <Menu
                        trigger={(toggle) => (
                          <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} disabled={busy === s.name}>
                            <MoreHorizontal size={14} />
                          </button>
                        )}
                        items={[
                          { label: actionLabel('start'), icon: <Play size={14} />, onClick: () => void run(s, 'start') },
                          { label: actionLabel('restart'), icon: <RotateCw size={14} />, onClick: () => void run(s, 'restart') },
                          { label: actionLabel('reload'), icon: <RefreshCw size={14} />, onClick: () => void run(s, 'reload') },
                          { label: actionLabel('stop'), icon: <Square size={14} />, danger: true, onClick: () => void run(s, 'stop') },
                          'sep',
                          { label: actionLabel('enable'), icon: <Power size={14} />, onClick: () => void run(s, 'enable') },
                          { label: actionLabel('disable'), icon: <PowerOff size={14} />, onClick: () => void run(s, 'disable') },
                          'sep',
                          { label: t('services.logs'), icon: <ScrollText size={14} />, onClick: () => setLogsFor(s.name) },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="dim" style={{ textAlign: 'center' }}>
                    {t('services.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {logsFor && <LogsDialog serverId={server.id} name={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  )
}

function LogsDialog({ serverId, name, onClose }: { serverId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation('server')
  const [lines, setLines] = useState(200)
  const preRef = useRef<HTMLPreElement>(null)
  const logs = useQuery({
    queryKey: ['service-logs', serverId, name, lines],
    queryFn: () => api.servers.serviceLogs(serverId, name, lines),
    gcTime: 0,
  })
  const text = logs.data?.lines.join('\n') ?? ''

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text])

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={<span className="mono">journalctl -u {name}</span>}
      headerExtra={
        <div className="row">
          <select className="select select-sm" style={{ width: 120 }} value={lines} onChange={(e) => setLines(Number(e.target.value))}>
            {[100, 200, 500, 1000, 2000].map((n) => (
              <option key={n} value={n}>
                {t('services.lines', { count: n })}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={() => void logs.refetch()} disabled={logs.isFetching}>
            <RefreshCw size={13} className={logs.isFetching ? 'spin' : undefined} />
          </button>
          <CopyButton text={text} />
        </div>
      }
    >
      {logs.isPending ? (
        <Loading />
      ) : logs.isError ? (
        <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
      ) : (
        <pre ref={preRef} className="output logs-view">
          {text || t('services.logsEmpty')}
        </pre>
      )}
    </Modal>
  )
}
