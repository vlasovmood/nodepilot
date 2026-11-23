import { useTranslation } from 'react-i18next'
import type { ServerStatus } from '../api/types'
import i18n from '../i18n'

export function StatusDot({ status, title }: { status: ServerStatus; title?: string }) {
  const { t } = useTranslation()
  return <span className={`dot dot-${status}`} title={title ?? t(`status.${status}`)} />
}

export function statusLabel(s: ServerStatus): string {
  return i18n.t(`common:status.${s}`)
}
