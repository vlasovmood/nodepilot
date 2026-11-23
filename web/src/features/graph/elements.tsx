import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  NodeResizer,
  Position,
  useInternalNode,
  useReactFlow,
  type EdgeProps,
  type InternalNode,
  type NodeProps,
} from '@xyflow/react'
import { StickyNote } from 'lucide-react'
import { createContext, memo, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Server, StatsSnapshot } from '../../api/types'
import { StatusDot } from '../../components/StatusDot'
import { formatPercent } from '../../lib/format'
import { cx } from '../../lib/util'
import { edgeKindOf, roleOf, type FlowEdge, type NoteNode, type ServiceNode } from './model'

export type GraphLive = { servers: Map<string, Server>; stats: Map<string, StatsSnapshot> }
export const GraphLiveContext = createContext<GraphLive>({ servers: new Map(), stats: new Map() })

const SIDES = [
  { id: 't', pos: Position.Top },
  { id: 'r', pos: Position.Right },
  { id: 'b', pos: Position.Bottom },
  { id: 'l', pos: Position.Left },
]

function Handles() {
  // With ConnectionMode.Loose any handle connects to any other, so all are sources.
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s.id} id={s.id} type="source" position={s.pos} className="g-handle" />
      ))}
    </>
  )
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > 60 ? line.slice(0, 57) + '…' : line
}

export const ServiceNodeView = memo(function ServiceNodeView({ data, selected }: NodeProps<ServiceNode>) {
  const { t } = useTranslation('graph')
  const live = useContext(GraphLiveContext)
  const role = roleOf(data.role)
  const roleLabel = t(role.labelKey)
  const Icon = role.icon
  const server = data.serverId ? live.servers.get(data.serverId) : undefined
  const stats = data.serverId ? live.stats.get(data.serverId) : undefined
  const status = stats?.status ?? server?.status
  const missing = !!data.serverId && !server && live.servers.size > 0

  return (
    <div
      className={cx('g-node', selected && 'selected')}
      style={data.color ? ({ '--g-accent': data.color } as React.CSSProperties) : undefined}
    >
      <Handles />
      <div className="g-node-icon">
        <Icon size={18} />
      </div>
      <div className="g-node-body">
        <div className="g-node-title">
          {status && <StatusDot status={status} />}
          <span className="ellipsis">{data.label || roleLabel}</span>
        </div>
        <div className="g-node-sub ellipsis">
          {missing ? <span className="danger-text">{t('element.serverDeleted')}</span> : server ? `${server.host}` : roleLabel}
        </div>
        {stats?.cpu_percent != null && (
          <div className="g-node-metrics">
            CPU {formatPercent(stats.cpu_percent)}
            {stats.mem_total ? ` · RAM ${formatPercent(((stats.mem_used ?? 0) / stats.mem_total) * 100)}` : ''}
          </div>
        )}
      </div>
      {data.note.trim() && (
        <div className="g-node-note" title={data.note}>
          <StickyNote size={11} /> <span className="ellipsis">{firstLine(data.note)}</span>
        </div>
      )}
    </div>
  )
})

export const NoteNodeView = memo(function NoteNodeView({ id, data, selected }: NodeProps<NoteNode>) {
  const { t } = useTranslation('graph')
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(false)
  return (
    <div className="g-note" style={data.color ? { background: data.color } : undefined} onDoubleClick={() => setEditing(true)}>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={80} lineClassName="g-resize-line" handleClassName="g-resize-handle" />
      <Handles />
      {editing ? (
        <textarea
          className="g-note-edit nodrag nowheel"
          autoFocus
          value={data.text}
          placeholder={t('element.notePlaceholder')}
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div className="g-note-text">{data.text || <span className="g-note-placeholder">{t('element.noteEmpty')}</span>}</div>
      )}
    </div>
  )
})

// Floating edges: drawn between the nearest node borders, regardless of handles.

function nodeRect(n: InternalNode) {
  const w = n.measured.width ?? n.width ?? 220
  const h = n.measured.height ?? n.height ?? 80
  return { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w, h }
}

function borderPoint(a: InternalNode, b: InternalNode) {
  const ra = nodeRect(a)
  const rb = nodeRect(b)
  const w = ra.w / 2
  const h = ra.h / 2
  const cx = ra.x + w
  const cy = ra.y + h
  const tx = rb.x + rb.w / 2
  const ty = rb.y + rb.h / 2
  const xx = (tx - cx) / (2 * w) - (ty - cy) / (2 * h)
  const yy = (tx - cx) / (2 * w) + (ty - cy) / (2 * h)
  const k = 1 / (Math.abs(xx) + Math.abs(yy) || 1)
  return { x: w * (k * xx + k * yy) + cx, y: h * (-k * xx + k * yy) + cy }
}

function sideOf(n: InternalNode, p: { x: number; y: number }): Position {
  const r = nodeRect(n)
  const eps = 1
  if (p.x <= r.x + eps) return Position.Left
  if (p.x >= r.x + r.w - eps) return Position.Right
  if (p.y <= r.y + eps) return Position.Top
  return Position.Bottom
}

export const LinkEdgeView = memo(function LinkEdgeView(props: EdgeProps<FlowEdge>) {
  const { source, target, data, selected, markerEnd, markerStart } = props
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const { setEdges, setNodes } = useReactFlow()
  const { t } = useTranslation('graph')
  if (!sourceNode || !targetNode) return null
  const sp = borderPoint(sourceNode, targetNode)
  const tp = borderPoint(targetNode, sourceNode)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: sideOf(sourceNode, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: sideOf(targetNode, tp),
  })
  const kind = edgeKindOf(data?.kind)
  const color = data?.color ?? (selected ? 'var(--text)' : 'var(--graph-edge)')
  const showLabel = !!data?.label || !!data?.note.trim() || kind.key !== 'link'
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={18}
        style={{ stroke: color, strokeWidth: selected ? 2.5 : 1.7, strokeDasharray: kind.dashed }}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={cx('g-edge-label nodrag nopan', selected && 'selected')}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={data?.note || undefined}
            onClick={() => {
              setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
              setEdges((es) => es.map((e) => (e.selected !== (e.id === props.id) ? { ...e, selected: e.id === props.id } : e)))
            }}
          >
            {kind.key !== 'link' && <span className="g-edge-kind">{t(kind.labelKey)}</span>}
            {data?.label && <span>{data.label}</span>}
            {data?.note.trim() && <StickyNote size={11} />}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

export const nodeTypes = { service: ServiceNodeView, note: NoteNodeView }
export const edgeTypes = { link: LinkEdgeView }
