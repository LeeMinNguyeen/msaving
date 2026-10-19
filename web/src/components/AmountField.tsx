import TextField, { type TextFieldProps } from '@mui/material/TextField'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { groupWhileTyping, parseAmount } from '../lib/money'

type Props = Omit<TextFieldProps, 'value' | 'onChange'> & {
  value: string
  onChange: (text: string) => void
  minorUnit: number
}

// Amount input: groups thousands while typing and reads the number by the
// language's separators ("1.250" in Vietnamese is one thousand two hundred fifty).
export function AmountField({ value, onChange, minorUnit, ...props }: Props) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const bad = value.trim() !== '' && parseAmount(value, minorUnit, lang) === null
  return (
    <TextField
      {...props}
      value={value}
      onChange={(e) => onChange(groupWhileTyping(e.target.value, lang))}
      error={bad || props.error}
      helperText={bad ? t('errors.amount') : props.helperText}
      slotProps={{ htmlInput: { inputMode: minorUnit ? 'decimal' : 'numeric', autoComplete: 'off' } }}
    />
  )
}
