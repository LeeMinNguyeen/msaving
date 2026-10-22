import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { AppTheme } from '../components/AppTheme'
import { DatesProvider } from '../components/DatesProvider'
import { ToastProvider } from '../components/ToastProvider'
import i18n from '../i18n'

export const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

// Shows the current address, so a test can see where the app navigated.
// oxlint-disable-next-line react/only-export-components -- a test helper: fast refresh doesn't apply
function Where() {
  const { pathname, search } = useLocation()
  return <div data-testid="where">{pathname + search}</div>
}

// An address in the history, with the state a link gave it if any.
type Entry = string | { pathname: string; state?: unknown }

// The app's providers around one screen. English by default so tests read
// plainly; pass lang: 'vi' to check Vietnamese.
export async function renderApp(ui: ReactElement, opts: { route?: string; history?: Entry[]; lang?: 'vi' | 'en'; client?: QueryClient } = {}) {
  await i18n.changeLanguage(opts.lang ?? 'en')
  const client = opts.client ?? testClient()
  const entries = opts.history ?? [opts.route ?? '/']
  // A wrapper, so rerender() keeps the providers.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppTheme>
      <QueryClientProvider client={client}>
        <DatesProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
              <Routes>
                <Route path="*" element={<>{children}<Where /></>} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </DatesProvider>
      </QueryClientProvider>
    </AppTheme>
  )
  return { ...render(ui, { wrapper }), client }
}

// MUI's useMediaQuery reads window.matchMedia; jsdom has none, which reads as
// a phone in light mode. desktop(true) matches the width queries; dark: true
// matches prefers-color-scheme: dark too.
export function desktop(on: boolean, { dark = false } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-color-scheme') ? dark && query.includes('dark') : on, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
