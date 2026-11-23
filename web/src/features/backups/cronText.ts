import type { TFunction } from 'i18next'
import { CRON_PRESETS, validateCron } from '../../lib/cron'

// lib/cron.ts holds the preset expressions; their labels live in backups.json (`cron.presets.*`),
// so they are translated at render time and follow language switches.
const PRESET_KEYS: Record<string, string> = {
  '0 0 * * * *': 'hourly',
  '0 0 */6 * * *': 'every6h',
  '0 0 */12 * * *': 'every12h',
  '0 0 0 * * *': 'daily0000',
  '0 0 3 * * *': 'daily0300',
  '0 0 5 * * *': 'daily0500',
  '0 0 4 * * Sun': 'sunday0400',
  '0 0 3 * * Mon': 'monday0300',
  '0 0 3 1 * *': 'monthly0300',
}

/** Translated label of a preset expression, or `null` if it isn't a known preset. */
export function presetLabel(t: TFunction, value: string): string | null {
  const key = PRESET_KEYS[value.trim()]
  if (key) return t(`backups:cron.presets.${key}`)
  return CRON_PRESETS.find((p) => p.value === value.trim())?.label ?? null
}

/** Human-readable schedule: "manual", a preset label, or the raw cron expression. */
export function describeSchedule(t: TFunction, expr: string | null | undefined): string {
  if (!expr) return t('backups:cron.manual')
  return presetLabel(t, expr) ?? expr
}

/** Translation key (in `backups`) of the cron syntax error, or `null` when the expression looks valid. */
export function cronErrorKey(expr: string): string | null {
  if (!validateCron(expr)) return null
  const n = expr.trim().split(/\s+/).length
  return n < 6 || n > 7 ? 'cron.errors.fields' : 'cron.errors.chars'
}
