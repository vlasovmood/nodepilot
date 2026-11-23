import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, useNavigate } from 'react-router'
import { useServers, useStatsMap } from '../api/queries'
import { StatusDot } from '../components/StatusDot'
import { cx } from '../lib/util'

export function Topbar() {
  const { t } = useTranslation('layout')
  const servers = useServers()
  const stats = useStatsMap()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Ctrl+K / "/" focuses global search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const results = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (!term || !servers.data) return []
    const out = []
    for (const s of servers.data) {
      if (s.name.toLowerCase().includes(term) || s.host.toLowerCase().includes(term)) {
        out.push(s)
        if (out.length >= 15) break
      }
    }
    return out
  }, [q, servers.data])

  const go = (id: string) => {
    setOpen(false)
    setQ('')
    inputRef.current?.blur()
    navigate(`/servers/${id}`)
  }

  return (
    <header className="topbar">
      <div className="search-box" ref={boxRef}>
        <div className="input-icon">
          <Search size={14} />
          <input
            ref={inputRef}
            className="input"
            placeholder={t('search.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                if (results[active]) go(results[active].id)
                else if (q.trim()) {
                  setOpen(false)
                  navigate(`/servers?q=${encodeURIComponent(q.trim())}`)
                }
              } else if (e.key === 'Escape') {
                setOpen(false)
                inputRef.current?.blur()
              }
            }}
          />
          <span className="kbd">Ctrl K</span>
        </div>
        {open && q.trim() && (
          <div className="search-pop">
            {servers.isPending && (
              <div className="dim small" style={{ padding: 8 }}>
                {t('common:state.loading')}
              </div>
            )}
            {!servers.isPending && results.length === 0 && (
              <div className="dim small" style={{ padding: 8 }}>
                {t('common:state.nothingFound')}
              </div>
            )}
            {results.map((s, i) => (
              <div
                key={s.id}
                className={cx('search-item', i === active && 'active')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  go(s.id)
                }}
              >
                <StatusDot status={stats.get(s.id)?.status ?? s.status} />
                <span className="ellipsis" style={{ fontWeight: 500 }}>
                  {s.name}
                </span>
                <span className="dim mono ellipsis" style={{ marginInlineStart: 'auto' }}>
                  {s.username}@{s.host}:{s.port}
                </span>
              </div>
            ))}
            {results.length > 0 && (
              <div
                className="dim small"
                style={{
                  padding: '6px 8px',
                  borderTop: '1px solid var(--border)',
                  marginTop: 4,
                }}
              >
                {t('search.hint')}
              </div>
            )}
          </div>
        )}
      </div>
      <nav className="top-links">
        <NavLink to="/servers" end>
          {t('nav.servers')}
        </NavLink>
        <NavLink to="/graphs">{t('nav.graph')}</NavLink>
        <NavLink to="/exec">{t('nav.terminal')}</NavLink>
        <NavLink to="/backups">{t('nav.backups')}</NavLink>
        <NavLink to="/notes">{t('nav.notes')}</NavLink>
        <NavLink to="/developer">{t('nav.api')}</NavLink>
      </nav>
    </header>
  )
}
