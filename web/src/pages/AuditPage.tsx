import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown, KeyRound, RefreshCw, ScrollText, Search, Settings2 } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../api/client'
import { qk } from '../api/queries'
import type { AuditEntry, AuditSeverity } from '../api/types'
import { Empty, ErrorState, Loading, Spinner } from '../components/States'
import { SEVERITIES } from '../features/security/util'
import { formatDateTime, formatNumber, formatRelative } from '../lib/format'
import { cx } from '../lib/util'

const PAGE = 200

type Filters = { actor: string; q: string; severity: AuditSeverity | '' }

/** Value that follows `value` after `ms` of quiet — typing in filters doesn't fire a request per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return v
}

export function AuditPage() {
  const { t } = useTranslation('security')
  const [filters, setFilters] = useState<Filters>({ actor: '', q: '', severity: '' })
  const debounced = useDebounced(filters, 300)
  const key = { actor: debounced.actor.trim(), q: debounced.q.trim(), severity: debounced.severity }
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const log = useInfiniteQuery({
    queryKey: qk.audit(key),
    queryFn: ({ pageParam, signal }) =>
      api.audit.list({ actor: key.actor, q: key.q, severity: key.severity || undefined, before_id: pageParam, limit: PAGE }, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < PAGE ? undefined : last[last.length - 1].id),
    placeholderData: keepPreviousData,
  })

  const rows = useMemo(() => log.data?.pages.flat() ?? [], [log.data])
  const toggle = (id: number) =>
    setExpanded((cur) => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }))
  const filtered = !!(filters.actor || filters.q || filters.severity)

  return (
    <div className="page">
      <div className="page-header">
        <div className="title-block">
          <h1>
            <ScrollText size={17} /> {t('audit.page.title')}
          </h1>
          <span className="muted small">{t('audit.page.subtitle')}</span>
        </div>
        <div className="actions">
          <Link className="btn btn-sm" to="/security#sec-audit">
            <Settings2 size={14} /> {t('audit.page.forwarding')}
          </Link>
        </div>
      </div>

      <div className="toolbar audit-filters">
        <div className="input-icon" style={{ width: 280 }}>
          <Search size={14} />
          <input
            className="input"
            placeholder={t('audit.filters.q')}
            aria-label={t('audit.filters.q')}
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
          />
        </div>
        <input
          className="input"
          style={{ width: 180 }}
          placeholder={t('audit.filters.actor')}
          aria-label={t('audit.filters.actor')}
          value={filters.actor}
          onChange={(e) => set('actor', e.target.value)}
        />
        <select
          className="select"
          style={{ width: 200 }}
          value={filters.severity}
          aria-label={t('audit.filters.severity')}
          onChange={(e) => set('severity', e.target.value as Filters['severity'])}
        >
          <option value="">{t('audit.filters.allSeverities')}</option>
          {SEVERITIES.filter((s) => s !== 'info').map((s) => (
            <option key={s} value={s}>
              {t(`audit.filters.atLeast.${s}`)}
            </option>
          ))}
        </select>
        {filtered && (
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ actor: '', q: '', severity: '' })}>
            {t('audit.filters.reset')}
          </button>
        )}
        <span className="spacer" />
        {log.data && <span className="muted small">{t('audit.shown', { count: rows.length, n: formatNumber(rows.length) })}</span>}
        <button className="btn btn-ghost btn-icon" title={t('common:actions.refresh')} onClick={() => void log.refetch()}>
          <RefreshCw size={14} className={log.isFetching && !log.isFetchingNextPage ? 'spin' : undefined} />
        </button>
      </div>

      {log.isPending ? (
        <Loading />
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon={<ScrollText size={28} />} title={filtered ? t('audit.emptyFiltered') : t('audit.empty')} />
        </div>
      ) : (
        <div className={cx('table-wrap', log.isPlaceholderData && 'loading-fade')}>
          <table className="table audit-table" data-testid="audit-table">
            <thead>
              <tr>
                <th style={{ width: 24 }} />
                <th>{t('audit.columns.time')}</th>
                <th>{t('audit.columns.severity')}</th>
                <th>{t('audit.columns.actor')}</th>
                <th>{t('audit.columns.ip')}</th>
                <th>{t('audit.columns.action')}</th>
                <th>{t('audit.columns.target')}</th>
                <th>{t('audit.columns.outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <AuditRow key={e.id} entry={e} open={expanded.has(e.id)} onToggle={toggle} />
              ))}
            </tbody>
          </table>
          {log.hasNextPage && (
            <div className="audit-more">
              <button className="btn btn-sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {log.isFetchingNextPage && <Spinner />} {t('audit.loadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useTranslation('security')
  const cls = severity === 'critical' ? 'badge-danger' : severity === 'warning' ? 'badge-warn' : ''
  return <span className={cx('badge', cls)}>{t(`audit.severity.${severity}`, { defaultValue: severity })}</span>
}

type OutcomeKind = 'ok' | 'warn' | 'danger' | 'neutral'

function outcomeKind(o: string): OutcomeKind {
  if (o === 'ok' || o === 'exit 0') return 'ok'
  if (o === 'denied' || o === 'locked') return 'warn'
  if (o.startsWith('error')) return 'danger'
  if (/^exit -?\d+$/.test(o)) return 'warn'
  return 'neutral'
}

function Outcome({ outcome }: { outcome: string }) {
  const { t } = useTranslation('security')
  const kind = outcomeKind(outcome)
  const exit = /^exit (-?\d+)$/.exec(outcome)
  let label: string
  if (outcome === 'ok' || outcome === 'denied' || outcome === 'locked') label = t(`audit.outcome.${outcome}`)
  else if (exit) label = t('audit.outcome.exit', { code: exit[1] })
  else if (outcome.startsWith('error')) label = t('audit.outcome.error')
  else label = outcome
  const message = outcome.startsWith('error') ? outcome.replace(/^error:?\s*/, '') : ''
  return (
    <span className={cx('audit-outcome', kind)} title={outcome}>
      <span className="audit-outcome-label">{label}</span>
      {message && <span className="ellipsis small audit-outcome-msg">{message}</span>}
    </span>
  )
}

