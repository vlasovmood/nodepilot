import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clock, Cpu, Fingerprint, Gauge, HardDrive, MemoryStick, Network, Power, RotateCw, ServerCog } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk, useServerStats } from '../../api/queries'
import type { Server, StatsPoint, StatsSnapshot } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { CopyButton } from '../../components/CopyButton'
import { Meter } from '../../components/Meter'
import { Alert, Empty, ErrorState, Loading, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { TimeChart, type ChartSeries } from '../../components/TimeChart'
import { useToast } from '../../components/Toast'
import { formatBps, formatBytes, formatDateTime, formatPercent, formatRelative, formatUptime, percentOf } from '../../lib/format'

const HOURS = [1, 6, 24, 168] as const
type Hours = (typeof HOURS)[number]

const PCT_RANGE: [number, number] = [0, 100]
const fmtPct = (v: number) => `${v.toFixed(0)}%`
const fmtBps = (v: number) => formatBps(v)
const fmtLoad = (v: number) => v.toFixed(2)

export function OverviewTab({ server }: { server: Server }) {
  const { t } = useTranslation('server')
  const stats = useServerStats(server.id)

  return (
    <div className="stack">
      {stats.isPending ? (
        <Loading label={t('overview.loading')} />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} title={t('overview.unavailable')} />
      ) : (
        <Snapshot s={stats.data} />
      )}
      <History serverId={server.id} />
      <div className="grid-cards grid-wide">
        <HostKeyCard server={server} />
        <PowerCard server={server} />
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  sub,
  children,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="card stat-card">
      <div className="label">
        {icon}
        {label}
      </div>
      <div className="value">{value}</div>
      {children}
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

function Snapshot({ s }: { s: StatsSnapshot }) {
  const { t } = useTranslation('server')
  const memPct = percentOf(s.mem_used, s.mem_total)
  const swapPct = percentOf(s.swap_used, s.swap_total)
  return (
    <div className="stack">
      {s.error && (
        <Alert kind={s.status === 'offline' ? 'danger' : 'warn'}>
          <b>{t('overview.lastError')}</b>
          <div className="mono small pre-wrap">{s.error}</div>
        </Alert>
      )}
      <div className="grid-cards">
        <StatCard
          icon={<Cpu size={13} />}
          label="CPU"
          value={formatPercent(s.cpu_percent, 1)}
          sub={s.cpu_cores ? t('overview.cores', { count: s.cpu_cores }) : undefined}
        >
          <Meter percent={s.cpu_percent} label="" />
        </StatCard>
        <StatCard
          icon={<MemoryStick size={13} />}
          label={t('overview.memory')}
          value={formatPercent(memPct)}
          sub={t('overview.usedOf', {
            used: formatBytes(s.mem_used),
            total: formatBytes(s.mem_total),
          })}
        >
          <Meter percent={memPct} label="" />
        </StatCard>
        <StatCard
          icon={<MemoryStick size={13} />}
          label="Swap"
          value={s.swap_total ? formatPercent(swapPct) : t('overview.swapNone')}
          sub={
            s.swap_total
              ? t('overview.usedOf', {
                  used: formatBytes(s.swap_used),
                  total: formatBytes(s.swap_total),
                })
              : undefined
          }
        >
          {!!s.swap_total && <Meter percent={swapPct} label="" />}
        </StatCard>
        <StatCard
          icon={<Gauge size={13} />}
          label="Load average"
          value={s.load ? s.load[0].toFixed(2) : '—'}
          sub={
            s.load
              ? t('overview.loadSub', {
                  l5: s.load[1].toFixed(2),
                  l15: s.load[2].toFixed(2),
                })
              : undefined
          }
        />
        <StatCard
          icon={<Network size={13} />}
          label={t('overview.network')}
          value={<span style={{ fontSize: 15 }}>↓ {formatBps(s.net_rx_bps)}</span>}
          sub={`↑ ${formatBps(s.net_tx_bps)}`}
        />
        <StatCard
          icon={<Clock size={13} />}
          label={t('overview.uptime')}
          value={formatUptime(s.uptime_secs)}
          sub={s.collected_at ? t('updated', { time: formatRelative(s.collected_at) }) : t('overview.notCollected')}
        />
      </div>
      <div className="grid-cards grid-wide">
        <div className="card">
          <div className="card-header">
            <ServerCog size={14} />
            <h3>{t('overview.system')}</h3>
          </div>
          <dl className="kv card-body">
            <dt>{t('overview.hostname')}</dt>
            <dd className="mono">{s.hostname ?? '—'}</dd>
            <dt>{t('overview.os')}</dt>
            <dd>{s.os ?? '—'}</dd>
            <dt>{t('overview.kernel')}</dt>
            <dd className="mono">{s.kernel ?? '—'}</dd>
            <dt>{t('overview.cpuCores')}</dt>
            <dd>{s.cpu_cores ?? '—'}</dd>
            <dt>{t('overview.collectedAt')}</dt>
            <dd>{formatDateTime(s.collected_at, true)}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="card-header">
            <HardDrive size={14} />
            <h3>{t('overview.disks')}</h3>
          </div>
          {s.disks.length === 0 ? (
            <div className="dim small card-body">{t('overview.noData')}</div>
          ) : (
            <div className="table-scroll">
              <table className="table disk-table">
                <thead>
                  <tr>
                    <th>{t('overview.disk.mount')}</th>
                    <th>{t('overview.disk.fs')}</th>
                    <th>{t('overview.disk.used')}</th>
                    <th className="disk-usage">{t('overview.disk.usage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.disks.map((d) => (
                    <tr key={d.mount}>
                      <td className="mono break">{d.mount}</td>
                      <td className="dim break">{d.fs}</td>
                      <td className="nowrap num">
                        {formatBytes(d.used)} / {formatBytes(d.total)}
                      </td>
                      <td>
                        <Meter percent={percentOf(d.used, d.total)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function History({ serverId }: { serverId: string }) {
  const { t } = useTranslation('server')
  const [hours, setHours] = useState<Hours>(1)
  const history = useQuery({
    queryKey: qk.statsHistory(serverId, hours),
    queryFn: () => api.servers.statsHistory(serverId, hours),
    refetchInterval: hours <= 6 ? 30_000 : 120_000,
    placeholderData: keepPreviousData,
  })

  const diskLabel = t('history.series.disk')
  const charts = useMemo(() => buildCharts(history.data ?? [], diskLabel), [history.data, diskLabel])

  return (
    <div className="card">
      <div className="card-header">
        <Activity size={14} />
        <h3>{t('history.title')}</h3>
        {history.isFetching && <Spinner />}
        <span className="spacer" />
        <Segmented<Hours>
          value={hours}
          onChange={setHours}
          options={HOURS.map((h) => ({
            value: h,
            label: h > 24 ? t('history.days', { n: h / 24 }) : t('history.hours', { n: h }),
          }))}
        />
      </div>
      <div className="card-body">
        {history.isPending ? (
          <Loading />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : charts.xs.length < 2 ? (
          <Empty title={t('history.notEnough')} icon={<Activity size={26} />}>
            <span className="muted">{t('history.notEnoughHint')}</span>
          </Empty>
        ) : (
          <div className="chart-grid">
            <ChartBox title={t('history.charts.cpu')} xs={charts.xs} series={charts.cpu} formatY={fmtPct} yRange={PCT_RANGE} />
            <ChartBox title={t('history.charts.memory')} xs={charts.xs} series={charts.mem} formatY={fmtPct} yRange={PCT_RANGE} />
            <ChartBox title={t('history.charts.network')} xs={charts.xs} series={charts.net} formatY={fmtBps} />
            <ChartBox title={t('history.charts.load')} xs={charts.xs} series={charts.load} formatY={fmtLoad} />
            <ChartBox title={t('history.charts.disk')} xs={charts.xs} series={charts.disk} formatY={fmtPct} yRange={PCT_RANGE} />
          </div>
        )}
      </div>
    </div>
  )
}

function ChartBox({ title, ...props }: { title: string } & React.ComponentProps<typeof TimeChart>) {
  return (
    <div className="card chart-box" style={{ background: 'var(--bg-elev-2)' }}>
      <div className="chart-title">
        {title}
        <span className="chart-legend">
          {props.series.map((s) => (
            <span key={s.label}>
              <i style={{ background: `var(${s.colorVar})` }} />
              {s.label}
            </span>
          ))}
        </span>
      </div>
      <TimeChart {...props} />
    </div>
  )
}

function buildCharts(points: StatsPoint[], diskLabel: string) {
  const sorted = points.slice().sort((a, b) => a.ts.localeCompare(b.ts))
  const xs = sorted.map((p) => Math.floor(new Date(p.ts).getTime() / 1000))
  const pct = (u: number | null, t: number | null) => percentOf(u, t)
  const cpu: ChartSeries[] = [
    {
      label: 'CPU',
      colorVar: '--chart-1',
      values: sorted.map((p) => p.cpu_percent),
      fill: true,
    },
  ]
  const mem: ChartSeries[] = [
    {
      label: 'RAM',
      colorVar: '--chart-4',
      values: sorted.map((p) => pct(p.mem_used, p.mem_total)),
      fill: true,
    },
  ]
  const net: ChartSeries[] = [
    {
      label: 'RX',
      colorVar: '--chart-2',
      values: sorted.map((p) => p.net_rx_bps),
    },
    {
      label: 'TX',
      colorVar: '--chart-3',
      values: sorted.map((p) => p.net_tx_bps),
    },
  ]
  const load: ChartSeries[] = [
    {
      label: 'load1',
      colorVar: '--chart-3',
      values: sorted.map((p) => p.load1),
      fill: true,
    },
  ]
  const disk: ChartSeries[] = [
    {
      label: diskLabel,
      colorVar: '--chart-2',
      values: sorted.map((p) => pct(p.disk_used, p.disk_total)),
      fill: true,
    },
  ]
  return { xs, cpu, mem, net, load, disk }
}

function HostKeyCard({ server }: { server: Server }) {
  const { t } = useTranslation('server')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const forget = useMutation({
    mutationFn: () => api.servers.forgetHostKey(server.id),
    onSuccess: () => {
      toast.success(t('hostKey.resetDone'), t('hostKey.resetDetail'))
      void qc.invalidateQueries({ queryKey: qk.server(server.id) })
      void qc.invalidateQueries({ queryKey: qk.servers })
    },
    onError: (e) => toast.error(t('hostKey.resetFailed'), e),
  })

  return (
    <div className="card">
      <div className="card-header">
        <Fingerprint size={14} />
        <h3>{t('hostKey.title')}</h3>
      </div>
      <div className="card-body stack-sm">
        {server.host_key_fingerprint ? (
          <>
            <div className="row">
              <code className="ellipsis grow" title={server.host_key_fingerprint}>
                {server.host_key_fingerprint}
              </code>
              <CopyButton text={server.host_key_fingerprint} />
            </div>
            <div className="field-hint">{t('hostKey.pinnedHint')}</div>
            <div>
              <button
                className="btn btn-sm btn-danger-ghost"
                disabled={forget.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('hostKey.confirmTitle'),
                    message: t('hostKey.confirmMessage'),
                    confirmText: t('hostKey.confirmText'),
                    danger: true,
                  })
                  if (ok) forget.mutate()
                }}
              >
                {forget.isPending && <Spinner />} {t('hostKey.forget')}
              </button>
            </div>
          </>
        ) : (
          <div className="muted small">{t('hostKey.notPinned')}</div>
        )}
      </div>
    </div>
  )
}

function PowerCard({ server }: { server: Server }) {
  const { t } = useTranslation('server')
  const toast = useToast()
  const confirm = useConfirm()
  const power = useMutation({
    mutationFn: (action: 'reboot' | 'shutdown') => api.servers.power(server.id, action),
    onSuccess: (_d, action) => toast.success(action === 'reboot' ? t('power.rebootSent') : t('power.shutdownSent'), server.name),
    onError: (e) => toast.error(t('power.failed'), e),
  })

  const ask = async (action: 'reboot' | 'shutdown') => {
    const ok = await confirm({
      title: action === 'reboot' ? t('power.rebootTitle') : t('power.shutdownTitle'),
      message:
        action === 'reboot'
          ? t('power.rebootMessage', { name: server.name, host: server.host })
          : t('power.shutdownMessage', {
              name: server.name,
              host: server.host,
            }),
      confirmText: action === 'reboot' ? t('power.reboot') : t('power.shutdown'),
      danger: true,
      requireText: server.name,
    })
    if (ok) power.mutate(action)
  }

  return (
    <div className="card">
      <div className="card-header">
        <Power size={14} />
        <h3>{t('power.title')}</h3>
      </div>
      <div className="card-body stack-sm">
        <div className="muted small">{t('power.hint', { user: server.username })}</div>
        <div className="row">
          <button className="btn btn-danger-ghost" disabled={power.isPending} onClick={() => void ask('reboot')}>
            <RotateCw size={14} /> {t('power.reboot')}
          </button>
          <button className="btn btn-danger-ghost" disabled={power.isPending} onClick={() => void ask('shutdown')}>
            <Power size={14} /> {t('power.shutdown')}
          </button>
          {power.isPending && <Spinner />}
        </div>
      </div>
    </div>
  )
}
