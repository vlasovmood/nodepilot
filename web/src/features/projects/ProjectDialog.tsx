import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { api } from '../../api/client'
import { qk } from '../../api/queries'
import type { Project } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { InlineError, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { cx } from '../../lib/util'

export const PROJECT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16']

export function ProjectDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project | null }) {
  const { t } = useTranslation('projects')
  return (
    <Modal open={open} onClose={onClose} title={project ? t('dialog.editTitle') : t('dialog.newTitle')} size="sm">
      {open && <ProjectForm key={project?.id ?? 'new'} project={project ?? null} onDone={onClose} />}
    </Modal>
  )
}

function ProjectForm({ project, onDone }: { project: Project | null; onDone: () => void }) {
  const { t } = useTranslation('projects')
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState<string | null>(project?.color ?? PROJECT_COLORS[0])

  const m = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim(), color }
      return project ? api.projects.update(project.id, body) : api.projects.create(body)
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.projects })
      toast.success(project ? t('toast.saved') : t('toast.created'), p.name)
      onDone()
      if (!project) navigate(`/projects/${p.id}`)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    m.mutate()
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field label={t('common:fields.name')}>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('common:fields.description')}>
        <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label={t('common:fields.color')}>
        <div className="swatches">
          <button
            type="button"
            className={cx('swatch', color === null && 'active')}
            style={{ background: 'var(--bg-hover)' }}
            title={t('dialog.noColor')}
            aria-label={t('dialog.noColor')}
            onClick={() => setColor(null)}
          />
          {PROJECT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={cx('swatch', color === c && 'active')}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <input
            type="color"
            value={color ?? '#64748b'}
            onChange={(e) => setColor(e.target.value)}
            title={t('dialog.customColor')}
            aria-label={t('dialog.customColor')}
            style={{ width: 28, height: 24, border: 0, background: 'none', padding: 0, cursor: 'pointer' }}
          />
        </div>
      </Field>
      <InlineError error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onDone}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={!name.trim() || m.isPending}>
          {m.isPending && <Spinner />}
          {project ? t('common:actions.save') : t('common:actions.create')}
        </button>
      </div>
    </form>
  )
}

export function useDeleteProject() {
  const { t } = useTranslation('projects')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  return async (p: Project, redirect: boolean) => {
    const ok = await confirm({
      title: t('confirm.deleteTitle'),
      message: <Trans t={t} i18nKey="confirm.deleteMessage" values={{ name: p.name }} components={{ b: <b /> }} />,
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.projects.remove(p.id)
      toast.success(t('toast.deleted'), p.name)
      void qc.invalidateQueries({ queryKey: qk.projects })
      void qc.invalidateQueries({ queryKey: qk.servers })
      if (redirect) navigate('/servers')
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e)
    }
  }
}
