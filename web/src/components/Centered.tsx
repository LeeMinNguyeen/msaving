import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import type { ReactNode } from 'react'

// Narrow card for the sign-in and setup screens; full width on a phone.
export function Centered({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: { xs: 'start stretch', sm: 'center' }, p: { xs: 0, sm: 2 } }}>
      <Paper
        variant="outlined"
        sx={{ width: '100%', maxWidth: 440, mx: 'auto', p: 3, border: { xs: 0, sm: 1 }, borderColor: { sm: 'divider' } }}
      >
        {children}
      </Paper>
    </Box>
  )
}
