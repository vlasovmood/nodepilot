import { cx } from '../lib/util'

export function meterLevel(pct: number): '' | 'warn' | 'crit' {
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return ''
}

export function Meter({ percent, label, title }: { percent: number | null; label?: string; title?: string }) {
  if (percent === null || !Number.isFinite(percent)) return <span className="dim">—</span>
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className="meter" title={title}>
      <div className="meter-bar">
        <div className={cx('meter-fill', meterLevel(p))} style={{ width: `${p}%` }} />
      </div>
      <span className="meter-label">{label ?? `${p.toFixed(0)}%`}</span>
    </div>
  )
}
