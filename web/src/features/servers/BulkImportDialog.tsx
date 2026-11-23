import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp, Upload } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { invalidateServers, useIdentities, useProjects } from '../../api/queries'
import type { Auth, ServerInput } from '../../api/types'
import { CheckList } from '../../components/CheckList'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Alert, InlineError, Spinner } from '../../components/States'
import { TagInput } from '../../components/TagInput'
import { useToast } from '../../components/Toast'

type Draft = {
  name: string
  host: string
  port: number
  username: string
  auth?: Auth
  tags?: string[]
  description?: string
  project_ids?: string[]
}
type ParseResult = { rows: Draft[]; errors: string[]; format: 'json' | 'csv' | 'empty' }

const EXAMPLE_ROWS = `web-01,10.0.0.11,22,root,prod;web
web-02,10.0.0.12,22,root,prod;web
db-01,10.0.0.21,2222,admin,prod;db`

function parseInput(text: string, defaultUser: string, t: TFunction<'servers'>): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { rows: [], errors: [], format: 'empty' }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      const rows: Draft[] = []
      const errors: string[] = []
      arr.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') {
          errors.push(t('import.errors.notObject', { n: i + 1 }))
          return
        }
        const o = raw as Record<string, unknown>
        const name = typeof o.name === 'string' ? o.name.trim() : ''
        const host = typeof o.host === 'string' ? o.host.trim() : ''
        const port = o.port === undefined || o.port === null ? 22 : Number(o.port)
        const username = typeof o.username === 'string' && o.username.trim() ? o.username.trim() : defaultUser
        if (!host) {
          errors.push(t('import.errors.noHostJson', { n: i + 1 }))
          return
        }
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(t('import.errors.badPortJson', { n: i + 1 }))
          return
        }
        rows.push({
          name: name || host,
          host,
          port,
          username,
          auth: o.auth && typeof o.auth === 'object' ? (o.auth as Auth) : undefined,
          tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : undefined,
          description: typeof o.description === 'string' ? o.description : undefined,
          project_ids: Array.isArray(o.project_ids) ? o.project_ids.filter((t): t is string => typeof t === 'string') : undefined,
        })
      })
      return { rows, errors, format: 'json' }
    } catch (e) {
      return { rows: [], errors: [t('import.errors.json', { message: (e as Error).message })], format: 'json' }
    }
  }

  const rows: Draft[] = []
  const errors: string[] = []
  const lines = trimmed.split(/\r?\n/)
  lines.forEach((line, idx) => {
    const l = line.trim()
    if (!l || l.startsWith('#')) return
    const cells = l.split(l.includes('\t') ? '\t' : ',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
    if (idx === 0 && /^name$/i.test(cells[0]) && /^host$/i.test(cells[1] ?? '')) return // header
    const [name, host, portStr, user, tagStr] = cells
    if (!host) {
      errors.push(t('import.errors.noHostLine', { n: idx + 1 }))
      return
    }
    const port = portStr ? Number(portStr) : 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(t('import.errors.badPortLine', { n: idx + 1, port: portStr }))
      return
    }
    rows.push({
      name: name || host,
      host,
      port,
      username: user || defaultUser,
      tags: tagStr
        ? tagStr
            .split(/[;|]/)
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    })
  })
  return { rows, errors, format: 'csv' }
}

export function BulkImportDialog({
  open,
  onClose,
  defaultProjectIds,
}: {
  open: boolean
  onClose: () => void
  defaultProjectIds?: string[]
}) {
  const { t } = useTranslation('servers')
  return (
    <Modal open={open} onClose={onClose} title={t('import.title')} size="xl">
      {open && <BulkImportForm onClose={onClose} defaultProjectIds={defaultProjectIds} />}
    </Modal>
  )
}

