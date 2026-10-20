import type { SxProps, Theme } from '@mui/material/styles'
import { DatePicker } from '@mui/x-date-pickers/DatePicker'
import dayjs, { type Dayjs } from 'dayjs'
import { useState } from 'react'

// Dates are typed and shown day first (DD/MM/YYYY) in both languages, whatever
// the browser's own language: a native date input would follow the browser.
// Values in and out are the API's YYYY-MM-DD, or '' when empty or incomplete.
const FORMAT = 'DD/MM/YYYY'
const ISO = 'YYYY-MM-DD'

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

const parse = (iso: string): Dayjs | null => (iso ? dayjs(iso) : null)
const isoOf = (d: Dayjs | null): string => (d && d.isValid() ? d.format(ISO) : '')

export function DateField({ label, value, onChange, required, size, helperText, fullWidth = true, sx }: Props) {
  // A half-typed date stays here while the parent sees '', so a parent that
  // stores '' (the filters, in the URL) doesn't wipe what's being typed.
  const [inner, setInner] = useState(() => parse(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (value !== isoOf(inner)) setInner(parse(value))
  }
  return (
    <DatePicker
      label={label}
      format={FORMAT}
      dayOfWeekFormatter={(d) => d.format('dd')} // T2 ... CN; the default first letter is T for six days
      value={inner}
      onChange={(d) => {
        setInner(d)
        onChange(isoOf(d))
      }}
      slotProps={{ textField: { required, size, helperText, fullWidth, sx }, field: { clearable: !required } }}
    />
  )
}
