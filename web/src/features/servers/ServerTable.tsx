import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, FolderOpen, MoreHorizontal, Pencil, SquareTerminal, Trash2 } from 'lucide-react'
import { useRef, type MouseEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Project, Server } from '../../api/types'
import { Menu } from '../../components/Menu'
import { Meter } from '../../components/Meter'
import { StatusDot } from '../../components/StatusDot'
import { formatBytes, formatLoad, formatUptime } from '../../lib/format'
import { cx, gridMinWidth } from '../../lib/util'
import type { ServerRow, SortKey, SortState } from './model'

const COLS = '34px 26px minmax(130px,1.1fr) minmax(110px,0.9fr) minmax(110px,1fr) minmax(110px,0.9fr) 100px 165px 105px 112px 68px 38px'
const MIN_W = gridMinWidth(COLS)
const ROW_H = 44

type Props = {
  rows: ServerRow[]
  projects: Map<string, Project>
  selected: Set<string>
  onSelectedChange: (s: Set<string>) => void
  sort: SortState
  onSortChange: (s: SortState) => void
  onTagClick?: (tag: string) => void
  onEdit: (s: Server) => void
  onDelete: (s: Server) => void
  footer?: ReactNode
}

export function ServerTable({
  rows,
  projects,
  selected,
  onSelectedChange,
  sort,
  onSortChange,
  onTagClick,
  onEdit,
  onDelete,
  footer,
}: Props) {
  const { t } = useTranslation('servers')
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastClicked = useRef<number | null>(null)
  const navigate = useNavigate()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  })

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.server.id))
  const someSelected = !allSelected && rows.some((r) => selected.has(r.server.id))

  const toggleAll = () => {
    const next = new Set(selected)
    if (allSelected) rows.forEach((r) => next.delete(r.server.id))
    else rows.forEach((r) => next.add(r.server.id))
    onSelectedChange(next)
  }

  const toggleRow = (index: number, e: MouseEvent) => {
    const id = rows[index].server.id
    const next = new Set(selected)
    if (e.shiftKey && lastClicked.current !== null) {
      const [a, b] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)]
      const value = !selected.has(id)
      for (let i = a; i <= b; i++) {
        if (value) next.add(rows[i].server.id)
        else next.delete(rows[i].server.id)
      }
    } else if (next.has(id)) next.delete(id)
    else next.add(id)
    lastClicked.current = index
    onSelectedChange(next)
  }

  const head = (key: SortKey | null, label: string, align?: 'right') => {
    const sorted = key && sort.key === key
    return (
      <div
        className={cx('vt-cell', key && 'sortable', sorted && 'sorted')}
        style={align === 'right' ? { justifyContent: 'flex-end' } : undefined}
        onClick={
          key
            ? () =>
                onSortChange({
                  key,
                  dir: sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : key === 'name' || key === 'host' ? 'asc' : 'desc',
                })
            : undefined
        }
      >
        {label}
        {sorted && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </div>
    )
  }

  return (
    <div className="vt">
      <div className="vt-scroll" ref={scrollRef}>
        <div className="vt-head" style={{ gridTemplateColumns: COLS, minWidth: MIN_W }}>
          <div className="vt-cell">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected
              }}
              onChange={toggleAll}
              title={t('table.selectAll')}
            />
          </div>
          {head('status', '')}
          {head('name', t('table.name'))}
          {head('host', t('table.address'))}
          {head(null, t('table.tags'))}
          {head(null, t('table.projects'))}
          {head('cpu', 'CPU')}
          {head('ram', 'RAM')}
          {head('disk', t('table.disk'))}
          {head('load', 'Load')}
          {head('uptime', t('table.uptime'))}
          <div className="vt-cell" />
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const r = rows[vi.index]
            const s = r.server
            const isSel = selected.has(s.id)
            const st = r.stats
            return (
              <div
                key={s.id}
                className={cx('vt-row clickable', isSel && 'selected')}
                style={{ gridTemplateColumns: COLS, minWidth: MIN_W, transform: `translateY(${vi.start}px)` }}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) toggleRow(vi.index, e)
                  else navigate(`/servers/${s.id}`)
                }}
              >
                <div
                  className="vt-cell"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleRow(vi.index, e)
                  }}
                >
                  <input type="checkbox" checked={isSel} readOnly style={{ accentColor: 'var(--accent)', pointerEvents: 'none' }} />
                </div>
                <div className="vt-cell">
                  <StatusDot status={r.status} title={st?.error ?? undefined} />
                </div>
                <div className="vt-cell" title={s.description || s.name}>
                  <span className="ellipsis" style={{ fontWeight: 500 }}>
                    {s.name}
                  </span>
                </div>
                <div className="vt-cell mono dim" title={`${s.username}@${s.host}:${s.port}`}>
                  <span className="ellipsis">
                    {s.host}
                    {s.port !== 22 && `:${s.port}`}
                  </span>
                </div>
                <div className="vt-cell chips" title={s.tags.join(', ')}>
                  {s.tags.map((tg) => (
                    <button
                      key={tg}
                      className="tag"
                      onClick={(e) => {
                        e.stopPropagation()
                        onTagClick?.(tg)
                      }}
                    >
                      {tg}
                    </button>
                  ))}
                </div>
                <div
                  className="vt-cell chips"
                  title={s.project_ids
                    .map((pid) => projects.get(pid)?.name)
                    .filter(Boolean)
                    .join(', ')}
                >
                  {s.project_ids.map((pid) => {
                    const p = projects.get(pid)
                    if (!p) return null
                    return (
                      <span key={pid} className="row" style={{ gap: 4 }} title={p.name}>
                        <span className="project-dot" style={p.color ? { background: p.color } : undefined} />
                        <span className="small nowrap">{p.name}</span>
                      </span>
                    )
                  })}
                </div>
                <div className="vt-cell">
                  <Meter percent={r.cpu} title={st?.cpu_cores ? t('table.cores', { count: st.cpu_cores }) : undefined} />
                </div>
                <div className="vt-cell">
                  <Meter
                    percent={r.ramPct}
                    label={r.ramPct !== null ? `${formatBytes(st?.mem_used, 1)} / ${formatBytes(st?.mem_total, 0)}` : undefined}
                  />
                </div>
                <div className="vt-cell">
                  <Meter
                    percent={r.diskPct}
                    title={r.disk ? `${r.disk.mount}: ${formatBytes(r.disk.used)} / ${formatBytes(r.disk.total)}` : undefined}
                  />
                </div>
                <div className="vt-cell mono small">{formatLoad(st?.load)}</div>
                <div className="vt-cell small num">{formatUptime(r.uptime)}</div>
                <div className="vt-cell" onClick={(e) => e.stopPropagation()}>
                  <Menu
                    trigger={(toggle) => (
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} title={t('common:actions.more')}>
                        <MoreHorizontal size={15} />
                      </button>
                    )}
                    items={[
                      { label: t('common:actions.open'), icon: <FolderOpen size={14} />, onClick: () => navigate(`/servers/${s.id}`) },
                      {
                        label: t('menu.terminal'),
                        icon: <SquareTerminal size={14} />,
                        onClick: () => navigate(`/servers/${s.id}/terminal`),
                      },
                      { label: t('menu.edit'), icon: <Pencil size={14} />, onClick: () => onEdit(s) },
                      'sep',
                      { label: t('common:actions.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => onDelete(s) },
                    ]}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {footer && <div className="vt-footer">{footer}</div>}
    </div>
  )
}
