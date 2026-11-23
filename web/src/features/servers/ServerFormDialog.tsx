import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileUp, PlugZap, XCircle } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { invalidateServers, qk, useIdentities, useProjects, useServers } from '../../api/queries'
import type { Auth, Server, ServerInput, TestConnectionResult } from '../../api/types'
import { CheckList } from '../../components/CheckList'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Alert, InlineError, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { TagInput } from '../../components/TagInput'
import { useToast } from '../../components/Toast'
import { formatDuration } from '../../lib/format'
import { uniq } from '../../lib/util'

type AuthMode = 'keep' | 'password' | 'key' | 'identity'

type Props = {
  open: boolean
  onClose: () => void
  server?: Server | null
  /** Pre-selected projects for a new server (e.g. when adding from a project page). */
  defaultProjectIds?: string[]
}

export function ServerFormDialog({ open, onClose, server, defaultProjectIds }: Props) {
  const { t } = useTranslation('servers')
  return (
    <Modal open={open} onClose={onClose} title={server ? t('form.editTitle', { name: server.name }) : t('form.newTitle')} size="lg">
      {open && <ServerForm key={server?.id ?? 'new'} initial={server ?? null} defaultProjectIds={defaultProjectIds} onClose={onClose} />}
    </Modal>
  )
}

export function TestResultView({ result }: { result: TestConnectionResult }) {
  const { t } = useTranslation('servers')
  return result.ok ? (
    <Alert kind="info" icon={<CheckCircle2 size={15} className="ok-text" />}>
      <Trans t={t} i18nKey="test.ok" values={{ latency: formatDuration(result.latency_ms) }} components={{ b: <b /> }} />
    </Alert>
  ) : (
    <Alert kind="danger" icon={<XCircle size={15} />}>
      <b>{t('test.fail')}</b>
      {result.error && (
        <div className="pre-wrap mono small" style={{ marginTop: 4 }}>
          {result.error}
        </div>
      )}
    </Alert>
  )
}

