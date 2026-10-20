import AddIcon from '@mui/icons-material/Add'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { send, type Account, type Book } from '../lib/api'
import { formatMoney } from '../lib/money'
import { currencyLabel } from '../lib/labels'
import { useAccounts, useCurrencies } from '../lib/queries'
import { AccountDialog } from './AccountDialog'
import { People } from './People'
import { RefreshButton } from '../components/RefreshButton'

// Screen 7, without people (milestone 5): accounts with their balances. A
// table on desktop, a list on phones. An account opens its details, which lead
// to its transactions (msaving#23).
export function Accounts({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const accounts = useAccounts(book.id, showArchived)
  const currencies = useCurrencies()
  const [dialog, setDialog] = useState<{ account: Account | null; editing: boolean } | null>(null)
  const [menu, setMenu] = useState<{ el: HTMLElement; account: Account } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const canEdit = book.role !== 'viewer'
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const navigate = useNavigate()
  const open = (a: Account) => setDialog({ account: a, editing: false })
  const transactions = (a: Account) => navigate(`/books/${book.id}/transactions?account_id=${a.id}`)

  const money = (a: Account) => formatMoney(a.balance, a.currency, currencies.data?.get(a.currency)?.minor_unit ?? 2, currentLanguage())

  async function setArchived(account: Account, archived: boolean) {
    setMenu(null)
    setError(null)
    try {
      await send('PATCH', `/v1/books/${book.id}/accounts/${account.id}`, { version: account.version, archived })
    } catch (err) {
      setError(err)
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'accounts'] })
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h5">{t('accounts.title')}</Typography>
          <RefreshButton bookId={book.id} />
        </Stack>
        {canEdit && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog({ account: null, editing: true })}>
            {t('accounts.add')}
          </Button>
        )}
      </Stack>
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      {accounts.isError ? <Alert severity="error">{errorText(accounts.error)}</Alert> : null}
      {accounts.data?.length === 0 && <Typography color="text.secondary">{t('accounts.empty')}</Typography>}
      {desktop && accounts.data && accounts.data.length > 0 && (
        <Paper variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>{t('accounts.name')}</TableCell>
                <TableCell>{t('accounts.kind')}</TableCell>
                <TableCell>{t('accounts.currency')}</TableCell>
                <TableCell align="right">{t('accounts.balance')}</TableCell>
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.data.map((a) => (
                <TableRow
                  key={a.id}
                  hover
                  onClick={() => open(a)}
                  sx={{ cursor: 'pointer', opacity: a.in_net_worth && !a.archived_at ? 1 : 0.55 }}
                >
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <span>{a.name}</span>
                      {a.last4 && <Typography variant="body2" color="text.secondary">•••• {a.last4}</Typography>}
                      {a.archived_at && <Chip size="small" label={t('accounts.archived')} />}
                      {!a.in_net_worth && <Chip size="small" variant="outlined" label={t('accounts.notInNetWorth')} />}
                    </Stack>
                  </TableCell>
                  <TableCell>{t(`accounts.kinds.${a.kind}`)}</TableCell>
                  <TableCell>{currencyLabel(a.currency, currencies.data?.get(a.currency)?.name)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: a.balance < 0 ? 'error.main' : undefined }}>
                    {money(a)}
                  </TableCell>
                  <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                    {canEdit && (
                      <IconButton aria-label={t('accounts.edit')} onClick={(e) => setMenu({ el: e.currentTarget, account: a })}>
                        <MoreVertIcon />
                      </IconButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {!desktop && accounts.data && accounts.data.length > 0 && (
        <Paper variant="outlined">
          <List disablePadding>
            {accounts.data.map((a) => (
              <ListItem
                key={a.id}
                divider
                disablePadding
                secondaryAction={
                  canEdit && (
                    <IconButton edge="end" aria-label={t('accounts.edit')} onClick={(e) => setMenu({ el: e.currentTarget, account: a })}>
                      <MoreVertIcon />
                    </IconButton>
                  )
                }
              >
                {/* Left out of net worth: greyed out but still clickable */}
                <ListItemButton onClick={() => open(a)} sx={{ opacity: a.in_net_worth && !a.archived_at ? 1 : 0.55 }}>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <span>{a.name}</span>
                        {a.archived_at && <Chip size="small" label={t('accounts.archived')} />}
                      </Stack>
                    }
                    secondary={[t(`accounts.kinds.${a.kind}`), a.last4 && `•••• ${a.last4}`, !a.in_net_worth && t('accounts.notInNetWorth')]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                  <Typography sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', ml: 2 }} color={a.balance < 0 ? 'error' : undefined}>
                    {money(a)}
                  </Typography>
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
      <FormControlLabel
        control={<Switch checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />}
        label={t('accounts.showArchived')}
      />
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setDialog({ account: menu!.account, editing: true })
            setMenu(null)
          }}
        >
          {t('accounts.edit')}
        </MenuItem>
        <MenuItem onClick={() => menu && setArchived(menu.account, !menu.account.archived_at)}>
          {t(menu?.account.archived_at ? 'accounts.unarchive' : 'accounts.archive')}
        </MenuItem>
      </Menu>
      <People book={book} />
      {dialog && (
        <AccountDialog key={dialog.account?.id ?? 'new'} book={book} account={dialog.account} editing={dialog.editing}
          onTransactions={transactions} onClose={() => setDialog(null)} />
      )}
    </Stack>
  )
}
