import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  Check,
  ChevronsDown,
  ChevronsUp,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  KeyRound,
  LayoutGrid,
  Plus,
  RotateCcw,
  Server as ServerIcon,
  SlidersHorizontal,
  SquareTerminal,
  StickyNote,
  Waypoints,
  Workflow,
  X,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { api } from '../api/client'
import { qk, useServers } from '../api/queries'
import { cx } from '../lib/util'
import { NavPinDialog } from './NavPinDialog'
import { defaultEntries, entryKey, setNavEntries, useNavEntries, type NavEntry, type PageId } from './navPrefs'
import { Section } from './NavSection'

const PAGE_DEFS: Record<PageId, { to: string; icon: ReactNode; labelKey: string }> = {
  servers: { to: '/servers', icon: <LayoutGrid size={17} />, labelKey: 'nav.servers' },
  graphs: { to: '/graphs', icon: <Waypoints size={17} />, labelKey: 'nav.graph' },
  exec: { to: '/exec', icon: <SquareTerminal size={17} />, labelKey: 'nav.terminal' },
  identities: { to: '/identities', icon: <KeyRound size={17} />, labelKey: 'nav.identities' },
  backups: { to: '/backups', icon: <Archive size={17} />, labelKey: 'nav.backups' },
  notes: { to: '/notes', icon: <StickyNote size={17} />, labelKey: 'nav.notes' },
}

type Item = {
  key: string
  entry: NavEntry
  to: string
  icon: ReactNode
  label: string
  count?: number
  /** The pinned object no longer exists. */
  missing: boolean
  active: boolean
}

