import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  Download,
  Lock,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlock,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { qk, useServers, useStorages } from '../../api/queries'
import type { BackupJob, BackupRun } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Empty, ErrorState, Loading, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { formatBytes, formatDateTime, formatDuration, formatRelative } from '../../lib/format'
import { downloadUrl } from '../../lib/util'
import { describeSchedule } from './cronText'
import { jobEncryption } from './encryption'
import { JobDialog } from './JobDialog'

function EncryptionBadge({ job }: { job: BackupJob }) {
  const { t } = useTranslation('backups')
  const mode = jobEncryption(job)
  if (mode === 'recipients')
    return (
      <span className="badge badge-ok nowrap" title={t('jobs.encryption.recipientsTitle', { count: job.recipients.length })}>
        <ShieldCheck size={11} /> {t('jobs.encryption.recipients')}
      </span>
    )
  if (mode === 'passphrase')
    return (
      <span className="badge nowrap" title={t('jobs.encryption.passphraseTitle')}>
        <Lock size={11} /> {t('jobs.encryption.passphrase')}
      </span>
    )
  return (
    <span className="badge badge-warn nowrap" title={t('jobs.encryption.noneTitle')}>
      <Unlock size={11} /> {t('jobs.encryption.none')}
    </span>
  )
}

function RunStatus({ run }: { run: BackupRun }) {
  const { t } = useTranslation('backups')
  if (run.status === 'running')
    return (
      <span className="badge badge-accent">
        <Spinner /> {t('runStatus.running')}
      </span>
    )
  if (run.status === 'success')
    return (
      <span className="badge badge-ok">
        <CheckCircle2 size={11} /> {t('runStatus.success')}
      </span>
    )
  return (
    <span className="badge badge-danger" title={run.error ?? undefined}>
      <XCircle size={11} /> {t('runStatus.failed')}
    </span>
  )
}

function sourceSummary(j: BackupJob): string {
  const s = j.source
  if (s.type === 'files') return s.paths.join(', ')
  const where = s.docker_container ? ` @docker:${s.docker_container}` : s.host ? ` @${s.host}${s.port ? ':' + s.port : ''}` : ''
  return `${s.type === 'postgres' ? 'PostgreSQL' : 'MySQL'}: ${s.database}${where}`
}

