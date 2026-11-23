import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { BulkExecResult } from '../../api/types'
import { CopyButton } from '../../components/CopyButton'
import { intlLocale } from '../../i18n'
import { Segmented } from '../../components/Tabs'
import { formatDuration } from '../../lib/format'

type Filter = 'all' | 'ok' | 'fail'

export function isSuccess(r: BulkExecResult): boolean {
  return r.ok && !r.error && r.result?.exit_code === 0
}

function resultText(r: BulkExecResult): string {
  const parts: string[] = []
  if (r.error) parts.push(`error: ${r.error}`)
  if (r.result?.stdout) parts.push(r.result.stdout)
  if (r.result?.stderr) parts.push(r.result.stderr)
  return parts.join('\n')
}

export function ExecResults({ results }: { results: BulkExecResult[] }) {
  const { t, i18n } = useTranslation('exec')
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(() => (results.length <= 5 ? new Set(results.map((r) => r.server_id)) : new Set()))

  const okCount = results.filter(isSuccess).length
  const failCount = results.length - okCount

  const shown = useMemo(() => {
    const list = filter === 'all' ? results : results.filter((r) => (filter === 'ok' ? isSuccess(r) : !isSuccess(r)))
    // failures first, then by name
    return list
      .slice()
      .sort((a, b) => Number(isSuccess(a)) - Number(isSuccess(b)) || a.server_name.localeCompare(b.server_name, intlLocale(i18n.language)))
  }, [results, filter, i18n.language])

  const allText = useMemo(
    () => shown.map((r) => `===== ${r.server_name} (exit ${r.result?.exit_code ?? '—'}) =====\n${resultText(r)}`).join('\n\n'),
    [shown],
  )

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="stack-sm">
      <div className="toolbar">
        <span className="badge badge-ok">
          <CheckCircle2 size={12} /> {t('results.success', { n: okCount })}
        </span>
        <span className={failCount ? 'badge badge-danger' : 'badge'}>
          <XCircle size={12} /> {t('results.failed', { n: failCount })}
        </span>
        <span className="spacer" />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('results.filterAll', { n: results.length }) },
            { value: 'ok', label: t('results.filterOk') },
            { value: 'fail', label: t('results.filterFail') },
          ]}
        />
        <button className="btn btn-sm" onClick={() => setExpanded(new Set(shown.map((r) => r.server_id)))}>
          {t('results.expandAll')}
        </button>
        <button className="btn btn-sm" onClick={() => setExpanded(new Set())}>
          {t('results.collapseAll')}
        </button>
        <CopyButton text={allText} label={t('results.copyAll')} />
      </div>
      {shown.length === 0 && (
        <div className="dim small" style={{ padding: 12 }}>
          {t('results.noResults')}
        </div>
      )}
      {shown.map((r) => {
        const open = expanded.has(r.server_id)
        const success = isSuccess(r)
        const res = r.result
        return (
          <div key={r.server_id} className="collapsible">
            <div className="collapsible-head" onClick={() => toggle(r.server_id)}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {success ? (
                <CheckCircle2 size={15} className="ok-text" />
              ) : r.error || !r.ok ? (
                <XCircle size={15} className="danger-text" />
              ) : (
                <CircleAlert size={15} className="warn-text" />
              )}
              <Link to={`/servers/${r.server_id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
                {r.server_name}
              </Link>
              {res && <span className={res.exit_code === 0 ? 'badge badge-ok' : 'badge badge-danger'}>exit {res.exit_code ?? '—'}</span>}
              {r.error && <span className="danger-text small ellipsis">{r.error}</span>}
              {res?.truncated && <span className="badge badge-warn">{t('results.truncated')}</span>}
              <span className="spacer" />
              {res && <span className="dim small num">{formatDuration(res.duration_ms)}</span>}
              <CopyButton text={resultText(r)} />
            </div>
            {open && (
              <div className="collapsible-body">
                {r.error && <pre className="output stderr">{r.error}</pre>}
                {res && (
                  <>
                    {res.stdout ? (
                      <div className="stack-sm">
                        <span className="field-label">stdout</span>
                        <pre className="output">{res.stdout}</pre>
                      </div>
                    ) : (
                      !res.stderr && <span className="dim small">{t('results.emptyOutput')}</span>
                    )}
                    {res.stderr && (
                      <div className="stack-sm">
                        <span className="field-label">stderr</span>
                        <pre className="output stderr">{res.stderr}</pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
