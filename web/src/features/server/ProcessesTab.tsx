import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, RefreshCw, Search, Skull, XCircle, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk } from '../../api/queries'
import type { KillSignal, Process, Server } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Menu } from '../../components/Menu'
import { ErrorState, Loading } from '../../components/States'
import { useToast } from '../../components/Toast'
import { formatBytes, formatRelative } from '../../lib/format'
import { cx } from '../../lib/util'

type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'rss' | 'command'

const SIGNALS: KillSignal[] = ['TERM', 'KILL', 'HUP']

export function ProcessesTab({ server }: { server: Server }) {
  const { t } = useTranslation('server')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [filter, setFilter] = useState('')
  const [auto, setAuto] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cpu', dir: -1 })

  const procs = useQuery({
    queryKey: qk.processes(server.id),
    queryFn: () => api.servers.processes(server.id),
    refetchInterval: auto ? 5000 : false,
  })

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase()
    const list = (procs.data ?? []).filter(
      (p) => !term || p.command.toLowerCase().includes(term) || p.user.toLowerCase().includes(term) || String(p.pid) === term,
    )
    return list.sort((a, b) => {
      const va = a[sort.key]
      const vb = b[sort.key]
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return r * sort.dir
    })
  }, [procs.data, filter, sort])

  const kill = async (p: Process, sig: KillSignal) => {
    const ok = await confirm({
      title: t('processes.confirmTitle', { sig }),
      message: (
        <>
          <Trans t={t} i18nKey="processes.confirmMessage" values={{ pid: p.pid, user: p.user }} components={{ b: <b /> }} />
          <pre className="output" style={{ marginTop: 8, maxHeight: 120 }}>
            {p.command}
          </pre>
        </>
      ),
      confirmText: t('common:actions.send'),
      danger: sig !== 'HUP',
    })
    if (!ok) return
    try {
      await api.servers.kill(server.id, p.pid, sig)
      toast.success(t('processes.sent', { sig }), `PID ${p.pid}`)
      void qc.invalidateQueries({ queryKey: qk.processes(server.id) })
    } catch (e) {
      toast.error(t('processes.sendFailed'), e)
    }
  }

  const th = (key: SortKey, label: string, right?: boolean) => (
    <th
      style={{ cursor: 'pointer', textAlign: right ? 'right' : undefined }}
      className={cx(sort.key === key && 'sorted')}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : key === 'command' || key === 'user' ? 1 : -1 }))}
    >
      {label} {sort.key === key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </th>
  )

  return (
    <div className="stack" style={{ flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <div className="input-icon" style={{ width: 280 }}>
          <Search size={14} />
          <input
            className="input"
            placeholder={t('processes.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <span className="spacer" />
        {procs.dataUpdatedAt > 0 && (
          <span className="dim small">{t('updated', { time: formatRelative(new Date(procs.dataUpdatedAt).toISOString()) })}</span>
        )}
        <label className="checkbox small">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          {t('processes.autoRefresh')}
        </label>
        <button className="btn" onClick={() => void procs.refetch()} disabled={procs.isFetching}>
          <RefreshCw size={14} className={procs.isFetching ? 'spin' : undefined} /> {t('common:actions.refresh')}
        </button>
      </div>
      {procs.isPending ? (
        <Loading label={t('processes.loading')} />
      ) : procs.isError ? (
        <ErrorState error={procs.error} onRetry={() => void procs.refetch()} />
      ) : (
        <div className="table-wrap" style={{ flex: 1 }}>
          <table className="table">
            <thead>
              <tr>
                {th('pid', 'PID', true)}
                {th('user', t('processes.user'))}
                {th('cpu', 'CPU %', true)}
                {th('mem', 'MEM %', true)}
                {th('rss', 'RSS', true)}
                {th('command', t('processes.command'))}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.pid}>
                  <td className="mono right">{p.pid}</td>
                  <td className="ellipsis" style={{ maxWidth: 120 }}>
                    {p.user}
                  </td>
                  <td className={cx('num right', p.cpu >= 50 && 'warn-text')}>{p.cpu.toFixed(1)}</td>
                  <td className="num right">{p.mem.toFixed(1)}</td>
                  <td className="num right nowrap">{formatBytes(p.rss)}</td>
                  <td className="mono small" style={{ maxWidth: 0, width: '60%' }}>
                    <div className="ellipsis" title={p.command}>
                      {p.command}
                    </div>
                  </td>
                  <td>
                    <Menu
                      trigger={(toggle) => (
                        <button className="btn btn-ghost btn-icon btn-sm" title={t('processes.signal')} onClick={toggle}>
                          <XCircle size={14} />
                        </button>
                      )}
                      items={SIGNALS.map((sig) => ({
                        label: (
                          <span className="stack-sm" style={{ gap: 0 }} title={t(`processes.signals.${sig}.hint`)}>
                            <span>{t(`processes.signals.${sig}.label`)}</span>
                          </span>
                        ),
                        icon: sig === 'KILL' ? <Skull size={14} /> : sig === 'HUP' ? <RefreshCw size={14} /> : <Zap size={14} />,
                        danger: sig === 'KILL',
                        onClick: () => void kill(p, sig),
                      }))}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim" style={{ textAlign: 'center' }}>
                    {t('processes.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
