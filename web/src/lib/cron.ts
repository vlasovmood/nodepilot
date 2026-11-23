// Backend uses 6-field cron with seconds: "sec min hour day-of-month month day-of-week" (UTC).

import i18n from '../i18n'

export type CronPreset = {
  labelKey: string
  value: string
  /** Computed on every access; read it at render time to follow the current language. */
  readonly label: string
}

function preset(labelKey: string, value: string): CronPreset {
  return {
    labelKey,
    value,
    get label() {
      return i18n.t(`common:cron.presets.${labelKey}`)
    },
  }
}

export const CRON_PRESETS: CronPreset[] = [
  preset('hourly', '0 0 * * * *'),
  preset('every6h', '0 0 */6 * * *'),
  preset('every12h', '0 0 */12 * * *'),
  preset('daily0000', '0 0 0 * * *'),
  preset('daily0300', '0 0 3 * * *'),
  preset('daily0500', '0 0 5 * * *'),
  preset('sunday0400', '0 0 4 * * Sun'),
  preset('monday0300', '0 0 3 * * Mon'),
  preset('monthly0300', '0 0 3 1 * *'),
]

export function describeCron(expr: string | null | undefined): string {
  if (!expr) return i18n.t('common:cron.manual')
  const found = CRON_PRESETS.find((p) => p.value === expr.trim())
  return found ? found.label : expr
}

/** Light syntax check: 6 (or 7 with year) whitespace-separated fields of allowed characters. */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 6 || parts.length > 7) {
    return i18n.t('common:cron.errors.fieldCount')
  }
  if (!parts.every((p) => /^[\w*/,\-?#LW]+$/.test(p))) return i18n.t('common:cron.errors.invalidChars')
  return null
}
