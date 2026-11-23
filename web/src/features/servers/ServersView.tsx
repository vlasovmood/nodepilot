import { useQueryClient } from '@tanstack/react-query'
import {
  FolderMinus,
  FolderPlus,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Search,
  ServerOff,
  SquareTerminal,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { invalidateServers, qk, useAllStats, useProjects, useServers, useStatsMap } from '../../api/queries'
import type { Project, Server, ServerStatus } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Empty, ErrorState, Loading } from '../../components/States'
import { useToast } from '../../components/Toast'
import { useFavorites } from '../../lib/favorites'
import { intlLocale } from '../../i18n'
import { formatRelative } from '../../lib/format'
import { mapLimit, uniq } from '../../lib/util'
import { AddToProjectDialog, BulkExecDialog } from './BulkActionDialogs'
import { BulkImportDialog } from './BulkImportDialog'
import { matchesFilter, sortRows, toRow, type SortState } from './model'
import { ServerFormDialog } from './ServerFormDialog'
import { ServerGrid } from './ServerGrid'
import { ServerTable } from './ServerTable'

type StatusFilter = 'all' | 'fav' | ServerStatus
type ViewMode = 'list' | 'grid'

const VIEW_KEY = 'np.servers.view'
function initialView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

/** Server dashboard: filters + virtualized table + bulk actions. Used for "all servers" and per-project views. */
export function ServersView({ project }: { project?: Project }) {
  const { t } = useTranslation('servers')
  const servers = useServers()
  const statsQuery = useAllStats()
  const stats = useStatsMap()
  const projects = useProjects()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()

  const q = params.get('q') ?? ''
  const tag = params.get('tag') ?? ''
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Server | null | 'new'>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [execOpen, setExecOpen] = useState(false)
  const [addToProjectOpen, setAddToProjectOpen] = useState(false)
  const [view, setViewState] = useState<ViewMode>(initialView)
  const [favs] = useFavorites()
  const setView = (v: ViewMode) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

  const setParam = useCallback(
    (key: string, value: string) => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          if (value) n.set(key, value)
          else n.delete(key)
          return n
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const projectMap = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data])

  const scoped = useMemo(() => (servers.data ?? []).filter((s) => !project || s.project_ids.includes(project.id)), [servers.data, project])

  const allTags = useMemo(() => uniq(scoped.flatMap((s) => s.tags)).sort((a, b) => a.localeCompare(b, intlLocale())), [scoped])

  const rows = useMemo(() => {
    const filtered = scoped.filter((s) => matchesFilter(s, q) && (!tag || s.tags.includes(tag)))
    let r = filtered.map((s) => toRow(s, stats.get(s.id)))
    if (status === 'fav') r = r.filter((x) => favs.has(x.server.id))
    else if (status !== 'all') r = r.filter((x) => x.status === status)
    return sortRows(r, sort)
  }, [scoped, q, tag, status, stats, sort, favs])

  const counts = useMemo(() => {
    const c = { online: 0, offline: 0, unknown: 0 }
    for (const s of scoped) c[stats.get(s.id)?.status ?? s.status]++
    return c
  }, [scoped, stats])

  // Only keep selected ids that are still visible
  const selectedIds = useMemo(() => rows.filter((r) => selected.has(r.server.id)).map((r) => r.server.id), [rows, selected])

  const deleteServers = async (ids: string[]) => {
    const names = ids.map((id) => scoped.find((s) => s.id === id)?.name ?? id)
    const ok = await confirm({
      title: ids.length === 1 ? t('confirm.deleteOneTitle') : t('confirm.deleteManyTitle', { count: ids.length }),
      message:
        ids.length === 1 ? (
          <Trans t={t} i18nKey="confirm.deleteOneMessage" values={{ name: names[0] }} components={{ b: <b /> }} />
        ) : names.length > 8 ? (
          t('confirm.deleteManyMessageMore', { names: names.slice(0, 8).join(', '), more: names.length - 8 })
        ) : (
          t('confirm.deleteManyMessage', { names: names.join(', ') })
        ),
      confirmText: t('common:actions.delete'),
      danger: true,
      requireText: ids.length > 5 ? t('confirm.deleteRequireText') : undefined,
    })
    if (!ok) return
    const res = await mapLimit(ids, 6, (id) => api.servers.remove(id))
    const failed = res.filter((r) => r.status === 'rejected')
    invalidateServers(qc)
    setSelected(new Set())
    if (failed.length)
      toast.error(
        t('toast.deletePartial', { ok: ids.length - failed.length, failed: failed.length }),
        (failed[0] as PromiseRejectedResult).reason,
      )
    else toast.success(ids.length === 1 ? t('toast.deletedOne') : t('toast.deletedMany', { count: ids.length }))
  }

  const removeFromProject = async (ids: string[]) => {
    if (!project) return
    const ok = await confirm({
      title: t('confirm.removeTitle'),
      message: t('confirm.removeMessage', { count: ids.length, project: project.name }),
      confirmText: t('confirm.removeConfirm'),
    })
    if (!ok) return
    const res = await mapLimit(ids, 8, (id) => api.projects.removeServer(project.id, id))
    const failed = res.filter((r) => r.status === 'rejected')
    invalidateServers(qc)
    setSelected(new Set())
    if (failed.length) toast.error(t('toast.errors', { failed: failed.length }), (failed[0] as PromiseRejectedResult).reason)
    else toast.success(t('toast.removedFromProject'))
  }

  if (servers.isPending) return <Loading label={t('loading')} />
  if (servers.isError) return <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />

  const filtersActive = !!q || !!tag || status !== 'all'
  const footer = (
    <>
      <span>{t('footer.shown', { shown: rows.length, total: scoped.length })}</span>
      <span className="row" style={{ gap: 5 }}>
        <span className="dot dot-online" /> {counts.online}
      </span>
      <span className="row" style={{ gap: 5 }}>
        <span className="dot dot-offline" /> {counts.offline}
      </span>
      <span className="row" style={{ gap: 5 }}>
        <span className="dot dot-unknown" /> {counts.unknown}
      </span>
      <span className="spacer" />
      {rows.length === 0 && filtersActive && <span className="warn-text">{t('footer.noMatch')}</span>}
      <span className="dim">
        <Tag size={11} style={{ verticalAlign: -1 }} /> {t('footer.selectHint')}
      </span>
      {statsQuery.isError ? (
        <span className="danger-text">{t('footer.statsUnavailable')}</span>
      ) : (
        <span className="dim">
          {t('footer.metrics', {
            time: statsQuery.dataUpdatedAt ? formatRelative(new Date(statsQuery.dataUpdatedAt).toISOString()) : '—',
          })}
        </span>
      )}
    </>
  )

  return (
    <>
      <div className="toolbar">
        <div className="input-icon" style={{ width: 230 }}>
          <Search size={14} />
          <input className="input" placeholder={t('toolbar.filterPlaceholder')} value={q} onChange={(e) => setParam('q', e.target.value)} />
        </div>
        <select
          className="select"
          style={{ width: 140 }}
          value={tag}
          onChange={(e) => setParam('tag', e.target.value)}
          title={t('toolbar.tagTitle')}
        >
          <option value="">{t('toolbar.allTags')}</option>
          {allTags.map((tg) => (
            <option key={tg} value={tg}>
              {tg}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 150 }}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          title={t('toolbar.statusTitle')}
        >
          <option value="all">{t('toolbar.anyStatus')}</option>
          <option value="online">{t('toolbar.online', { n: counts.online })}</option>
          <option value="offline">{t('toolbar.offline', { n: counts.offline })}</option>
          <option value="unknown">{t('toolbar.unknown', { n: counts.unknown })}</option>
          <option value="fav">{t('toolbar.favorites', { n: scoped.filter((x) => favs.has(x.id)).length })}</option>
        </select>
        {filtersActive && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setParams({}, { replace: true })
              setStatus('all')
            }}
          >
            <X size={14} /> {t('common:actions.reset')}
          </button>
        )}
        <span className="spacer" />
        <div className="segmented" role="tablist" aria-label={t('toolbar.view')}>
          <button className={view === 'list' ? 'active' : undefined} onClick={() => setView('list')}>
            <List size={14} /> {t('toolbar.list')}
          </button>
          <button className={view === 'grid' ? 'active' : undefined} onClick={() => setView('grid')}>
            <LayoutGrid size={14} /> {t('toolbar.grid')}
          </button>
        </div>
        <button
          className="btn btn-ghost btn-icon"
          title={t('common:actions.refresh')}
          onClick={() => {
            void qc.invalidateQueries({ queryKey: qk.servers })
            void qc.invalidateQueries({ queryKey: qk.statsAll })
          }}
        >
          <RefreshCw size={15} className={servers.isFetching || statsQuery.isFetching ? 'spin' : undefined} />
        </button>
        <button className="btn" onClick={() => setImportOpen(true)}>
          <Upload size={14} /> {t('toolbar.import')}
        </button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> {t('toolbar.addServer')}
        </button>
      </div>

      {selectedIds.length > 0 && (
        <div className="selection-bar">
          <b>{t('selection.count', { n: selectedIds.length })}</b>
          <button className="btn btn-sm" onClick={() => setExecOpen(true)}>
            <SquareTerminal size={14} /> {t('selection.exec')}
          </button>
          <button className="btn btn-sm" onClick={() => setAddToProjectOpen(true)}>
            <FolderPlus size={14} /> {t('selection.toProject')}
          </button>
          {project && (
            <button className="btn btn-sm" onClick={() => void removeFromProject(selectedIds)}>
              <FolderMinus size={14} /> {t('selection.removeFromProject')}
            </button>
          )}
          <button className="btn btn-sm btn-danger-ghost" onClick={() => void deleteServers(selectedIds)}>
            <Trash2 size={14} /> {t('common:actions.delete')}
          </button>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            {t('selection.clear')}
          </button>
        </div>
      )}

      {scoped.length === 0 ? (
        <div className="card">
          <Empty icon={<ServerOff size={30} />} title={project ? t('empty.projectTitle') : t('empty.title')}>
            <div className="muted">{project ? t('empty.projectHint') : t('empty.hint')}</div>
            <div className="row">
              <button className="btn" onClick={() => setImportOpen(true)}>
                <Upload size={14} /> {t('toolbar.import')}
              </button>
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <Plus size={14} /> {t('toolbar.addServer')}
              </button>
            </div>
          </Empty>
        </div>
      ) : view === 'grid' ? (
        <ServerGrid
          rows={rows}
          selected={selected}
          onSelectedChange={setSelected}
          onEdit={(s) => setEditing(s)}
          onDelete={(s) => void deleteServers([s.id])}
          footer={footer}
        />
      ) : (
        <ServerTable
          rows={rows}
          projects={projectMap}
          selected={selected}
          onSelectedChange={setSelected}
          sort={sort}
          onSortChange={setSort}
          onTagClick={(tg) => setParam('tag', tg)}
          onEdit={(s) => setEditing(s)}
          onDelete={(s) => void deleteServers([s.id])}
          footer={footer}
        />
      )}

      <ServerFormDialog
        open={editing !== null}
        server={editing === 'new' ? null : editing}
        defaultProjectIds={project ? [project.id] : undefined}
        onClose={() => setEditing(null)}
      />
      <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} defaultProjectIds={project ? [project.id] : undefined} />
      <BulkExecDialog open={execOpen} onClose={() => setExecOpen(false)} serverIds={selectedIds} />
      <AddToProjectDialog open={addToProjectOpen} onClose={() => setAddToProjectOpen(false)} serverIds={selectedIds} />
    </>
  )
}
