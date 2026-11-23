import { useQueryClient } from '@tanstack/react-query'
import { FolderPlus } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { invalidateServers, useProjects } from '../../api/queries'
import type { BulkExecResult } from '../../api/types'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { ExecForm } from '../exec/ExecForm'
import { ExecResults } from '../exec/ExecResults'
import { mapLimit } from '../../lib/util'

export function BulkExecDialog({ open, onClose, serverIds }: { open: boolean; onClose: () => void; serverIds: string[] }) {
  const { t } = useTranslation('servers')
  const [results, setResults] = useState<{ cmd: string; items: BulkExecResult[] } | null>(null)
  return (
    <Modal
      open={open}
      onClose={() => {
        setResults(null)
        onClose()
      }}
      title={t('bulkExec.title', { count: serverIds.length })}
      size="xl"
    >
      <div className="stack">
        <ExecForm target={{ server_ids: serverIds }} onResults={(items, cmd) => setResults({ items, cmd })} />
        {results && (
          <div className="stack-sm">
            <div className="muted small">
              <Trans t={t} i18nKey="bulkExec.result" values={{ cmd: results.cmd }} components={{ code: <code /> }} />
            </div>
            <ExecResults key={results.cmd + results.items.length} results={results.items} />
          </div>
        )}
      </div>
    </Modal>
  )
}

export function AddToProjectDialog({
  open,
  onClose,
  serverIds,
  onDone,
}: {
  open: boolean
  onClose: () => void
  serverIds: string[]
  onDone?: () => void
}) {
  const { t } = useTranslation('servers')
  const projects = useProjects()
  const qc = useQueryClient()
  const toast = useToast()
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  const submit = async () => {
    if (!projectId) return
    setBusy(true)
    setProgress(0)
    let done = 0
    const res = await mapLimit(serverIds, 8, async (id) => {
      await api.projects.addServer(projectId, id)
      setProgress(++done)
    })
    setBusy(false)
    invalidateServers(qc)
    const failed = res.filter((r) => r.status === 'rejected').length
    const pname = projects.data?.find((p) => p.id === projectId)?.name ?? ''
    if (failed)
      toast.error(
        t('addToProject.partial', { ok: serverIds.length - failed, failed }),
        (res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      )
    else toast.success(t('addToProject.success'), t('addToProject.successDetail', { project: pname, count: serverIds.length }))
    onDone?.()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      size="sm"
      title={t('addToProject.title')}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!projectId || busy} onClick={() => void submit()}>
            {busy ? <Spinner /> : <FolderPlus size={14} />}
            {busy ? `${progress}/${serverIds.length}` : t('common:actions.add')}
          </button>
        </>
      }
    >
      <Field label={t('addToProject.label', { count: serverIds.length })}>
        <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} autoFocus>
          <option value="">{t('addToProject.placeholder')}</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {projects.data?.length === 0 && <span className="field-hint">{t('addToProject.noProjects')}</span>}
      </Field>
    </Modal>
  )
}
