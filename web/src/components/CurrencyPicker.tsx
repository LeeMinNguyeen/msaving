import Autocomplete from '@mui/material/Autocomplete'
import TextField from '@mui/material/TextField'
import { useMemo } from 'react'
import { currencyLabel } from '../lib/labels'
import { useCurrencies } from '../lib/queries'

type Props = {
  label: string
  value: string | null
  onChange: (code: string | null) => void
  helperText?: string
  disabled?: boolean
}

export function CurrencyPicker({ label, value, onChange, helperText, disabled }: Props) {
  const currencies = useCurrencies()
  const options = useMemo(() => [...(currencies.data?.keys() ?? [])], [currencies.data])
  return (
    <Autocomplete
      options={options}
      value={value}
      onChange={(_, v) => onChange(v)}
      getOptionLabel={(code) => currencyLabel(code, currencies.data?.get(code)?.name)}
      loading={currencies.isPending}
      disabled={disabled}
      autoHighlight
      renderInput={(params) => <TextField {...params} label={label} helperText={helperText} />}
    />
  )
}
