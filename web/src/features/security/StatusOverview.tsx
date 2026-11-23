import type { UseQueryResult } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, CheckCircle2, Info, RefreshCw, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { SecurityStatus } from '../../api/types'
import { ErrorState, Spinner } from '../../components/States'
import { cx } from '../../lib/util'
import { scrollToSection } from './util'

type State = 'ok' | 'warn' | 'info'
type Fix = { to: string } | { anchor: string }
type Check = { id: string; state: State; title: string; text: string; fix?: Fix; fixLabel?: string }

function useChecks(s: SecurityStatus): Check[] {
  const { t } = useTranslation('security')
  const checks: Check[] = []
  const toMaster: Fix = { anchor: 'sec-master-key' }

  // master key
  const mk = s.master_key
  checks.push(
    mk.kind === 'data-dir'
      ? {
          id: 'master',
          state: 'warn',
          title: t('overview.master.title'),
          text: t('overview.master.dataDir'),
          fix: toMaster,
          fixLabel: t('overview.howTo'),
        }
      : {
          id: 'master',
          state: 'ok',
          title: t('overview.master.title'),
          text: mk.kind === 'systemd-credential' ? t('overview.master.sealed') : t('overview.master.file'),
        },
  )
  if (mk.plaintext_copy_on_disk)
    checks.push({
      id: 'plain',
      state: 'warn',
      title: t('overview.plaintext.title'),
      text: t('overview.plaintext.text'),
      fix: toMaster,
      fixLabel: t('overview.details'),
    })

  // 2FA
  const tf = s.two_factor
  checks.push(
    !tf.enabled
      ? {
          id: '2fa',
          state: 'warn',
          title: t('overview.twoFactor.title'),
          text: t('overview.twoFactor.off'),
          fix: { anchor: 'sec-2fa' },
          fixLabel: t('overview.twoFactor.enable'),
        }
      : tf.recovery_codes_left <= 3
        ? {
            id: '2fa',
            state: 'warn',
            title: t('overview.twoFactor.title'),
            text: t('overview.twoFactor.fewCodes', { count: tf.recovery_codes_left }),
            fix: { anchor: 'sec-2fa' },
            fixLabel: t('overview.twoFactor.newCodes'),
          }
        : {
            id: '2fa',
            state: 'ok',
            title: t('overview.twoFactor.title'),
            text: t('overview.twoFactor.on', { count: tf.recovery_codes_left }),
          },
  )

  // panel key
  const toKey: Fix = { anchor: 'sec-panel-key' }
  if (!s.panel_key_configured)
    checks.push({
      id: 'key',
      state: 'info',
      title: t('overview.panelKey.title'),
      text: t('overview.panelKey.none'),
      fix: toKey,
      fixLabel: t('overview.panelKey.create'),
    })
  else if (!s.panel_key_from_restricted)
    checks.push({
      id: 'key',
      state: 'warn',
      title: t('overview.panelKey.title'),
      text: t('overview.panelKey.unrestricted'),
      fix: toKey,
      fixLabel: t('overview.panelKey.restrict'),
    })
  else if (s.servers_on_panel_key < s.servers_total)
    checks.push({
      id: 'key',
      state: 'info',
      title: t('overview.panelKey.title'),
      text: t('overview.panelKey.partial', { using: s.servers_on_panel_key, count: s.servers_total }),
      fix: toKey,
      fixLabel: t('overview.panelKey.install'),
    })
  else
    checks.push({
      id: 'key',
      state: 'ok',
      title: t('overview.panelKey.title'),
      text: t('overview.panelKey.all', { count: s.servers_total }),
    })

  // backups
  const toBackups: Fix = { to: '/backups' }
  if (s.backup_jobs_total === 0)
    checks.push({
      id: 'backups',
      state: 'info',
      title: t('overview.backups.title'),
      text: t('overview.backups.none'),
      fix: toBackups,
      fixLabel: t('overview.backups.open'),
    })
  else if (s.backup_jobs_unencrypted > 0)
    checks.push({
      id: 'backups',
      state: 'warn',
      title: t('overview.backups.title'),
      text: t('overview.backups.unencrypted', { count: s.backup_jobs_unencrypted }),
      fix: toBackups,
      fixLabel: t('overview.backups.open'),
    })
  else if (s.backup_jobs_passphrase > 0)
    checks.push({
      id: 'backups',
      state: 'info',
      title: t('overview.backups.title'),
      text: t('overview.backups.passphrase', { count: s.backup_jobs_passphrase }),
      fix: toBackups,
      fixLabel: t('overview.backups.open'),
    })
  else
    checks.push({
      id: 'backups',
      state: 'ok',
      title: t('overview.backups.title'),
      text: t('overview.backups.allKeys', { count: s.backup_jobs_recipients }),
    })

  // API tokens
  const toTokens: Fix = { to: '/developer/tokens' }
  if (s.api_tokens_full_access > 0 || s.api_tokens_without_expiry > 0) {
    const parts: string[] = []
    if (s.api_tokens_full_access > 0) parts.push(t('overview.tokens.fullAccess', { count: s.api_tokens_full_access }))
    if (s.api_tokens_without_expiry > 0) parts.push(t('overview.tokens.noExpiry', { count: s.api_tokens_without_expiry }))
    parts.push(t('overview.tokens.advice'))
    checks.push({
      id: 'tokens',
      state: 'warn',
      title: t('overview.tokens.title'),
      text: parts.join(' '),
      fix: toTokens,
      fixLabel: t('overview.tokens.open'),
    })
  } else
    checks.push({
      id: 'tokens',
      state: 'ok',
      title: t('overview.tokens.title'),
      text: s.api_tokens_total === 0 ? t('overview.tokens.none') : t('overview.tokens.ok', { count: s.api_tokens_total }),
      fix: s.api_tokens_total ? toTokens : undefined,
      fixLabel: t('overview.tokens.open'),
    })

  // audit forwarding
  checks.push(
    s.audit_forwarding
      ? { id: 'audit', state: 'ok', title: t('overview.audit.title'), text: t('overview.audit.on') }
      : {
          id: 'audit',
          state: 'info',
          title: t('overview.audit.title'),
          text: t('overview.audit.off'),
          fix: { anchor: 'sec-audit' },
          fixLabel: t('overview.audit.configure'),
        },
  )

  // HTTPS
  checks.push(
    s.secure_cookies
      ? { id: 'https', state: 'ok', title: t('overview.https.title'), text: t('overview.https.on') }
      : { id: 'https', state: 'warn', title: t('overview.https.title'), text: t('overview.https.off') },
  )
  return checks
}

