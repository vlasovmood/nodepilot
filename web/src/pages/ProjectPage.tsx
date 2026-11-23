import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Server, StickyNote, Trash2, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { api } from '../api/client'
import { qk } from '../api/queries'
import type { Project } from '../api/types'
import { ErrorState, Loading } from '../components/States'
import { Tabs } from '../components/Tabs'
import { NotesPanel } from '../features/notes/NotesPanel'
import { ProjectDialog, useDeleteProject } from '../features/projects/ProjectDialog'
import { ServersView } from '../features/servers/ServersView'
import { GraphGrid } from './GraphsPage'

type Tab = 'servers' | 'graphs' | 'notes'

export function ProjectPage() {
  const { t } = useTranslation('projects')
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('servers')
  const [editOpen, setEditOpen] = useState(false)
  const deleteProject = useDeleteProject()

  const project = useQuery({
    queryKey: qk.project(id),
    queryFn: () => api.projects.get(id),
    placeholderData: () => qc.getQueryData<Project[]>(qk.projects)?.find((p) => p.id === id),
  })

  if (project.isPending) return <Loading />
  if (project.isError) return <ErrorState error={project.error} onRetry={() => void project.refetch()} title={t('notFound')} />
  const p = project.data

  return (
    <div className="page page-fill">
      <div className="page-header">
        <span className="project-dot" style={{ width: 14, height: 14, borderRadius: 4, ...(p.color ? { background: p.color } : {}) }} />
        <div className="title-block">
          <h1>{p.name}</h1>
          <span className="muted small">
            {p.description || t('common:noDescription')} · {t('common:counts.servers', { count: p.server_count })}
          </span>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setEditOpen(true)}>
            <Pencil size={14} /> {t('common:actions.edit')}
          </button>
          <button className="btn btn-danger-ghost" onClick={() => void deleteProject(p, true)}>
            <Trash2 size={14} /> {t('common:actions.delete')}
          </button>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'servers', label: t('tabs.servers'), icon: <Server size={14} /> },
          { key: 'graphs', label: t('tabs.graphs'), icon: <Waypoints size={14} /> },
          { key: 'notes', label: t('tabs.notes'), icon: <StickyNote size={14} /> },
        ]}
      />
      {tab === 'servers' && <ServersView key={p.id} project={p} />}
      {tab === 'graphs' && <GraphGrid key={p.id} projectId={p.id} />}
      {tab === 'notes' && <NotesPanel key={p.id} scope={{ project_id: p.id }} />}
      <ProjectDialog open={editOpen} project={p} onClose={() => setEditOpen(false)} />
    </div>
  )
}
