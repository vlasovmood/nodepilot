import { useCallback, useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

const KEY = 'np.theme'
const listeners = new Set<() => void>()

function read(): Theme {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' ? 'light' : 'dark'
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const theme = useSyncExternalStore(subscribe, read, () => 'dark' as Theme)
  const toggle = useCallback(() => setTheme(read() === 'dark' ? 'light' : 'dark'), [])
  return [theme, setTheme, toggle]
}

/** Read a CSS custom property from :root (used by canvas-based charts / xterm). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