function BulkImportForm({ onClose, defaultProjectIds }: { onClose: () => void; defaultProjectIds?: string[] }) {
  const { t } = useTranslation('servers')
  const qc = useQueryClient()
  const toast = useToast()
  const identities = useIdentities()
  const projects = useProjects()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [identityId, setIdentityId] = useState('')
  const [defaultUser, setDefaultUser] = useState('root')
  const [extraTags, setExtraTags] = useState<string[]>([])
  const [projectIds, setProjectIds] = useState<string[]>(defaultProjectIds ?? [])

  const parsed = useMemo(() => parseInput(text, defaultUser.trim() || 'root', t), [text, defaultUser, t])
  const exampleCsv = `${t('import.exampleHeader')}\n${EXAMPLE_ROWS}`
  const needIdentity = parsed.rows.some((r) => !r.auth)

  const payload = (): ServerInput[] =>
    parsed.rows.map((r) => ({
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      auth: r.auth ?? { type: 'identity', identity_id: identityId },
      tags: Array.from(new Set([...(r.tags ?? []), ...extraTags])),
      project_ids: Array.from(new Set([...(r.project_ids ?? []), ...projectIds])),
      description: r.description ?? '',
    }))

  const m = useMutation({
    mutationFn: () => api.servers.bulkCreate(payload()),
    onSuccess: (created) => {
      invalidateServers(qc)
      toast.success(t('import.successTitle'), t('import.successDetail', { count: created.length }))
      onClose()
    },
  })

  const canSubmit = parsed.rows.length > 0 && (!needIdentity || !!identityId) && !m.isPending

  return (
    <div className="stack">
      <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
        <div className="stack-sm">
          <div className="row">
            <span className="field-label grow">{t('import.formatHelp')}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setText(exampleCsv)}>
              {t('import.example')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <FileUp size={14} /> {t('import.file')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.json,.txt,text/csv,application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (f) setText(await f.text())
                e.target.value = ''
              }}
            />
          </div>
          <textarea
            className="textarea mono"
            rows={14}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={exampleCsv}
            spellCheck={false}
          />
        </div>
        <div className="stack">
          <Field label={t('import.identity')} hint={parsed.format === 'json' ? t('import.identityHintJson') : t('import.identityHintCsv')}>
            <select className="select" value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
              <option value="">{t('select')}</option>
              {identities.data?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.kind === 'key' ? t('identityKind.key') : t('identityKind.password')})
                </option>
              ))}
            </select>
            {identities.data?.length === 0 && (
              <span className="field-hint">
                <Trans t={t} i18nKey="import.keychainEmpty" components={{ link: <Link to="/identities" onClick={onClose} /> }} />
              </span>
            )}
          </Field>
          <Field label={t('import.defaultUser')} hint={t('import.defaultUserHint')}>
            <input className="input" value={defaultUser} onChange={(e) => setDefaultUser(e.target.value)} />
          </Field>
          <Field label={t('import.extraTags')}>
            <TagInput value={extraTags} onChange={setExtraTags} />
          </Field>
          <Field label={t('import.addToProjects')}>
            <CheckList
              maxHeight={110}
              empty={t('import.noProjects')}
              value={projectIds}
              onChange={setProjectIds}
              items={(projects.data ?? []).map((p) => ({ id: p.id, label: p.name }))}
            />
          </Field>
        </div>
      </div>

      {parsed.errors.length > 0 && (
        <Alert kind="warn">
          <b>{t('import.skipped', { n: parsed.errors.length })}</b>
          <div className="mono small" style={{ marginTop: 4, maxHeight: 90, overflow: 'auto' }}>
            {parsed.errors.slice(0, 50).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        </Alert>
      )}

      {parsed.rows.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 220 }}>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('import.col.name')}</th>
                <th>{t('import.col.address')}</th>
                <th>{t('import.col.user')}</th>
                <th>{t('import.col.tags')}</th>
                <th>Auth</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  <td className="dim">{i + 1}</td>
                  <td>{r.name}</td>
                  <td className="mono">
                    {r.host}:{r.port}
                  </td>
                  <td>{r.username}</td>
                  <td>{[...(r.tags ?? []), ...extraTags].join(', ')}</td>
                  <td className="dim">{r.auth ? r.auth.type : t('import.authKeychain')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {parsed.rows.length > 200 && (
            <div className="dim small" style={{ padding: 8 }}>
              {t('import.more', { n: parsed.rows.length - 200 })}
            </div>
          )}
        </div>
      )}

      <InlineError error={m.error} />

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <span className="muted small grow">
          {parsed.rows.length > 0 ? t('import.ready', { count: parsed.rows.length }) : t('import.pasteData')}
          {needIdentity && !identityId && parsed.rows.length > 0 && <span className="warn-text"> {t('import.needIdentity')}</span>}
        </span>
        <button className="btn" onClick={onClose} disabled={m.isPending}>
          {t('common:actions.cancel')}
        </button>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={() => m.mutate()}>
          {m.isPending ? <Spinner /> : <Upload size={14} />} {t('import.submit')}
        </button>
      </div>
    </div>
  )
}