export function JobsSection({ serverId }: { serverId?: string }) {
  const { t } = useTranslation('backups')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const servers = useServers()
  const storages = useStorages()
  const filter = serverId ? { server_id: serverId } : undefined
  const jobs = useQuery({
    queryKey: qk.jobs(filter),
    queryFn: () => api.backups.jobs(filter),
    refetchInterval: (q) => (q.state.data?.some((j) => j.last_run?.status === 'running') ? 5000 : 30_000),
  })
  const [editing, setEditing] = useState<BackupJob | null | 'new'>(null)
  const [running, setRunning] = useState<Set<string>>(new Set())

  const serverName = useMemo(() => new Map((servers.data ?? []).map((s) => [s.id, s.name])), [servers.data])
  const storageName = useMemo(() => new Map((storages.data ?? []).map((s) => [s.id, s.name])), [storages.data])

  const runNow = async (j: BackupJob) => {
    setRunning((s) => new Set(s).add(j.id))
    try {
      await api.backups.runJob(j.id)
      toast.info(t('jobs.toast.started'), j.name)
      void qc.invalidateQueries({ queryKey: qk.jobs() })
      void qc.invalidateQueries({ queryKey: qk.runs() })
    } catch (e) {
      toast.error(t('jobs.toast.startFailed'), e)
    } finally {
      setRunning((s) => {
        const n = new Set(s)
        n.delete(j.id)
        return n
      })
    }
  }

  const toggleEnabled = async (j: BackupJob) => {
    try {
      await api.backups.updateJob(j.id, { enabled: !j.enabled })
      void qc.invalidateQueries({ queryKey: qk.jobs() })
    } catch (e) {
      toast.error(t('common:state.error'), e)
    }
  }

  const remove = async (j: BackupJob) => {
    const ok = await confirm({
      title: t('jobs.confirmDelete.title'),
      message: t('jobs.confirmDelete.message', { name: j.name }),
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.backups.removeJob(j.id)
      toast.success(t('jobs.toast.deleted'), j.name)
      void qc.invalidateQueries({ queryKey: qk.jobs() })
    } catch (e) {
      toast.error(t('jobs.toast.deleteFailed'), e)
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <h2>{t('jobs.title')}</h2>
        <span className="spacer" />
        <button className="btn btn-ghost btn-icon" title={t('common:actions.refresh')} onClick={() => void jobs.refetch()}>
          <RefreshCw size={14} className={jobs.isFetching ? 'spin' : undefined} />
        </button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> {t('jobs.new')}
        </button>
      </div>
      {jobs.isPending ? (
        <Loading />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.length === 0 ? (
        <div className="card">
          <Empty icon={<CalendarClock size={28} />} title={t('jobs.emptyTitle')}>
            <span className="muted">{t('jobs.emptyHint')}</span>
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('jobs.columns.enabled')}</th>
                <th>{t('jobs.columns.name')}</th>
                {!serverId && <th>{t('jobs.columns.server')}</th>}
                <th>{t('jobs.columns.source')}</th>
                <th>{t('jobs.columns.storage')}</th>
                <th>{t('jobs.columns.schedule')}</th>
                <th>{t('jobs.columns.retention')}</th>
                <th>{t('jobs.columns.encryption')}</th>
                <th>{t('jobs.columns.lastRun')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id} style={j.enabled ? undefined : { opacity: 0.6 }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={j.enabled}
                      onChange={() => void toggleEnabled(j)}
                      style={{ accentColor: 'var(--accent)' }}
                      title={j.enabled ? t('jobs.disable') : t('jobs.enable')}
                    />
                  </td>
                  <td style={{ fontWeight: 500, minWidth: 130 }}>{j.name}</td>
                  {!serverId && (
                    <td className="nowrap">
                      <Link to={`/servers/${j.server_id}/backups`}>{serverName.get(j.server_id) ?? '—'}</Link>
                    </td>
                  )}
                  <td className="mono small" style={{ maxWidth: 240 }}>
                    <div className="ellipsis" title={sourceSummary(j)}>
                      {sourceSummary(j)}
                    </div>
                  </td>
                  <td className="small">{storageName.get(j.storage_id) ?? '—'}</td>
                  <td className="small" title={j.schedule ?? undefined}>
                    <div className="nowrap">{describeSchedule(t, j.schedule)}</div>
                    {j.enabled && j.next_run_at && (
                      <div className="dim nowrap" title={`${t('jobs.columns.nextRun')}: ${formatDateTime(j.next_run_at)}`}>
                        {t('jobs.columns.nextRun')}: {formatRelative(j.next_run_at)}
                      </div>
                    )}
                  </td>
                  <td className="small num">{j.retention === 0 ? t('jobs.retentionAll') : j.retention}</td>
                  <td>
                    <EncryptionBadge job={j} />
                  </td>
                  <td className="small">
                    {j.last_run ? (
                      <span className="row nowrap" style={{ gap: 6 }} title={formatDateTime(j.last_run.started_at)}>
                        <RunStatus run={j.last_run} />
                        <span className="dim">{formatRelative(j.last_run.started_at)}</span>
                      </span>
                    ) : (
                      <span className="dim">{t('jobs.never')}</span>
                    )}
                  </td>
                  <td>
                    <div className="row nowrap" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      <button
                        className="btn btn-sm"
                        disabled={running.has(j.id) || j.last_run?.status === 'running'}
                        onClick={() => void runNow(j)}
                        title={t('jobs.runNow')}
                      >
                        {running.has(j.id) ? <Spinner /> : <Play size={13} />} {t('jobs.run')}
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('jobs.edit')} onClick={() => setEditing(j)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.delete')} onClick={() => void remove(j)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <JobDialog open={editing !== null} job={editing === 'new' ? null : editing} serverId={serverId} onClose={() => setEditing(null)} />
    </div>
  )
}

export function RunsSection({ serverId, title }: { serverId?: string; title?: string }) {
  const { t } = useTranslation('backups')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const servers = useServers()
  const filter = serverId ? { server_id: serverId } : undefined
  const runs = useQuery({
    queryKey: qk.runs(filter),
    queryFn: () => api.backups.runs(filter),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 4000 : 30_000),
  })
  const jobs = useQuery({ queryKey: qk.jobs(filter), queryFn: () => api.backups.jobs(filter) })
  const [limit, setLimit] = useState(100)

  const jobName = useMemo(() => new Map((jobs.data ?? []).map((j) => [j.id, j.name])), [jobs.data])
  const serverName = useMemo(() => new Map((servers.data ?? []).map((s) => [s.id, s.name])), [servers.data])

  const remove = async (r: BackupRun) => {
    const ok = await confirm({
      title: t('runs.confirmDelete.title'),
      message: r.file_name ? t('runs.confirmDelete.message', { file: r.file_name }) : t('runs.confirmDelete.messageNoFile'),
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.backups.removeRun(r.id)
      toast.success(t('runs.toast.deleted'))
      void qc.invalidateQueries({ queryKey: qk.runs() })
    } catch (e) {
      toast.error(t('runs.toast.deleteFailed'), e)
    }
  }

  const list = runs.data ?? []

  return (
    <div className="stack">
      <div className="toolbar">
        <h2>{title ?? t('runs.title')}</h2>
        <span className="spacer" />
        <button className="btn btn-ghost btn-icon" title={t('common:actions.refresh')} onClick={() => void runs.refetch()}>
          <RefreshCw size={14} className={runs.isFetching ? 'spin' : undefined} />
        </button>
      </div>
      {runs.isPending ? (
        <Loading />
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty icon={<Archive size={28} />} title={t('runs.empty')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common:fields.status')}</th>
                <th>{t('runs.columns.job')}</th>
                {!serverId && <th>{t('common:fields.server')}</th>}
                <th>{t('runs.columns.started')}</th>
                <th>{t('runs.columns.duration')}</th>
                <th>{t('runs.columns.size')}</th>
                <th>{t('runs.columns.file')}</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {list.slice(0, limit).map((r) => (
                <tr key={r.id}>
                  <td>
                    <RunStatus run={r} />
                  </td>
                  <td className="small">{jobName.get(r.job_id) ?? <span className="dim">{t('runs.deletedJob')}</span>}</td>
                  {!serverId && <td className="small">{serverName.get(r.server_id) ?? '—'}</td>}
                  <td className="small nowrap">{formatDateTime(r.started_at, true)}</td>
                  <td className="small num">
                    {r.finished_at ? formatDuration(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) : '—'}
                  </td>
                  <td className="small num nowrap">{formatBytes(r.size_bytes)}</td>
                  <td className="mono small" style={{ maxWidth: 320 }}>
                    {r.error ? (
                      <div className="danger-text pre-wrap" style={{ fontFamily: 'var(--font)' }}>
                        {r.error}
                      </div>
                    ) : (
                      <div className="ellipsis row" style={{ gap: 4 }} title={r.file_name ?? undefined}>
                        {r.encrypted && <Lock size={11} className="dim" />}
                        {r.file_name ?? '—'}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      {r.status === 'success' && (
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          title={r.encrypted ? t('runs.downloadEncrypted') : t('common:actions.download')}
                          onClick={() => downloadUrl(api.backups.downloadUrl(r.id), r.file_name ?? undefined)}
                        >
                          <Download size={13} />
                        </button>
                      )}
                      {r.status !== 'running' && (
                        <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.delete')} onClick={() => void remove(r)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > limit && (
            <div style={{ padding: 8, textAlign: 'center' }}>
              <button className="btn btn-sm" onClick={() => setLimit((l) => l + 200)}>
                {t('runs.showMore', { n: list.length - limit })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
