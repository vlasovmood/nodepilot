import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Save, Send, Share2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, errorMessage } from '../../api/client'
import { invalidateSecurity, qk } from '../../api/queries'
import type { AuditSettings, AuditSettingsInput, AuditSeverity, OkResult } from '../../api/types'
import { Field } from '../../components/Field'
import { Alert, InlineError, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { SEVERITIES } from './util'

type Form = { syslog: string; webhookUrl: string; secret: string; clearSecret: boolean; minSeverity: AuditSeverity; retention: string }

const fromSettings = (s: AuditSettings): Form => ({
  syslog: s.syslog ?? '',
  webhookUrl: s.webhook_url ?? '',
  secret: '',
  clearSecret: false,
  minSeverity: s.min_severity,
  retention: String(s.retention_days),
})

/** Same checks as the server, so mistakes show up next to the field. */
function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {}
  const syslog = f.syslog.trim()
  if (syslog && !/^(udp|tcp):\/\/[^\s/]+:\d{1,5}$/.test(syslog)) e.syslog = 'audit.settings.errors.syslog'
  const url = f.webhookUrl.trim()
  if (url && !/^https?:\/\/\S+$/.test(url)) e.webhookUrl = 'audit.settings.errors.webhook'
  const r = Number(f.retention)
  if (!f.retention || !Number.isInteger(r) || r < 7 || r > 3650) e.retention = 'audit.settings.errors.retention'
  return e
}

