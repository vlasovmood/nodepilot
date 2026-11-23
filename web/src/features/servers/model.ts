import type { DiskUsage, Server, ServerStatus, StatsSnapshot } from '../../api/types'
import { intlLocale } from '../../i18n'
import { percentOf } from '../../lib/format'

export type ServerRow = {
  server: Server
  stats: StatsSnapshot | undefined
  status: ServerStatus
  cpu: number | null
  ramPct: number | null
  disk: DiskUsage | null
  diskPct: number | null
  load1: number | null
  uptime: number | null
}

/** Largest mount by total size — "the" disk shown in the dashboard. */
export function largestDisk(disks: DiskUsage[] | undefined): DiskUsage | null {
  if (!disks || disks.length === 0) return null
  let best = disks[0]
  for (const d of disks) if (d.total > best.total) best = d
  return best
}

export function toRow(server: Server, stats: StatsSnapshot | undefined): ServerRow {
  const disk = largestDisk(stats?.disks)
  return {
    server,
    stats,
    status: stats?.status ?? server.status,
    cpu: stats?.cpu_percent ?? null,
    ramPct: percentOf(stats?.mem_used, stats?.mem_total),
    disk,
    diskPct: disk ? percentOf(disk.used, disk.total) : null,
    load1: stats?.load?.[0] ?? null,
    uptime: stats?.uptime_secs ?? null,
  }
}

export type SortKey = 'status' | 'name' | 'host' | 'cpu' | 'ram' | 'disk' | 'load' | 'uptime'
export type SortState = { key: SortKey; dir: 'asc' | 'desc' }

const STATUS_ORDER: Record<ServerStatus, number> = { offline: 0, unknown: 1, online: 2 }

function cmpNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1 // nulls always last
  if (b === null) return -1
  return a - b
}

const collators = new Map<string, Intl.Collator>()
function getCollator(): Intl.Collator {
  const loc = intlLocale()
  let c = collators.get(loc)
  if (!c) {
    c = new Intl.Collator(loc, { numeric: true, sensitivity: 'base' })
    collators.set(loc, c)
  }
  return c
}

export function sortRows(rows: ServerRow[], sort: SortState): ServerRow[] {
  const collator = getCollator()
  const dir = sort.dir === 'asc' ? 1 : -1
  const out = rows.slice()
  out.sort((a, b) => {
    let r = 0
    switch (sort.key) {
      case 'name':
        r = collator.compare(a.server.name, b.server.name) * dir
        break
      case 'host':
        r = collator.compare(a.server.host, b.server.host) * dir
        break
      case 'status':
        r = (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dir
        break
      case 'cpu':
      case 'ram':
      case 'disk':
      case 'load':
      case 'uptime': {
        const pick = (x: ServerRow) =>
          sort.key === 'cpu'
            ? x.cpu
            : sort.key === 'ram'
              ? x.ramPct
              : sort.key === 'disk'
                ? x.diskPct
                : sort.key === 'load'
                  ? x.load1
                  : x.uptime
        const va = pick(a)
        const vb = pick(b)
        if (va === null || vb === null) r = cmpNullable(va, vb)
        else r = (va - vb) * dir
        break
      }
    }
    return r !== 0 ? r : collator.compare(a.server.name, b.server.name)
  })
  return out
}

export function matchesFilter(s: Server, term: string): boolean {
  if (!term) return true
  const t = term.toLowerCase()
  return (
    s.name.toLowerCase().includes(t) ||
    s.host.toLowerCase().includes(t) ||
    s.username.toLowerCase().includes(t) ||
    s.tags.some((x) => x.toLowerCase().includes(t)) ||
    s.description.toLowerCase().includes(t)
  )
}
