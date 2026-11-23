import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../lib/util'
import { cx } from '../lib/util'

export function CopyButton({ text, label, small = true }: { text: string; label?: string; small?: boolean }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={cx('btn btn-ghost', small && 'btn-sm', !label && 'btn-icon')}
      title={done ? t('actions.copied') : t('actions.copy')}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(text)) {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        }
      }}
    >
      {done ? <Check size={14} className="ok-text" /> : <Copy size={14} />}
      {label}
    </button>
  )
}
