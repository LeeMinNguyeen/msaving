import type { SxProps, Theme } from '@mui/material/styles'
import { TimeField as MuiTimeField } from '@mui/x-date-pickers/TimeField'
import { useDraftTime } from '../lib/dates'

// A time of day, typed and shown as HH:mm on a 24-hour clock in both languages. Values in and out are HH:mm, or ''
// while incomplete.
type Props = { label: string; value: string; onChange: (hhmm: string) => void; required?: boolean; sx?: SxProps<Theme> }

export function TimeField({ label, value, onChange, required, sx }: Props) {
  const [draft, change] = useDraftTime(value)
  return (
    <MuiTimeField label={label} format="HH:mm" ampm={false} value={draft} onChange={(d) => onChange(change(d))}
      required={required} fullWidth sx={sx} />
  )
}
