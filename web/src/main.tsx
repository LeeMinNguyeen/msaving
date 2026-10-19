import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { config } from './config'
import { storeUrlFor } from './lib/store'
import './i18n'
import { supabase } from './lib/supabase'
import { theme } from './theme'

// Several devices at once: refetch when the window regains focus and about every minute.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, refetchInterval: 60_000, retry: 1 } },
})

// Nothing from one signed-in person stays in memory for the next.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') queryClient.clear()
})

// Phones go to the mobile app's store page once it's published.
const store = storeUrlFor(navigator.userAgent, config)
if (store) window.location.replace(store)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
