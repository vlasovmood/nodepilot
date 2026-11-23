import { useEffect, useRef, type RefObject } from 'react'
import { makeEdge, newId, type FlowEdge, type FlowNode } from './model'

const MARKER = 'nodepilot/graph-clip'
const OFFSET = 40

type Clip = { [MARKER]: 1; nodes: FlowNode[]; edges: FlowEdge[] }

/** Shared across graphs in this tab, so nodes can be copied from one graph and pasted into another. */
let memoryClip: Clip | null = null

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.cm-editor')
}

function parseClip(text: string | undefined): Clip | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as Partial<Clip>
    return v && v[MARKER] === 1 && Array.isArray(v.nodes) && Array.isArray(v.edges) ? (v as Clip) : null
  } catch {
    return null
  }
}

/** Copy only what defines the node; React Flow re-measures the rest. */
function cleanNode(n: FlowNode): FlowNode {
  const { id, type, position, data, width, height } = n
  return { id, type, position, data: structuredClone(data), ...(width ? { width } : {}), ...(height ? { height } : {}) } as FlowNode
}

type Api = {
  /** Element that must contain the focus/pointer for shortcuts to apply (the canvas). */
  scope: RefObject<HTMLElement | null>
  getNodes: () => FlowNode[]
  getEdges: () => FlowEdge[]
  setNodes: (fn: (ns: FlowNode[]) => FlowNode[]) => void
  setEdges: (fn: (es: FlowEdge[]) => FlowEdge[]) => void
  deleteSelected: () => void
  markDirty: () => void
}

/**
 * Graph keyboard shortcuts: Ctrl/Cmd+C, X, V (via clipboard events, so the system clipboard works across tabs)
 * and Ctrl/Cmd+A. They are ignored while typing in inputs, the inspector or a dialog.
 */
export function useGraphClipboard(api: Api) {
  const ref = useRef(api)
  useEffect(() => {
    ref.current = api
  })
  const pasteCount = useRef(0)

  useEffect(() => {
    // Only react when the user is working with the canvas, not with forms elsewhere on the page.
    const active = (e: Event) => {
      if (isEditable(e.target) || isEditable(document.activeElement)) return false
      if (document.querySelector('.modal-overlay')) return false
      const scope = ref.current.scope.current
      if (!scope) return false
      const ae = document.activeElement
      return !ae || ae === document.body || scope.contains(ae)
    }

    const selection = (): Clip | null => {
      const nodes = ref.current.getNodes().filter((n) => n.selected)
      if (!nodes.length) return null
      const ids = new Set(nodes.map((n) => n.id))
      const edges = ref.current.getEdges().filter((e) => ids.has(e.source) && ids.has(e.target))
      return { [MARKER]: 1, nodes: nodes.map(cleanNode), edges: edges.map((e) => ({ ...e, selected: false })) }
    }

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      if (!active(e)) return
      const clip = selection()
      if (!clip) return
      e.preventDefault()
      memoryClip = clip
      pasteCount.current = 0
      e.clipboardData?.setData('text/plain', JSON.stringify(clip))
      if (cut) ref.current.deleteSelected()
    }
    const copy = (e: ClipboardEvent) => onCopy(e, false)
    const cut = (e: ClipboardEvent) => onCopy(e, true)

    const paste = (e: ClipboardEvent) => {
      if (!active(e)) return
      const clip = parseClip(e.clipboardData?.getData('text/plain')) ?? memoryClip
      if (!clip || !clip.nodes.length) return
      e.preventDefault()
      pasteCount.current += 1
      const shift = OFFSET * pasteCount.current
      const idMap = new Map<string, string>()
      const nodes = clip.nodes.map((n) => {
        const id = newId(n.type === 'note' ? 'note' : 'n')
        idMap.set(n.id, id)
        return { ...cleanNode(n), id, position: { x: n.position.x + shift, y: n.position.y + shift }, selected: true } as FlowNode
      })
      const edges = clip.edges.flatMap((ed) => {
        const source = idMap.get(ed.source)
        const target = idMap.get(ed.target)
        if (!source || !target || !ed.data) return []
        const edge = makeEdge(
          { id: newId('e'), source, target, sourceHandle: ed.sourceHandle, targetHandle: ed.targetHandle },
          structuredClone(ed.data),
        )
        return [{ ...edge, selected: false }]
      })
      ref.current.setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...nodes])
      ref.current.setEdges((es) => [...es.map((x) => (x.selected ? { ...x, selected: false } : x)), ...edges])
      ref.current.markDirty()
    }

    const keydown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a' || !active(e)) return
      e.preventDefault()
      ref.current.setNodes((ns) => ns.map((n) => (n.selected ? n : { ...n, selected: true })))
    }

    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', paste)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', paste)
      document.removeEventListener('keydown', keydown)
    }
  }, [])
}
