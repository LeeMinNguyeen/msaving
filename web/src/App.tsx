import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import { useEffect, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useParams } from 'react-router'
import { useSession } from './auth/useSession'
import { useErrorText } from './components/errors'
import { Shell } from './components/Shell'
import { setLanguage } from './i18n'
import { ApiError } from './lib/api'
import { useBooks, useMe } from './lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import { Centered } from './components/Centered'
import { MfaChallenge } from './components/MfaChallenge'
import { AccountClosing } from './pages/AccountClosing'
import { UpdatedPolicy } from './pages/UpdatedPolicy'
import { Profile } from './pages/Profile'
import { Accounts } from './pages/Accounts'
import { BookSettings } from './pages/BookSettings'
import { Categories } from './pages/Categories'
import { ChooseUsername } from './pages/ChooseUsername'
import { CreateBook } from './pages/CreateBook'
import { Dashboard } from './pages/Dashboard'
import { SignIn } from './pages/SignIn'
import { Transactions } from './pages/Transactions'

function Loading() {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '50dvh' }}>
      <CircularProgress />
    </Box>
  )
}

function Failed({ error }: { error: unknown }) {
  const errorText = useErrorText()
  return (
    <Box sx={{ p: 2 }}>
      <Alert severity="error">{errorText(error)}</Alert>
    </Box>
  )
}

// Signed in, confirmed email, and an account (username + consent). Otherwise
// show the step that's missing.
function RequireAccount() {
  const session = useSession()
  const me = useMe(!!session)
  const qc = useQueryClient()
  const language = me.data?.profile?.language
  useEffect(() => {
    if (language) setLanguage(language) // the saved language wins once signed in
  }, [language])

  if (session === undefined) return <Loading />
  if (session === null) return <Navigate to="/sign-in" replace />
  if (me.isPending) return <Loading />
  if (me.isError && me.error instanceof ApiError && me.error.code === 'mfa_required') {
    return <Centered><MfaChallenge onDone={() => qc.invalidateQueries()} /></Centered>
  }
  if (me.isError) return <Failed error={me.error} />
  const profile = me.data.profile
  if (!profile) return <ChooseUsername />
  if (profile.deletion_requested_at) return <AccountClosing requestedAt={profile.deletion_requested_at} needsConsent={me.data.needs_consent} />
  if (me.data.needs_consent) return <UpdatedPolicy />
  return <Outlet />
}

// "/" goes to the first open book, or to Create a book when there's none.
function Home() {
  const books = useBooks()
  if (books.isPending) return <Loading />
  if (books.isError) return <Failed error={books.error} />
  const first = books.data.find((b) => !b.archived_at) ?? books.data[0]
  return <Navigate to={first ? `/books/${first.id}` : '/books/new'} replace />
}

type Page = 'dashboard' | 'transactions' | 'accounts' | 'categories' | 'settings' | 'profile'

function InBook({ page }: { page: Page }) {
  const { bookId } = useParams()
  const books = useBooks()
  if (books.isPending) return <Loading />
  if (books.isError) return <Failed error={books.error} />
  const book = books.data.find((b) => b.id === bookId)
  if (!book) return <Navigate to="/" replace />
  const pages: Record<Page, ReactNode> = {
    dashboard: <Dashboard book={book} />,
    transactions: <Transactions book={book} />,
    accounts: <Accounts book={book} />,
    categories: <Categories book={book} />,
    settings: <BookSettings key={book.version} book={book} />,
    profile: <Profile />,
  }
  const content = pages[page]
  return <Shell book={book}>{content}</Shell>
}

function PublicOnly() {
  const session = useSession()
  if (session === undefined) return <Loading />
  if (session) return <Navigate to="/" replace />
  return <SignIn />
}

const router = createBrowserRouter([
  { path: '/sign-in', element: <PublicOnly /> },
  {
    element: <RequireAccount />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/books/new', element: <CreateBook /> },
      { path: '/books/:bookId', element: <InBook page="dashboard" /> },
      { path: '/books/:bookId/transactions', element: <InBook page="transactions" /> },
      { path: '/books/:bookId/accounts', element: <InBook page="accounts" /> },
      { path: '/books/:bookId/categories', element: <InBook page="categories" /> },
      { path: '/books/:bookId/profile', element: <InBook page="profile" /> },
      { path: '/books/:bookId/settings', element: <InBook page="settings" /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
