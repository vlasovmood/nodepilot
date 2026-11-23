import type { ReactNode } from 'react'
import { cx } from '../lib/util'

export type TabDef<K extends string> = { key: K; label: ReactNode; icon?: ReactNode }

export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef<K>[]
  value: K
  onChange: (k: K) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          className={cx('tab', value === t.key && 'active')}
          onClick={() => onChange(t.key)}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Segmented<K extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: K; label: ReactNode }[]
  value: K
  onChange: (k: K) => void
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={cx(value === o.value && 'active')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
