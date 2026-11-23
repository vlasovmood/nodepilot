import { Check } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGUAGES, setLanguage, type LangCode } from '../i18n'
import { cx } from '../lib/util'
import { Modal } from './Modal'

function useCurrentLanguage(): LangCode {
  const { i18n } = useTranslation()
  const lng = i18n.resolvedLanguage ?? i18n.language
  return LANGUAGES.find((l) => l.code === lng)?.code ?? LANGUAGES.find((l) => l.code === lng?.split('-')[0])?.code ?? 'en'
}

export function LanguageSelect({ small, className, style }: { small?: boolean; className?: string; style?: CSSProperties }) {
  const { t } = useTranslation()
  const current = useCurrentLanguage()
  return (
    <select
      className={cx('select', small && 'select-sm', className)}
      style={style}
      value={current}
      aria-label={t('language.interface')}
      title={t('language.interface')}
      onChange={(e) => void setLanguage(e.target.value as LangCode)}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code} lang={l.code} dir={l.rtl ? 'rtl' : 'ltr'}>
          {l.name}
        </option>
      ))}
    </select>
  )
}

export function LanguageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const current = useCurrentLanguage()
  return (
    <Modal open={open} onClose={onClose} title={t('language.interface')} size="sm">
      <div role="radiogroup" aria-label={t('language.interface')} className="stack" style={{ gap: 2 }}>
        {LANGUAGES.map((l) => {
          const active = l.code === current
          return (
            <button
              key={l.code}
              type="button"
              role="radio"
              aria-checked={active}
              className="menu-item"
              style={active ? { background: 'var(--bg-active)', fontWeight: 600 } : undefined}
              onClick={() => {
                void setLanguage(l.code)
                onClose()
              }}
            >
              <span lang={l.code} dir={l.rtl ? 'rtl' : 'ltr'} className="grow">
                {l.name}
              </span>
              {active && <Check size={14} />}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
