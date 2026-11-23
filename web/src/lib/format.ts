import i18n, { intlLocale } from '../i18n'

const t = (key: string, opts: Record<string, unknown> = {}): string => i18n.t(`format:${key}`, opts) as string

const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>()
function cached<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(key: string, make: (loc: string) => T): T {
  const loc = intlLocale()
  const k = `${key}|${loc}`
  let f = cache.get(k) as T | undefined
  if (!f) {
    f = make(loc)
    cache.set(k, f)
  }
  return f
}

const UNIT_KEYS = ['b', 'kb', 'mb', 'gb', 'tb', 'pb'] as const

function num(v: number, digits: number): string {
  return cached(`num${digits}`, (loc) => new Intl.NumberFormat(loc, { maximumFractionDigits: digits, minimumFractionDigits: digits })).format(v)
}

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${num(n, 0)} ${t('units.b')}`
  let v = n
  let i = 0
  while (v >= 1024 && i < UNIT_KEYS.length - 1) {
    v /= 1024
    i++
  }
  return `${num(v, v >= 100 ? 0 : digits)} ${t(`units.${UNIT_KEYS[i]}`)}`
}

export function formatBps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return t('perSecond', { value: formatBytes(n) })
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${num(n, digits)}%`
}

export function percentOf(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}

export function formatUptime(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return t('uptime.dh', { d, h })
  if (h > 0) return t('uptime.hm', { h, m })
  return t('uptime.m', { m })
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return t('duration.ms', { v: Math.round(ms) })
  const s = ms / 1000
  if (s < 60) return t('duration.s', { v: num(s, 1) })
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return t('duration.ms2', { m, s: rs })
  return t('duration.hm', { h: Math.floor(m / 60), m: m % 60 })
}

export function formatDateTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const f = cached(withSeconds ? 'dts' : 'dt', (loc) =>
    new Intl.DateTimeFormat(loc, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
    }),
  ) as Intl.DateTimeFormat
  return f.format(d)
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  const rtf = cached('rel', (loc) => new Intl.RelativeTimeFormat(loc, { numeric: 'auto' })) as Intl.RelativeTimeFormat
  const diff = (time - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return rtf.format(Math.round(diff), 'second')
  if (abs < 45 * 60) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 22 * 3600) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 26 * 86400) return rtf.format(Math.round(diff / 86400), 'day')
  return formatDateTime(iso)
}

export function formatLoad(load: [number, number, number] | null | undefined): string {
  if (!load) return '—'
  return load.map((v) => v.toFixed(2)).join(' ')
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return num(n, digits)
}

/** @deprecated Use i18next plurals: t('ns:key', { count }) with key_one/key_few/key_many/key_other. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** @deprecated See {@link pluralRu}. */
export function countRu(n: number, one: string, few: string, many: string): string {
  return `${n} ${pluralRu(n, one, few, many)}`
}
