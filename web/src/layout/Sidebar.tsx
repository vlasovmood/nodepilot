import {
  ChevronsUpDown,
  Code2,
  Languages,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  ScrollText,
  Settings,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation, useNavigate } from 'react-router'
import { useProjects } from '../api/queries'
import type { Project } from '../api/types'
import { LanguageDialog } from '../components/LanguageSelect'
import { Menu } from '../components/Menu'
import { Spinner } from '../components/States'
import { useAuth } from '../features/auth/AuthGate'
import { ProjectDialog, useDeleteProject } from '../features/projects/ProjectDialog'
import { useTheme } from '../lib/theme'
import { cx } from '../lib/util'
import { BrandLogo, BrandMark } from '../components/Logo'
import { MainNav } from './MainNav'
import { Section } from './NavSection'

function NavItem({ to, icon, label, count, end }: { to: string; icon: ReactNode; label: string; count?: number; end?: boolean }) {
  return (
    <NavLink to={to} end={end} title={label} className={({ isActive }) => cx('nav-item', isActive && 'active')}>
      {icon}
      <span className="ellipsis">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </NavLink>
  )
}

export function Sidebar({ collapsed, mobile, onToggleCollapsed }: { collapsed: boolean; mobile: boolean; onToggleCollapsed: () => void }) {
  const { t, i18n } = useTranslation('layout')
  const { user, logout } = useAuth()
  const [theme, , toggleTheme] = useTheme()
  const projects = useProjects()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<{ project: Project | null } | null>(null)
  const deleteProject = useDeleteProject()
  const [langOpen, setLangOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const location = useLocation()

  // In the mobile top bar, keep the current page's item in view.
  useEffect(() => {
    if (!mobile) return
    navRef.current?.querySelector('.nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [mobile, location.pathname, location.search])

  return (
    <aside className="sidebar">
      <div className="brand">
        {collapsed || mobile ? <BrandMark size={mobile ? 30 : 34} /> : <BrandLogo height={52} />}
        <button
          className="btn btn-ghost btn-icon btn-sm collapse-btn"
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav
        className="sidebar-scroll"
        ref={navRef}
        onWheel={(e) => {
          // In the top bar a plain mouse wheel scrolls sideways.
          if (mobile && Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        <MainNav collapsed={collapsed || mobile} />

        <Section
          id="projects"
          title={t('sidebar.sections.projects')}
          action={
            <button
              className="btn btn-ghost btn-icon btn-sm add-btn"
              title={t('sidebar.newProject')}
              onClick={() => setDialog({ project: null })}
            >
              <Plus size={15} />
            </button>
          }
        >
          {projects.isPending && (
            <div className="row dim small" style={{ padding: '6px 12px' }}>
              <Spinner /> <span>{t('common:state.loading')}</span>
            </div>
          )}
          {projects.isError && (
            <div className="danger-text small" style={{ padding: '6px 12px' }}>
              <span>{t('sidebar.projectsLoadError')}</span>
            </div>
          )}
          {projects.data?.length === 0 && (
            <button className="nav-item dim" onClick={() => setDialog({ project: null })} title={t('sidebar.createProject')}>
              <Plus size={17} />
              <span>{t('sidebar.createProject')}</span>
            </button>
          )}
          {projects.data
            ?.slice()
            .sort((a, b) => a.name.localeCompare(b.name, i18n.language))
            .map((p) => (
              <NavLink
                key={p.id}
                to={`/projects/${p.id}`}
                title={p.name}
                className={({ isActive }) => cx('nav-item', isActive && 'active')}
              >
                <span className="project-dot" style={p.color ? { background: p.color } : undefined} />
                <span className="ellipsis">{p.name}</span>
                <span className="count hide-on-hover">{p.server_count}</span>
                <span className="nav-actions">
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title={t('common:actions.editItem')}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDialog({ project: p })
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    title={t('common:actions.delete')}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void deleteProject(p, false)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </NavLink>
            ))}
        </Section>

        <Section id="more" title={t('sidebar.sections.more')}>
          <NavItem to="/security" icon={<Shield size={17} />} label={t('nav.security')} />
          <NavItem to="/audit" icon={<ScrollText size={17} />} label={t('nav.audit')} />
          <NavItem to="/developer" icon={<Code2 size={17} />} label={t('nav.api')} />
          <NavItem to="/settings" icon={<Settings size={17} />} label={t('nav.settings')} />
          <button className="nav-item" onClick={toggleTheme} title={t('sidebar.darkMode')}>
            <Moon size={17} />
            <span>{t('sidebar.darkMode')}</span>
            <span className={cx('switch', theme === 'dark' && 'on')} />
          </button>
        </Section>
      </nav>

      <div className="sidebar-footer">
        <Menu
          align={mobile ? 'right' : 'left'}
          trigger={(toggle) => (
            <button className="user-card" onClick={toggle} title={user.username}>
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <span className="user-text">
                <span className="user-name ellipsis">{user.username}</span>
                <span className="user-sub">{t('user.role')}</span>
              </span>
              <ChevronsUpDown size={15} className="chev dim" />
            </button>
          )}
          items={[
            {
              label: t('user.settings'),
              icon: <Settings size={14} />,
              onClick: () => navigate('/settings'),
            },
            {
              label: t('user.language'),
              icon: <Languages size={14} />,
              onClick: () => setLangOpen(true),
            },
            {
              label: theme === 'dark' ? t('user.lightTheme') : t('user.darkTheme'),
              icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />,
              onClick: toggleTheme,
            },
            'sep',
            {
              label: t('user.logout'),
              icon: <LogOut size={14} />,
              onClick: () => void logout(),
              danger: true,
            },
          ]}
        />
      </div>
      <LanguageDialog open={langOpen} onClose={() => setLangOpen(false)} />
      <ProjectDialog open={!!dialog} project={dialog?.project} onClose={() => setDialog(null)} />
    </aside>
  )
}
