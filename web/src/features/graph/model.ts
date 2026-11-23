import type { Edge, Node, Viewport } from '@xyflow/react'
import { MarkerType } from '@xyflow/react'
import { Box, Braces, Cloud, Database, Globe, HardDrive, Inbox, Server, ShieldCheck, Split, Zap, type LucideIcon } from 'lucide-react'
import type { GraphDoc, GraphDocEdge, GraphDocNode } from '../../api/types'

export type Role = { key: string; labelKey: string; icon: LucideIcon }

export const ROLES: Role[] = [
  { key: 'server', labelKey: 'roles.server', icon: Server },
  { key: 'api', labelKey: 'roles.api', icon: Braces },
  { key: 'web', labelKey: 'roles.web', icon: Globe },
  { key: 'db', labelKey: 'roles.db', icon: Database },
  { key: 'cache', labelKey: 'roles.cache', icon: Zap },
  { key: 'queue', labelKey: 'roles.queue', icon: Inbox },
  { key: 'storage', labelKey: 'roles.storage', icon: HardDrive },
  { key: 'lb', labelKey: 'roles.lb', icon: Split },
  { key: 'vpn', labelKey: 'roles.vpn', icon: ShieldCheck },
  { key: 'internet', labelKey: 'roles.internet', icon: Cloud },
  { key: 'other', labelKey: 'roles.other', icon: Box },
]

export function roleOf(key: string | null | undefined): Role {
  return ROLES.find((r) => r.key === key) ?? ROLES[ROLES.length - 1]
}

export type EdgeKind = { key: string; labelKey: string; dashed?: string; animated?: boolean; directed: boolean; both?: boolean }

export const EDGE_KINDS: EdgeKind[] = [
  { key: 'link', labelKey: 'edgeKinds.link', directed: false },
  { key: 'depends', labelKey: 'edgeKinds.depends', directed: true },
  { key: 'cascade', labelKey: 'edgeKinds.cascade', dashed: '6 5', animated: true, directed: true },
  { key: 'vpn', labelKey: 'edgeKinds.vpn', dashed: '2 5', directed: false },
  { key: 'replication', labelKey: 'edgeKinds.replication', dashed: '10 4 2 4', directed: true, both: true },
  { key: 'other', labelKey: 'edgeKinds.other', directed: false },
]

export function edgeKindOf(key: string | null | undefined): EdgeKind {
  return EDGE_KINDS.find((k) => k.key === key) ?? EDGE_KINDS[0]
}

export const NODE_COLORS = ['#f5f5f5', '#4ade80', '#60a5fa', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#2dd4bf']
export const NOTE_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#e5e5e5']

export type ServiceData = { label: string; role: string; serverId: string | null; color: string | null; note: string }
export type NoteData = { text: string; color: string | null }
export type ServiceNode = Node<ServiceData, 'service'>
export type NoteNode = Node<NoteData, 'note'>
export type FlowNode = ServiceNode | NoteNode

export type LinkData = { kind: string; label: string; note: string; directed: boolean; color: string | null }
export type FlowEdge = Edge<LinkData, 'link'>

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

export function edgeMarkers(d: LinkData) {
  const kind = edgeKindOf(d.kind)
  const color = d.color ?? 'var(--graph-edge)'
  const arrow = { type: MarkerType.ArrowClosed, width: 18, height: 18, color }
  return {
    markerEnd: d.directed ? arrow : undefined,
    markerStart: d.directed && kind.both ? arrow : undefined,
    animated: !!kind.animated,
  }
}

export function makeEdge(
  base: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  data: LinkData,
): FlowEdge {
  return { ...base, type: 'link', data, ...edgeMarkers(data) }
}

export function toFlow(doc: GraphDoc): { nodes: FlowNode[]; edges: FlowEdge[]; viewport: Viewport | null } {
  const nodes: FlowNode[] = doc.nodes.map((n) =>
    n.type === 'note'
      ? {
          id: n.id,
          type: 'note',
          position: { x: n.x, y: n.y },
          width: n.width ?? 220,
          height: n.height ?? 140,
          data: { text: n.note, color: n.color ?? null },
        }
      : {
          id: n.id,
          type: 'service',
          position: { x: n.x, y: n.y },
          data: { label: n.label, role: n.role ?? 'other', serverId: n.server_id ?? null, color: n.color ?? null, note: n.note },
        },
  )
  const edges = doc.edges.map((e) =>
    makeEdge(
      { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null },
      { kind: e.kind, label: e.label, note: e.note, directed: e.directed, color: e.color ?? null },
    ),
  )
  return { nodes, edges, viewport: doc.viewport ?? null }
}

export function fromFlow(nodes: FlowNode[], edges: FlowEdge[], viewport: Viewport | null): GraphDoc {
  const docNodes: GraphDocNode[] = nodes.map((n) => {
    const base = { id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }
    if (n.type === 'note') {
      return {
        ...base,
        type: 'note',
        width: Math.round(n.width ?? n.measured?.width ?? 220),
        height: Math.round(n.height ?? n.measured?.height ?? 140),
        label: '',
        color: n.data.color,
        note: n.data.text,
      }
    }
    return {
      ...base,
      type: 'node',
      label: n.data.label,
      role: n.data.role,
      server_id: n.data.serverId,
      color: n.data.color,
      note: n.data.note,
    }
  })
  const docEdges: GraphDocEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    label: e.data?.label ?? '',
    kind: e.data?.kind ?? 'link',
    directed: e.data?.directed ?? false,
    color: e.data?.color ?? null,
    note: e.data?.note ?? '',
  }))
  return {
    nodes: docNodes,
    edges: docEdges,
    viewport: viewport ? { x: Math.round(viewport.x), y: Math.round(viewport.y), zoom: viewport.zoom } : null,
  }
}
