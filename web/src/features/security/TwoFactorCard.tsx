import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, RefreshCw, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiRequestError, errorMessage } from '../../api/client'
import { invalidateSecurity, qk } from '../../api/queries'
import { CopyButton } from '../../components/CopyButton'
import { Field } from '../../components/Field'
import { Modal } from '../../components/Modal'
import { Alert, InlineError, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import { downloadText } from '../../lib/util'
import { useAuth } from '../auth/AuthGate'
import { QrCode } from './QrCode'

type DialogKind = 'enable' | 'disable' | 'regenerate'

/** Two-factor authentication of the signed-in user. */
export function TwoFactorCard() {
  const { t } = useTranslation('security')
  const status = useQuery({ queryKey: qk.twoFactor, queryFn: () => api.twoFactor.status() })
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const s = status.data

  return (
    <div className="card sec-anchor" id="sec-2fa">
      <div className="card-header">
        <Smartphone size={14} />
        <h3 className="grow">{t('twoFactor.title')}</h3>
        {s &&
          (s.enabled ? (
            <span className="badge badge-ok">
              <ShieldCheck size={11} /> {t('twoFactor.on')}
            </span>
          ) : (
            <span className="badge badge-warn">{t('twoFactor.off')}</span>
          ))}
      </div>
      <div className="card-body stack">
        {status.isPending && (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        )}
        {status.isError && <Alert kind="danger">{errorMessage(status.error)}</Alert>}
        {s && !s.enabled && (
          <>
            <div className="muted">{t('twoFactor.offText')}</div>
            <div className="row">
              <button className="btn btn-primary" onClick={() => setDialog('enable')}>
                <ShieldCheck size={14} /> {t('twoFactor.enable')}
              </button>
            </div>
          </>
        )}
        {s?.enabled && (
          <>
            <div className="muted">{t('twoFactor.onText')}</div>
            <div className="row-wrap">
              <span className={s.recovery_codes_left <= 3 ? 'warn-text' : 'muted'}>
                <KeyRound size={13} style={{ verticalAlign: '-2px' }} /> {t('twoFactor.codesLeft', { count: s.recovery_codes_left })}
              </span>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => setDialog('regenerate')}>
                <RefreshCw size={13} /> {t('twoFactor.regenerate')}
              </button>
              <button className="btn btn-ghost btn-sm btn-danger-ghost" onClick={() => setDialog('disable')}>
                <ShieldOff size={13} /> {t('twoFactor.disable')}
              </button>
            </div>
            {s.recovery_codes_left <= 3 && <Alert kind="warn">{t('twoFactor.fewCodes')}</Alert>}
          </>
        )}
      </div>
      {dialog === 'enable' && <EnableDialog onClose={() => setDialog(null)} />}
      {dialog === 'disable' && <DisableDialog onClose={() => setDialog(null)} />}
      {dialog === 'regenerate' && <RegenerateDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

/** Digits only, at most 6 — for TOTP inputs. */
const totpInput = (v: string) => v.replace(/\D/g, '').slice(0, 6)

function codeError(t: (k: string) => string, e: unknown, key = 'twoFactor.errors.wrongCode'): string | null {
  if (!e) return null
  if (e instanceof ApiRequestError && (e.status === 400 || e.status === 403)) return t(key)
  return errorMessage(e)
}

function EnableDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  // A query (not an effect + mutation) so StrictMode / re-renders never create a second pending secret.
  const setup = useQuery({
    queryKey: ['2fa-setup'],
    queryFn: () => api.twoFactor.setup(),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const enable = useMutation({
    mutationFn: () => api.twoFactor.enable(code),
    onSuccess: (r) => {
      setCodes(r.recovery_codes)
      invalidateSecurity(qc)
    },
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length === 6 && !enable.isPending) enable.mutate()
  }

  if (codes) {
    return (
      <Modal
        open
        onClose={onClose}
        locked={!saved}
        size="md"
        title={t('twoFactor.enabledTitle')}
        footer={
          <button className="btn btn-primary" disabled={!saved} onClick={onClose}>
            {t('recovery.done')}
          </button>
        }
      >
        <RecoveryCodesView codes={codes} saved={saved} onSaved={setSaved} />
      </Modal>
    )
  }

  const secret = setup.data?.secret ?? ''
  return (
    <Modal
      open
      onClose={onClose}
      locked={enable.isPending}
      size="md"
      title={t('twoFactor.enableTitle')}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={enable.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-primary" disabled={code.length !== 6 || enable.isPending || !setup.data} onClick={() => submit()}>
            {enable.isPending && <Spinner />} {t('twoFactor.enableSubmit')}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        <div className="muted">{t('twoFactor.step1')}</div>
        {setup.isError ? (
          <InlineError error={setup.error} />
        ) : (
          <div className="tfa-setup">
            {setup.data ? (
              <QrCode text={setup.data.otpauth_url} label={t('twoFactor.qrAlt')} />
            ) : (
              <div className="qr-box">
                <Spinner />
              </div>
            )}
            <div className="stack-sm grow">
              <span className="small muted">{t('twoFactor.manualEntry')}</span>
              <div className="token-reveal" data-testid="totp-secret">
                <span className="grow">{secret.replace(/(.{4})/g, '$1 ').trim() || '…'}</span>
                {secret && <CopyButton text={secret} />}
              </div>
              <span className="small dim">{t('twoFactor.manualHint')}</span>
            </div>
          </div>
        )}
        <Field label={t('twoFactor.step2')} error={codeError(t, enable.error)}>
          <input
            className="input mono totp-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(totpInput(e.target.value))}
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function DisableDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const m = useMutation({
    mutationFn: () => api.twoFactor.disable(password, code.trim()),
    onSuccess: () => {
      invalidateSecurity(qc)
      toast.success(t('twoFactor.toast.disabled'))
      onClose()
    },
  })
  const can = !!password && code.trim().length >= 6 && !m.isPending
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (can) m.mutate()
  }
  return (
    <Modal
      open
      onClose={onClose}
      locked={m.isPending}
      size="sm"
      title={t('twoFactor.disableTitle')}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={m.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button className="btn btn-danger" disabled={!can} onClick={() => submit()}>
            {m.isPending && <Spinner />} {t('twoFactor.disable')}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Alert kind="warn">{t('twoFactor.disableWarning')}</Alert>
        <Field label={t('common:fields.password')}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t('twoFactor.codeOrRecovery')} hint={t('twoFactor.codeOrRecoveryHint')}>
          <input
            className="input mono"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
        </Field>
        {m.error ? <InlineError error={codeError(t, m.error, 'twoFactor.errors.wrongPasswordOrCode')} /> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function RegenerateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  const m = useMutation({
    mutationFn: () => api.twoFactor.regenerateCodes(code),
    onSuccess: (r) => {
      setCodes(r.recovery_codes)
      invalidateSecurity(qc)
    },
  })
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (code.length === 6 && !m.isPending) m.mutate()
  }
  return (
    <Modal
      open
      onClose={onClose}
      locked={m.isPending || (!!codes && !saved)}
      size="md"
      title={t('twoFactor.regenerateTitle')}
      footer={
        codes ? (
          <button className="btn btn-primary" disabled={!saved} onClick={onClose}>
            {t('recovery.done')}
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={m.isPending}>
              {t('common:actions.cancel')}
            </button>
            <button className="btn btn-primary" disabled={code.length !== 6 || m.isPending} onClick={() => submit()}>
              {m.isPending && <Spinner />} {t('twoFactor.regenerateSubmit')}
            </button>
          </>
        )
      }
    >
      {codes ? (
        <RecoveryCodesView codes={codes} saved={saved} onSaved={setSaved} />
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="muted">{t('twoFactor.regenerateText')}</div>
          <Field label={t('twoFactor.appCode')} error={codeError(t, m.error)}>
            <input
              className="input mono totp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(totpInput(e.target.value))}
            />
          </Field>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  )
}

/** Recovery codes shown once: copy, download as .txt, and an explicit «I saved them». */
function RecoveryCodesView({ codes, saved, onSaved }: { codes: string[]; saved: boolean; onSaved: (v: boolean) => void }) {
  const { t } = useTranslation('security')
  const { user } = useAuth()
  const text = codes.join('\n')
  return (
    <div className="stack">
      <Alert kind="warn">{t('recovery.warning')}</Alert>
      <div className="recovery-codes mono" data-testid="recovery-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="row-wrap">
        <CopyButton text={text} label={t('recovery.copyAll')} small={false} />
        <button
          className="btn btn-ghost"
          onClick={() => {
            const header = t('recovery.fileHeader', {
              username: user.username,
              host: window.location.host,
              date: formatDateTime(new Date().toISOString()),
            })
            downloadText('nodepilot-recovery-codes.txt', `${header}\n\n${text}\n`)
          }}
        >
          <Download size={14} /> {t('recovery.download')}
        </button>
      </div>
      <div className="muted small">{t('recovery.howTo')}</div>
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => onSaved(e.target.checked)} />
        {t('recovery.savedCheck')}
      </label>
    </div>
  )
}
