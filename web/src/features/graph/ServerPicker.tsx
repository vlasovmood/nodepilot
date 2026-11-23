import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjects, useServers, useStatsMap } from '../../api/queries'
import { Modal } from '../../components/Modal'
import { StatusDot } from '../../components/StatusDot'
import { intlLocale } from '../../i18n'
import { matchesFilter } from '../servers/model'

type Props = {
  open: boolean
  onClose: () => void
  onPick: (serverIds: string[]) => void
  alreadyOnGraph: Set<string>
}

export function ServerPicker({ open, onClose, onPick, alreadyOnGraph }: Props) {
  const { t } = useTranslation('graph')
  return (
    <Modal open={open} onClose={onClose} title={t('picker.title')} size="md">
      {open && <PickerBody onPick={onPick} onClose={onClose} alreadyOnGraph={alreadyOnGraph} />}
    </Modal>
  )
}

function PickerBody({ onPick, onClose, alreadyOnGraph }: Omit<Props, 'open'>) {
  const { t } = useTranslation('graph')
  const servers = useServers()
  const stats = useStatsMap()
  const projects = useProjects()
  const [q, setQ] = useState('')
  const [project, setProject] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const list = useMemo(
    () =>
      (servers.data ?? [])
        .filter((s) => matchesFilter(s, q.trim()) && (!project || s.project_ids.includes(project)))
        .sort((a, b) => a.name.localeCompare(b.name, intlLocale())),
    [servers.data, q, project],
  )

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="stack">
      <div className="row">
        <div className="input-icon grow">
          <Search size={14} />
          <input className="input" autoFocus placeholder={t('picker.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 180 }} value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">{t('picker.allProjects')}</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row small muted">
        <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(list.map((s) => s.id)))} disabled={list.length === 0}>
          {t('picker.selectAll', { n: list.length })}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
          {t('picker.clearSelection')}
        </button>
      </div>
      <div className="picker-list">
        {servers.isPending && (
          <div className="muted small" style={{ padding: 12 }}>
            {t('common:state.loading')}
          </div>
        )}
        {!servers.isPending && list.length === 0 && (
          <div className="muted small" style={{ padding: 12 }}>
            {t('picker.nothingFound')}
          </div>
        )}
        {list.map((s) => (
          <label key={s.id} className="picker-item">
            <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
            <StatusDot status={stats.get(s.id)?.status ?? s.status} />
            <span className="ellipsis" style={{ fontWeight: 600 }}>
              {s.name}
            </span>
            <span className="dim mono ellipsis small">{s.host}</span>
            {alreadyOnGraph.has(s.id) && (
              <span className="badge" style={{ marginInlineStart: 'auto' }}>
                {t('picker.alreadyOnGraph')}
              </span>
            )}
          </label>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          {t('common:actions.cancel')}
        </button>
        <button className="btn btn-primary" disabled={selected.size === 0} onClick={() => onPick([...selected])}>
          {selected.size > 0 ? t('picker.addCount', { n: selected.size }) : t('common:actions.add')}
        </button>
      </div>
    </div>
  )
}
