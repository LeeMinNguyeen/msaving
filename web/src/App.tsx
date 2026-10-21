import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import { useEffect, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useParams } from 'react-router'
import { useSession } from './auth/useSession'
import { useErrorText } from './components/errors'
import { IdleSignOut } from './components/IdleSignOut'
import { Shell } from './components/Shell'
import { UpdatingNotice } from './components/UpdatingNotice'
import { setLanguage } from './i18n'
import { useBooks, useInstance, useMe } from './lib/queries'
import { useUpdating } from './lib/updating'
import { AccountClosing } from './pages/AccountClosing'
import { Admin } from './pages/Admin'
import { Profile } from './pages/Profile'
import { Accounts } from './pages/Accounts'
import { BookSettings } from './pages/BookSettings'
import { Categories } from './pages/Categories'
import { CreateBook } from './pages/CreateBook'
import { Dashboard } from './pages/Dashboard'
import { Join, Reset, Setup } from './pages/Join'
import { SignIn } from './pages/SignIn'
import { Transactions } from './pages/Transactions'

function Loading() {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '50dvh' }}>
      <CircularProgress />
    </Box>
  )
}

// Only when there's nothing to show yet: a refresh that fails later keeps the
// page as it was (the server may be restarting, and every query retries).
function Failed({ error }: { error: unknown }) {
  const errorText = useErrorText()
  const updating = useUpdating()
  return (
    <Box sx={{ p: 2 }}>
      {updating ? <UpdatingNotice /> : <Alert severity="error">{errorText(error)}</Alert>}
    </Box>
  )
}

// Signed in, with an open account. Otherwise sign-in, or the closing screen.
function RequireAccount() {
  const signedIn = useSession()
  const me = useMe(signedIn)
  const idleMinutes = useInstance().data?.idle_sign_out_minutes ?? null
  const language = me.data?.profile.language
  useEffect(() => {
    if (language) setLanguage(language) // the saved language wins once signed in
  }, [language])

  if (!signedIn) return <Navigate to="/sign-in" replace />
  if (me.isPending) return <Loading />
  if (!me.data) return <Failed error={me.error} />
  const profile = me.data.profile
  return (
    <>
      <IdleSignOut minutes={idleMinutes} />
      {profile.deletion_requested_at ? <AccountClosing requestedAt={profile.deletion_requested_at} /> : <Outlet />}
    </>
  )
}

// "/" goes to the first open book, or to Create a book when there's none.
function Home() {
  const books = useBooks()
  if (books.isPending) return <Loading />
  if (!books.data) return <Failed error={books.error} />
  const first = books.data.find((b) => !b.archived_at) ?? books.data[0]
  return <Navigate to={first ? `/books/${first.id}` : '/books/new'} replace />
}

type Page = 'dashboard' | 'transactions' | 'accounts' | 'categories' | 'settings' | 'profile' | 'admin'

function InBook({ page }: { page: Page }) {
  const { bookId } = useParams()
  const books = useBooks()
  if (books.isPending) return <Loading />
  if (!books.data) return <Failed error={books.error} />
  const book = books.data.find((b) => b.id === bookId)
  if (!book) return <Navigate to="/" replace />
  const pages: Record<Page, ReactNode> = {
    dashboard: <Dashboard book={book} />,
    transactions: <Transactions book={book} />,
    accounts: <Accounts book={book} />,
    categories: <Categories book={book} />,
    settings: <BookSettings key={book.version} book={book} />,
    profile: <Profile />,
    admin: <Admin />,
  }
  const content = pages[page]
  return <Shell book={book}>{content}</Shell>
}

// Screens for people not signed in. A server with no admin yet shows only setup.
function PublicOnly({ page }: { page: 'sign-in' | 'join' | 'reset' }) {
  const signedIn = useSession()
  const instance = useInstance()
  if (signedIn && page !== 'reset') return <Navigate to="/" replace />
  if (instance.isPending) return <Loading />
  if (!instance.data) return <Failed error={instance.error} />
  if (instance.data.setup_needed) return <Setup />
  return { 'sign-in': <SignIn />, join: <Join />, reset: <Reset /> }[page]
}

const router = createBrowserRouter([
  { path: '/sign-in', element: <PublicOnly page="sign-in" /> },
  { path: '/join', element: <PublicOnly page="join" /> },
  { path: '/reset', element: <PublicOnly page="reset" /> },
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
      { path: '/books/:bookId/admin', element: <InBook page="admin" /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
