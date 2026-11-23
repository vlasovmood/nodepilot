import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeySquare, Plus, RotateCw, Save, ServerCog, ShieldAlert, Siren, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, errorMessage } from '../../api/client'
import { invalidateSecurity, invalidateServers, qk } from '../../api/queries'
import type { PanelKeyInfo, ServerOpResult } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Field } from '../../components/Field'
import { Alert, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import { Snippet } from '../developer/Snippet'
import { AddressEditor, DetectIp } from './AddressEditor'
import { DeployDialog } from './DeployDialog'
import { OpResultsModal } from './OpResults'
import { isValidAddress } from './util'

type Results = { kind: 'rotate' | 'revoke'; items: ServerOpResult[]; revokeCommand: string }

/** Quote a shell command for `ansible -a '…'`. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The panel's own SSH key, accepted by servers only from the panel's addresses. */
export function PanelKeyCard() {
  const { t } = useTranslation('security')
  const key = useQuery({ queryKey: qk.panelKey, queryFn: () => api.security.panelKey() })
  const [deployOpen, setDeployOpen] = useState(false)
  const [results, setResults] = useState<Results | null>(null)
  const info = key.data

  return (
    <div className="card sec-anchor" id="sec-panel-key">
      <div className="card-header">
        <KeySquare size={14} />
        <h3 className="grow">{t('panelKey.title')}</h3>
        {info &&
          (info.configured ? (
            <span className="badge badge-ok">{t('panelKey.configured')}</span>
          ) : (
            <span className="badge">{t('panelKey.notConfigured')}</span>
          ))}
      </div>
      <div className="card-body stack">
        {key.isPending && (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        )}
        {key.isError && <Alert kind="danger">{errorMessage(key.error)}</Alert>}
        {info && !info.configured && <PanelKeySetup />}
        {info?.configured && <PanelKeyDetails info={info} onDeploy={() => setDeployOpen(true)} onResults={setResults} />}
      </div>
      {deployOpen && info?.configured && <DeployDialog info={info} onClose={() => setDeployOpen(false)} />}
      <OpResultsModal
        title={results?.kind === 'revoke' ? t('panelKey.revoke.resultsTitle') : t('panelKey.rotate.resultsTitle')}
        results={results?.items ?? null}
        onClose={() => setResults(null)}
      >
        {results?.kind === 'rotate' && results.items.some((r) => !r.ok) && <Alert kind="info">{t('panelKey.rotate.resultsHint')}</Alert>}
        {results?.kind === 'revoke' && (
          <>
            <Alert kind="danger" icon={<Siren size={15} />}>
              {results.items.some((r) => !r.ok) ? t('panelKey.revoke.resultsHint') : t('panelKey.revoke.resultsDone')}
            </Alert>
            <RevokeCommands command={results.revokeCommand} />
          </>
        )}
      </OpResultsModal>
    </div>
  )
}

function WhyPanelKey() {
  const { t } = useTranslation('security')
  return (
    <div className="stack-sm">
      <div className="muted">{t('panelKey.intro')}</div>
      <ul className="sec-bullets">
        <li>
          <Trans t={t} i18nKey="panelKey.why.stolen" components={{ b: <b />, code: <code /> }} />
        </li>
        <li>
          <Trans t={t} i18nKey="panelKey.why.rotate" components={{ b: <b /> }} />
        </li>
        <li>
          <Trans t={t} i18nKey="panelKey.why.revoke" components={{ b: <b /> }} />
        </li>
        <li>
          <Trans t={t} i18nKey="panelKey.why.flow" components={{ b: <b /> }} />
        </li>
      </ul>
    </div>
  )
}

function AddressesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation('security')
  const invalid = value.filter((a) => !isValidAddress(a))
  return (
    <Field
      label={t('panelKey.addresses.label')}
      error={invalid.length ? t('panelKey.addresses.invalidList', { list: invalid.join(', ') }) : undefined}
      hint={t('panelKey.addresses.hint')}
    >
      <AddressEditor value={value} onChange={onChange} />
      <DetectIp onDetected={(ip) => !value.includes(ip) && onChange([...value, ip])} />
    </Field>
  )
}

function PanelKeySetup() {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const toast = useToast()
  const [from, setFrom] = useState<string[]>([])
  const m = useMutation({
    mutationFn: () => api.security.createPanelKey({ allowed_from: from }),
    onSuccess: (info) => {
      qc.setQueryData(qk.panelKey, info)
      invalidateSecurity(qc)
      toast.success(t('panelKey.toast.created'))
    },
    onError: (e) => toast.error(t('panelKey.toast.createFailed'), e),
  })
  const valid = from.every(isValidAddress)
  return (
    <>
      <WhyPanelKey />
      <AddressesField value={from} onChange={setFrom} />
      {from.length === 0 && (
        <Alert kind="warn" icon={<ShieldAlert size={15} />}>
          {t('panelKey.addresses.emptyWarning')}
        </Alert>
      )}
      <div className="row">
        <button className="btn btn-primary" disabled={!valid || m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? <Spinner /> : <Plus size={14} />} {t('panelKey.create')}
        </button>
      </div>
    </>
  )
}

