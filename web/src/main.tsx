import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { AppTheme } from './components/AppTheme'
import { DatesProvider } from './components/DatesProvider'
import { config } from './config'
import { storeUrlFor } from './lib/store'
import { session } from './auth/session'
import './i18n'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, refetchInterval: 60_000, retry: 1 } },
})

// Nothing from one signed-in person stays in memory for the next.
session.subscribe(() => {
  if (!session.token()) queryClient.clear()
})

const store = storeUrlFor(navigator.userAgent, config)
if (store) window.location.replace(store)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppTheme>
      <QueryClientProvider client={queryClient}>
        <DatesProvider>
          <App />
        </DatesProvider>
      </QueryClientProvider>
    </AppTheme>
  </StrictMode>,
)
