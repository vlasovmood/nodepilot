import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { NotesPanel } from '../features/notes/NotesPanel'

export function NotesPage() {
  const { t } = useTranslation('notes')
  const [params, setParams] = useSearchParams()
  const focusId = params.get('note')
  // Keep the open note in the URL (?note=<id>) so it can be linked and pinned to the sidebar.
  const onSelect = useCallback(
    (id: string | null) => {
      setParams(
        (prev) => {
          if ((prev.get('note') ?? null) === id) return prev
          const next = new URLSearchParams(prev)
          if (id) next.set('note', id)
          else next.delete('note')
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )
  return (
    <div className="page page-fill">
      <div className="page-header">
        <div className="title-block">
          <h1>{t('page.title')}</h1>
          <span className="muted small">{t('page.subtitle')}</span>
        </div>
      </div>
      <NotesPanel filters focusId={focusId} onSelect={onSelect} />
    </div>
  )
}
