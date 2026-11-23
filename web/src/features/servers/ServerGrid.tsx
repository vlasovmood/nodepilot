import { ArrowLeft, ArrowRight, FolderOpen, MoreHorizontal, Pencil, SquareTerminal, Star, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { Server } from '../../api/types'
import { Menu } from '../../components/Menu'
import { StatusDot } from '../../components/StatusDot'
import { meterLevel } from '../../components/Meter'
import { useFavorites } from '../../lib/favorites'
import { cx } from '../../lib/util'
import type { ServerRow } from './model'

const PAGE_SIZE = 24

/** "Ubuntu 24.04.1 LTS" → { mark: "UBUNTU", version: "24.04.1 LTS" } */
function osMark(os: string | null | undefined): {
  mark: string
  version: string
} {
  if (!os) return { mark: '', version: '' }
  const [first, ...rest] = os
    .replace(/GNU\/Linux/i, '')
    .trim()
    .split(/\s+/)
  return { mark: first.toUpperCase(), version: rest.join(' ') }
}

function MiniMeter({ label, pct }: { label: string; pct: number | null }) {
  const { t } = useTranslation('servers')
  const v = pct === null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct))
  return (
    <div className="mini-meter" title={v === null ? t('grid.noData', { label }) : `${label}: ${v.toFixed(0)}%`}>
      <div className="mini-meter-head">
        <span>{label}</span>
        <span className="num">{v === null ? '—' : `${v.toFixed(0)}%`}</span>
      </div>
      <div className="meter-bar">{v !== null && <div className={cx('meter-fill', meterLevel(v))} style={{ width: `${v}%` }} />}</div>
    </div>
  )
}

function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i)
  const set = new Set([0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages))
  if (page <= 2) [1, 2, 3].forEach((p) => set.add(p))
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2].forEach((p) => set.add(p))
  const sorted = [...set].sort((a, b) => a - b)
  const out: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…')
    out.push(p)
  })
  return out
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const { t } = useTranslation('servers')
  if (pages <= 1) return null
  return (
    <div className="pagination">
      <button className="round-btn" disabled={page === 0} onClick={() => onPage(page - 1)} title={t('grid.prev')}>
        <ArrowLeft size={14} />
      </button>
      {pageList(page, pages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="round-btn" style={{ cursor: 'default' }}>
            …
          </span>
        ) : (
          <button key={p} className={cx('round-btn', p === page && 'active')} onClick={() => onPage(p)}>
            {p + 1}
          </button>
        ),
      )}
      <button className="round-btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} title={t('grid.next')}>
        <ArrowRight size={14} />
      </button>
    </div>
  )
}

type Props = {
  rows: ServerRow[]
  selected: Set<string>
  onSelectedChange: (s: Set<string>) => void
  onEdit: (s: Server) => void
  onDelete: (s: Server) => void
  footer?: ReactNode
}

export function ServerGrid({ rows, selected, onSelectedChange, onEdit, onDelete, footer }: Props) {
  const { t } = useTranslation('servers')
  const navigate = useNavigate()
  const [favs, toggleFav] = useFavorites()
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))

  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1)
  }, [page, pages])

  const visible = useMemo(() => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [rows, page])

  const toggleSel = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectedChange(next)
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="srv-grid">
        {visible.map((r) => {
          const s = r.server
          const { mark, version } = osMark(r.stats?.os)
          const fav = favs.has(s.id)
          return (
            <div
              key={s.id}
              className={cx('srv-card', selected.has(s.id) && 'selected')}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) toggleSel(s.id)
                else navigate(`/servers/${s.id}`)
              }}
            >
              <div className="srv-card-top" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSel(s.id)} title={t('grid.select')} />
                <button
                  className={cx('icon-toggle', fav && 'on')}
                  onClick={() => toggleFav(s.id)}
                  title={fav ? t('grid.removeFavorite') : t('grid.addFavorite')}
                >
                  <Star size={15} fill={fav ? 'currentColor' : 'none'} />
                </button>
                <span className="spacer" />
                <Menu
                  trigger={(toggle) => (
                    <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} title={t('common:actions.more')}>
                      <MoreHorizontal size={16} />
                    </button>
                  )}
                  items={[
                    {
                      label: t('common:actions.open'),
                      icon: <FolderOpen size={14} />,
                      onClick: () => navigate(`/servers/${s.id}`),
                    },
                    {
                      label: t('menu.terminal'),
                      icon: <SquareTerminal size={14} />,
                      onClick: () => navigate(`/servers/${s.id}/terminal`),
                    },
                    {
                      label: t('menu.edit'),
                      icon: <Pencil size={14} />,
                      onClick: () => onEdit(s),
                    },
                    'sep',
                    {
                      label: t('common:actions.delete'),
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onClick: () => onDelete(s),
                    },
                  ]}
                />
              </div>
              <div className="srv-card-mark" title={r.stats?.os ?? undefined}>
                {mark ? (
                  <>
                    <span className="mark">{mark}</span>
                    {version && <span className="ver">{version}</span>}
                  </>
                ) : (
                  <span className="mark dim">{r.status === 'offline' ? t('grid.offlineMark') : '· · ·'}</span>
                )}
              </div>
              <div className="srv-card-name">
                <StatusDot status={r.status} title={r.stats?.error ?? t(`common:status.${r.status}`)} />
                <span className="ellipsis">{s.name}</span>
              </div>
              <div className="srv-card-sub ellipsis">
                {s.host}
                {s.port !== 22 && `:${s.port}`}
              </div>
              <div className="srv-card-meters">
                <MiniMeter label="CPU" pct={r.cpu} />
                <MiniMeter label="RAM" pct={r.ramPct} />
                <MiniMeter label={t('table.disk')} pct={r.diskPct} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="row-wrap" style={{ gap: 16 }}>
        <Pagination page={page} pages={pages} onPage={setPage} />
        <span className="spacer" />
        {footer && <div className="row-wrap small muted">{footer}</div>}
      </div>
    </div>
  )
}