function PanelKeyDetails({ info, onDeploy, onResults }: { info: PanelKeyInfo; onDeploy: () => void; onResults: (r: Results) => void }) {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [from, setFrom] = useState<string[]>(info.allowed_from)
  const [savedHint, setSavedHint] = useState(false)
  const dirty = from.join('\n') !== info.allowed_from.join('\n')
  const valid = from.every(isValidAddress)

  const afterOp = () => {
    invalidateSecurity(qc)
    invalidateServers(qc)
  }

  const save = useMutation({
    mutationFn: () => api.security.updatePanelKey({ allowed_from: from }),
    onSuccess: (next) => {
      qc.setQueryData(qk.panelKey, next)
      invalidateSecurity(qc)
      setSavedHint(true)
      toast.success(t('panelKey.toast.addressesSaved'))
    },
    onError: (e) => toast.error(t('panelKey.toast.saveFailed'), e),
  })

  const rotate = useMutation({
    mutationFn: () => api.security.rotatePanelKey(),
    onSuccess: (items) => {
      afterOp()
      onResults({ kind: 'rotate', items, revokeCommand: info.emergency_revoke_command })
    },
    onError: (e) => toast.error(t('panelKey.toast.rotateFailed'), e),
  })

  const revoke = useMutation({
    mutationFn: () => api.security.revokePanelKey(),
    onSuccess: (items) => {
      afterOp()
      onResults({ kind: 'revoke', items, revokeCommand: info.emergency_revoke_command })
    },
    onError: (e) => toast.error(t('panelKey.toast.revokeFailed'), e),
  })

  const askRotate = async () => {
    const ok = await confirm({
      title: t('panelKey.rotate.confirmTitle'),
      message: t('panelKey.rotate.confirmText', { count: info.servers_using }),
      confirmText: t('panelKey.rotate.button'),
    })
    if (ok) rotate.mutate()
  }

  const askRevoke = async () => {
    const ok = await confirm({
      title: t('panelKey.revoke.confirmTitle'),
      message: (
        <div className="stack-sm">
          <span>{t('panelKey.revoke.confirmText', { count: info.servers_using })}</span>
          <span>{t('panelKey.revoke.confirmWhen')}</span>
        </div>
      ),
      confirmText: t('panelKey.revoke.button'),
      danger: true,
      requireText: t('panelKey.revoke.confirmWord'),
    })
    if (ok) revoke.mutate()
  }

  const busy = rotate.isPending || revoke.isPending

  return (
    <>
      <dl className="kv">
        <dt>{t('panelKey.created')}</dt>
        <dd>{formatDateTime(info.created_at)}</dd>
        <dt>{t('panelKey.serversOnKey')}</dt>
        <dd>
          <span className={info.servers_using < info.servers_total ? 'warn-text' : 'ok-text'}>
            {t('panelKey.serversOnKeyValue', { using: info.servers_using, count: info.servers_total })}
          </span>
        </dd>
      </dl>

      <div className="row-wrap">
        <button className="btn btn-primary" onClick={onDeploy} disabled={busy}>
          <ServerCog size={14} /> {t('panelKey.deploy.button')}
        </button>
        <button className="btn" onClick={() => void askRotate()} disabled={busy}>
          {rotate.isPending ? <Spinner /> : <RotateCw size={14} />} {t('panelKey.rotate.button')}
        </button>
        <span className="spacer" />
        <button className="btn btn-danger" onClick={() => void askRevoke()} disabled={busy}>
          {revoke.isPending ? <Spinner /> : <Siren size={14} />} {t('panelKey.revoke.button')}
        </button>
      </div>
      {busy && <div className="muted small">{t('panelKey.working')}</div>}

      <div className="stack-sm">
        <AddressesField value={from} onChange={setFrom} />
        {from.length === 0 && (
          <Alert kind="warn" icon={<ShieldAlert size={15} />}>
            {t('panelKey.addresses.emptyWarning')}
          </Alert>
        )}
        {dirty && (
          <div className="row-wrap">
            <button className="btn btn-sm btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner /> : <Save size={13} />} {t('panelKey.addresses.save')}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={save.isPending} onClick={() => setFrom(info.allowed_from)}>
              <Undo2 size={13} /> {t('common:actions.reset')}
            </button>
          </div>
        )}
        {savedHint && !dirty && (
          <Alert kind="info">
            <div className="row-wrap">
              <span className="grow">{t('panelKey.addresses.redeployHint')}</span>
              <button className="btn btn-sm" onClick={onDeploy}>
                <ServerCog size={13} /> {t('panelKey.deploy.button')}
              </button>
            </div>
          </Alert>
        )}
      </div>

      {info.public_key && <Snippet title={t('panelKey.publicKey')} code={info.public_key} />}
      {info.authorized_keys_line && (
        <Snippet title={t('panelKey.authorizedLine')} hint={t('panelKey.authorizedLineHint')} code={info.authorized_keys_line} />
      )}
      {info.install_command && (
        <Snippet title={t('panelKey.installCommand')} hint={t('panelKey.installCommandHint')} code={info.install_command} />
      )}

      <details className="sec-details">
        <summary>{t('panelKey.revoke.manualTitle')}</summary>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <RevokeCommands command={info.emergency_revoke_command} />
        </div>
      </details>
    </>
  )
}

/** The emergency revoke command for running without the panel: on one server and on a whole fleet via ansible. */
function RevokeCommands({ command }: { command: string }) {
  const { t } = useTranslation('security')
  return (
    <div className="stack-sm">
      <div className="muted small">{t('panelKey.revoke.manualText')}</div>
      <Snippet title={t('panelKey.revoke.manualOne')} code={command} />
      <Snippet title={t('panelKey.revoke.manualAnsible')} code={`ansible all -m shell -a ${shQuote(command)}`} />
    </div>
  )
}
