import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useLayoutEffect, useRef, useState } from 'react'
import { useChartColors } from './palette'

export type CashflowPoint = { month: string; spent: number; income: number }

type Props = {
  data: CashflowPoint[]
  labels: { spent: string; income: string; month: string }
  formatMoney: (minor: number) => string
  formatAxis: (minor: number) => string
  formatMonth: (isoDate: string) => string
}

const HEIGHT = 220
const PAD = { top: 12, right: 8, bottom: 28, left: 64 }

// A bar with 4px rounded top corners, anchored square to the baseline.
function bar(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

// Four or five gridlines on round steps (1, 2, 2.5 or 5 times a power of ten).
function niceTicks(v: number): number[] {
  if (v <= 0) return [0, 1]
  const raw = v / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= raw) ?? raw
  const top = Math.ceil(v / step) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
}

// Spending vs income per month: paired bars on one axis, a legend, a tooltip
// per month, and the same numbers as a table for screen readers.
export function CashflowChart({ data, labels, formatMoney, formatAxis, formatMonth }: Props) {
  const colors = useChartColors()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0) // measured; never wider than its container
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ticks = niceTicks(Math.max(0, ...data.flatMap((d) => [d.spent, d.income])))
  const max = ticks[ticks.length - 1]
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const groupW = data.length ? plotW / data.length : plotW
  const barW = Math.max(4, Math.min(22, groupW * 0.28))
  const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / max) * plotH
  const hovered = hover !== null ? data[hover] : null

  return (
    <Box>
      <Stack direction="row" spacing={2} sx={{ mb: 1 }} aria-hidden>
        {(['income', 'spent'] as const).map((k) => (
          <Stack key={k} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: colors[k] }} />
            <Typography variant="caption" color="text.secondary">{labels[k]}</Typography>
          </Stack>
        ))}
      </Stack>
      <Box ref={ref} sx={{ position: 'relative', width: '100%', minWidth: 0, overflow: 'hidden' }} onMouseLeave={() => setHover(null)}>
        <svg width={width} height={HEIGHT} role="img" aria-hidden style={{ display: 'block' }}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke={colors.grid} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="currentColor" opacity={0.6}>
                {formatAxis(v)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = PAD.left + groupW * (i + 0.5)
            return (
              <g key={d.month} opacity={hover === null || hover === i ? 1 : 0.45}>
                <path d={bar(cx - barW - 1, y(d.income), barW, y(0) - y(d.income))} fill={colors.income} />
                <path d={bar(cx + 1, y(d.spent), barW, y(0) - y(d.spent))} fill={colors.spent} />
                <text x={cx} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.7}>
                  {formatMonth(d.month)}
                </text>
                <rect x={cx - groupW / 2} y={PAD.top} width={groupW} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            )
          })}
        </svg>
        {hovered && hover !== null && (
          <Box
            sx={{
              position: 'absolute', top: 0, pointerEvents: 'none', bgcolor: 'background.paper', border: 1, borderColor: 'divider',
              borderRadius: 1, px: 1.5, py: 1, boxShadow: 2, minWidth: 190,
              left: Math.min(Math.max(0, PAD.left + groupW * (hover + 0.5) - 95), Math.max(0, width - 200)),
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>{formatMonth(hovered.month)}</Typography>
            {(['income', 'spent'] as const).map((k) => (
              <Stack key={k} direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                  <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: colors[k] }} />
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{labels[k]}</Typography>
                </Stack>
                <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatMoney(hovered[k])}</Typography>
              </Stack>
            ))}
          </Box>
        )}
      </Box>
      <Box sx={visuallyHidden}>
        <table>
        <thead><tr><th>{labels.month}</th><th>{labels.income}</th><th>{labels.spent}</th></tr></thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.month}><td>{formatMonth(d.month)}</td><td>{formatMoney(d.income)}</td><td>{formatMoney(d.spent)}</td></tr>
          ))}
        </tbody>
        </table>
      </Box>
    </Box>
  )
}

const visuallyHidden = {
  position: 'absolute', width: '1px', height: '1px', p: 0, m: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
} as const
