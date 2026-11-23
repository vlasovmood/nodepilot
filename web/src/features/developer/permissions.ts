import type { PermissionArea, PermissionLevel, Permissions } from '../../api/types'
import i18n from '../../i18n'

export type AreaInfo = {
  key: PermissionArea
  /** Translation keys in the `developer` namespace — translated at render time (see areaLabel() & co). */
  labelKey: string
  shortKey: string
  descriptionKey: string
  /** Only "no / allowed" makes sense (backend normalises read → write). */
  writeOnly?: boolean
  /** Granting it deserves a warning: key of the risk description. */
  dangerKey?: string
}

const defineArea = (key: PermissionArea, extra: Partial<AreaInfo> = {}): AreaInfo => ({
  key,
  labelKey: `areas.${key}.label`,
  shortKey: `areas.${key}.short`,
  descriptionKey: `areas.${key}.description`,
  ...extra,
})

export const AREAS: AreaInfo[] = [
  defineArea('servers'),
  defineArea('projects'),
  defineArea('identities'),
  defineArea('exec', { writeOnly: true, dangerKey: 'areas.exec.danger' }),
  defineArea('system'),
  defineArea('files'),
  defineArea('notes'),
  defineArea('graphs'),
  defineArea('backups'),
  defineArea('admin', { dangerKey: 'areas.admin.danger' }),
]

const tr = (key: string, opts?: Record<string, unknown>): string => i18n.t(`developer:${key}`, opts ?? {}) as string

/** Full label (matrix, MCP groups). */
export const areaLabel = (a: AreaInfo) => tr(a.labelKey)
/** Short label for compact summaries and badges. */
export const areaShort = (a: AreaInfo) => tr(a.shortKey)
export const areaDescription = (a: AreaInfo) => tr(a.descriptionKey)
export const areaDanger = (a: AreaInfo) => (a.dangerKey ? tr(a.dangerKey) : '')

export const AREA_BY_KEY = new Map<string, AreaInfo>(AREAS.map((a) => [a.key, a]))

export type Preset = 'full' | 'readonly' | 'custom'

export const FULL_ACCESS: Permissions = { full: true, areas: {} }

export function readOnlyPermissions(): Permissions {
  const areas: Permissions['areas'] = {}
  for (const a of AREAS) if (a.key !== 'exec' && a.key !== 'admin') areas[a.key] = 'read'
  return { full: false, areas }
}

/** Levels actually granted (normalised: `exec` is always write). */
function grantedAreas(p: Permissions): [PermissionArea, PermissionLevel][] {
  const out: [PermissionArea, PermissionLevel][] = []
  for (const a of AREAS) {
    const lvl = p.areas[a.key]
    if (lvl) out.push([a.key, a.writeOnly ? 'write' : lvl])
  }
  return out
}

export function isReadOnlyPreset(p: Permissions): boolean {
  if (p.full) return false
  const ro = readOnlyPermissions()
  const granted = grantedAreas(p)
  return granted.length === Object.keys(ro.areas).length && granted.every(([k, l]) => ro.areas[k] === l)
}

export function presetOf(p: Permissions): Preset {
  if (p.full) return 'full'
  if (isReadOnlyPreset(p)) return 'readonly'
  return 'custom'
}

export function levelLabel(area: PermissionArea | string, level: PermissionLevel | string): string {
  if (AREA_BY_KEY.get(area)?.writeOnly) return tr('perm.allowed')
  return level === 'write' ? tr('perm.write') : tr('perm.read')
}

/** Human summary of a token's rights. */
export function permissionsSummary(p: Permissions): { kind: 'full' | 'readonly' | 'none' | 'custom'; text: string } {
  if (p.full) return { kind: 'full', text: tr('perm.full') }
  if (isReadOnlyPreset(p)) return { kind: 'readonly', text: tr('perm.readonly') }
  const granted = grantedAreas(p)
  if (granted.length === 0) return { kind: 'none', text: tr('perm.none') }
  return {
    kind: 'custom',
    text: granted
      .map(([k, l]) => {
        const a = AREA_BY_KEY.get(k)!
        return a.writeOnly ? areaShort(a) : tr('perm.areaLevel', { area: areaShort(a), level: levelLabel(k, l) })
      })
      .join(' · '),
  }
}

/** Areas whose grant needs a warning. */
export function dangerousGrants(p: Permissions): AreaInfo[] {
  return AREAS.filter((a) => a.dangerKey && (p.full || !!p.areas[a.key]))
}

/**
 * Human label for an `x-permission` / `nodepilot/permission` value:
 * `graphs:write` → "Graphs: write", `authenticated` → "Any sign-in", absent → "Public".
 */
export function permissionLabel(perm: string | null | undefined): string {
  if (!perm) return tr('perm.public')
  if (perm === 'authenticated') return tr('perm.authenticated')
  const [area, level] = perm.split(':')
  const a = AREA_BY_KEY.get(area)
  if (!a) return perm
  if (a.writeOnly) return areaLabel(a)
  return tr('perm.areaLevel', { area: areaShort(a), level: levelLabel(area, level) })
}

export function permissionArea(perm: string | null | undefined): string | null {
  if (!perm || perm === 'authenticated') return null
  return perm.split(':')[0] ?? null
}
