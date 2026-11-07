import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
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
 * Time-series line chart on one axis. Single series: no legend (the card title names it).
 * Multiple series: the caller renders a legend; this adds a direct label at each line's end.
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
}) {
  const c = useChartColors()
  const data = props.rows.map((r) => {
    const point: Record<string, string | number | null> = { trade_date: r.trade_date }
    for (const s of props.series) point[s.key] = s.value(r)
    return point
  })
  const last = data.length - 1
  const axis = timeAxis(props.rows.map((r) => r.trade_date))
  return (
    <ResponsiveContainer width="100%" height={props.height ?? 220}>
      <LineChart data={data} syncId={props.syncId} margin={{ top: 8, right: props.endLabels ? 56 : 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis
          dataKey="trade_date" ticks={axis.ticks} interval={0} tickFormatter={axis.format}
          stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false}
        />
        <YAxis
          domain={['auto', 'auto']} width={64} stroke={c.axis} axisLine={false} tickLine={false}
          tick={{ fill: c.muted, fontSize: 11 }}
          tickFormatter={(v: number) => (props.axisFormat ?? props.format)(v)}
        />
        {props.referenceY && (
          <ReferenceLine
            y={props.referenceY.y} stroke={c.axis}
            label={props.referenceY.label
              ? { value: props.referenceY.label, position: 'insideTopLeft', fill: c.muted, fontSize: 11 }
              : undefined}
          />
        )}
        <Tooltip
          cursor={{ stroke: c.axis, strokeWidth: 1 }}
          isAnimationActive={false}
          content={(p) => <ChartTooltip {...p} format={props.format} labelFormat={fmtDate} />}
        />
        {props.series.map((s) => (
          <Line
            key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
            dot={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
            isAnimationActive={false} connectNulls={false}
            label={props.endLabels
              ? (lp: { index?: number; x?: number | string; y?: number | string }) =>
                  lp.index === last && lp.x != null && lp.y != null ? (
                    <text key={`${s.key}-end`} x={Number(lp.x) + 6} y={Number(lp.y)} dy={4}
                          fill={c.textSecondary} fontSize={11}>
                      {s.label}
                    </text>
                  ) : <g key={`${s.key}-${lp.index}`} />
              : undefined}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
