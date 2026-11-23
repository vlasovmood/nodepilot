import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/util'

export type MenuItem =
  | { label: ReactNode; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }
  | 'sep'

/** Dropdown menu rendered in a portal (so it is never clipped by scroll containers / virtual rows). */
export function Menu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: (toggle: () => void) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return
    const r = wrapRef.current.getBoundingClientRect()
    const menuH = menuRef.current?.offsetHeight ?? 0
    const below = r.bottom + 4 + menuH <= window.innerHeight
    const s: CSSProperties = { position: 'fixed', top: below ? r.bottom + 4 : Math.max(4, r.top - 4 - menuH) }
    if (align === 'right') s.right = Math.max(4, window.innerWidth - r.right)
    else s.left = r.left
    setStyle(s)
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {trigger(() => setOpen((o) => !o))}
      {open &&
        createPortal(
          <div className={cx('menu')} role="menu" ref={menuRef} style={{ ...style, right: style.right, left: style.left }}>
            {items.map((it, i) =>
              it === 'sep' ? (
                <div key={i} className="menu-sep" />
              ) : (
                <button
                  key={i}
                  className={cx('menu-item', it.danger && 'danger')}
                  disabled={it.disabled}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpen(false)
                    it.onClick()
                  }}
                >
                  {it.icon}
                  {it.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
