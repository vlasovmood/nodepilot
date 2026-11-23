import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, ExternalLink, RefreshCw, ShieldCheck, ShieldAlert, Sparkles } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, errorMessage } from '../../api/client'
import type { InstallStatus, UpdateInfo } from '../../api/types'
import { useConfirm } from '../../components/Confirm'
import { Alert, Spinner } from '../../components/States'
import { useToast } from '../../components/Toast'
import { formatBytes, formatDateTime, formatRelative } from '../../lib/format'

const Markdown = lazy(() => import('../notes/Markdown'))

const qkUpdate = ['system', 'update'] as const
const BUSY: InstallStatus['phase'][] = ['downloading', 'verifying', 'installing', 'restarting']

export function UpdatesCard() {
  const { t } = useTranslation('settings')
  const qc = useQueryClient()
  const toast = useToast()
  const confirm = useConfirm()
  const [notesOpen, setNotesOpen] = useState(false)

  const info = useQuery({ queryKey: qkUpdate, queryFn: () => api.system.update(false), staleTime: 60_000 })
  const check = useMutation({
    mutationFn: () => api.system.update(true),
    onSuccess: (d) => qc.setQueryData(qkUpdate, d),
    onError: (e) => toast.error(t('updates.toast.checkFailed'), e),
  })
  const settings = useMutation({
    mutationFn: api.system.updateSettings,
    onSuccess: () => void qc.invalidateQueries({ queryKey: qkUpdate }),
    onError: (e) => toast.error(t('updates.toast.settingsFailed'), e),
  })

  const [install, setInstall] = useState<InstallStatus | null>(null)
  const target = useRef<string | null>(null)
  const busy = !!install && BUSY.includes(install.phase)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(async () => {
      if (install?.phase === 'restarting') {
        try {
          const h = await api.health()
          if (target.current && h.version === target.current) {
            window.clearInterval(timer)
            toast.success(t('updates.toast.installed', { version: h.version }))
            window.setTimeout(() => window.location.reload(), 800)
          }
        } catch {
          /* the panel is restarting; keep polling */
        }
        return
      }
      try {
        setInstall(await api.system.installStatus())
      } catch {
        // The old process is already gone; wait for the new version.
        setInstall((s) => (s ? { ...s, phase: 'restarting' } : s))
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [busy, install?.phase, t, toast])

  useEffect(() => {
    if (install?.phase === 'failed') toast.error(t('updates.toast.installFailed'), install.error ?? undefined)
  }, [install?.phase, install?.error, t, toast])

  const startInstall = async (d: UpdateInfo) => {
    const version = d.latest?.version ?? ''
    const ok = await confirm({
      title: t('updates.confirm.title', { version }),
      message: t('updates.confirm.message'),
      confirmText: t('updates.confirm.ok'),
    })
    if (!ok) return
    try {
      target.current = version
      setInstall(await api.system.installUpdate())
    } catch (e) {
      toast.error(t('updates.toast.installFailed'), errorMessage(e))
    }
  }

  const d = info.data
  const phaseLabel = install ? t(`updates.phase.${install.phase}`) : ''
  const progress = install?.total ? Math.min(100, (install.downloaded / install.total) * 100) : null

  return (
    <div className="card">
      <div className="card-header">
        <Sparkles size={14} />
        <h3 className="grow">{t('updates.title')}</h3>
        <button className="btn btn-sm" onClick={() => check.mutate()} disabled={check.isPending || busy}>
          <RefreshCw size={13} className={check.isPending ? 'spin' : undefined} /> {t('updates.checkNow')}
        </button>
      </div>
      <div className="card-body stack">
        {info.isPending && (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        )}
        {info.isError && <Alert kind="danger">{errorMessage(info.error)}</Alert>}
        {d && (
          <>
            <dl className="kv">
              <dt>{t('updates.current')}</dt>
              <dd className="mono">{d.current_version}</dd>
              <dt>{t('updates.latest')}</dt>
              <dd className="row" style={{ gap: 8 }}>
                {d.latest ? (
                  <>
                    <span className="mono">{d.latest.version}</span>
                    {d.latest.prerelease && <span className="badge badge-warn">{t('updates.prerelease')}</span>}
                    {d.update_available ? (
                      <span className="badge badge-ok">{t('updates.available')}</span>
                    ) : (
                      <span className="badge">
                        <CheckCircle2 size={11} /> {t('updates.upToDate')}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
              {d.latest?.published_at && (
                <>
                  <dt>{t('updates.published')}</dt>
                  <dd>{formatDateTime(d.latest.published_at)}</dd>
                </>
              )}
              <dt>{t('updates.checked')}</dt>
              <dd>{d.checked_at ? formatRelative(d.checked_at) : t('updates.never')}</dd>
              <dt>{t('updates.repo')}</dt>
              <dd className="mono" dir="ltr">
                {d.repo ?? <span className="muted">{t('updates.repoNotSet')}</span>}
              </dd>
              <dt>{t('updates.verification')}</dt>
              <dd className="row" style={{ gap: 6 }}>
                {d.signature_required ? (
                  <>
                    <ShieldCheck size={14} className="ok-text" /> {t('updates.signed')}
                  </>
                ) : (
                  <>
                    <ShieldAlert size={14} className="warn-text" /> {t('updates.checksumOnly')}
                  </>
                )}
              </dd>
            </dl>

            {d.error && d.repo && <Alert kind="warn">{t('updates.checkError', { error: d.error })}</Alert>}

            {d.latest && (d.update_available || notesOpen) && (
              <div className="stack-sm">
                <div className="row">
                  <button className="btn btn-ghost btn-sm" onClick={() => setNotesOpen((o) => !o)}>
                    {notesOpen ? t('updates.hideNotes') : t('updates.showNotes', { version: d.latest.version })}
                  </button>
                  <a className="btn btn-ghost btn-sm" href={d.latest.url} target="_blank" rel="noopener noreferrer">
                    {t('updates.openRelease')} <ExternalLink size={12} />
                  </a>
                </div>
                {notesOpen && (
                  <div className="card card-pad">
                    <Suspense fallback={<Spinner />}>
                      <Markdown text={d.latest.notes || t('updates.noNotes')} />
                    </Suspense>
                  </div>
                )}
              </div>
            )}

            {busy || install?.phase === 'failed' ? (
              <div className="stack-sm">
                <div className="row">
                  {busy && <Spinner />}
                  <b>{phaseLabel}</b>
                  {install?.phase === 'downloading' && install.total ? (
                    <span className="muted small">
                      {formatBytes(install.downloaded)} / {formatBytes(install.total)}
                    </span>
                  ) : null}
                </div>
                {install?.phase === 'downloading' && progress !== null && (
                  <div className="progress">
                    <div style={{ width: `${progress}%` }} />
                  </div>
                )}
                {install?.phase === 'restarting' && <span className="muted small">{t('updates.waitRestart')}</span>}
                {install?.phase === 'failed' && <Alert kind="danger">{install.error}</Alert>}
              </div>
            ) : d.update_available && d.can_install ? (
              <div className="row">
                <button className="btn btn-primary" onClick={() => void startInstall(d)}>
                  <Download size={14} /> {t('updates.install', { version: d.latest?.version })}
                </button>
                {d.latest?.asset_size ? <span className="muted small">{formatBytes(d.latest.asset_size)}</span> : null}
              </div>
            ) : d.update_available && d.install_blocker ? (
              <Alert kind="info">
                <Trans t={t} i18nKey="updates.blocked" values={{ reason: d.install_blocker }} components={{ code: <code /> }} />
              </Alert>
            ) : null}

            <div className="row-wrap" style={{ gap: 18 }}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={d.settings.auto_check}
                  disabled={settings.isPending}
                  onChange={(e) => settings.mutate({ auto_check: e.target.checked })}
                />
                {t('updates.autoCheck')}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={d.settings.include_prereleases}
                  disabled={settings.isPending}
                  onChange={(e) => settings.mutate({ include_prereleases: e.target.checked })}
                />
                {t('updates.prereleases')}
              </label>
            </div>
            <span className="muted small">{t('updates.hint')}</span>
          </>
        )}
      </div>
    </div>
  )
}
