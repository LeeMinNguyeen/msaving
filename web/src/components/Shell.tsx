import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet'
import AddIcon from '@mui/icons-material/Add'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import CategoryIcon from '@mui/icons-material/CategoryOutlined'
import DashboardIcon from '@mui/icons-material/SpaceDashboardOutlined'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import LogoutIcon from '@mui/icons-material/Logout'
import PersonIcon from '@mui/icons-material/PersonOutlined'
import SettingsIcon from '@mui/icons-material/Settings'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Button from '@mui/material/Button'
import Drawer from '@mui/material/Drawer'
import Fab from '@mui/material/Fab'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link as RouterLink, useLocation, useNavigate } from 'react-router'
import type { Book, Transaction } from '../lib/api'
import { useBooks, useMe } from '../lib/queries'
import { signOut } from '../auth/signOut'
import { BookInvites } from './BookInvites'
import { TxnContext } from './txnContext'
import { TxnDialog, type TxnDefaults } from './TxnDialog'

const SIDEBAR = 264

function BookSwitcher({ book }: { book: Book }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const books = useBooks()
  const open = (books.data ?? []).filter((b) => !b.archived_at || b.id === book.id)
  return (
    <Select
      size="small"
      fullWidth
      value={book.id}
      aria-label={t('book.switch')}
      onChange={(e) => (e.target.value === 'new' ? navigate('/books/new') : navigate(`/books/${e.target.value}`))}
    >
      {open.map((b) => (
        <MenuItem key={b.id} value={b.id}>
          {b.name}
        </MenuItem>
      ))}
      <Divider />
      <MenuItem value="new">
        <ListItemIcon>
          <AddIcon fontSize="small" />
        </ListItemIcon>
        {t('book.new')}
      </MenuItem>
    </Select>
  )
}

// Desktop first (a project decision): a fixed sidebar with the book switcher
// and the book's pages. Phones keep a working top bar until the mobile app is
// in the stores (main.tsx sends phones there then).
export function Shell({ book, children }: { book: Book; children: ReactNode }) {
  const [dialog, setDialog] = useState<{ txn: Transaction | null; defaults?: TxnDefaults } | null>(null)
  const openTxn = (txn: Transaction | null, defaults?: TxnDefaults) => setDialog({ txn, defaults })
  return (
    <TxnContext.Provider value={openTxn}>
      <Frame book={book} onAdd={() => openTxn(null)}>
        {children}
      </Frame>
      {dialog && (
        <TxnDialog key={dialog.txn?.id ?? 'new'} book={book} txn={dialog.txn} defaults={dialog.defaults} onClose={() => setDialog(null)} />
      )}
    </TxnContext.Provider>
  )
}

function Frame({ book, children, onAdd }: { book: Book; children: ReactNode; onAdd: () => void }) {
  const { t } = useTranslation()
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const { pathname } = useLocation()
  const me = useMe()
  const canAdd = book.role !== 'viewer'
  const pages = [
    { to: `/books/${book.id}`, label: t('nav.dashboard'), icon: <DashboardIcon /> },
    { to: `/books/${book.id}/transactions`, label: t('nav.transactions'), icon: <ReceiptLongIcon /> },
    { to: `/books/${book.id}/accounts`, label: t('accounts.title'), icon: <AccountBalanceWalletIcon /> },
    { to: `/books/${book.id}/categories`, label: t('nav.categories'), icon: <CategoryIcon /> },
    { to: `/books/${book.id}/settings`, label: t('book.settings'), icon: <SettingsIcon /> },
    ...(me.data?.profile.is_admin ? [{ to: `/books/${book.id}/admin`, label: t('nav.admin'), icon: <AdminPanelSettingsIcon /> }] : []),
  ]

  if (!desktop) {
    return (
      <Box sx={{ minHeight: '100dvh' }}>
        <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Toolbar sx={{ gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0, maxWidth: 320 }}>
              <BookSwitcher book={book} />
            </Box>
            {pages.map((p) => (
              <Tooltip key={p.to} title={p.label}>
                <IconButton component={RouterLink} to={p.to} aria-label={p.label} color={pathname === p.to ? 'primary' : 'default'}>
                  {p.icon}
                </IconButton>
              </Tooltip>
            ))}
            <Tooltip title={t('nav.profile')}>
              <IconButton component={RouterLink} to={`/books/${book.id}/profile`} aria-label={t('nav.profile')}>
                <PersonIcon />
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>
        <Box component="main" sx={{ p: 2, pb: 10 }}>
          <BookInvites />
          {children}
        </Box>
        {canAdd && (
          <Fab color="primary" aria-label={t('txn.add')} onClick={onAdd} sx={{ position: 'fixed', right: 16, bottom: 16 }}>
            <AddIcon />
          </Fab>
        )}
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      <Drawer
        variant="permanent"
        sx={{ width: SIDEBAR, flexShrink: 0, '& .MuiDrawer-paper': { width: SIDEBAR, boxSizing: 'border-box' } }}
      >
        <Box sx={{ p: 2, pb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
            {t('app.name')}
          </Typography>
          <BookSwitcher book={book} />
          {canAdd && (
            <Button variant="contained" fullWidth startIcon={<AddIcon />} onClick={onAdd} sx={{ mt: 2 }}>
              {t('txn.add')}
            </Button>
          )}
        </Box>
        <List sx={{ px: 1 }}>
          {pages.map((p) => (
            <ListItemButton key={p.to} component={RouterLink} to={p.to} selected={pathname === p.to} sx={{ borderRadius: 1 }}>
              <ListItemIcon>{p.icon}</ListItemIcon>
              <ListItemText primary={p.label} />
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ flex: 1 }} />
        <Divider />
        <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ListItemButton component={RouterLink} to={`/books/${book.id}/profile`} selected={pathname.endsWith('/profile')}
            sx={{ borderRadius: 1, px: 1, flex: 1, minWidth: 0 }}>
            <ListItemIcon sx={{ minWidth: 32 }}><PersonIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary={me.data?.profile.username} slotProps={{ primary: { noWrap: true, variant: 'body2' } }} />
          </ListItemButton>
          <Tooltip title={t('auth.signOut')}>
            <IconButton size="small" onClick={() => signOut()} aria-label={t('auth.signOut')}>
              <LogoutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Drawer>
      <Box component="main" sx={{ flex: 1, minWidth: 0, px: 4, py: 3 }}>
        <Box sx={{ maxWidth: 1100 }}>
          <BookInvites />
          {children}
        </Box>
      </Box>
    </Box>
  )
}
