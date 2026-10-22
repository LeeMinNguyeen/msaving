import AddIcon from '@mui/icons-material/Add'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
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
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { send, type Account, type AccountKind, type Book } from '../lib/api'
import { groupByKind, type AccountGroup } from '../lib/accounts'
import { formatMoney } from '../lib/money'
import { currencyLabel } from '../lib/labels'
import { useAccounts, useCurrencies } from '../lib/queries'
import { AccountDialog } from './AccountDialog'
import { RefreshButton } from '../components/RefreshButton'

// A table on desktop, a list on phones. An account opens its details, which
// lead to its transactions.
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
  const [folded, setFolded] = useState<Set<AccountKind>>(new Set())
  const canEdit = book.role !== 'viewer'
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const navigate = useNavigate()
  const open = (a: Account) => setDialog({ account: a, editing: false })
  const transactions = (a: Account) => navigate(`/books/${book.id}/transactions?account_id=${a.id}`)

  const money = (a: Account) => formatMoney(a.balance, a.currency, currencies.data?.get(a.currency)?.minor_unit ?? 2, currentLanguage())
  const groups = groupByKind(accounts.data ?? [])
  const toggle = (kind: AccountKind) => setFolded((f) => {
    const next = new Set(f)
    if (!next.delete(kind)) next.add(kind)
    return next
  })
  const foldButton = (kind: AccountKind) => (
    <IconButton size="small" aria-label={t('accounts.fold', { kind: t(`accounts.kinds.${kind}`) })} aria-expanded={!folded.has(kind)}
      onClick={(e) => { e.stopPropagation(); toggle(kind) }}>
      {folded.has(kind) ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
    </IconButton>
  )
  const pinButton = (a: Account) => (
    <IconButton size="small" aria-label={t(a.pinned ? 'accounts.unpin' : 'accounts.pin')} aria-pressed={!!a.pinned}
      color={a.pinned ? 'primary' : 'default'} onClick={() => setPinned(a, !a.pinned)}>
      {a.pinned ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
    </IconButton>
  )
  const groupTotal = (g: AccountGroup) => (
    <>
      <Typography variant="subtitle2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }} color={g.total < 0 ? 'error' : undefined}>
        {formatMoney(g.total, book.base_currency, currencies.data?.get(book.base_currency)?.minor_unit ?? 0, currentLanguage())}
      </Typography>
      {g.notIncluded > 0 && <Typography variant="caption" color="text.secondary">{t('accounts.notIncluded', { count: g.notIncluded })}</Typography>}
    </>
  )

  async function setPinned(account: Account, pinned: boolean) {
    setError(null)
    try {
      await send(pinned ? 'PUT' : 'DELETE', `/v1/books/${book.id}/accounts/${account.id}/pin`)
    } catch (err) {
      setError(err)
    }
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'accounts'] })
    await qc.invalidateQueries({ queryKey: ['books', book.id, 'dashboard'] })
  }

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
      {accounts.isError && !accounts.data ? <Alert severity="error">{errorText(accounts.error)}</Alert> : null}
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
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.kind}>
                  <TableRow data-group={g.kind} onClick={() => toggle(g.kind)} sx={{ cursor: 'pointer', bgcolor: 'action.hover' }}>
                    <TableCell colSpan={3} sx={{ py: 0.5 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        {foldButton(g.kind)}
                        <Typography variant="subtitle2">{`${t(`accounts.kinds.${g.kind}`)} · ${g.accounts.length}`}</Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ py: 0.5 }}>{groupTotal(g)}</TableCell>
                    <TableCell padding="checkbox" />
                    <TableCell padding="checkbox" />
                  </TableRow>
                  {!folded.has(g.kind) && g.accounts.map((a) => (
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
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>{pinButton(a)}</TableCell>
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        {canEdit && (
                          <IconButton aria-label={t('accounts.edit')} onClick={(e) => setMenu({ el: e.currentTarget, account: a })}>
                            <MoreVertIcon />
                          </IconButton>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {!desktop && accounts.data && accounts.data.length > 0 && (
        <Paper variant="outlined">
          <List disablePadding>
            {groups.map((g) => (
              <Fragment key={g.kind}>
                <ListItem data-group={g.kind} divider disablePadding sx={{ bgcolor: 'action.hover' }}>
                  <ListItemButton onClick={() => toggle(g.kind)} sx={{ py: 0.5 }}>
                    <ListItemIcon sx={{ minWidth: 32 }}>{folded.has(g.kind) ? <ChevronRightIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}</ListItemIcon>
                    <ListItemText primary={`${t(`accounts.kinds.${g.kind}`)} · ${g.accounts.length}`} slotProps={{ primary: { variant: 'subtitle2' } }} />
                    <Box sx={{ textAlign: 'right', ml: 2 }}>{groupTotal(g)}</Box>
                  </ListItemButton>
                </ListItem>
                {!folded.has(g.kind) && g.accounts.map((a) => (
                <ListItem
                  key={a.id}
                  divider
                  disablePadding
                  secondaryAction={
                    <Stack direction="row">
                      {pinButton(a)}
                      {canEdit && (
                        <IconButton edge="end" aria-label={t('accounts.edit')} onClick={(e) => setMenu({ el: e.currentTarget, account: a })}>
                          <MoreVertIcon />
                        </IconButton>
                      )}
                    </Stack>
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
              </Fragment>
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
      {dialog && (
        <AccountDialog key={dialog.account?.id ?? 'new'} book={book} account={dialog.account} editing={dialog.editing}
          onTransactions={transactions} onClose={() => setDialog(null)} />
      )}
    </Stack>
  )
}