function prettyDetails(details: string): string {
  try {
    return JSON.stringify(JSON.parse(details), null, 2)
  } catch {
    return details
  }
}

const AuditRow = memo(function AuditRow({
  entry: e,
  open,
  onToggle,
}: {
  entry: AuditEntry
  open: boolean
  onToggle: (id: number) => void
}) {
  const { t } = useTranslation('security')
  return (
    <>
      <tr className={cx('audit-row', open && 'open')} onClick={() => onToggle(e.id)} aria-expanded={open}>
        <td className="dim">
          <ChevronDown size={13} className="audit-chev" />
        </td>
        <td className="nowrap small" title={formatDateTime(e.ts, true)}>
          {formatRelative(e.ts)}
        </td>
        <td>
          <SeverityBadge severity={e.severity} />
        </td>
        <td className="nowrap">
          <span className="row" style={{ gap: 6 }}>
            <span style={{ fontWeight: 600 }}>{e.actor}</span>
            {e.token && (
              <span className="badge" title={t('audit.viaToken', { name: e.token })}>
                <KeyRound size={10} /> {e.token}
              </span>
            )}
          </span>
        </td>
        <td className="mono small nowrap dim">{e.ip ?? '—'}</td>
        <td className="mono small nowrap">{e.action}</td>
        <td className="small audit-target">
          <div className="ellipsis mono" title={e.target ?? undefined}>
            {e.target ?? <span className="dim">—</span>}
          </div>
        </td>
        <td className="small audit-outcome-cell">
          <Outcome outcome={e.outcome} />
        </td>
      </tr>
      {open && (
        <tr className="audit-details-row">
          <td />
          <td colSpan={7}>
            <div className="audit-details">
              <dl className="kv">
                <dt>{t('audit.details.id')}</dt>
                <dd>
                  <span className="mono">{e.id}</span>
                </dd>
                <dt>{t('audit.details.time')}</dt>
                <dd>{formatDateTime(e.ts, true)}</dd>
                {e.token && (
                  <>
                    <dt>{t('audit.details.token')}</dt>
                    <dd>{e.token}</dd>
                  </>
                )}
                {e.target && (
                  <>
                    <dt>{t('audit.columns.target')}</dt>
                    <dd>
                      <span className="mono">{e.target}</span>
                    </dd>
                  </>
                )}
                <dt>{t('audit.columns.outcome')}</dt>
                <dd>
                  <span className="mono pre-wrap">{e.outcome}</span>
                </dd>
              </dl>
              {e.details ? (
                <pre className="snippet-code audit-json">{prettyDetails(e.details)}</pre>
              ) : (
                <span className="dim small">{t('audit.details.none')}</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
})
