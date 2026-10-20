import type { SxProps, Theme } from '@mui/material/styles'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { useDraftDate } from '../lib/dates'

// Dates are typed and shown day first (DD/MM/YYYY) in both languages, whatever
// the browser's own language: a native date input would follow the browser.
// Values in and out are the API's YYYY-MM-DD, or '' when empty or incomplete.
const FORMAT = 'DD/MM/YYYY'

type Props = {
  label: string
  value: string
  onChange: (iso: string) => void
  required?: boolean
  size?: 'small' | 'medium'
  helperText?: string
  fullWidth?: boolean
  sx?: SxProps<Theme>
}

export function DateField({ label, value, onChange, required, size, helperText, fullWidth = true, sx }: Props) {
  const [draft, change] = useDraftDate(value)
  return (
    <DatePicker
      label={label}
      format={FORMAT}
      dayOfWeekFormatter={(d) => d.format('dd')} // T2 ... CN; the default first letter is T for six days
      value={draft}
      onChange={(d) => onChange(change(d))}
      slotProps={{ textField: { required, size, helperText, fullWidth, sx }, field: { clearable: !required } }}
    />
  )
}
