import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp, KeyRound, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import { qk, useIdentities } from '../api/queries'
import type { Identity, IdentityInput, IdentityKind } from '../api/types'
import { useConfirm } from '../components/Confirm'
import { Field } from '../components/Field'
import { Modal } from '../components/Modal'
import { Alert, Empty, ErrorState, InlineError, Loading, Spinner } from '../components/States'
import { Segmented } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { formatDateTime } from '../lib/format'

export function IdentitiesPage() {
  const { t } = useTranslation('identities')
  const identities = useIdentities()
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Identity | null | 'new'>(null)

  const remove = async (i: Identity) => {
    if (i.server_count > 0) {
      toast.error(t('toast.inUse'), t('toast.inUseMessage', { count: i.server_count }))
      return
    }
    const ok = await confirm({
      title: t('confirm.deleteTitle'),
      message: t('confirm.deleteMessage', { name: i.name }),
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.identities.remove(i.id)
      toast.success(t('toast.deleted'), i.name)
      void qc.invalidateQueries({ queryKey: qk.identities })
    } catch (e) {
      toast.error(t('toast.deleteFailed'), e)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1>{t('title')}</h1>
          <span className="muted small">{t('subtitle')}</span>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} /> {t('add')}
          </button>
        </div>
      </div>
      <Alert kind="info" icon={<Lock size={15} />}>
        {t('secretsInfo')}
      </Alert>
      {identities.isPending ? (
        <Loading />
      ) : identities.isError ? (
        <ErrorState error={identities.error} onRetry={() => void identities.refetch()} />
      ) : identities.data.length === 0 ? (
        <div className="card">
          <Empty icon={<KeyRound size={28} />} title={t('empty.title')}>
            <span className="muted">{t('empty.text')}</span>
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('add')}
            </button>
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('table.name')}</th>
                <th>{t('table.type')}</th>
                <th>{t('table.servers')}</th>
                <th>{t('table.created')}</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {identities.data.map((i) => (
                <tr key={i.id}>
                  <td style={{ fontWeight: 500 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <KeyRound size={13} className="dim" />
                      {i.name}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{t(`kind.${i.kind}`)}</span>
                  </td>
                  <td className="num">{i.server_count}</td>
                  <td className="small dim">{formatDateTime(i.created_at)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.editItem')} onClick={() => setEditing(i)}>
                        <Pencil size={13} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.delete')} onClick={() => void remove(i)}>
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
        title={editing && editing !== 'new' ? t('dialog.editTitle', { name: editing.name }) : t('dialog.newTitle')}
      >
        {editing !== null && <IdentityForm identity={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      </Modal>
    </div>
  )
}

function IdentityForm({ identity, onClose }: { identity: Identity | null; onClose: () => void }) {
  const { t } = useTranslation('identities')
  const qc = useQueryClient()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(identity?.name ?? '')
  const [kind, setKind] = useState<IdentityKind>(identity?.kind ?? 'key')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const kindChanged = !!identity && identity.kind !== kind
  const secretRequired = !identity || kindChanged

  const validate = () => {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = t('validation.nameRequired')
    if (secretRequired && kind === 'password' && !password) e.secret = t('validation.passwordRequired')
    if (secretRequired && kind === 'key' && !privateKey.trim()) e.secret = t('validation.keyRequired')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const m = useMutation({
    mutationFn: () => {
      const body: Partial<IdentityInput> = { name: name.trim(), kind }
      if (kind === 'password' && password) body.password = password
      if (kind === 'key') {
        if (privateKey.trim()) body.private_key = privateKey
        if (passphrase) body.passphrase = passphrase
      }
      return identity ? api.identities.update(identity.id, body) : api.identities.create(body as IdentityInput)
    },
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: qk.identities })
      toast.success(identity ? t('toast.saved') : t('toast.added'), i.name)
      onClose()
    },
  })

  return (
    <div className="stack">
      <Field label={t('form.name')} error={errors.name}>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy@prod" />
      </Field>
      <Field label={t('form.type')}>
        <div>
          <Segmented<IdentityKind>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'key', label: t('kind.key') },
              { value: 'password', label: t('kind.password') },
            ]}
          />
        </div>
      </Field>
      {kind === 'password' ? (
        <Field label={t('form.password')} error={errors.secret} hint={!secretRequired ? t('form.keepEmpty') : undefined}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={!secretRequired ? '••••••••' : ''}
          />
        </Field>
      ) : (
        <>
          <Field label={t('form.privateKey')} error={errors.secret} hint={!secretRequired ? t('form.keepEmpty') : t('form.keyFormats')}>
            <textarea
              className="textarea mono"
              rows={7}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
          </Field>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <FileUp size={14} /> {t('form.loadFromFile')}
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f && f.size < 64 * 1024) setPrivateKey(await f.text())
                else if (f) toast.error(t('toast.fileTooLarge'))
                e.target.value = ''
              }}
            />
          </div>
          <Field label={t('form.passphrase')} hint={t('form.passphraseHint')}>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
        </>
      )}
      <InlineError error={m.error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={m.isPending}>
          {t('common:actions.cancel')}
        </button>
        <button className="btn btn-primary" disabled={m.isPending} onClick={() => validate() && m.mutate()}>
          {m.isPending && <Spinner />} {identity ? t('common:actions.save') : t('common:actions.add')}
        </button>
      </div>
    </div>
  )
}
