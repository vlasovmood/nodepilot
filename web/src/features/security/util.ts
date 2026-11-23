import type { AuditSeverity } from '../../api/types'

export const SEVERITIES: AuditSeverity[] = ['info', 'warning', 'critical']

const V4 = /^(\d{1,3}|\*)(\.(\d{1,3}|\*|\?)){0,3}(\/\d{1,2})?$/
const V6 = /^[0-9a-f:.*?]+(\/\d{1,3})?$/i

/**
 * Light client-side check of an sshd `from=` entry: an IPv4/IPv6 address, a CIDR network or a wildcard
 * pattern (`10.0.0.*`), optionally negated with `!`. The server validates again.
 */
export function isValidAddress(raw: string): boolean {
  const s = raw.startsWith('!') ? raw.slice(1) : raw
  if (!s || s.length > 64) return false
  if (s.includes(':')) {
    if (!V6.test(s)) return false
    const bits = s.split('/')[1]
    return bits === undefined || Number(bits) <= 128
  }
  if (!V4.test(s)) return false
  const [addr, bits] = s.split('/')
  if (bits !== undefined && (Number(bits) > 32 || addr.includes('*'))) return false
  const parts = addr.split('.')
  if (bits !== undefined && parts.length !== 4) return false
  if (!addr.includes('*') && !addr.includes('?') && parts.length !== 4) return false
  return parts.every((p) => p === '*' || p === '?' || Number(p) <= 255)
}

/** Scroll to a card of the security page and briefly highlight it. */
export function scrollToSection(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.remove('sec-flash')
  void el.offsetWidth // restart the animation
  el.classList.add('sec-flash')
}
