import DeleteIcon from '@mui/icons-material/DeleteOutlined'
import HistoryIcon from '@mui/icons-material/History'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLanguage } from '../i18n'
import { api, ApiError, categoryKindFor, send, type Account, type Book, type Entry, type Transaction, type TxnType } from '../lib/api'
import { categoryTree } from '../lib/categories'
import { todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { personName } from '../lib/people'
import { useAccounts, useCategories, useCurrencies, useInvalidateBook } from '../lib/queries'
import { AmountField } from './AmountField'
import { DateField } from './DateField'
import { useErrorText } from './errors'
import { HistoryDialog } from './HistoryDialog'
import { newId } from '../lib/uuid'

const mainTypes: TxnType[] = ['expense', 'income', 'transfer']
const otherTypes: TxnType[] = ['refund', 'adjustment']

type Form = {
  type: TxnType
  date: string
  account: string
  toAccount: string
  amount: string
  amountReceived: string
  category: string
  payee: string
  note: string
}

export type TxnDefaults = { account?: string }

type Props = { book: Book; txn: Transaction | null; defaults?: TxnDefaults; onClose: () => void }

// The form needs each currency's decimals to show saved amounts, so it waits for them.
export function TxnDialog(props: Props) {
  const currencies = useCurrencies()
  if (!currencies.data) return null
  const map = currencies.data
  return <TxnForm {...props} minorOf={(code) => map.get(code)?.minor_unit ?? 0} />
}

// Amounts are typed as positive numbers; the type decides the sign (an expense
// is money out). Adjustments take a sign.
function TxnForm({ book, txn: initial, defaults, onClose, minorOf }: Props & { minorOf: (currency: string) => number }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const accounts = useAccounts(book.id, true)
  const categories = useCategories(book.id, true)
  const invalidate = useInvalidateBook()
  const id = useRef(initial?.id ?? newId()) // made once, reused on retry
  const [txn, setTxn] = useState(initial)
  const [form, setForm] = useState<Form>(() => toForm(initial, book, minorOf, defaults))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const accountList = accounts.data ?? []
  const byId = new Map(accountList.map((a) => [a.id, a]))
  const usable = (a: Account) => !a.archived_at || txn?.entries.some((e) => e.account_id === a.id)
  const open = accountList.filter(usable)
  // With a single open account there's nothing to pick: it's the one.
  const account = form.account || (open.length === 1 ? open[0].id : '')
  const minor = (accountId: string) => minorOf(byId.get(accountId)?.currency ?? '')
  const from = byId.get(account)
  const to = byId.get(form.toAccount)
  const transfer = form.type === 'transfer'
  const crossCurrency = transfer && !!from && !!to && from.currency !== to.currency
  const kind = categoryKindFor[form.type]
  const options = useMemo(
    () => (kind ? categoryTree(categories.data ?? [], kind).filter((r) => !r.category.archived_at || r.category.id === form.category) : []),
    [categories.data, kind, form.category],
  )

  function money(): { account_id: string; amount: number }[] | null {
    const a = parseAmount(form.amount, minor(account), lang)
    if (a === null || a === 0 || !account) return null
    if (form.type === 'adjustment') return [{ account_id: account, amount: a }]
    const abs = Math.abs(a)
    if (form.type === 'expense') return [{ account_id: account, amount: -abs }]
    if (!transfer) return [{ account_id: account, amount: abs }]
    if (!form.toAccount || form.toAccount === account) return null
    const received = crossCurrency ? parseAmount(form.amountReceived, minor(form.toAccount), lang) : abs
    if (received === null || received === 0) return null
    return [{ account_id: account, amount: -abs }, { account_id: form.toAccount, amount: Math.abs(received) }]
  }
  const entries = money()

  async function reload(message: unknown) {
    // Another device saved first: show the newer version and say so.
    try {
      const latest = await api<Transaction>(`/v1/books/${book.id}/transactions/${id.current}`)
      setTxn(latest)
      setForm(toForm(latest, book, minorOf))
    } catch {
      onClose()
    }
    setError(message)
    await invalidate(book.id)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!entries) return
    setBusy(true)
    setError(null)
    const body = {
      type: form.type,
      occurred_on: form.date,
      entries,
      category_id: form.category || null,
      payee: form.payee.trim() || null,
      note: form.note.trim() || null,
    }
    try {
      if (txn) await send('PUT', `/v1/books/${book.id}/transactions/${txn.id}`, { ...body, version: txn.version })
      else await send('POST', `/v1/books/${book.id}/transactions`, { ...body, id: id.current })
      await invalidate(book.id)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && txn) await reload(err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!txn) return
    setBusy(true)
    try {
      await send('DELETE', `/v1/books/${book.id}/transactions/${txn.id}?version=${txn.version}`)
      await invalidate(book.id)
      onClose()
    } catch (err) {
      setConfirmDelete(false)
      if (err instanceof ApiError && err.status === 409) await reload(err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  const noAccounts = accounts.isSuccess && open.length === 0
  const readOnly = book.role === 'viewer'
  const openingBalance = form.type === 'opening_balance'
  const accountLabel = (a: Account) => `${a.name} · ${formatMoney(a.balance, a.currency, minor(a.id), lang)}`

  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm">
      <form onSubmit={submit}>
        <DialogTitle>{t(txn ? 'txn.edit' : 'txn.add')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {openingBalance ? (
              <Typography color="text.secondary">{t('txn.types.opening_balance')}</Typography>
            ) : (
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                <ToggleButtonGroup
                  exclusive
                  color="primary"
                  value={mainTypes.includes(form.type) ? form.type : null}
                  onChange={(_, v: TxnType | null) => v && set({ type: v, category: '' })}
                  sx={{ flex: 1 }}
                >
                  {mainTypes.map((ty) => (
                    <ToggleButton key={ty} value={ty} sx={{ flex: 1, whiteSpace: 'nowrap', textTransform: 'none', px: 2 }}>
                      {t(`txn.types.${ty}`)}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                <TextField
                  select
                  size="small"
                  label={t('txn.otherType')}
                  value={otherTypes.includes(form.type) ? form.type : ''}
                  onChange={(e) => set({ type: e.target.value as TxnType, category: '' })}
                  sx={{ minWidth: 160 }}
                >
                  {otherTypes.map((ty) => (
                    <MenuItem key={ty} value={ty}>
                      {t(`txn.types.${ty}`)}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            )}
            {noAccounts && <Alert severity="info">{t('txn.needAccount')}</Alert>}
            {transfer && open.length < 2 && !noAccounts && <Alert severity="info">{t('txn.needTwoAccounts')}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <AmountField
                label={t('txn.amount')}
                required
                autoFocus={!txn}
                value={form.amount}
                onChange={(v) => set({ amount: v })}
                minorUnit={minor(account)}
                helperText={form.type === 'adjustment' ? t('txn.adjustmentHint') : from?.currency}
              />
              <DateField label={t('txn.date')} required value={form.date} onChange={(date) => set({ date })} sx={{ maxWidth: { sm: 190 } }} />
            </Stack>
            <TextField
              select
              required
              label={t(transfer ? 'txn.fromAccount' : 'txn.account')}
              value={byId.has(account) ? account : ''}
              onChange={(e) => set({ account: e.target.value })}
              disabled={openingBalance}
            >
              {open.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {accountLabel(a)}
                </MenuItem>
              ))}
            </TextField>
            {transfer && (
              <TextField
                select
                required
                label={t('txn.toAccount')}
                value={byId.has(form.toAccount) ? form.toAccount : ''}
                onChange={(e) => set({ toAccount: e.target.value })}
                error={!!form.toAccount && form.toAccount === account}
                helperText={form.toAccount && form.toAccount === account ? t('txn.sameAccount') : undefined}
              >
                {open.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {crossCurrency && (
              <AmountField
                label={`${t('txn.amountReceived')} (${to?.currency})`}
                required
                value={form.amountReceived}
                onChange={(v) => set({ amountReceived: v })}
                minorUnit={minor(form.toAccount)}
              />
            )}
            {kind && (
              <TextField select label={t('txn.category')} value={form.category} onChange={(e) => set({ category: e.target.value })}>
                <MenuItem value="">
                  <em>{t('txn.noCategory')}</em>
                </MenuItem>
                {options.map(({ category, depth, path }) => (
                  <MenuItem key={category.id} value={category.id} sx={{ pl: 2 + depth * 2 }}>
                    <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: category.color ?? 'action.disabled', mr: 1, flexShrink: 0 }} />
                    {depth ? category.name : path}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField label={t('txn.payee')} value={form.payee} onChange={(e) => set({ payee: e.target.value })} />
            <TextField label={t('txn.note')} value={form.note} onChange={(e) => set({ note: e.target.value })} multiline minRows={1} maxRows={4} />
            {txn?.created_by && (
              <Typography variant="body2" color="text.secondary">
                {t('txn.createdBy', { name: personName(txn.created_by, t), editor: personName(txn.modified_by, t) })}
              </Typography>
            )}
            {error ? <Alert severity={error instanceof ApiError && error.status === 409 ? 'warning' : 'error'}>{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {txn && (
            <>
              <Button startIcon={<HistoryIcon />} onClick={() => setShowHistory(true)}>
                {t('txn.history')}
              </Button>
              {!readOnly && (
                <Button color="error" startIcon={<DeleteIcon />} onClick={() => setConfirmDelete(true)}>
                  {t('txn.delete')}
                </Button>
              )}
            </>
          )}
          <Box sx={{ flex: 1 }} />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {!readOnly && (
            <Button type="submit" variant="contained" loading={busy} disabled={!entries || !form.date}>
              {t('txn.save')}
            </Button>
          )}
        </DialogActions>
      </form>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>{t('txn.deleteConfirm')}</DialogTitle>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy} onClick={remove}>
            {t('txn.delete')}
          </Button>
        </DialogActions>
      </Dialog>
      {showHistory && txn && <HistoryDialog book={book} txnId={txn.id} onClose={() => setShowHistory(false)} />}
    </Dialog>
  )
}

function toForm(txn: Transaction | null | undefined, book: Book, minorOf: (currency: string) => number, defaults?: TxnDefaults): Form {
  if (!txn) {
    return { type: 'expense', date: todayIn(book.timezone), account: defaults?.account ?? '', toAccount: '', amount: '', amountReceived: '', category: '', payee: '', note: '' }
  }
  const lang = currentLanguage()
  const text = (e: Entry, signed = false) => amountText(signed ? e.amount : Math.abs(e.amount), minorOf(e.currency ?? ''), lang)
  const out = txn.entries.find((e) => e.amount < 0) ?? txn.entries[0]
  const into = txn.entries.find((e) => e !== out)
  const transfer = txn.type === 'transfer'
  return {
    type: txn.type,
    date: txn.occurred_on,
    account: transfer ? out.account_id : txn.entries[0].account_id,
    toAccount: transfer && into ? into.account_id : '',
    amount: text(transfer ? out : txn.entries[0], txn.type === 'adjustment'),
    amountReceived: transfer && into ? text(into) : '',
    category: txn.category_id ?? '',
    payee: txn.payee ?? '',
    note: txn.note ?? '',
  }
}
