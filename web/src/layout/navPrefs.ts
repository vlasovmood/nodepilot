import { useSyncExternalStore } from 'react'

export const PAGES = ['servers', 'graphs', 'exec', 'identities', 'backups', 'notes'] as const
export type PageId = (typeof PAGES)[number]
export type PinKind = 'server' | 'graph' | 'note'

export type NavEntry = { kind: 'page'; id: PageId; hidden?: boolean } | { kind: PinKind; id: string; hidden?: boolean }

const KEY = 'np.nav.items'
/** Earlier builds stored the items under the key the section's open flag uses. */
const LEGACY_KEY = 'np.nav.main'
const PIN_KINDS: readonly string[] = ['server', 'graph', 'note']

export const entryKey = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`

export function defaultEntries(): NavEntry[] {
  return PAGES.map((id) => ({ kind: 'page', id }))
}

/** Drops unknown or duplicate entries and appends built-in pages that are missing (e.g. added in a newer version). */
function normalize(raw: unknown): NavEntry[] {
  if (!Array.isArray(raw)) return defaultEntries()
  const out: NavEntry[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const { kind, id, hidden } = v as Record<string, unknown>
    if (typeof id !== 'string' || typeof kind !== 'string') continue
    const ok = kind === 'page' ? (PAGES as readonly string[]).includes(id) : PIN_KINDS.includes(kind)
    const key = `${kind}:${id}`
    if (!ok || seen.has(key)) continue
    seen.add(key)
    out.push({ kind, id, ...(hidden === true ? { hidden: true } : {}) } as NavEntry)
  }
  for (const id of PAGES) if (!seen.has(`page:${id}`)) out.push({ kind: 'page', id })
  return out
}

function read(): NavEntry[] {
  try {
    const s = localStorage.getItem(KEY)
    if (s) return normalize(JSON.parse(s))
    const legacy = localStorage.getItem(LEGACY_KEY)
    return legacy?.startsWith('[') ? normalize(JSON.parse(legacy)) : defaultEntries()
  } catch {
    return defaultEntries()
  }
}

let cache: NavEntry[] | null = null
const listeners = new Set<() => void>()

function snapshot(): NavEntry[] {
  if (!cache) cache = read()
  return cache
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return
    cache = null
    cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function setNavEntries(next: NavEntry[]) {
  cache = normalize(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
  listeners.forEach((l) => l())
}

/** Sidebar "Navigation" items: order, hidden flags and pinned servers/graphs/notes. Stored per browser. */
export function useNavEntries(): NavEntry[] {
  return useSyncExternalStore(subscribe, snapshot, defaultEntries)
}

export function togglePin(kind: PinKind, id: string) {
  const cur = snapshot()
  const key = entryKey({ kind, id })
  setNavEntries(cur.some((e) => entryKey(e) === key) ? cur.filter((e) => entryKey(e) !== key) : [...cur, { kind, id }])
}
