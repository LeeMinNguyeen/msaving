import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import { useTranslation } from 'react-i18next'
import { currentLanguage, languages, setLanguage, type Language } from '../i18n'

// Each language in its own name. Without value and onChange it is the screen's language, remembered in this browser.
export function LanguagePicker({ value, onChange = setLanguage, size, helperText }: {
  value?: Language; onChange?: (lang: Language) => void; size?: 'small'; helperText?: string
}) {
  const { t } = useTranslation()
  return (
    <TextField select label={t('language.label')} value={value ?? currentLanguage()} size={size} helperText={helperText}
      onChange={(e) => onChange(e.target.value as Language)} sx={size && { minWidth: 140 }}>
      {languages.map((l) => <MenuItem key={l} value={l}>{t(`language.${l}`)}</MenuItem>)}
    </TextField>
  )
}
