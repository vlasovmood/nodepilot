import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

type Item = { id: string; label: ReactNode }

export function CheckList({
  items,
  value,
  onChange,
  empty,
  maxHeight,
}: {
  items: Item[]
  value: string[]
  onChange: (v: string[]) => void
  empty?: string
  maxHeight?: number
}) {
  const { t } = useTranslation()
  if (!items.length)
    return (
      <div className="check-list dim small" style={{ padding: 8 }}>
        {empty ?? t('state.noItems')}
      </div>
    )
  return (
    <div className="check-list" style={maxHeight ? { maxHeight } : undefined}>
      {items.map((it) => (
        <label key={it.id} className="checkbox">
          <input
            type="checkbox"
            checked={value.includes(it.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))}
          />
          {it.label}
        </label>
      ))}
    </div>
  )
}
