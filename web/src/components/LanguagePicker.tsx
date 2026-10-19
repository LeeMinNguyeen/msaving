import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { useTranslation } from 'react-i18next'
import { currentLanguage, languages, setLanguage, type Language } from '../i18n'

export function LanguagePicker({ onChange }: { onChange?: (lang: Language) => void }) {
  const { t } = useTranslation()
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={currentLanguage()}
      aria-label={t('language.label')}
      onChange={(_, lang: Language | null) => {
        if (!lang) return
        setLanguage(lang)
        onChange?.(lang)
      }}
    >
      {languages.map((l) => (
        <ToggleButton key={l} value={l}>
          {t(`language.${l}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