/** The customizable "Navigation" section: built-in pages plus pinned servers, graphs and notes. */
export function MainNav({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation('layout')
  const entries = useNavEntries()
  const [editing, setEditing] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [picker, setPicker] = useState(false)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const { pathname, search } = useLocation()
  const edit = editing && !collapsed

  const servers = useServers()
  const graphs = useQuery({ queryKey: qk.graphs, queryFn: () => api.graphs.list(), enabled: entries.some((e) => e.kind === 'graph') })
  const notes = useQuery({ queryKey: qk.notes(), queryFn: () => api.notes.list(), enabled: entries.some((e) => e.kind === 'note') })

  const items = useMemo<Item[]>(() => {
    const noteParam = new URLSearchParams(search).get('note')
    const pinned = entries.map((e): Omit<Item, 'active'> & { match: boolean } => {
      const key = entryKey(e)
      if (e.kind === 'page') {
        const d = PAGE_DEFS[e.id]
        return { key, entry: e, to: d.to, icon: d.icon, label: t(d.labelKey), missing: false, match: false }
      }
      if (e.kind === 'server') {
        const s = servers.data?.find((x) => x.id === e.id)
        return {
          key,
          entry: e,
          to: `/servers/${e.id}`,
          icon: <ServerIcon size={17} />,
          label: s?.name ?? '…',
          missing: !!servers.data && !s,
          match: pathname === `/servers/${e.id}` || pathname.startsWith(`/servers/${e.id}/`),
        }
      }
      if (e.kind === 'graph') {
        const g = graphs.data?.find((x) => x.id === e.id)
        return {
          key,
          entry: e,
          to: `/graphs/${e.id}`,
          icon: <Workflow size={17} />,
          label: g?.name ?? '…',
          missing: !!graphs.data && !g,
          match: pathname === `/graphs/${e.id}`,
        }
      }
      const n = notes.data?.find((x) => x.id === e.id)
      return {
        key,
        entry: e,
        to: `/notes?note=${encodeURIComponent(e.id)}`,
        icon: <FileText size={17} />,
        label: n ? n.title.trim() || t('sidebar.nav.untitled') : '…',
        missing: !!notes.data && !n,
        match: pathname === '/notes' && noteParam === e.id,
      }
    })
    // A pinned item takes the highlight from its section page (e.g. a pinned graph vs. "Graphs").
    const pinnedMatch = pinned.some((p) => p.match && !p.missing)
    return pinned.map(({ match, ...p }) => {
      if (p.entry.kind !== 'page') return { ...p, active: match && !p.missing }
      const to = PAGE_DEFS[p.entry.id].to
      const inSection = p.entry.id === 'servers' ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)
      return { ...p, count: p.entry.id === 'servers' ? servers.data?.length : undefined, active: inSection && !pinnedMatch }
    })
  }, [entries, servers.data, graphs.data, notes.data, pathname, search, t])

  const hiddenCount = items.filter((i) => i.entry.hidden && !i.missing).length

  const update = (fn: (list: NavEntry[]) => NavEntry[]) => setNavEntries(fn(entries.slice()))
  const toggleHidden = (key: string) => update((l) => l.map((e) => (entryKey(e) === key ? ({ ...e, hidden: !e.hidden } as NavEntry) : e)))
  const remove = (key: string) => update((l) => l.filter((e) => entryKey(e) !== key))
  /** Move the entry at `from` so it lands before the entry currently at `to` (to === length means "to the end"). */
  const move = (from: number, to: number) =>
    update((l) => {
      const [it] = l.splice(from, 1)
      l.splice(to > from ? to - 1 : to, 0, it)
      return l
    })

  const action = collapsed ? undefined : edit ? (
    <button className="btn btn-ghost btn-icon btn-sm add-btn" title={t('sidebar.nav.done')} onClick={() => setEditing(false)}>
      <Check size={15} />
    </button>
  ) : (
    <button className="btn btn-ghost btn-icon btn-sm add-btn" title={t('sidebar.nav.customize')} onClick={() => setEditing(true)}>
      <SlidersHorizontal size={14} />
    </button>
  )

  return (
    <Section id="main" title={t('sidebar.sections.main')} action={action} forceOpen={edit}>
      {edit ? (
        <>
          <div className="nav-edit-hint dim small">{t('sidebar.nav.reorderHint')}</div>
          {items.map((it, i) => (
            <div
              key={it.key}
              className={cx(
                'nav-item nav-edit-row',
                it.entry.hidden && 'is-hidden',
                it.missing && 'is-missing',
                drag?.from === i && 'dragging',
                drag && drag.over === i && drag.from !== i && drag.from !== i - 1 && 'drop-before',
                drag && i === items.length - 1 && drag.over === items.length && drag.from !== i && 'drop-after',
              )}
              draggable
              tabIndex={0}
              title={it.label}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', it.key)
                setDrag({ from: i, over: i })
              }}
              onDragOver={(e) => {
                if (!drag) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const over = e.clientY > r.top + r.height / 2 ? i + 1 : i
                if (over !== drag.over) setDrag({ ...drag, over })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (drag) move(drag.from, drag.over)
                setDrag(null)
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(e) => {
                if (!e.altKey) return
                if (e.key === 'ArrowUp' && i > 0) {
                  e.preventDefault()
                  move(i, i - 1)
                } else if (e.key === 'ArrowDown' && i < items.length - 1) {
                  e.preventDefault()
                  move(i, i + 2)
                }
              }}
            >
              <GripVertical size={14} className="grip" />
              {it.icon}
              <span className="ellipsis">{it.missing ? t('sidebar.nav.missing') : it.label}</span>
              <span className="nav-edit-actions">
                {!it.missing && (
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title={it.entry.hidden ? t('sidebar.nav.show') : t('sidebar.nav.hide')}
                    aria-pressed={!it.entry.hidden}
                    onClick={() => toggleHidden(it.key)}
                  >
                    {it.entry.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
                {it.entry.kind !== 'page' && (
                  <button className="btn btn-ghost btn-icon btn-sm" title={t('sidebar.nav.remove')} onClick={() => remove(it.key)}>
                    <X size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
          <div className="nav-edit-footer">
            <button className="btn btn-sm" onClick={() => setPicker(true)}>
              <Plus size={14} /> {t('sidebar.nav.add')}
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              title={`${t('sidebar.nav.reset')}: ${t('sidebar.nav.resetHint')}`}
              aria-label={t('sidebar.nav.reset')}
              onClick={() => setNavEntries(defaultEntries())}
            >
              <RotateCcw size={13} />
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setEditing(false)}>
              {t('sidebar.nav.done')}
            </button>
          </div>
        </>
      ) : (
        <>
          {items
            .filter((it) => !it.missing && (!it.entry.hidden || showAll || it.active))
            .map((it) => (
              <Link
                key={it.key}
                to={it.to}
                title={it.label}
                className={cx('nav-item', it.active && 'active', it.entry.hidden && 'is-hidden')}
              >
                {it.icon}
                <span className="ellipsis">{it.label}</span>
                {it.count !== undefined && <span className="count">{it.count}</span>}
              </Link>
            ))}
          {hiddenCount > 0 && (
            <button
              className="nav-item nav-more"
              title={showAll ? t('sidebar.nav.showLess') : t('sidebar.nav.showAll')}
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? <ChevronsUp size={17} /> : <ChevronsDown size={17} />}
              <span className="ellipsis">{showAll ? t('sidebar.nav.showLess') : t('sidebar.nav.showAll')}</span>
              {!showAll && <span className="count">{hiddenCount}</span>}
            </button>
          )}
        </>
      )}
      <NavPinDialog open={picker} onClose={() => setPicker(false)} />
    </Section>
  )
}
