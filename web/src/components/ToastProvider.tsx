import Snackbar from '@mui/material/Snackbar'
import { useCallback, useState, type ReactNode } from 'react'
import { ToastContext } from '../lib/toast'

// Centred, clear of the desktop sidebar; on phones above the bottom bar (56 px) and the add button (56 px).
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null)
  const show = useCallback((text: string) => setToast({ text, key: Date.now() }), [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      <Snackbar key={toast?.key} open={!!toast} message={toast?.text} autoHideDuration={3000}
        onClose={(_, reason) => { if (reason !== 'clickaway') setToast(null) }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 'calc(136px + env(safe-area-inset-bottom))', md: 24 } }} />
    </ToastContext.Provider>
  )
}
