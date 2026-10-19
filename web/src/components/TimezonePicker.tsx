import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'

const zones: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC', 'Asia/Ho_Chi_Minh']
  }
})()

type Props = { label: string; value: string | null; onChange: (tz: string | null) => void; disabled?: boolean }

export function TimezonePicker({ label, value, onChange, disabled }: Props) {
  return (
    <Autocomplete
      // The server stores canonical names (Asia/Ho_Chi_Minh), which some browsers list under an old alias.
      options={value && !zones.includes(value) ? [value, ...zones] : zones}
      value={value}
      onChange={(_, v) => onChange(v)}
      autoHighlight
      disabled={disabled}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  )
}
