import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { intlLocale } from '../i18n'
import { cssVar, useTheme } from '../lib/theme'

export type ChartSeries = {
  label: string
  /** CSS variable name for the stroke colour, e.g. "--chart-1". */
  colorVar: string
  values: (number | null)[]
  fill?: boolean
}

type Props = {
  /** Unix timestamps in seconds. */
  xs: number[]
  series: ChartSeries[]
  height?: number
  formatY: (v: number) => string
  /** Fixed y range, e.g. [0, 100] for percentages. */
  yRange?: [number, number]
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')
    return color + a
  }
  return color
}

/** Small uPlot wrapper: responsive width, theme-aware colours, hover tooltip in the legend line. */
export function TimeChart({ xs, series, height = 160, formatY, yRange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const legendRef = useRef<HTMLDivElement>(null)
  const [theme] = useTheme()
  const { i18n } = useTranslation()
  const lang = i18n.language

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const grid = cssVar('--chart-grid')
    const text = cssVar('--text-dim')
    const spanSecs = xs.length > 1 ? xs[xs.length - 1] - xs[0] : 0
    const loc = intlLocale(lang)
    const timeFmt = new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' })
    const dayFmt = new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit' })
    const fullFmt = new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

    const axis: uPlot.Axis = {
      stroke: text,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: '11px system-ui, sans-serif',
    }

    const opts: uPlot.Options = {
      width: Math.max(200, host.clientWidth),
      height,
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: { time: true },
        y: yRange ? { range: () => yRange } : { range: (_u, _min, max) => [0, max > 0 ? max * 1.1 : 1] },
      },
      axes: [
        {
          ...axis,
          values: (_u, splits) => splits.map((v) => (spanSecs > 2 * 86400 ? dayFmt : timeFmt).format(new Date(v * 1000))),
        },
        { ...axis, size: 64, values: (_u, splits) => splits.map((v) => formatY(v)) },
      ],
      series: [
        {},
        ...series.map((s) => {
          const c = cssVar(s.colorVar) || '#3b82f6'
          return {
            label: s.label,
            stroke: c,
            width: 1.5,
            fill: s.fill ? withAlpha(c, 0.12) : undefined,
            spanGaps: false,
            points: { show: false },
          } satisfies uPlot.Series
        }),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const el = legendRef.current
            if (!el) return
            const idx = u.cursor.idx
            if (idx === null || idx === undefined) {
              el.textContent = ''
              return
            }
            const parts = [fullFmt.format(new Date((u.data[0][idx] ?? 0) * 1000))]
            series.forEach((s, i) => {
              const v = u.data[i + 1][idx]
              parts.push(`${s.label}: ${v === null || v === undefined ? '—' : formatY(v)}`)
            })
            el.textContent = parts.join('   ')
          },
        ],
      },
    }

    const data: uPlot.AlignedData = [xs, ...series.map((s) => s.values)]
    const plot = new uPlot(opts, data, host)

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth
      if (w > 0) plot.setSize({ width: w, height })
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      plot.destroy()
    }
  }, [xs, series, height, formatY, yRange, theme, lang])

  return (
    <div>
      <div ref={hostRef} style={{ width: '100%' }} />
      <div ref={legendRef} className="dim small mono" style={{ minHeight: 18, paddingTop: 2 }} />
    </div>
  )
}
