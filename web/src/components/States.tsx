import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { cx } from '../lib/util'

export function Spinner({ large }: { large?: boolean }) {
  const { t } = useTranslation()
  return <span className={cx('spinner', large && 'spinner-lg')} aria-label={t('state.loadingAria')} />
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation()
  return (
    <div className="state">
      <Spinner large />
      <div>{label ?? t('state.loading')}</div>
    </div>
  )
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { t } = useTranslation()
  return (
    <div className="state">
      <AlertTriangle size={28} className="danger-text" />
      <div className="state-title">{title ?? t('state.loadFailed')}</div>
      <div className="muted pre-wrap" style={{ maxWidth: 560 }}>
        {errorMessage(error)}
      </div>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          <RefreshCw size={14} /> {t('actions.retry')}
        </button>
      )}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <div className="state-icon">{icon ?? <Inbox size={28} />}</div>
      <div className="state-title">{title}</div>
      {children}
    </div>
  )
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div className="alert alert-danger">
      <AlertTriangle size={15} />
      <div className="pre-wrap">{errorMessage(error)}</div>
    </div>
  )
}

export function Alert({ kind = 'info', icon, children }: { kind?: 'info' | 'warn' | 'danger'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`}>
      {icon ?? <AlertTriangle size={15} />}
      <div className="grow">{children}</div>
    </div>
  )
}