const ICONS: Record<State, ReactNode> = {
  ok: <CheckCircle2 size={17} />,
  warn: <AlertTriangle size={17} />,
  info: <Info size={17} />,
}

function FixButton({ fix, label }: { fix: Fix; label: string }) {
  if ('to' in fix)
    return (
      <Link className="btn btn-sm" to={fix.to}>
        {label} <ArrowRight size={13} />
      </Link>
    )
  return (
    <button className="btn btn-sm" onClick={() => scrollToSection(fix.anchor)}>
      {label} <ArrowRight size={13} />
    </button>
  )
}

function Checklist({ status }: { status: SecurityStatus }) {
  const { t } = useTranslation('security')
  const checks = useChecks(status)
  const ok = checks.filter((c) => c.state === 'ok').length
  const warn = checks.filter((c) => c.state === 'warn').length
  return (
    <>
      <div className="sec-summary">
        <span className={cx('sec-score', warn ? 'warn' : 'ok')}>{t('overview.score', { ok, count: checks.length })}</span>
        <span className="muted small">{warn ? t('overview.warnings', { count: warn }) : t('overview.allGood')}</span>
      </div>
      <div className="sec-checks" data-testid="security-checks">
        {checks.map((c) => (
          <div key={c.id} className={cx('sec-check', c.state)} data-check={c.id} data-state={c.state}>
            <span className="sec-check-icon">{ICONS[c.state]}</span>
            <div className="grow">
              <div className="sec-check-title">{c.title}</div>
              <div className="muted small">{c.text}</div>
            </div>
            {c.fix && c.fixLabel && <FixButton fix={c.fix} label={c.fixLabel} />}
          </div>
        ))}
      </div>
    </>
  )
}

export function StatusOverview({ status }: { status: UseQueryResult<SecurityStatus> }) {
  const { t } = useTranslation('security')
  return (
    <div className="card">
      <div className="card-header">
        <ShieldCheck size={14} />
        <h3 className="grow">{t('overview.title')}</h3>
        <button className="btn btn-ghost btn-icon btn-sm" title={t('common:actions.refresh')} onClick={() => void status.refetch()}>
          <RefreshCw size={14} className={status.isFetching ? 'spin' : undefined} />
        </button>
      </div>
      <div className="card-body stack">
        {status.isPending ? (
          <div className="row muted">
            <Spinner /> {t('common:state.loading')}
          </div>
        ) : status.isError ? (
          <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <Checklist status={status.data} />
        )}
      </div>
    </div>
  )
}
