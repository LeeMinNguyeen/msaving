import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet'
import AddIcon from '@mui/icons-material/Add'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import CheckIcon from '@mui/icons-material/Check'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import CategoryIcon from '@mui/icons-material/CategoryOutlined'
import DashboardIcon from '@mui/icons-material/SpaceDashboardOutlined'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import LogoutIcon from '@mui/icons-material/Logout'
import PeopleIcon from '@mui/icons-material/PeopleOutlined'
import PersonIcon from '@mui/icons-material/PersonOutlined'
import SettingsIcon from '@mui/icons-material/Settings'
import AppBar from '@mui/material/AppBar'
import BottomNavigation from '@mui/material/BottomNavigation'
import BottomNavigationAction from '@mui/material/BottomNavigationAction'
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
import ListSubheader from '@mui/material/ListSubheader'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
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
import { useBookChanges, useBooks, useInstance, useMe } from '../lib/queries'
import { signOut } from '../auth/signOut'
import { BookInvites } from './BookInvites'
import { UpdatingNotice } from './UpdatingNotice'
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
      onChange={(e) => (e.target.value === 'new' ? navigate('/books/new', { state: { fromApp: true } }) : navigate(`/books/${e.target.value}`))}
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

// Desktop first: a fixed sidebar with the book switcher and the book's pages.
// Phones get the book's name on top and the pages in a bar at the bottom until
// the mobile app is in the stores (main.tsx sends phones there then).
export function Shell({ book, children }: { book: Book; children: ReactNode }) {
  useBookChanges(book.id)
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
  const version = useInstance().data?.server_version
  const canAdd = book.role !== 'viewer'
  const pages = [
    { to: `/books/${book.id}`, label: t('nav.dashboard'), icon: <DashboardIcon /> },
    { to: `/books/${book.id}/transactions`, label: t('nav.transactions'), icon: <ReceiptLongIcon /> },
    { to: `/books/${book.id}/accounts`, label: t('accounts.title'), icon: <AccountBalanceWalletIcon /> },
    { to: `/books/${book.id}/people`, label: t('nav.people'), icon: <PeopleIcon />, phoneMore: true },
    { to: `/books/${book.id}/categories`, label: t('nav.categories'), icon: <CategoryIcon /> },
    { to: `/books/${book.id}/settings`, label: t('book.settings'), icon: <SettingsIcon /> },
    ...(me.data?.profile.is_admin ? [{ to: `/books/${book.id}/admin`, label: t('nav.admin'), icon: <AdminPanelSettingsIcon /> }] : []),
  ]

  if (!desktop) {
    return (
      <PhoneFrame book={book} pages={pages} canAdd={canAdd} onAdd={onAdd} admin={!!me.data?.profile.is_admin}>
        {children}
      </PhoneFrame>
    )
  }

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh' }}>
      <Drawer
        variant="permanent"
        sx={{ width: SIDEBAR, flexShrink: 0, '& .MuiDrawer-paper': { width: SIDEBAR, boxSizing: 'border-box', bgcolor: 'background.sidebar' } }}
      >
        <Box sx={{ p: 2, pb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
            {t('app.name')}
            {version && (
              <Typography component="span" variant="caption" color="text.secondary" title={t('admin.version', { version })}
                sx={{ ml: 1, fontWeight: 400 }}>
                {/^\d/.test(version) ? `v${version}` : version}
              </Typography>
            )}
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
          <UpdatingNotice />
          <BookInvites />
          {children}
        </Box>
      </Box>
    </Box>
  )
}

type Page = { to: string; label: string; icon: ReactNode; phoneMore?: boolean }
const NAV_HEIGHT = 56

// Phones: the book's name on top opens a list of books; the main pages sit in
// a bar at the bottom, within reach of a thumb, with the rest under More.
function PhoneFrame({ book, pages, canAdd, onAdd, admin, children }: {
  book: Book; pages: Page[]; canAdd: boolean; onAdd: () => void; admin: boolean; children: ReactNode
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const books = useBooks()
  const [sheet, setSheet] = useState<'books' | 'more' | null>(null)
  const main = pages.filter((p) => !p.phoneMore).slice(0, 4) // dashboard, transactions, accounts, categories
  const more: Page[] = [
    ...pages.filter((p) => p.phoneMore),
    { to: `/books/${book.id}/settings`, label: t('book.settings'), icon: <SettingsIcon /> },
    ...(admin ? [{ to: `/books/${book.id}/admin`, label: t('nav.admin'), icon: <AdminPanelSettingsIcon /> }] : []),
    { to: `/books/${book.id}/profile`, label: t('nav.profile'), icon: <PersonIcon /> },
  ]
  const current = main.some((p) => p.to === pathname) ? pathname : 'more'
  const go = (to: string, state?: unknown) => {
    setSheet(null)
    navigate(to, { state })
  }
  const open = (books.data ?? []).filter((b) => !b.archived_at || b.id === book.id)
  const bottom = `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom))`

  return (
    <Box sx={{ minHeight: '100dvh' }}>
      <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.sidebar', color: 'text.primary', borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar>
          <Button color="inherit" onClick={() => setSheet('books')} endIcon={<ExpandMoreIcon />} aria-label={t('book.switch')}
            sx={{ textTransform: 'none', fontSize: '1.1rem', fontWeight: 600, minWidth: 0, maxWidth: '100%', px: 1, ml: -1 }}>
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book.name}</Box>
          </Button>
        </Toolbar>
      </AppBar>
      <Box component="main" sx={{ p: 2, pb: `calc(${NAV_HEIGHT + 88}px + env(safe-area-inset-bottom))` }}>
        <UpdatingNotice />
        <BookInvites />
        {children}
      </Box>
      {canAdd && (
        <Fab color="primary" aria-label={t('txn.add')} onClick={onAdd} sx={{ position: 'fixed', right: 16, bottom: `calc(${bottom} + 16px)` }}>
          <AddIcon />
        </Fab>
      )}
      <Paper square elevation={0} sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 'appBar', borderTop: 1, borderColor: 'divider',
        bgcolor: 'background.sidebar', pb: 'env(safe-area-inset-bottom)' }}>
        <BottomNavigation showLabels value={current} sx={{ bgcolor: 'transparent', height: NAV_HEIGHT }}>
          {main.map((p) => (
            <BottomNavigationAction key={p.to} value={p.to} label={p.label} icon={p.icon} component={RouterLink} to={p.to}
              sx={{ minWidth: 0, px: 0.5, '& .MuiBottomNavigationAction-label': { whiteSpace: 'nowrap' } }} />
          ))}
          <BottomNavigationAction value="more" label={t('nav.more')} icon={<MoreHorizIcon />} onClick={() => setSheet('more')} sx={{ minWidth: 0, px: 0.5 }} />
        </BottomNavigation>
      </Paper>
      <Drawer anchor="bottom" open={sheet === 'books'} onClose={() => setSheet(null)} slotProps={{ paper: { sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, pb: 'env(safe-area-inset-bottom)' } } }}>
        <List subheader={<ListSubheader sx={{ bgcolor: 'transparent' }}>{t('book.switch')}</ListSubheader>}>
          {open.map((b) => (
            <ListItemButton key={b.id} selected={b.id === book.id} onClick={() => go(`/books/${b.id}`)}>
              <ListItemText primary={b.name} secondary={t(`members.role.${b.role}`)} />
              {b.id === book.id && <CheckIcon color="primary" />}
            </ListItemButton>
          ))}
          <Divider />
          <ListItemButton onClick={() => go('/books/new', { fromApp: true })}>
            <ListItemIcon><AddIcon /></ListItemIcon>
            <ListItemText primary={t('book.new')} />
          </ListItemButton>
        </List>
      </Drawer>
      <Drawer anchor="bottom" open={sheet === 'more'} onClose={() => setSheet(null)} slotProps={{ paper: { sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, pb: 'env(safe-area-inset-bottom)' } } }}>
        <List>
          {more.map((p) => (
            <ListItemButton key={p.to} selected={pathname === p.to} onClick={() => go(p.to)}>
              <ListItemIcon>{p.icon}</ListItemIcon>
              <ListItemText primary={p.label} />
            </ListItemButton>
          ))}
          <Divider />
          <ListItemButton onClick={() => signOut()}>
            <ListItemIcon><LogoutIcon /></ListItemIcon>
            <ListItemText primary={t('auth.signOut')} />
          </ListItemButton>
        </List>
      </Drawer>
    </Box>
  )
}
