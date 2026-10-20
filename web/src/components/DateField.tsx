import type { SxProps, Theme } from '@mui/material/styles'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import { useDraftDate } from '../lib/dates'

// Dates are typed and shown day first (DD-MM-YYYY) in both languages, whatever
// the browser's own language: a native date input would follow the browser.
// Values in and out are the API's YYYY-MM-DD, or '' when empty or incomplete.
// onInvalid says whether a part is half typed (day "0") or the date doesn't
// exist, so a form can wait; MUI X reports a part left empty as no date at all.
const FORMAT = 'DD-MM-YYYY'

type Props = {
  label: string
  value: string
  onChange: (iso: string) => void
  onInvalid?: (invalid: boolean) => void
  required?: boolean
  size?: 'small' | 'medium'
  helperText?: string
  fullWidth?: boolean
  sx?: SxProps<Theme>
}

export function DateField({ label, value, onChange, onInvalid, required, size, helperText, fullWidth = true, sx }: Props) {
  const [draft, change] = useDraftDate(value)
  return (
    <DatePicker
      label={label}
      format={FORMAT}
      dayOfWeekFormatter={(d) => d.format('dd')} // T2 ... CN; the default first letter is T for six days
      value={draft}
      onChange={(d) => onChange(change(d))}
      onError={(e) => onInvalid?.(e !== null)}
      slotProps={{ textField: { required, size, helperText, fullWidth, sx }, field: { clearable: !required } }}
    />
  )
}
