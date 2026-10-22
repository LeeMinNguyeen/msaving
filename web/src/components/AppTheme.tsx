import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import type { ReactNode } from 'react'
import { theme } from '../theme'

// Light, dark, or the device's setting (the default), chosen on Profile and security and kept in this browser.
export function AppTheme({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={theme} defaultMode="system" modeStorageKey="waterflow.theme">
      <CssBaseline />
      {children}
    </ThemeProvider>
  )
}
