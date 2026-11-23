import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cx } from '../lib/util'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

/** Collapsible sidebar section; the open state is remembered per browser. */
export function Section({
  id,
  title,
  action,
  forceOpen,
  children,
}: {
  id: string
  title: string
  action?: ReactNode
  /** Keep the section expanded (e.g. while it is being customized). */
  forceOpen?: boolean
  children: ReactNode
}) {
  const key = `np.nav.${id}`
  const [stored, setOpen] = useState(() => readFlag(key, true))
  const open = stored || !!forceOpen
  return (
    <div className={cx('nav-section', !open && 'closed')}>
      <div className="row" style={{ gap: 2 }}>
        <button
          className="nav-section-title"
          onClick={() => {
            setOpen(!open)
            writeFlag(key, !open)
          }}
          title={title}
        >
          <span>{title}</span>
          <ChevronDown size={15} className="chev" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
        {action}
      </div>
      <div className="nav-list">{children}</div>
    </div>
  )
}
