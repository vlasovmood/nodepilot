import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'np.favorites'
const listeners = new Set<() => void>()
let cache: Set<string> | null = null

function load(): Set<string> {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    cache = new Set()
  }
  return cache
}

function save(next: Set<string>) {
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useFavorites(): [Set<string>, (id: string) => void] {
  const favs = useSyncExternalStore(subscribe, load, load)
  const toggle = useCallback((id: string) => {
    const next = new Set(load())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save(next)
  }, [])
  return [favs, toggle]
}
