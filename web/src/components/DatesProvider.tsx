import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { enUS, viVN } from '@mui/x-date-pickers/locales'
import 'dayjs/locale/en-gb'
import 'dayjs/locale/vi'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

// The date pickers' calendar (month and day names, buttons) in the UI language.
// en-gb starts weeks on Monday, as Vietnamese does.
export function DatesProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const vi = i18n.language === 'vi'
  const localeText = (vi ? viVN : enUS).components.MuiLocalizationProvider.defaultProps.localeText
  return (
    <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale={vi ? 'vi' : 'en-gb'} localeText={localeText}>
      {children}
    </LocalizationProvider>
  )
}
