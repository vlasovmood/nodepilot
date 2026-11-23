import { useState } from 'react'
import { Outlet } from 'react-router'
import { useMediaQuery } from '../lib/useMediaQuery'
import { cx } from '../lib/util'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

const KEY = 'np.sidebar.collapsed'
/** Below this width the sidebar turns into a horizontally scrolling bar at the top. */
export const MOBILE_QUERY = '(max-width: 805.98px)'

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const mobile = useMediaQuery(MOBILE_QUERY)
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !c
    })
  }
  return (
    <div className={cx('app', mobile ? 'mobile' : collapsed && 'sidebar-collapsed')}>
      <Sidebar collapsed={collapsed && !mobile} mobile={mobile} onToggleCollapsed={toggle} />
      <Topbar />
      <main className="main">
        <Outlet />
        <footer className="app-footer">
          <span>© {new Date().getFullYear()} NodePilot</span>
          <span className="spacer" />
          <span className="dim">Self-hosted · v0.1.0</span>
        </footer>
      </main>
    </div>
  )
}
