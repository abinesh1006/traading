import { useId } from 'react'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { date as fmtDate, timeAxis } from '../format'
import { useChartColors } from '../theme'

export interface SeriesSpec<R> {
  key: string
  label: string
  color: string
  value: (row: R) => number | null
}

interface TooltipEntry {
  value?: unknown
  name?: unknown
  color?: string
}

/** One tooltip, every series; value leads, label follows; line keys, not boxes. */
export function ChartTooltip(props: {
  active?: boolean
  payload?: ReadonlyArray<TooltipEntry>
  label?: unknown
  format: (v: number) => string
  labelFormat?: (label: string) => string
}) {
  if (!props.active || !props.payload?.length) return null
  const label = String(props.label ?? '')
  return (
    <div className="tt">
      <div className="tt-head">{props.labelFormat ? props.labelFormat(label) : label}</div>
      {props.payload.map((p, i) => (
        <div className="tt-row" key={i}>
          <span className="swatch-line" style={{ background: p.color }} />
          <span className="tt-value">{typeof p.value === 'number' ? props.format(p.value) : '—'}</span>
          {props.payload!.length > 1 && <span className="tt-name">{String(p.name ?? '')}</span>}
        </div>
      ))}
    </div>
  )
}

/**
 * Grafana-style time series on one axis: faint grid both ways, thin lines, gradient ("opacity") fill.
 * Single series: no legend (the card title names it) and a soft area fill.
 * Multiple series: the caller renders a legend; `endLabels` adds a direct label at each line's end.
 */
export function TimeSeriesChart<R extends { trade_date: string }>(props: {
  rows: R[]
  series: SeriesSpec<R>[]
  format: (v: number) => string
  axisFormat?: (v: number) => string
  height?: number
  syncId?: string
  referenceY?: { y: number; label?: string }
  endLabels?: boolean
  /** Area fill under the line. Defaults to on for a single series. */
  area?: boolean
}) {
  const uid = useId().replace(/:/g, '')
  const showArea = props.area ?? props.series.length === 1
  const c = useChartColors()
  const data = props.rows.map((r) => {
    const point: Record<string, string | number | null> = { trade_date: r.trade_date }
    for (const s of props.series) point[s.key] = s.value(r)
    return point
  })
  const last = data.length - 1
  const axis = timeAxis(props.rows.map((r) => r.trade_date), 6)
  const tick = { fill: c.muted, fontSize: 11.5 }
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 200}>
      <ComposedChart data={data} syncId={props.syncId}
                     margin={{ top: 8, right: props.endLabels ? 64 : 8, bottom: 0, left: 0 }}>
        <defs>
          {props.series.map((s) => (
            <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={c.grid} strokeDasharray="3 5" vertical={false} />
        <XAxis
          dataKey="trade_date" ticks={axis.ticks} interval={0} tickFormatter={axis.format}
          axisLine={false} tick={tick} tickLine={false} tickMargin={8} minTickGap={24}
        />
        <YAxis
          domain={['auto', 'auto']} width={56} axisLine={false} tickLine={false} tick={tick} tickCount={5}
          tickFormatter={(v: number) => (props.axisFormat ?? props.format)(v)}
        />
        {props.referenceY && (
          <ReferenceLine
            y={props.referenceY.y} stroke={c.axis} strokeDasharray="4 4" ifOverflow="extendDomain"
            label={props.referenceY.label
              ? { value: props.referenceY.label, position: 'insideTopLeft', fill: c.muted, fontSize: 11 }
              : undefined}
          />
        )}
        <Tooltip
          cursor={{ stroke: c.muted, strokeWidth: 1, strokeDasharray: '3 3' }}
          isAnimationActive={false}
          content={(p) => <ChartTooltip {...p} format={props.format} labelFormat={fmtDate} />}
        />
        {showArea && props.series.map((s) => (
          <Area
            key={`${s.key}-area`} type="monotone" dataKey={s.key} name={s.label} stroke="none"
            fill={`url(#${uid}-${s.key})`} baseValue="dataMin" legendType="none"
            isAnimationActive={false} connectNulls={false} activeDot={false} tooltipType="none"
          />
        ))}
        {props.series.map((s) => (
          <Line
            key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
            dot={false} activeDot={{ r: 5, stroke: c.surface, strokeWidth: 3, fill: s.color }}
            isAnimationActive={false} connectNulls={false}
            label={props.endLabels
              ? (lp: { index?: number; x?: number | string; y?: number | string }) =>
                  lp.index === last && lp.x != null && lp.y != null ? (
                    <text key={`${s.key}-end`} x={Number(lp.x) + 6} y={Number(lp.y)} dy={4}
                          fill={c.textSecondary} fontSize={11.5}>
                      {s.label}
                    </text>
                  ) : <g key={`${s.key}-${lp.index}`} />
              : undefined}
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
