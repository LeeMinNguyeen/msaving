import SearchIcon from '@mui/icons-material/Search'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import InputAdornment from '@mui/material/InputAdornment'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ListSubheader from '@mui/material/ListSubheader'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useErrorText } from '../components/errors'
import { useOpenTxn } from '../components/txnContext'
import { currentLanguage } from '../i18n'
import { txnTypes, type Account, type Book, type Transaction } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { CategoryPicker } from '../components/CategoryPicker'
import { formatMoney } from '../lib/money'
import { useAccounts, useCategories, useCurrencies, useTransactions, type TxnFilters } from '../lib/queries'
import { DateField } from '../components/DateField'
import { RefreshButton } from '../components/RefreshButton'

const FILTERS = ['account_id', 'category_id', 'type', 'from', 'to', 'q'] as const

// Filters are kept in the URL, so an account can link to its own list.
export function Transactions({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const desktop = useMediaQuery(useTheme().breakpoints.up('md'))
  const openTxn = useOpenTxn()
  const [params, setParams] = useSearchParams()
  const filters: TxnFilters = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? undefined]).filter(([, v]) => v))
  const [search, setSearch] = useState(filters.q ?? '')
  // Clear starts the date fields afresh: a half-typed date isn't in the address, so clearing it wouldn't reach them.
  const [cleared, setCleared] = useState(0)
  const txns = useTransactions(book.id, filters)
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)
  const currencies = useCurrencies()

  // Search as the user types, a moment after they stop.
  useEffect(() => {
    const id = setTimeout(() => setFilter('q', search.trim()), 350)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  function setFilter(key: (typeof FILTERS)[number], value: string) {
    setParams(
      (p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: true },
    )
  }

  const accountById = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data])
  const categoryById = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c])), [categories.data])
  const tree = useMemo(() => categoryTree(categories.data ?? []), [categories.data])
  const items = txns.data?.pages.flatMap((p) => p.items) ?? []
  const filtered = Object.keys(filters).length > 0
  const minor = (currency: string) => currencies.data?.get(currency)?.minor_unit ?? 0
  const fmt = (amount: number, currency: string) => formatMoney(amount, currency, minor(currency), lang)
  const day = new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

  // The amount shown for a row: the filtered account's side, else the money out
  // of the first account (a transfer shows the amount moved).
  function shown(txn: Transaction) {
    const e =
      txn.entries.find((x) => x.account_id === filters.account_id) ??
      (txn.type === 'transfer' ? txn.entries.find((x) => x.amount < 0) : txn.entries[0]) ??
      txn.entries[0]
    const amount = txn.type === 'transfer' && !filters.account_id ? Math.abs(e.amount) : e.amount
    return { amount, text: fmt(amount, e.currency ?? '') }
  }
  const accountsOf = (txn: Transaction) => {
    const names = [...txn.entries].sort((a, b) => a.amount - b.amount).map((e) => accountById.get(e.account_id)?.name ?? '')
    return txn.type === 'transfer' ? names.join(' → ') : names[0]
  }
  const title = (txn: Transaction) => txn.payee || t(`txn.types.${txn.type}`)
  const color = (amount: number) => (amount < 0 ? 'error.main' : amount > 0 ? 'success.main' : undefined)
  const filteredAccount: Account | undefined = filters.account_id ? accountById.get(filters.account_id) : undefined

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="h5">{filteredAccount ? `${t('txn.title')} · ${filteredAccount.name}` : t('txn.title')}</Typography>
        <RefreshButton bookId={book.id} />
      </Stack>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder={t('filters.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ flex: 2, minWidth: 220 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
        />
        <TextField select size="small" value={filters.account_id ?? ''} onChange={(e) => setFilter('account_id', e.target.value)} sx={{ flex: 1, minWidth: 160 }}
          slotProps={{ select: { displayEmpty: true } }}>
          <MenuItem value="">{t('filters.allAccounts')}</MenuItem>
          {(accounts.data ?? []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
        </TextField>
        <CategoryPicker key={`category-${filters.category_id ?? ''}`} size="small" ariaLabel={t('txn.category')} noneLabel={t('filters.allCategories')}
          options={tree} value={filters.category_id ?? ''} onChange={(v) => setFilter('category_id', v)} sx={{ flex: 1, minWidth: 210 }} />
        <TextField select size="small" value={filters.type ?? ''} onChange={(e) => setFilter('type', e.target.value)} sx={{ flex: 1, minWidth: 140 }}
          slotProps={{ select: { displayEmpty: true } }}>
          <MenuItem value="">{t('filters.allTypes')}</MenuItem>
          {txnTypes.map((ty) => <MenuItem key={ty} value={ty}>{t(`txn.types.${ty}`)}</MenuItem>)}
        </TextField>
        <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', md: 'auto' } }}>
          <DateField key={`from-${cleared}`} size="small" label={t('filters.from')} value={filters.from ?? ''} onChange={(v) => setFilter('from', v)} sx={{ flex: 1, minWidth: 0, maxWidth: { md: 190 } }} />
          <DateField key={`to-${cleared}`} size="small" label={t('filters.to')} value={filters.to ?? ''} onChange={(v) => setFilter('to', v)} sx={{ flex: 1, minWidth: 0, maxWidth: { md: 190 } }} />
        </Stack>
        {filtered && (
          <Button onClick={() => { setSearch(''); setCleared((n) => n + 1); setParams({}, { replace: true }) }}>{t('filters.clear')}</Button>
        )}
      </Stack>

      {txns.isError && !txns.data && <Alert severity="error">{errorText(txns.error)}</Alert>}
      {txns.isSuccess && items.length === 0 && (
        <Typography color="text.secondary">{t(filtered ? 'txn.noMatch' : 'txn.empty')}</Typography>
      )}

      {items.length > 0 && desktop && (
        <Paper variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('txn.date')}</TableCell>
                <TableCell>{t('txn.payee')}</TableCell>
                <TableCell>{t('txn.category')}</TableCell>
                <TableCell>{t('txn.account')}</TableCell>
                <TableCell align="right">{t('txn.amount')}</TableCell>
                {filteredAccount && <TableCell align="right">{t('txn.balance')}</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((txn) => {
                const money = shown(txn)
                const cat = txn.category_id ? categoryById.get(txn.category_id) : undefined
                return (
                  <TableRow key={txn.id} hover onClick={() => openTxn(txn)} sx={{ cursor: 'pointer' }}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {day.format(new Date(`${txn.occurred_on}T00:00:00`))}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{txn.occurred_time.slice(0, 5)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{title(txn)}</Typography>
                      {txn.note && <Typography variant="caption" color="text.secondary">{txn.note}</Typography>}
                    </TableCell>
                    <TableCell>
                      {cat && (
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: cat.color ?? 'action.disabled' }} />
                          <span>{cat.name}</span>
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell>{accountsOf(txn)}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: txn.type === 'transfer' && !filteredAccount ? undefined : color(money.amount) }}>
                      {money.text}
                    </TableCell>
                    {filteredAccount && (
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {txn.running_balance !== null ? fmt(txn.running_balance, filteredAccount.currency) : ''}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Paper>
      )}

      {items.length > 0 && !desktop && (
        <Paper variant="outlined">
          <List disablePadding>
            {items.map((txn, i) => {
              const money = shown(txn)
              const newDay = i === 0 || items[i - 1].occurred_on !== txn.occurred_on
              return (
                <Box key={txn.id}>
                  {newDay && <ListSubheader>{day.format(new Date(`${txn.occurred_on}T00:00:00`))}</ListSubheader>}
                  <ListItemButton divider onClick={() => openTxn(txn)}>
                    <ListItemText
                      primary={title(txn)}
                      secondary={[txn.occurred_time.slice(0, 5), txn.category_id ? categoryById.get(txn.category_id)?.name : '', accountsOf(txn)]
                        .filter(Boolean).join(' · ')}
                    />
                    <Typography sx={{ ml: 2, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: txn.type === 'transfer' && !filteredAccount ? undefined : color(money.amount) }}>
                      {money.text}
                    </Typography>
                  </ListItemButton>
                </Box>
              )
            })}
          </List>
        </Paper>
      )}

      {txns.hasNextPage && (
        <Button onClick={() => txns.fetchNextPage()} loading={txns.isFetchingNextPage} sx={{ alignSelf: 'center' }}>
          {t('txn.loadMore')}
        </Button>
      )}
    </Stack>
  )
}
