import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, Archive, ArrowLeft, Cog, FolderOpen, ListTree, Pencil, PlugZap, SquareTerminal, StickyNote, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../api/client'
import { invalidateServers, qk, useProjects, useServer, useStatsMap } from '../api/queries'
import { useConfirm } from '../components/Confirm'
import { ErrorState, Loading, Spinner } from '../components/States'
import { StatusDot } from '../components/StatusDot'
import { Tabs, type TabDef } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { formatDuration } from '../lib/format'
import { NotesPanel } from '../features/notes/NotesPanel'
import { BackupsTab } from '../features/server/BackupsTab'
import { FilesTab } from '../features/server/FilesTab'
import { OverviewTab } from '../features/server/OverviewTab'
import { ProcessesTab } from '../features/server/ProcessesTab'
import { ServicesTab } from '../features/server/ServicesTab'
import { TerminalTab } from '../features/server/TerminalTab'
import { ServerFormDialog } from '../features/servers/ServerFormDialog'

const TABS = ['overview', 'terminal', 'files', 'processes', 'services', 'notes', 'backups'] as const
type Tab = (typeof TABS)[number]

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  overview: <Activity size={14} />,
  terminal: <SquareTerminal size={14} />,
  files: <FolderOpen size={14} />,
  processes: <ListTree size={14} />,
  services: <Cog size={14} />,
  notes: <StickyNote size={14} />,
  backups: <Archive size={14} />,
}

export function ServerPage() {
  const { id = '', tab: rawTab } = useParams()
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'overview'
  const { t } = useTranslation('server')
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const server = useServer(id)
  const tabDefs = useMemo<TabDef<Tab>[]>(() => TABS.map((key) => ({ key, label: t(`tabs.${key}`), icon: TAB_ICONS[key] })), [t])
  const stats = useStatsMap()
  const projects = useProjects()
  const [editOpen, setEditOpen] = useState(false)
  // The terminal stays mounted (sessions survive tab switches) once it has been opened.
  const [terminalMounted, setTerminalMounted] = useState(tab === 'terminal')

  useEffect(() => {
    if (tab === 'terminal') setTerminalMounted(true)
  }, [tab])

  // New server → fresh terminal state
  useEffect(() => {
    setTerminalMounted(tab === 'terminal')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const test = useMutation({
    mutationFn: () => api.servers.test(id),
    onSuccess: (r) => {
      if (r.ok) toast.success(t('toast.connected'), t('toast.latency', { latency: formatDuration(r.latency_ms) }))
      else toast.error(t('toast.connectFailed'), r.error ?? undefined)
      void qc.invalidateQueries({ queryKey: qk.server(id) })
    },
    onError: (e) => toast.error(t('toast.testFailed'), e),
  })

  if (server.isPending) return <Loading />
  if (server.isError || !server.data)
    return (
      <div className="page">
        <ErrorState error={server.error ?? t('notFound')} title={t('notFound')} onRetry={() => void server.refetch()} />
      </div>
    )

  const s = server.data
  const status = stats.get(s.id)?.status ?? s.status

  const remove = async () => {
    const ok = await confirm({
      title: t('confirm.deleteTitle'),
      message: <Trans t={t} i18nKey="confirm.deleteMessage" values={{ name: s.name }} components={{ b: <b /> }} />,
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.servers.remove(s.id)
      toast.success(t('toast.deleted'), s.name)
      invalidateServers(qc)
      navigate('/servers')
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e)
    }
  }

  const fillTab = tab === 'terminal' || tab === 'files' || tab === 'notes' || tab === 'processes' || tab === 'services'

  return (
    <div className={fillTab ? 'page page-fill' : 'page'} style={{ gap: 12 }}>
      <div className="page-header">
        <Link to="/servers" className="btn btn-ghost btn-icon" title={t('header.back')}>
          <ArrowLeft size={16} />
        </Link>
        <StatusDot status={status} />
        <div className="title-block">
          <h1 className="row" style={{ gap: 10 }}>
            {s.name}
            <span className="badge">{t(`common:status.${status}`)}</span>
          </h1>
          <span className="muted small row-wrap" style={{ gap: 6 }}>
            <span className="mono">
              {s.username}@{s.host}:{s.port}
            </span>
            {s.tags.map((tg) => (
              <Link key={tg} to={`/servers?tag=${encodeURIComponent(tg)}`} className="tag">
                {tg}
              </Link>
            ))}
            {s.project_ids.map((pid) => {
              const p = projects.data?.find((x) => x.id === pid)
              return p ? (
                <Link key={pid} to={`/projects/${pid}`} className="row small" style={{ gap: 4 }}>
                  <span className="project-dot" style={p.color ? { background: p.color } : undefined} />
                  {p.name}
                </Link>
              ) : null
            })}
          </span>
          {s.description && <span className="small dim">{s.description}</span>}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Spinner /> : <PlugZap size={14} />} {t('header.test')}
          </button>
          <button className="btn" onClick={() => setEditOpen(true)}>
            <Pencil size={14} /> {t('common:actions.edit')}
          </button>
          <button className="btn btn-danger-ghost btn-icon" title={t('common:actions.delete')} onClick={() => void remove()}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <Tabs<Tab> tabs={tabDefs} value={tab} onChange={(k) => navigate(k === 'overview' ? `/servers/${id}` : `/servers/${id}/${k}`)} />

      <div className="stack" style={fillTab ? { flex: 1, minHeight: 0 } : undefined}>
        {tab === 'overview' && <OverviewTab server={s} />}
        {terminalMounted && (
          <div style={{ display: tab === 'terminal' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <TerminalTab key={s.id} server={s} active={tab === 'terminal'} />
          </div>
        )}
        {tab === 'files' && <FilesTab key={s.id} server={s} />}
        {tab === 'processes' && <ProcessesTab server={s} />}
        {tab === 'services' && <ServicesTab server={s} />}
        {tab === 'notes' && <NotesPanel key={s.id} scope={{ server_id: s.id }} />}
        {tab === 'backups' && <BackupsTab server={s} />}
      </div>

      <ServerFormDialog open={editOpen} server={s} onClose={() => setEditOpen(false)} />
    </div>
  )
}
