/**
 * Fixed width for virtual-table rows: the sum of the column minimums. Each row is its own grid, so sizing rows
 * by their content would make columns drift between rows.
 */
export function gridMinWidth(cols: string): number {
  return (cols.match(/\d+(?=px)/g) ?? []).reduce((sum, n) => sum + Number(n), 0)
}

/** Plain-text preview of Markdown: drops markup but keeps words like `pg-main` intact. */
export function markdownExcerpt(md: string, max = 120): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s*/gm, '')
    .replace(/[`*~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Absolute URL of an in-app route, honoring the build-time base path (NODEPILOT_BASE_PATH). */
export function appUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, '')
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fallback for non-secure contexts (plain http on a LAN IP)
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

/** Run async tasks with limited concurrency; never rejects, returns settled results in input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---- POSIX path helpers (remote paths are always '/'-separated) ----

export function joinPath(dir: string, name: string): string {
  if (!dir || dir === '/') return '/' + name.replace(/^\/+/, '')
  return dir.replace(/\/+$/, '') + '/' + name.replace(/^\/+/, '')
}

export function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i)
}

export function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function splitPath(p: string): { name: string; path: string }[] {
  const parts = p.split('/').filter(Boolean)
  const out = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += '/' + part
    out.push({ name: part, path: acc })
  }
  return out
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function downloadUrl(url: string, fileName?: string): void {
  const a = document.createElement('a')
  a.href = url
  if (fileName) a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Save a text file generated in the browser (recovery codes, key files). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  downloadUrl(url, fileName)
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
