import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cloud, HardDrive, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { qk, useStorages } from '../../api/queries'
import type { Storage, StorageInput, StoragePatch } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Empty, ErrorState, InlineError, Loading, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'

export function StoragesSection() {
  const { t } = useTranslation('backups')
  const storages = useStorages()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Storage | null | 'new'>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const test = async (s: Storage) => {
    setTesting(s.id)
    try {
      const r = await api.backups.testStorage(s.id)
      if (r.ok) toast.success(t('storages.toast.available'), s.name)
      else toast.error(t('storages.toast.unavailable', { name: s.name }), r.error ?? undefined)
    } catch (e) {
      toast.error(t('storages.toast.testFailed'), e)
    } finally {
      setTesting(null)
    }
  }

  const remove = async (s: Storage) => {
    const ok = await confirm({
      title: t('storages.confirmDelete.title'),
      message: t('storages.confirmDelete.message', { name: s.name }),
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.backups.removeStorage(s.id)
      toast.success(t('storages.toast.deleted'), s.name)
      void qc.invalidateQueries({ queryKey: qk.storages })
    } catch (e) {
      toast.error(t('storages.toast.deleteFailed'), e)
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted small">{t('storages.intro')}</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Plus size={14} /> {t('storages.add')}
        </button>
      </div>
      {storages.isPending ? (
        <Loading />
      ) : storages.isError ? (
        <ErrorState error={storages.error} onRetry={() => void storages.refetch()} />
      ) : storages.data.length === 0 ? (
        <div className="card">
          <Empty icon={<HardDrive size={28} />} title={t('storages.emptyTitle')}>
            <span className="muted">{t('storages.emptyHint')}</span>
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common:fields.name')}</th>
                <th>{t('common:fields.type')}</th>
                <th>{t('storages.columns.location')}</th>
                <th>{t('common:fields.created')}</th>
                <th style={{ width: 160 }} />
              </tr>
            </thead>
            <tbody>
              {storages.data.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td>
                    <span className="badge">
                      {s.kind === 's3' ? <Cloud size={11} /> : <HardDrive size={11} />}
                      {s.kind === 's3' ? t('storages.kind.s3') : t('storages.kind.local')}
                    </span>
                  </td>
                  <td className="mono small">
                    {s.kind === 'local'
                      ? s.local?.path
                      : s.s3 && (
                          <>
                            s3://{s.s3.bucket}/{s.s3.prefix}
                            <span className="dim">
                              {' '}
                              · {s.s3.endpoint || 'AWS'} · {s.s3.region}
                            </span>
                          </>
                        )}
                  </td>
                  <td className="small dim">{formatDateTime(s.created_at)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      <button className="btn btn-sm" onClick={() => void test(s)} disabled={testing === s.id}>
                        {testing === s.id ? <Spinner /> : <PlugZap size={13} />} {t('storages.test')}
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('storages.edit')} onClick={() => setEditing(s)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.delete')} onClick={() => void remove(s)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing && editing !== 'new' ? t('storages.dialog.title', { name: editing.name }) : t('storages.dialog.newTitle')}
      >
        {editing !== null && <StorageForm storage={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </Modal>
    </div>
  )
}

function StorageForm({ storage, onClose }: { storage: Storage | null; onClose: () => void }) {
  const { t } = useTranslation('backups')
  const qc = useQueryClient()
  const toast = useToast()
  const [name, setName] = useState(storage?.name ?? '')
  const [kind, setKind] = useState<'local' | 's3'>(storage?.kind ?? 'local')
  const [path, setPath] = useState(storage?.local?.path ?? '/var/lib/nodepilot/backups')
  const [endpoint, setEndpoint] = useState(storage?.s3?.endpoint ?? '')
  const [region, setRegion] = useState(storage?.s3?.region ?? 'us-east-1')
  const [bucket, setBucket] = useState(storage?.s3?.bucket ?? '')
  const [prefix, setPrefix] = useState(storage?.s3?.prefix ?? 'nodepilot/')
  const [accessKey, setAccessKey] = useState(storage?.s3?.access_key_id ?? '')
  const [secretKey, setSecretKey] = useState('')
  const [pathStyle, setPathStyle] = useState(storage?.s3?.path_style ?? false)
  /** Field → translation key of the validation message. */
  const [errors, setErrors] = useState<Record<string, string>>({})

  const hadS3 = storage?.kind === 's3'

  const validate = () => {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = 'storages.errors.name'
    if (kind === 'local' && !path.trim().startsWith('/')) e.path = 'storages.errors.path'
    if (kind === 's3') {
      if (!bucket.trim()) e.bucket = 'storages.errors.bucket'
      if (!region.trim()) e.region = 'storages.errors.region'
      if (!accessKey.trim()) e.accessKey = 'storages.errors.accessKey'
      if (!hadS3 && !secretKey) e.secretKey = 'storages.errors.secretKey'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }
  const err = (field: string) => (errors[field] ? t(errors[field]) : undefined)

  const m = useMutation({
    mutationFn: () => {
      const s3 = {
        endpoint: endpoint.trim() || undefined,
        region: region.trim(),
        bucket: bucket.trim(),
        prefix: prefix.trim(),
        access_key_id: accessKey.trim(),
        path_style: pathStyle,
      }
      if (storage) {
        const patch: StoragePatch = { name: name.trim(), kind }
        if (kind === 'local') patch.local = { path: path.trim() }
        else patch.s3 = secretKey ? { ...s3, secret_access_key: secretKey } : s3
        return api.backups.updateStorage(storage.id, patch)
      }
      const body: StorageInput =
        kind === 'local'
          ? { name: name.trim(), kind, local: { path: path.trim() } }
          : { name: name.trim(), kind, s3: { ...s3, secret_access_key: secretKey } }
      return api.backups.createStorage(body)
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.storages })
      toast.success(storage ? t('storages.toast.saved') : t('storages.toast.created'), s.name)
      onClose()
    },
  })

  return (
    <div className="stack">
      <Field label={t('common:fields.name')} error={err('name')}>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('common:fields.type')}>
        <div>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'local', label: t('storages.form.kindLocal') },
              { value: 's3', label: t('storages.form.kindS3') },
            ]}
          />
        </div>
      </Field>
      {kind === 'local' ? (
        <Field label={t('storages.form.path')} error={err('path')}>
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
      ) : (
        <div className="form-grid">
          <Field label={t('storages.form.endpoint')} hint={t('storages.form.endpointHint')} className="span-2">
            <input
              className="input mono"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://s3.example.com"
            />
          </Field>
          <Field label={t('storages.form.region')} error={err('region')}>
            <input className="input mono" value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label={t('storages.form.bucket')} error={err('bucket')}>
            <input className="input mono" value={bucket} onChange={(e) => setBucket(e.target.value)} />
          </Field>
          <Field label={t('storages.form.prefix')} className="span-2">
            <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </Field>
          <Field label={t('storages.form.accessKey')} error={err('accessKey')}>
            <input className="input mono" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label={t('storages.form.secretKey')}
            error={err('secretKey')}
            hint={hadS3 ? t('storages.form.keepEmpty') : t('storages.form.secretHidden')}
          >
            <input
              className="input mono"
              type="password"
              autoComplete="new-password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={hadS3 ? '••••••••' : ''}
            />
          </Field>
          <label className="checkbox span-2">
            <input type="checkbox" checked={pathStyle} onChange={(e) => setPathStyle(e.target.checked)} />
            {t('storages.form.pathStyle')}
          </label>
        </div>
      )}
      <InlineError error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={m.isPending}>
          {t('common:actions.cancel')}
        </button>
        <button className="btn btn-primary" disabled={m.isPending} onClick={() => validate() && m.mutate()}>
          {m.isPending && <Spinner />} {storage ? t('common:actions.save') : t('common:actions.create')}
        </button>
      </div>
    </div>
  )
}
