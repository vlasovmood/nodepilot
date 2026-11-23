import { ArrowLeftRight, ExternalLink, MousePointerClick, Trash2 } from 'lucide-react'
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjects } from '../../api/queries'
import { Field } from '../../components/Field'
import { StatusDot } from '../../components/StatusDot'
import { intlLocale } from '../../i18n'
import { appUrl, cx } from '../../lib/util'
import { GraphLiveContext } from './elements'
import {
  EDGE_KINDS,
  edgeKindOf,
  NODE_COLORS,
  NOTE_COLORS,
  ROLES,
  type FlowEdge,
  type FlowNode,
  type LinkData,
  type NoteData,
  type ServiceData,
} from './model'

export type GraphMeta = { name: string; description: string; project_id: string | null }

type Props = {
  meta: GraphMeta
  onMetaChange: (patch: Partial<GraphMeta>) => void
  node: FlowNode | undefined
  edge: FlowEdge | undefined
  nodeCount: number
  edgeCount: number
  onNodeChange: (id: string, patch: Partial<ServiceData> | Partial<NoteData>) => void
  onEdgeChange: (id: string, patch: Partial<LinkData>) => void
  onReverseEdge: (id: string) => void
  onDelete: (kind: 'node' | 'edge', id: string) => void
}

function Swatches({ colors, value, onChange }: { colors: string[]; value: string | null; onChange: (c: string | null) => void }) {
  const { t } = useTranslation('graph')
  return (
    <div className="swatches">
      <button
        type="button"
        className={cx('swatch', value === null && 'active')}
        style={{ background: 'var(--bg-hover)' }}
        title={t('inspector.defaultColor')}
        onClick={() => onChange(null)}
      />
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={cx('swatch', value === c && 'active')}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}

const HELP_ITEMS = ['connect', 'select', 'note', 'openServer', 'delete', 'shortcuts'] as const

export function Inspector(p: Props) {
  return (
    <aside className="graph-inspector">
      {p.node ? <NodePanel {...p} node={p.node} /> : p.edge ? <EdgePanel {...p} edge={p.edge} /> : <GraphPanel {...p} />}
    </aside>
  )
}

function GraphPanel({ meta, onMetaChange, nodeCount, edgeCount }: Props) {
  const { t } = useTranslation('graph')
  const projects = useProjects()
  return (
    <div className="stack">
      <div className="inspector-title">{t('inspector.graph')}</div>
      <Field label={t('common:fields.name')}>
        <input className="input" value={meta.name} onChange={(e) => onMetaChange({ name: e.target.value })} />
      </Field>
      <Field label={t('common:fields.description')}>
        <textarea className="textarea" rows={3} value={meta.description} onChange={(e) => onMetaChange({ description: e.target.value })} />
      </Field>
      <Field label={t('common:fields.project')}>
        <select className="select" value={meta.project_id ?? ''} onChange={(e) => onMetaChange({ project_id: e.target.value || null })}>
          <option value="">{t('common:noProject')}</option>
          {projects.data?.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="muted small">{t('inspector.counts', { nodes: nodeCount, edges: edgeCount })}</div>
      <div className="inspector-help">
        <div className="row" style={{ gap: 6, fontWeight: 600, color: 'var(--text)' }}>
          <MousePointerClick size={14} /> {t('inspector.helpTitle')}
        </div>
        <ul>
          {HELP_ITEMS.map((k) => (
            <li key={k}>{t(`inspector.help.${k}`)}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function NodePanel({ node, onNodeChange, onDelete }: Props & { node: FlowNode }) {
  const { t } = useTranslation('graph')
  const live = useContext(GraphLiveContext)
  const servers = [...live.servers.values()].sort((a, b) => a.name.localeCompare(b.name, intlLocale()))

  if (node.type === 'note') {
    return (
      <div className="stack">
        <div className="inspector-title">{t('inspector.note')}</div>
        <Field label={t('inspector.noteText')}>
          <textarea
            className="textarea"
            rows={10}
            autoFocus={!node.data.text}
            value={node.data.text}
            placeholder={t('inspector.notePlaceholder')}
            onChange={(e) => onNodeChange(node.id, { text: e.target.value })}
          />
        </Field>
        <Field label={t('common:fields.color')}>
          <Swatches colors={NOTE_COLORS} value={node.data.color} onChange={(color) => onNodeChange(node.id, { color })} />
        </Field>
        <button className="btn btn-danger-ghost" onClick={() => onDelete('node', node.id)}>
          <Trash2 size={14} /> {t('inspector.deleteNote')}
        </button>
      </div>
    )
  }

  const d = node.data
  const server = d.serverId ? live.servers.get(d.serverId) : undefined
  const status = d.serverId ? (live.stats.get(d.serverId)?.status ?? server?.status) : undefined
  return (
    <div className="stack">
      <div className="inspector-title">{t('inspector.node')}</div>
      <Field label={t('common:fields.name')}>
        <input className="input" value={d.label} onChange={(e) => onNodeChange(node.id, { label: e.target.value })} />
      </Field>
      <Field label={t('inspector.role')}>
        <select className="select" value={d.role} onChange={(e) => onNodeChange(node.id, { role: e.target.value })}>
          {ROLES.map((r) => (
            <option key={r.key} value={r.key}>
              {t(r.labelKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('inspector.server')} hint={t('inspector.serverHint')}>
        <select
          className="select"
          value={d.serverId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null
            const s = id ? live.servers.get(id) : undefined
            // Take the server's name unless the label was customized.
            const patch: Partial<ServiceData> = { serverId: id }
            if (s && (!d.label || d.label === t('editor.newNodeLabel') || d.label === server?.name)) patch.label = s.name
            onNodeChange(node.id, patch)
          }}
        >
          <option value="">{t('inspector.notBound')}</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.host}
            </option>
          ))}
          {d.serverId && !server && <option value={d.serverId}>{t('inspector.deletedServer')}</option>}
        </select>
      </Field>
      {server && (
        <a className="btn btn-sm" href={appUrl(`servers/${server.id}`)} target="_blank" rel="noreferrer">
          {status && <StatusDot status={status} />} {t('inspector.openServer', { name: server.name })} <ExternalLink size={12} />
        </a>
      )}
      <Field label={t('common:fields.color')}>
        <Swatches colors={NODE_COLORS} value={d.color} onChange={(color) => onNodeChange(node.id, { color })} />
      </Field>
      <Field label={t('common:fields.note')}>
        <textarea
          className="textarea"
          rows={6}
          value={d.note}
          placeholder={t('inspector.nodeNotePlaceholder')}
          onChange={(e) => onNodeChange(node.id, { note: e.target.value })}
        />
      </Field>
      <button className="btn btn-danger-ghost" onClick={() => onDelete('node', node.id)}>
        <Trash2 size={14} /> {t('inspector.deleteNode')}
      </button>
    </div>
  )
}

function EdgePanel({ edge, onEdgeChange, onReverseEdge, onDelete }: Props & { edge: FlowEdge }) {
  const { t } = useTranslation('graph')
  const d = edge.data ?? { kind: 'link', label: '', note: '', directed: false, color: null }
  return (
    <div className="stack">
      <div className="inspector-title">{t('inspector.edge')}</div>
      <Field label={t('common:fields.type')}>
        <select
          className="select"
          value={d.kind}
          onChange={(e) => onEdgeChange(edge.id, { kind: e.target.value, directed: edgeKindOf(e.target.value).directed })}
        >
          {EDGE_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {t(k.labelKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('inspector.edgeLabel')} hint={t('inspector.edgeLabelHint')}>
        <input className="input" value={d.label} onChange={(e) => onEdgeChange(edge.id, { label: e.target.value })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={d.directed} onChange={(e) => onEdgeChange(edge.id, { directed: e.target.checked })} />
        {t('inspector.directed')}
      </label>
      {d.directed && (
        <button className="btn btn-sm" onClick={() => onReverseEdge(edge.id)}>
          <ArrowLeftRight size={13} /> {t('inspector.reverse')}
        </button>
      )}
      <Field label={t('common:fields.color')}>
        <Swatches colors={NODE_COLORS.slice(1)} value={d.color} onChange={(color) => onEdgeChange(edge.id, { color })} />
      </Field>
      <Field label={t('common:fields.note')}>
        <textarea
          className="textarea"
          rows={6}
          value={d.note}
          placeholder={t('inspector.edgeNotePlaceholder')}
          onChange={(e) => onEdgeChange(edge.id, { note: e.target.value })}
        />
      </Field>
      <button className="btn btn-danger-ghost" onClick={() => onDelete('edge', edge.id)}>
        <Trash2 size={14} /> {t('inspector.deleteEdge')}
      </button>
    </div>
  )
}
