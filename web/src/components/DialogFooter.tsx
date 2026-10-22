import DialogActions from '@mui/material/DialogActions'
import type { ReactNode } from 'react'

// Every dialog's buttons: other actions first, then a spacer, then Cancel and the main action on the right.
export function DialogFooter({ children }: { children: ReactNode }) {
  return <DialogActions disableSpacing sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>{children}</DialogActions>
}
