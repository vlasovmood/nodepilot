import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { API_BASE, api } from '../../api/client'
import { qk } from '../../api/queries'
import type { ApiToken, CreateTokenResponse, PermissionArea, Permissions, TokenInput } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { CopyButton } from '../../components/CopyButton'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Alert, Empty, ErrorState, InlineError, Loading, Spinner } from '../../components/States'
import { Segmented } from '../../components/Tabs'
import { useToast } from '../../components/Toast'
import { intlLocale } from '../../i18n'
import { formatDateTime, formatRelative } from '../../lib/format'
import { cx } from '../../lib/util'
import {
  AREAS,
  areaDanger,
  areaDescription,
  areaLabel,
  dangerousGrants,
  FULL_ACCESS,
  permissionsSummary,
  presetOf,
  readOnlyPermissions,
  type AreaInfo,
  type Preset,
} from './permissions'
import { Snippet } from './Snippet'

export function TokensTab() {
  const { t } = useTranslation('developer')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const tokens = useQuery({ queryKey: qk.tokens, queryFn: () => api.tokens.list() })
  const [dialog, setDialog] = useState<{ token: ApiToken | null } | null>(null)
  const [created, setCreated] = useState<CreateTokenResponse | null>(null)

  const remove = async (tok: ApiToken) => {
    const ok = await confirm({
      title: t('tokens.confirm.deleteTitle'),
      message: <Trans t={t} i18nKey="tokens.confirm.deleteMessage" values={{ name: tok.name }} components={{ b: <b /> }} />,
      confirmText: t('common:actions.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.tokens.remove(tok.id)
      toast.success(t('tokens.toast.deleted'), tok.name)
      void qc.invalidateQueries({ queryKey: qk.tokens })
    } catch (e) {
      toast.error(t('tokens.toast.deleteFailed'), e)
    }
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-body dev-intro">
          <div className="grow stack-sm">
            <div>
              <Trans
                t={t}
                i18nKey="tokens.intro"
                values={{ header: `Authorization: Bearer <${t('tokens.tokenPlaceholder')}>` }}
                components={{ code: <code /> }}
              />
            </div>
            <div className="muted small">{t('tokens.introHint')}</div>
          </div>
          <button className="btn btn-primary" onClick={() => setDialog({ token: null })}>
            <Plus size={14} /> {t('tokens.create')}
          </button>
        </div>
      </div>

      {tokens.isPending ? (
        <Loading />
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.length === 0 ? (
        <div className="card">
          <Empty icon={<KeyRound size={28} />} title={t('tokens.emptyTitle')}>
            <div className="muted">{t('tokens.emptyText')}</div>
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table tokens-table">
            <thead>
              <tr>
                <th>{t('tokens.table.name')}</th>
                <th>{t('tokens.table.access')}</th>
                <th>{t('tokens.table.created')}</th>
                <th>{t('tokens.table.lastUsed')}</th>
                <th>{t('tokens.table.expires')}</th>
                <th style={{ width: 1 }} />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((tok) => (
                <tr key={tok.id}>
                  <td style={{ fontWeight: 600 }}>{tok.name}</td>
                  <td className="wrap">
                    <AccessSummary permissions={tok.permissions} />
                  </td>
                  <td className="small dim nowrap">{formatDateTime(tok.created_at)}</td>
                  <td className="small nowrap" title={tok.last_used_at ? formatDateTime(tok.last_used_at, true) : undefined}>
                    {tok.last_used_at ? formatRelative(tok.last_used_at) : <span className="dim">{t('tokens.never')}</span>}
                  </td>
                  <td className="small nowrap">
                    <Expiry at={tok.expires_at} />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ token: tok })}>
                        <Pencil size={13} /> {t('common:actions.edit')}
                      </button>
                      <button className="btn btn-ghost btn-sm btn-danger-ghost" onClick={() => void remove(tok)}>
                        <Trash2 size={13} /> {t('common:actions.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <TokenDialog
          token={dialog.token}
          onClose={() => setDialog(null)}
          onCreated={(r) => {
            setDialog(null)
            setCreated(r)
          }}
        />
      )}
      <CreatedTokenModal created={created} onClose={() => setCreated(null)} />
    </div>
  )
}

function AccessSummary({ permissions }: { permissions: Permissions }) {
  useTranslation('developer') // re-render on language change: the summary text is translated in permissionsSummary()
  const s = permissionsSummary(permissions)
  if (s.kind === 'full') return <span className="badge badge-accent">{s.text}</span>
  if (s.kind === 'readonly') return <span className="badge">{s.text}</span>
  if (s.kind === 'none') return <span className="badge badge-danger">{s.text}</span>
  return <span className="small muted">{s.text}</span>
}

const isPast = (iso: string) => new Date(iso).getTime() <= Date.now()
/** "in 3 days", "in 11 months" — also for long horizons, where formatRelative switches to a date. */
function formatUntil(iso: string): string {
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 1) return formatRelative(iso)
  if (days < 60) return rtf.format(Math.round(days), 'day')
  return rtf.format(Math.round(days / 30), 'month')
}

function Expiry({ at }: { at: string | null }) {
  const { t } = useTranslation('developer')
  if (!at) return <span className="dim">{t('tokens.noExpiry')}</span>
  const past = isPast(at)
  if (past)
    return (
      <span className="badge badge-danger" title={formatDateTime(at)}>
        {t('tokens.expired')}
      </span>
    )
  return <span title={formatDateTime(at)}>{formatUntil(at)}</span>
}

// ---------- create / edit ----------

type ExpiryChoice = 'keep' | '0' | '7' | '30' | '90' | '365'

const EXPIRY_OPTIONS: Exclude<ExpiryChoice, 'keep'>[] = ['0', '7', '30', '90', '365']

type LevelChoice = 'none' | 'read' | 'write'

function TokenDialog({
  token,
  onClose,
  onCreated,
}: {
  token: ApiToken | null
  onClose: () => void
  onCreated: (r: CreateTokenResponse) => void
}) {
  const { t } = useTranslation('developer')
  const qc = useQueryClient()
  const toast = useToast()
  const editing = !!token
  const [name, setName] = useState(token?.name ?? '')
  const [preset, setPreset] = useState<Preset>(token ? presetOf(token.permissions) : 'full')
  const [areas, setAreas] = useState<Permissions['areas']>(() =>
    token && presetOf(token.permissions) === 'custom' ? { ...token.permissions.areas } : {},
  )
  const [expiry, setExpiry] = useState<ExpiryChoice>(editing ? 'keep' : '0')

  const permissions: Permissions =
    preset === 'full' ? FULL_ACCESS : preset === 'readonly' ? readOnlyPermissions() : { full: false, areas: cleanAreas(areas) }
  const warnings = dangerousGrants(permissions)
  const empty = !permissions.full && Object.keys(permissions.areas).length === 0

  const changePreset = (p: Preset) => {
    // Switching to custom pre-fills the matrix from the preset that was selected.
    if (p === 'custom' && preset !== 'custom') {
      if (preset === 'readonly') setAreas(readOnlyPermissions().areas)
      else {
        const all: Permissions['areas'] = {}
        for (const a of AREAS) all[a.key] = 'write'
        setAreas(all)
      }
    }
    setPreset(p)
  }

  const setLevel = (area: PermissionArea, level: LevelChoice) =>
    setAreas((cur) => {
      const next = { ...cur }
      if (level === 'none') delete next[area]
      else next[area] = level
      return next
    })

  const setAll = (level: LevelChoice) => {
    const next: Permissions['areas'] = {}
    if (level !== 'none') for (const a of AREAS) if (!a.writeOnly || level === 'write') next[a.key] = level
    setAreas(next)
  }

  const m = useMutation({
    mutationFn: async () => {
      const input: TokenInput = { name: name.trim(), permissions }
      if (expiry !== 'keep') input.expires_in_days = Number(expiry)
      if (token) return { updated: await api.tokens.update(token.id, input) }
      return { created: await api.tokens.create(input) }
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.tokens })
      if (r.created) onCreated(r.created)
      else {
        toast.success(t('tokens.toast.updated'), r.updated?.name)
        onClose()
      }
    },
  })

  const canSave = !!name.trim() && !m.isPending

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={editing ? t('tokens.dialog.editTitle', { name: token.name }) : t('tokens.dialog.newTitle')}
      locked={m.isPending}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={m.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!canSave} onClick={() => m.mutate()}>
            {m.isPending && <Spinner />} {editing ? t('common:actions.save') : t('common:actions.create')}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) m.mutate()
        }}
      >
        <div className="form-grid">
          <Field label={t('common:fields.name')} hint={t('tokens.dialog.nameHint')}>
            <input className="input" autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('tokens.dialog.expiry')} hint={editing && expiry !== 'keep' ? t('tokens.dialog.expiryHint') : undefined}>
            <select className="select" value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}>
              {editing && <option value="keep">{t('tokens.dialog.keepExpiry')}</option>}
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === '0' ? t('tokens.expiry.never') : t('tokens.expiry.days', { count: Number(o) })}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label={t('tokens.dialog.access')}>
          <div>
            <Segmented<Preset>
              value={preset}
              onChange={changePreset}
              options={[
                { value: 'full', label: t('perm.full') },
                { value: 'readonly', label: t('perm.readonly') },
                { value: 'custom', label: t('tokens.dialog.presetCustom') },
              ]}
            />
          </div>
        </Field>

        {preset === 'full' && <div className="muted small">{t('tokens.dialog.fullHint')}</div>}
        {preset === 'readonly' && <div className="muted small">{t('tokens.dialog.readonlyHint')}</div>}
        {preset === 'custom' && (
          <div className="perm-matrix">
            <div className="perm-matrix-head">
              <span className="grow muted small">{t('tokens.dialog.area')}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll('read')}>
                {t('tokens.dialog.allRead')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll('write')}>
                {t('tokens.dialog.allWrite')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll('none')}>
                {t('tokens.dialog.reset')}
              </button>
            </div>
            {AREAS.map((a) => (
              <MatrixRow
                key={a.key}
                area={a}
                value={(areas[a.key] as LevelChoice | undefined) ?? 'none'}
                onChange={(l) => setLevel(a.key, l)}
              />
            ))}
          </div>
        )}

        {empty && <Alert kind="info">{t('tokens.dialog.emptyInfo')}</Alert>}
        {warnings.length > 0 && (
          <Alert kind="warn" icon={<ShieldAlert size={15} />}>
            <div className="stack-sm">
              {warnings.map((a) => (
                <div key={a.key}>
                  <Trans
                    t={t}
                    i18nKey="tokens.dialog.dangerWarning"
                    values={{ area: areaLabel(a), risk: areaDanger(a) }}
                    components={{ b: <b /> }}
                  />
                </div>
              ))}
            </div>
          </Alert>
        )}
        <InlineError error={m.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function MatrixRow({ area, value, onChange }: { area: AreaInfo; value: LevelChoice; onChange: (l: LevelChoice) => void }) {
  const { t } = useTranslation('developer')
  return (
    <div className={cx('perm-row', value !== 'none' && 'on')}>
      <div className="grow">
        <div className="perm-row-label">{areaLabel(area)}</div>
        <div className="dim small">{areaDescription(area)}</div>
      </div>
      <Segmented<LevelChoice>
        value={area.writeOnly && value === 'read' ? 'write' : value}
        onChange={onChange}
        options={
          area.writeOnly
            ? [
                { value: 'none', label: t('tokens.dialog.levelNone') },
                { value: 'write', label: t('tokens.dialog.levelAllowed') },
              ]
            : [
                { value: 'none', label: t('tokens.dialog.levelNone') },
                { value: 'read', label: t('tokens.dialog.levelRead') },
                { value: 'write', label: t('tokens.dialog.levelWrite') },
              ]
        }
      />
    </div>
  )
}

/** Drop empty entries; `exec` is only ever `write`. */
function cleanAreas(areas: Permissions['areas']): Permissions['areas'] {
  const out: Permissions['areas'] = {}
  for (const a of AREAS) {
    const l = areas[a.key]
    if (l) out[a.key] = a.writeOnly ? 'write' : l
  }
  return out
}

// ---------- shown once ----------

function CreatedTokenModal({ created, onClose }: { created: CreateTokenResponse | null; onClose: () => void }) {
  const { t } = useTranslation('developer')
  const base = `${window.location.origin}${API_BASE}`
  return (
    <Modal
      open={!!created}
      onClose={onClose}
      size="lg"
      title={t('tokens.created.title')}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('tokens.created.done')}
        </button>
      }
    >
      {created && (
        <div className="stack">
          <Alert kind="warn">{t('tokens.created.warning')}</Alert>
          <div className="token-reveal" data-testid="token-value">
            <span className="grow">{created.token}</span>
            <CopyButton text={created.token} label={t('common:actions.copy')} />
          </div>
          <div className="row-wrap small muted">
            <span>
              <b>{created.info.name}</b>
            </span>
            <span>·</span>
            <AccessSummary permissions={created.info.permissions} />
            <span>·</span>
            <span>
              {created.info.expires_at
                ? t('tokens.created.validUntil', { date: formatDateTime(created.info.expires_at) })
                : t('tokens.created.noExpiry')}
            </span>
          </div>
          <Snippet title={t('tokens.created.curlTitle')} code={`curl -H "Authorization: Bearer ${created.token}" ${base}/servers`} />
          <Snippet
            title={t('tokens.created.claudeTitle')}
            code={`claude mcp add --transport http nodepilot ${base}/mcp --header "Authorization: Bearer ${created.token}"`}
          />
        </div>
      )}
    </Modal>
  )
}
