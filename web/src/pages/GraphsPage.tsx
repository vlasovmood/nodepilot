import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, Pencil, Plus, Trash2, Waypoints } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import { qk, useGraphs, useProjects } from '../api/queries'
import type { GraphSummary } from '../api/types'
import { useConfirm } from '../components/Confirm'
import { Field } from '../components/Field'
import { Menu } from '../components/Menu'
import { Modal } from '../components/Modal'
import { Empty, ErrorState, InlineError, Loading, Spinner } from '../components/States'
import { useToast } from '../components/Toast'
import { formatRelative } from '../lib/format'

export function GraphsPage() {
  const { t } = useTranslation('graph')
  const [createOpen, setCreateOpen] = useState(false)
  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1>
            <Waypoints size={17} /> {t('list.title')}
          </h1>
          <span className="muted small">{t('list.subtitle')}</span>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> {t('list.newGraph')}
          </button>
        </div>
      </div>
      <GraphGrid createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
    </div>
  )
}

export function GraphGrid({
  projectId,
  createOpen: createOpenProp,
  onCreateOpenChange,
}: {
  projectId?: string
  createOpen?: boolean
  onCreateOpenChange?: (open: boolean) => void
}) {
  const { t } = useTranslation('graph')
  const graphs = useGraphs()
  const projects = useProjects()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [createOpenState, setCreateOpenState] = useState(false)
  const controlled = createOpenProp !== undefined
  const createOpen = controlled ? createOpenProp : createOpenState
  const setCreateOpen = (v: boolean) => (onCreateOpenChange ?? setCreateOpenState)(v)
  const projectName = (id: string | null) => (id ? projects.data?.find((p) => p.id === id) : undefined)
  const list = (graphs.data ?? []).filter((g) => !projectId || g.project_id === projectId)

  const remove = async (g: GraphSummary) => {
    const ok = await confirm({
      title: t('confirm.deleteTitle'),
      message: <Trans t={t} i18nKey="confirm.deleteMessage" values={{ name: g.name }} components={{ b: <b /> }} />,
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.graphs.remove(g.id)
      void qc.invalidateQueries({ queryKey: qk.graphs })
      toast.success(t('toast.deleted'), g.name)
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e)
    }
  }

  return (
    <>
      {!controlled && list.length > 0 && (
        <div className="toolbar">
          <span className="muted small">{t('list.countInProject', { count: list.length })}</span>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> {t('list.newGraph')}
          </button>
        </div>
      )}
      {graphs.isPending ? (
        <Loading />
      ) : graphs.isError ? (
        <ErrorState error={graphs.error} onRetry={() => void graphs.refetch()} />
      ) : list.length === 0 ? (
        <div className="card">
          <Empty icon={<Waypoints size={30} />} title={projectId ? t('list.emptyProjectTitle') : t('list.emptyTitle')}>
            <div className="muted">{t('list.emptyText')}</div>
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> {t('list.createGraph')}
            </button>
          </Empty>
        </div>
      ) : (
        <div className="srv-grid">
          {list.map((g) => {
            const pr = projectName(g.project_id)
            return (
              <div key={g.id} className="srv-card graph-card" onClick={() => navigate(`/graphs/${g.id}`)}>
                <div className="srv-card-top" onClick={(e) => e.stopPropagation()}>
                  {pr && !projectId && (
                    <span className="badge">
                      <span className="project-dot" style={pr.color ? { background: pr.color } : undefined} /> {pr.name}
                    </span>
                  )}
                  <span className="spacer" />
                  <Menu
                    trigger={(toggle) => (
                      <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} title={t('common:actions.more')}>
                        <MoreHorizontal size={16} />
                      </button>
                    )}
                    items={[
                      { label: t('common:actions.open'), icon: <Pencil size={14} />, onClick: () => navigate(`/graphs/${g.id}`) },
                      'sep',
                      { label: t('common:actions.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(g) },
                    ]}
                  />
                </div>
                <div className="srv-card-mark">
                  <Waypoints size={30} strokeWidth={1.5} />
                </div>
                <div className="srv-card-name">
                  <span className="ellipsis">{g.name}</span>
                </div>
                <div className="srv-card-sub ellipsis">{g.description || t('common:noDescription')}</div>
                <div className="graph-card-foot">
                  <span>{t('list.nodes', { count: g.node_count })}</span>
                  <span>{t('list.edges', { count: g.edge_count })}</span>
                  <span className="dim">{formatRelative(g.updated_at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <CreateGraphDialog open={createOpen} onClose={() => setCreateOpen(false)} defaultProjectId={projectId} />
    </>
  )
}

function CreateGraphDialog({ open, onClose, defaultProjectId }: { open: boolean; onClose: () => void; defaultProjectId?: string }) {
  const { t } = useTranslation('graph')
  return (
    <Modal open={open} onClose={onClose} title={t('list.newGraph')} size="sm">
      {open && <CreateGraphForm onDone={onClose} defaultProjectId={defaultProjectId} />}
    </Modal>
  )
}

function CreateGraphForm({ onDone, defaultProjectId }: { onDone: () => void; defaultProjectId?: string }) {
  const { t } = useTranslation('graph')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const projects = useProjects()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState(defaultProjectId ?? '')
  const m = useMutation({
    mutationFn: () => api.graphs.create({ name: name.trim(), description: description.trim(), project_id: projectId || null }),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: qk.graphs })
      onDone()
      navigate(`/graphs/${g.id}`)
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) m.mutate()
  }
  return (
    <form className="stack" onSubmit={submit}>
      <Field label={t('common:fields.name')}>
        <input className="input" autoFocus placeholder={t('list.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('common:fields.description')}>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label={t('common:fields.project')}>
        <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t('common:noProject')}</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <InlineError error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onDone}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || m.isPending}>
          {m.isPending && <Spinner />} {t('common:actions.create')}
        </button>
      </div>
    </form>
  )
}
