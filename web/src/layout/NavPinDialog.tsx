import { useQuery } from '@tanstack/react-query'
import { Check, FileText, Search, Server as ServerIcon, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client'
import { qk, useServers } from '../api/queries'
import { Modal } from '../components/Modal'
import { Spinner } from '../components/States'
import { Tabs } from '../components/Tabs'
import { cx } from '../lib/util'
import { entryKey, togglePin, useNavEntries, type PinKind } from './navPrefs'

type Row = { id: string; label: string; sub?: string }

export function NavPinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation('layout')
  const [tab, setTab] = useState<PinKind>('server')
  const [q, setQ] = useState('')
  const entries = useNavEntries()
  const pinned = useMemo(() => new Set(entries.map(entryKey)), [entries])

  const servers = useServers()
  const graphs = useQuery({ queryKey: qk.graphs, queryFn: () => api.graphs.list(), enabled: open })
  const notes = useQuery({ queryKey: qk.notes(), queryFn: () => api.notes.list(), enabled: open })

  const source = tab === 'server' ? servers : tab === 'graph' ? graphs : notes
  const rows = useMemo<Row[]>(() => {
    let list: Row[] = []
    if (tab === 'server') list = (servers.data ?? []).map((s) => ({ id: s.id, label: s.name, sub: `${s.username}@${s.host}` }))
    if (tab === 'graph')
      list = (graphs.data ?? []).map((g) => ({ id: g.id, label: g.name, sub: t('sidebar.nav.picker.nodes', { count: g.node_count }) }))
    if (tab === 'note') list = (notes.data ?? []).map((n) => ({ id: n.id, label: n.title.trim() || t('sidebar.nav.untitled') }))
    const term = q.trim().toLowerCase()
    return list
      .filter((r) => !term || r.label.toLowerCase().includes(term) || r.sub?.toLowerCase().includes(term))
      .sort((a, b) => a.label.localeCompare(b.label, i18n.language))
  }, [tab, servers.data, graphs.data, notes.data, q, t, i18n.language])

  const icon = tab === 'server' ? <ServerIcon size={15} /> : tab === 'graph' ? <Workflow size={15} /> : <FileText size={15} />

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('sidebar.nav.picker.title')}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('sidebar.nav.done')}
        </button>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Tabs<PinKind>
          tabs={[
            { key: 'server', label: t('sidebar.nav.picker.servers'), icon: <ServerIcon size={14} /> },
            { key: 'graph', label: t('sidebar.nav.picker.graphs'), icon: <Workflow size={14} /> },
            { key: 'note', label: t('sidebar.nav.picker.notes'), icon: <FileText size={14} /> },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="input-icon">
          <Search size={14} />
          <input
            className="input"
            autoFocus
            placeholder={t('sidebar.nav.picker.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="pin-list">
          {source.isPending ? (
            <div className="row dim small" style={{ padding: 12 }}>
              <Spinner /> <span>{t('common:state.loading')}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="dim small" style={{ padding: 12 }}>
              {t('sidebar.nav.picker.empty')}
            </div>
          ) : (
            rows.map((r) => {
              const on = pinned.has(entryKey({ kind: tab, id: r.id }))
              return (
                <button key={r.id} className={cx('pin-row', on && 'on')} aria-pressed={on} onClick={() => togglePin(tab, r.id)}>
                  {icon}
                  <span className="pin-text">
                    <span className="ellipsis">{r.label}</span>
                    {r.sub && <span className="dim small ellipsis mono">{r.sub}</span>}
                  </span>
                  <span className="pin-state">{on ? <Check size={15} /> : t('sidebar.nav.add')}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </Modal>
  )
}
