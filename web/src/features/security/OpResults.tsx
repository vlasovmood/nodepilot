import { CheckCircle2, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { ServerOpResult } from '../../api/types'
import { Modal } from '../../components/Modal'
import { Empty } from '../../components/States'

/** Per-server results of a panel-key operation (deploy / rotate / revoke). */
export function OpResultsTable({ results }: { results: ServerOpResult[] }) {
  const { t } = useTranslation('security')
  if (results.length === 0) return <Empty title={t('results.empty')} />
  const ok = results.filter((r) => r.ok).length
  return (
    <div className="stack-sm">
      <div className="row small">
        <span className="badge badge-ok">
          <CheckCircle2 size={11} /> {t('results.ok', { count: ok })}
        </span>
        {ok < results.length && (
          <span className="badge badge-danger">
            <XCircle size={11} /> {t('results.failed', { count: results.length - ok })}
          </span>
        )}
      </div>
      <div className="table-wrap" style={{ maxHeight: 360 }}>
        <table className="table" data-testid="op-results">
          <thead>
            <tr>
              <th>{t('common:fields.server')}</th>
              <th>{t('common:fields.status')}</th>
              <th>{t('results.details')}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.server_id}>
                <td className="nowrap" style={{ fontWeight: 600 }}>
                  <Link to={`/servers/${r.server_id}`}>{r.server_name}</Link>
                </td>
                <td className="nowrap">
                  {r.ok ? (
                    <span className="ok-text row" style={{ gap: 4 }}>
                      <CheckCircle2 size={13} /> {t('results.okShort')}
                    </span>
                  ) : (
                    <span className="danger-text row" style={{ gap: 4 }}>
                      <XCircle size={13} /> {t('results.errorShort')}
                    </span>
                  )}
                </td>
                <td className="wrap small">
                  {r.error ? <span className="danger-text pre-wrap">{r.error}</span> : <span className="dim">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function OpResultsModal({
  title,
  results,
  onClose,
  children,
}: {
  title: string
  results: ServerOpResult[] | null
  onClose: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation('security')
  return (
    <Modal
      open={!!results}
      onClose={onClose}
      size="lg"
      title={title}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('common:actions.close')}
        </button>
      }
    >
      {results && (
        <div className="stack">
          {children}
          <OpResultsTable results={results} />
        </div>
      )}
    </Modal>
  )
}
