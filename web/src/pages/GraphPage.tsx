import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, CloudOff, Loader2, RefreshCw, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { api } from '../api/client'
import { qk } from '../api/queries'
import { ErrorState, Loading } from '../components/States'
import { GraphEditor, type SaveState } from '../features/graph/GraphEditor'

function SaveIndicator({ state, onReload }: { state: SaveState; onReload: () => void }) {
  const { t } = useTranslation('graph')
  switch (state) {
    case 'saved':
      return (
        <span className="save-state">
          <Check size={14} /> {t('save.saved')}
        </span>
      )
    case 'dirty':
    case 'saving':
      return (
        <span className="save-state">
          <Loader2 size={14} className="spin" /> {t('save.saving')}
        </span>
      )
    case 'error':
      return (
        <span className="save-state danger-text">
          <CloudOff size={14} /> {t('save.error')}
        </span>
      )
    case 'conflict':
      return (
        <span className="save-state warn-text">
          <AlertTriangle size={14} /> {t('save.conflict')}
          <button className="btn btn-sm" onClick={onReload}>
            <RefreshCw size={13} /> {t('save.reload')}
          </button>
        </span>
      )
  }
}

export function GraphPage() {
  const { t } = useTranslation('graph')
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [reloadKey, setReloadKey] = useState(0)
  const graph = useQuery({ queryKey: qk.graph(id), queryFn: () => api.graphs.get(id), staleTime: Infinity, refetchOnWindowFocus: false })

  if (graph.isPending) return <Loading />
  if (graph.isError) return <ErrorState error={graph.error} onRetry={() => void graph.refetch()} title={t('page.notFound')} />

  const reload = async () => {
    await qc.fetchQuery({ queryKey: qk.graph(id), queryFn: () => api.graphs.get(id) })
    setSaveState('saved')
    setReloadKey((k) => k + 1)
  }

  return (
    <div className="page page-fill">
      <div className="page-header">
        <button className="btn btn-ghost btn-icon" title={t('page.backToList')} onClick={() => navigate('/graphs')}>
          <ArrowLeft size={16} />
        </button>
        <div className="title-block">
          <h1>
            <Waypoints size={17} /> {graph.data.name}
          </h1>
          <span className="muted small">{graph.data.description || t('page.defaultSubtitle')}</span>
        </div>
        <div className="actions">
          <SaveIndicator state={saveState} onReload={() => void reload()} />
        </div>
      </div>
      <GraphEditor key={`${graph.data.id}:${reloadKey}`} graph={graph.data} onSaveState={setSaveState} />
    </div>
  )
}
