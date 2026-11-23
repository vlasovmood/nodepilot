import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnEdgesChange,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useQueryClient } from '@tanstack/react-query'
import { Box, Server as ServerIcon, StickyNote } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiRequestError, api } from '../../api/client'
import { qk, useServers, useStatsMap } from '../../api/queries'
import type { Graph } from '../../api/types'
import { useToast } from '../../components/Toast'
import { useTheme } from '../../lib/theme'
import { appUrl } from '../../lib/util'
import { edgeTypes, GraphLiveContext, nodeTypes } from './elements'
import { Inspector, type GraphMeta } from './Inspector'
import { fromFlow, makeEdge, newId, toFlow, type FlowEdge, type FlowNode, type LinkData } from './model'
import { ServerPicker } from './ServerPicker'
import { useGraphClipboard } from './useGraphClipboard'

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

const SAVE_DELAY_MS = 800

type Props = {
  graph: Graph
  onSaveState: (s: SaveState) => void
}

export function GraphEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  )
}

function Editor({ graph, onSaveState }: Props) {
  const initial = useMemo(() => toFlow(graph.doc), [graph.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<FlowEdge>(initial.edges)
  const [pickerOpen, setPickerOpen] = useState(false)
  const rf = useReactFlow<FlowNode, FlowEdge>()
  const { t } = useTranslation('graph')
  const [theme] = useTheme()
  const toast = useToast()
  const qc = useQueryClient()

  const servers = useServers()
  const stats = useStatsMap()
  const live = useMemo(() => ({ servers: new Map((servers.data ?? []).map((s) => [s.id, s])), stats }), [servers.data, stats])

  const version = useRef(graph.version)
  const viewport = useRef<Viewport | null>(initial.viewport)
  const dirty = useRef(false)
  const saving = useRef(false)
  const conflict = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const [meta, setMeta] = useState<GraphMeta>({ name: graph.name, description: graph.description, project_id: graph.project_id })
  const latest = useRef({ nodes, edges, meta })
  latest.current = { nodes, edges, meta }

  const save = useCallback(async () => {
    if (saving.current || conflict.current || !dirty.current) return
    saving.current = true
    dirty.current = false
    onSaveState('saving')
    try {
      const { nodes: ns, edges: es, meta: m } = latest.current
      const doc = fromFlow(ns, es, viewport.current)
      const res = await api.graphs.update(graph.id, {
        doc,
        version: version.current,
        name: m.name.trim() || graph.name,
        description: m.description,
        project_id: m.project_id,
      })
      version.current = res.version
      qc.setQueryData(qk.graph(graph.id), res)
      void qc.invalidateQueries({ queryKey: qk.graphs, exact: true })
      onSaveState(dirty.current ? 'dirty' : 'saved')
    } catch (e) {
      dirty.current = true
      if (e instanceof ApiRequestError && e.status === 409) {
        conflict.current = true
        onSaveState('conflict')
      } else {
        onSaveState('error')
        toast.error(t('toast.saveFailed'), e)
      }
    } finally {
      saving.current = false
      if (dirty.current && !conflict.current) timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS * 3)
    }
  }, [graph.id, onSaveState, qc, toast, t])

  const markDirty = useCallback(() => {
    if (conflict.current) return
    dirty.current = true
    onSaveState('dirty')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
  }, [onSaveState, save])

  // Flush unsaved changes on unmount.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (dirty.current && !conflict.current) {
        const { nodes: ns, edges: es, meta: m } = latest.current
        const doc = fromFlow(ns, es, viewport.current)
        void api.graphs
          .update(graph.id, {
            doc,
            version: version.current,
            name: m.name.trim() || graph.name,
            description: m.description,
            project_id: m.project_id,
          })
          .then((res) => qc.setQueryData(qk.graph(graph.id), res))
          .catch(() => {})
      }
    },
    [graph.id, graph.name, qc],
  )
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const onNodesChange = useCallback(
    (changes: Parameters<OnNodesChange<FlowNode>>[0]) => {
      onNodesChangeBase(changes)
      // Selection and size measurements don't change the document.
      if (changes.toArray().some((c) => (c.type !== 'select' && c.type !== 'dimensions') || (c.type === 'dimensions' && c.resizing)))
        markDirty()
    },
    [onNodesChangeBase, markDirty],
  )
  const onEdgesChange = useCallback(
    (changes: Parameters<OnEdgesChange<FlowEdge>>[0]) => {
      onEdgesChangeBase(changes)
      if (changes.toArray().some((c) => c.type !== 'select')) markDirty()
    },
    [onEdgesChangeBase, markDirty],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return
      const data: LinkData = { kind: 'link', label: '', note: '', directed: false, color: null }
      const edge = makeEdge(
        { id: newId('e'), source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle },
        data,
      )
      setEdges((es) => [...es.map((e) => ({ ...e, selected: false })), { ...edge, selected: true }])
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
      markDirty()
    },
    [setEdges, setNodes, markDirty],
  )

  const viewCenter = () => {
    const el = document.querySelector('.graph-canvas')?.getBoundingClientRect()
    return rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 })
  }

  const freeSpots = (count: number, size: { w: number; h: number }) => {
    const c = viewCenter()
    const taken = latest.current.nodes.map((n) => ({
      x: n.position.x,
      y: n.position.y,
      w: n.width ?? n.measured?.width ?? 220,
      h: n.height ?? n.measured?.height ?? 80,
    }))
    const gap = 80
    const free = (x: number, y: number) =>
      taken.every((r) => x + size.w + gap <= r.x || r.x + r.w + gap <= x || y + size.h + gap <= r.y || r.y + r.h + gap <= y)
    const stepX = size.w + gap
    const stepY = size.h + gap
    const out: { x: number; y: number }[] = []
    for (let ring = 0; ring < 40 && out.length < count; ring++) {
      for (let dy = -ring; dy <= ring && out.length < count; dy++) {
        for (let dx = -ring; dx <= ring && out.length < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const x = Math.round((c.x - size.w / 2 + dx * stepX) / 10) * 10
          const y = Math.round((c.y - size.h / 2 + dy * stepY) / 10) * 10
          if (free(x, y)) {
            out.push({ x, y })
            taken.push({ x, y, w: size.w, h: size.h })
          }
        }
      }
    }
    while (out.length < count) out.push({ x: c.x + out.length * 20, y: c.y + out.length * 20 })
    return out
  }

  const addNodes = (list: FlowNode[]) => {
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...list.map((n, i) => ({ ...n, selected: i === list.length - 1 }))])
    setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)))
    markDirty()
  }

  const addService = () => {
    const [position] = freeSpots(1, { w: 220, h: 80 })
    addNodes([
      {
        id: newId('n'),
        type: 'service',
        position,
        data: { label: t('editor.newNodeLabel'), role: 'api', serverId: null, color: null, note: '' },
      },
    ])
  }

  const addNote = () => {
    const [position] = freeSpots(1, { w: 220, h: 140 })
    addNodes([{ id: newId('note'), type: 'note', position, width: 220, height: 140, data: { text: '', color: '#fef08a' } }])
  }

  const addServers = (ids: string[]) => {
    const spots = freeSpots(ids.length, { w: 220, h: 80 })
    addNodes(
      ids.map((id, i) => {
        const s = live.servers.get(id)
        return {
          id: newId('n'),
          type: 'service' as const,
          position: spots[i],
          data: { label: s?.name ?? t('editor.serverLabel'), role: 'server', serverId: id, color: null, note: '' },
        }
      }),
    )
  }

  const canvasRef = useRef<HTMLDivElement>(null)
  useGraphClipboard({
    scope: canvasRef,
    getNodes: () => latest.current.nodes,
    getEdges: () => latest.current.edges,
    setNodes,
    setEdges,
    markDirty,
    deleteSelected: () => {
      const { nodes: ns, edges: es } = latest.current
      void rf.deleteElements({ nodes: ns.filter((n) => n.selected), edges: es.filter((e) => e.selected) })
    },
  })

  const selectedNode = nodes.find((n) => n.selected)
  const selectedEdge = selectedNode ? undefined : edges.find((e) => e.selected)

  return (
    <GraphLiveContext.Provider value={live}>
      <div className="graph-shell">
        <div className="graph-canvas" ref={canvasRef}>
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onMoveEnd={(_, vp) => {
              viewport.current = vp
            }}
            onNodeDoubleClick={(_, n) => {
              if (n.type === 'service' && n.data.serverId) window.open(appUrl(`servers/${n.data.serverId}`), '_blank')
            }}
            connectionMode={ConnectionMode.Loose}
            defaultViewport={initial.viewport ?? undefined}
            fitView={!initial.viewport && initial.nodes.length > 0}
            fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
            minZoom={0.1}
            maxZoom={2.5}
            snapToGrid
            snapGrid={[10, 10]}
            deleteKeyCode={['Backspace', 'Delete']}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            className={theme === 'dark' ? 'dark' : undefined}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'link' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--graph-dots)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeBorderRadius={10}
              maskColor="var(--graph-mask)"
              nodeColor="var(--graph-mini-node)"
            />
            <Panel position="top-left">
              <div className="graph-toolbar">
                <button className="btn btn-sm" onClick={addService} title={t('editor.nodeTitle')}>
                  <Box size={14} /> {t('editor.node')}
                </button>
                <button className="btn btn-sm" onClick={() => setPickerOpen(true)} title={t('editor.serversTitle')}>
                  <ServerIcon size={14} /> {t('editor.servers')}
                </button>
                <button className="btn btn-sm" onClick={addNote} title={t('editor.noteTitle')}>
                  <StickyNote size={14} /> {t('editor.note')}
                </button>
              </div>
            </Panel>
            {nodes.length === 0 && (
              <Panel position="top-center" className="graph-empty">
                {t('editor.emptyHint')}
              </Panel>
            )}
          </ReactFlow>
        </div>
        <Inspector
          meta={meta}
          onMetaChange={(patch) => {
            setMeta((m) => ({ ...m, ...patch }))
            markDirty()
          }}
          node={selectedNode}
          edge={selectedEdge}
          nodeCount={nodes.length}
          edgeCount={edges.length}
          onNodeChange={(id, patch) => {
            setNodes((ns) => ns.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n)))
            markDirty()
          }}
          onEdgeChange={(id, patch) => {
            setEdges((es) =>
              es.map((e) => {
                if (e.id !== id || !e.data) return e
                const data = { ...e.data, ...patch }
                return { ...makeEdge(e, data), selected: e.selected }
              }),
            )
            markDirty()
          }}
          onReverseEdge={(id) => {
            setEdges((es) =>
              es.map((e) =>
                e.id === id ? { ...e, source: e.target, target: e.source, sourceHandle: e.targetHandle, targetHandle: e.sourceHandle } : e,
              ),
            )
            markDirty()
          }}
          onDelete={(kind, id) => {
            if (kind === 'node') rf.deleteElements({ nodes: [{ id }] })
            else rf.deleteElements({ edges: [{ id }] })
          }}
        />
      </div>
      <ServerPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        alreadyOnGraph={new Set(nodes.flatMap((n) => (n.type === 'service' && n.data.serverId ? [n.data.serverId] : [])))}
        onPick={(ids) => {
          setPickerOpen(false)
          addServers(ids)
        }}
      />
    </GraphLiveContext.Provider>
  )
}