/** Forwarding of audit events to syslog / a webhook, and retention in the panel. */
export function AuditSettingsCard() {
  const { t } = useTranslation('security')
  const qc = useQueryClient()
  const toast = useToast()
  const settings = useQuery({ queryKey: qk.auditSettings, queryFn: () => api.audit.settings() })
  /** Unsaved edits; `null` — show the saved settings. */
  const [draft, setDraft] = useState<Form | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<OkResult | null>(null)

  const s = settings.data
  const form = draft ?? (s ? fromSettings(s) : null)
  const dirty =
    !!form &&
    !!s &&
    (form.syslog.trim() !== (s.syslog ?? '') ||
      form.webhookUrl.trim() !== (s.webhook_url ?? '') ||
      !!form.secret ||
      form.clearSecret ||
      form.minSeverity !== s.min_severity ||
      form.retention !== String(s.retention_days))

  const save = useMutation({
    mutationFn: (f: Form) => {
      const body: AuditSettingsInput = {
        syslog: f.syslog.trim(),
        webhook_url: f.webhookUrl.trim(),
        min_severity: f.minSeverity,
        retention_days: Number(f.retention),
      }
      if (f.secret) body.webhook_secret = f.secret
      else if (f.clearSecret) body.webhook_secret = ''
      return api.audit.updateSettings(body)
    },
    onSuccess: (next) => {
      qc.setQueryData(qk.auditSettings, next)
      setDraft(null)
      invalidateSecurity(qc)
    },
  })

  const test = useMutation({
    mutationFn: () => api.audit.test(),
    onSuccess: setTestResult,
    onError: (e) => setTestResult({ ok: false, error: errorMessage(e) }),
  })

  const submit = async (alsoTest: boolean) => {
    if (!form) return
    setTestResult(null)
    if (dirty) {
      const e = validate(form)
      setErrors(e)
      if (Object.keys(e).length) return
      try {
        await save.mutateAsync(form)
        if (!alsoTest) toast.success(t('audit.settings.saved'))
      } catch {
        return
      }
    }
    if (alsoTest) test.mutate()
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    if (form) setDraft({ ...form, [k]: v })
  }
  const err = (k: string) => (errors[k] ? t(errors[k]) : undefined)
  const nothingToTest = !!form && !form.syslog.trim() && !form.webhookUrl.trim()

  return (
    <div className="card sec-anchor" id="sec-audit">
      <div className="card-header">
        <Share2 size={14} />
        <h3 className="grow">{t('audit.settings.title')}</h3>
        {s && (s.syslog || s.webhook_url) ? (
          <span className="badge badge-ok">{t('audit.settings.on')}</span>
        ) : s ? (
          <span className="badge">{t('audit.settings.off')}</span>
        ) : null}
      </div>
      <div className="card-body stack">
        {settings.isPending && (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        )}
        {settings.isError && <Alert kind="danger">{errorMessage(settings.error)}</Alert>}
        {form && s && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(false)
            }}
          >
            <div className="muted">{t('audit.settings.intro')}</div>
            <div className="form-grid">
              <Field label={t('audit.settings.syslog')} hint={t('audit.settings.syslogHint')} error={err('syslog')}>
                <input
                  className="input mono"
                  dir="ltr"
                  placeholder="udp://10.0.0.5:514"
                  value={form.syslog}
                  onChange={(e) => set('syslog', e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <Field label={t('audit.settings.webhook')} hint={t('audit.settings.webhookHint')} error={err('webhookUrl')}>
                <input
                  className="input mono"
                  dir="ltr"
                  placeholder="https://siem.example.com/hooks/nodepilot"
                  value={form.webhookUrl}
                  onChange={(e) => set('webhookUrl', e.target.value)}
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t('audit.settings.secret')}
                hint={
                  <Trans
                    t={t}
                    i18nKey="audit.settings.secretHint"
                    values={{ header: 'X-NodePilot-Signature: sha256=<hmac>' }}
                    components={{ code: <code /> }}
                  />
                }
              >
                <div className="row">
                  <input
                    className="input grow"
                    type="password"
                    autoComplete="new-password"
                    placeholder={s.webhook_secret_set && !form.clearSecret ? t('audit.settings.secretSetPlaceholder') : ''}
                    value={form.secret}
                    onChange={(e) => setDraft({ ...form, secret: e.target.value, clearSecret: false })}
                  />
                  {s.webhook_secret_set && !form.clearSecret && !form.secret && (
                    <span className="badge badge-ok nowrap" data-testid="secret-set">
                      {t('audit.settings.secretSet')}
                    </span>
                  )}
                  {s.webhook_secret_set && (
                    <label className="checkbox small nowrap">
                      <input
                        type="checkbox"
                        checked={form.clearSecret}
                        onChange={(e) => setDraft({ ...form, clearSecret: e.target.checked, secret: '' })}
                      />
                      {t('audit.settings.clearSecret')}
                    </label>
                  )}
                </div>
              </Field>
              <div className="form-grid">
                <Field label={t('audit.settings.minSeverity')} hint={t('audit.settings.minSeverityHint')}>
                  <select className="select" value={form.minSeverity} onChange={(e) => set('minSeverity', e.target.value as AuditSeverity)}>
                    {SEVERITIES.map((v) => (
                      <option key={v} value={v}>
                        {t(`audit.severity.${v}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('audit.settings.retention')} hint={t('audit.settings.retentionHint')} error={err('retention')}>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form.retention}
                    onChange={(e) => set('retention', e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
              </div>
            </div>
            <InlineError error={save.error} />
            {testResult && (
              <Alert
                kind={testResult.ok ? 'info' : 'danger'}
                icon={testResult.ok ? <CheckCircle2 size={15} className="ok-text" /> : <XCircle size={15} />}
              >
                <span data-testid="audit-test-result">
                  {testResult.ok ? t('audit.settings.testOk') : t('audit.settings.testFailed', { error: testResult.error ?? '' })}
                </span>
              </Alert>
            )}
            <div className="row-wrap">
              <button className="btn btn-primary" type="submit" disabled={!dirty || save.isPending}>
                {save.isPending && !test.isPending ? <Spinner /> : <Save size={14} />} {t('common:actions.save')}
              </button>
              <button
                className="btn"
                type="button"
                disabled={save.isPending || test.isPending || nothingToTest}
                onClick={() => void submit(true)}
                title={nothingToTest ? t('audit.settings.testNothing') : undefined}
              >
                {test.isPending ? <Spinner /> : <Send size={14} />} {dirty ? t('audit.settings.saveAndTest') : t('audit.settings.test')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