function ServerForm({
  initial,
  defaultProjectIds,
  onClose,
}: {
  initial: Server | null
  defaultProjectIds?: string[]
  onClose: () => void
}) {
  const { t } = useTranslation('servers')
  const qc = useQueryClient()
  const toast = useToast()
  const identities = useIdentities()
  const projects = useProjects()
  const servers = useServers()
  const fileRef = useRef<HTMLInputElement>(null)

  const [saved, setSaved] = useState<Server | null>(initial)
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? 'root')
  const [authMode, setAuthMode] = useState<AuthMode>(initial ? 'keep' : 'password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [identityId, setIdentityId] = useState(initial?.identity_id ?? '')
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [projectIds, setProjectIds] = useState<string[]>(initial?.project_ids ?? defaultProjectIds ?? [])
  const [description, setDescription] = useState(initial?.description ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  const allTags = useMemo(() => uniq((servers.data ?? []).flatMap((s) => s.tags)).sort(), [servers.data])

  const buildAuth = (): Auth | undefined => {
    switch (authMode) {
      case 'keep':
        return undefined
      case 'password':
        return { type: 'password', password }
      case 'key':
        return { type: 'key', private_key: privateKey, ...(passphrase ? { passphrase } : {}) }
      case 'identity':
        return { type: 'identity', identity_id: identityId }
    }
  }

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!name.trim()) e.name = t('form.errors.name')
    if (!host.trim()) e.host = t('form.errors.host')
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = '1–65535'
    if (!username.trim()) e.username = t('form.errors.username')
    if (authMode === 'password' && !password) e.auth = t('form.errors.password')
    if (authMode === 'key' && !privateKey.trim()) e.auth = t('form.errors.key')
    if (authMode === 'identity' && !identityId) e.auth = t('form.errors.identity')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = useMutation({
    mutationFn: async (): Promise<Server> => {
      const auth = buildAuth()
      const common = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        tags,
        project_ids: projectIds,
        description: description.trim(),
      }
      if (saved) {
        return api.servers.update(saved.id, auth ? { ...common, auth } : common)
      }
      if (!auth) throw new Error(t('form.errors.noAuth'))
      const body: ServerInput = { ...common, auth }
      return api.servers.create(body)
    },
    onSuccess: (s) => {
      invalidateServers(qc)
      qc.setQueryData(qk.server(s.id), s)
      setSaved(s)
      setAuthMode('keep')
      setPassword('')
      setPrivateKey('')
      setPassphrase('')
    },
  })

  const test = useMutation({
    mutationFn: (id: string) => api.servers.test(id),
    onSuccess: (r, id) => {
      setTestResult(r)
      void qc.invalidateQueries({ queryKey: qk.server(id) })
      void qc.invalidateQueries({ queryKey: qk.servers })
    },
  })

  const onSave = async (andTest: boolean) => {
    if (!validate()) return
    setTestResult(null)
    try {
      const s = await save.mutateAsync()
      toast.success(initial || saved ? t('form.toast.saved') : t('form.toast.added'), s.name)
      if (andTest) test.mutate(s.id)
      else onClose()
    } catch {
      /* error shown inline */
    }
  }

  const readKeyFile = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 64 * 1024) {
      toast.error(t('form.toast.keyTooLarge'))
      return
    }
    setPrivateKey(await f.text())
  }

  const busy = save.isPending || test.isPending

  return (
    <div className="stack">
      <div className="form-grid-3">
        <Field label={t('form.name')} error={errors.name}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="web-01" />
        </Field>
        <Field label={t('form.username')} error={errors.username}>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <div />
        <Field label={t('form.host')} error={errors.host}>
          <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5" />
        </Field>
        <Field label={t('form.port')} error={errors.port}>
          <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>

      <Field label={t('form.auth')} error={errors.auth}>
        <div className="stack-sm">
          <div>
            <Segmented<AuthMode>
              value={authMode}
              onChange={setAuthMode}
              options={[
                ...(saved ? [{ value: 'keep' as const, label: t('form.authMode.keep') }] : []),
                { value: 'password', label: t('form.authMode.password') },
                { value: 'key', label: t('form.authMode.key') },
                { value: 'identity', label: t('form.authMode.identity') },
              ]}
            />
          </div>
          {authMode === 'keep' && saved && (
            <div className="field-hint">
              {t('form.currentAuth', {
                method:
                  saved.auth_type === 'password'
                    ? t('form.currentMethod.password')
                    : saved.auth_type === 'key'
                      ? t('form.currentMethod.key')
                      : t('form.currentMethod.identity', { name: identities.data?.find((i) => i.id === saved.identity_id)?.name ?? '…' }),
              })}
            </div>
          )}
          {authMode === 'password' && (
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={t('form.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {authMode === 'key' && (
            <>
              <textarea
                className="textarea mono"
                rows={6}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                spellCheck={false}
              />
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
                  <FileUp size={14} /> {t('form.uploadKey')}
                </button>
                <input ref={fileRef} type="file" hidden onChange={(e) => void readKeyFile(e.target.files?.[0])} />
                <input
                  className="input input-sm"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('form.passphrasePlaceholder')}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  style={{ maxWidth: 260 }}
                />
              </div>
            </>
          )}
          {authMode === 'identity' &&
            (identities.isPending ? (
              <Spinner />
            ) : identities.data && identities.data.length > 0 ? (
              <select className="select" value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
                <option value="">{t('select')}</option>
                {identities.data.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.kind === 'key' ? t('identityKind.key') : t('identityKind.password')})
                  </option>
                ))}
              </select>
            ) : (
              <div className="field-hint">
                <Trans t={t} i18nKey="form.keychainEmpty" components={{ link: <Link to="/identities" onClick={onClose} /> }} />
              </div>
            ))}
        </div>
      </Field>

      <div className="form-grid">
        <Field label={t('common:fields.tags')} hint={t('form.tagsHint')}>
          <TagInput value={tags} onChange={setTags} suggestions={allTags} />
        </Field>
        <Field label={t('form.projects')}>
          <CheckList
            maxHeight={120}
            empty={t('form.noProjects')}
            value={projectIds}
            onChange={setProjectIds}
            items={(projects.data ?? []).map((p) => ({
              id: p.id,
              label: (
                <span className="row" style={{ gap: 6 }}>
                  <span className="project-dot" style={p.color ? { background: p.color } : undefined} />
                  {p.name}
                </span>
              ),
            }))}
          />
        </Field>
        <Field label={t('common:fields.description')} className="span-2">
          <textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      {save.isError && <InlineError error={save.error} />}
      {test.isError && <InlineError error={test.error} />}
      {testResult && <TestResultView result={testResult} />}

      <div className="row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        {saved && (
          <button type="button" className="btn" disabled={busy} onClick={() => test.mutate(saved.id)} title={t('form.testTitle')}>
            {test.isPending ? <Spinner /> : <PlugZap size={14} />} {t('form.test')}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={save.isPending}>
          {saved && !initial ? t('common:actions.close') : t('common:actions.cancel')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void onSave(true)}>
          {t('form.saveAndTest')}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onSave(false)}>
          {save.isPending && <Spinner />} {t('common:actions.save')}
        </button>
      </div>
    </div>
  )
}
