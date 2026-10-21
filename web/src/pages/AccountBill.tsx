import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AmountField } from '../components/AmountField'
import { DateField } from '../components/DateField'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { liabilityKinds, send, type Account, type Bill, type Book } from '../lib/api'
import { todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { useAccounts, useBill, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'

const dateIn = (locale: string, options: Intl.DateTimeFormatOptions) => (iso: string) =>
  new Intl.DateTimeFormat(locale, options).format(new Date(`${iso}T00:00:00`))

// This month's bill of a credit card or a loan (msaving#37), in its details, with Pay. A card's is its statement
// balance, what the bank asks for; a loan's is its installment. The server works it out (app/domain/bills.py).
export function BillPanel({ book, account, minorUnit, canPay }: { book: Book; account: Account; minorUnit: number; canPay: boolean }) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const bill = useBill(book.id, account.id, true)
  const [paying, setPaying] = useState(false)
  if (!bill.isSuccess) return null
  const b = bill.data
  if (!b) return canPay ? <Alert severity="info">{t(account.kind === 'loan' ? 'bill.needsLoan' : 'bill.needsCard')}</Alert> : null

  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const day = dateIn(locale, { dateStyle: 'medium' })
  const short = dateIn(locale, { day: 'numeric', month: 'short' })
  const money = (v: number) => formatMoney(v, account.currency, minorUnit, lang)
  const daysLeft = Math.round((Date.parse(b.due_on) - Date.parse(todayIn(book.timezone))) / 86_400_000)
  const status: { color: 'success' | 'error' | 'warning' | 'default'; label: string } =
    b.remaining === 0 ? { color: 'success', label: t('bill.settled') }
      : daysLeft < 0 ? { color: 'error', label: t('bill.overdue') }
        : { color: daysLeft <= 3 ? 'warning' : 'default', label: daysLeft === 0 ? t('bill.dueToday') : t('bill.daysLeft', { days: daysLeft }) }
  const row = (label: string, value: ReactNode) => (
    <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ textAlign: 'right' }}>{value}</Typography>
    </Stack>
  )

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {b.kind === 'card' ? t('bill.cardTitle', { from: short(b.period_start), to: short(b.period_end) }) : t('bill.loanTitle')}
          </Typography>
          <Chip size="small" color={status.color} label={status.label} />
        </Stack>
        {b.kind === 'card'
          ? row(t('bill.statementBalance'), money(b.amount))
          : row(t('bill.installment'), <>{money(b.amount - b.fee)}{b.interest > 0 && <Typography component="span" variant="caption"
            color="text.secondary" sx={{ display: 'block' }}>{t('bill.ofWhichInterest', { amount: money(b.interest) })}</Typography>}</>)}
        {b.fee > 0 && row(t('bill.fee'), money(b.fee))}
        {row(t(b.kind === 'card' ? 'bill.paidSince' : 'bill.paid'), money(b.paid))}
        {row(t('bill.due'), day(b.due_on))}
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center', pt: 0.5 }}>
          <div>
            <Typography variant="body2" color="text.secondary">{t('bill.remaining')}</Typography>
            <Typography variant="h6">{money(b.remaining)}</Typography>
          </div>
          {canPay && b.remaining > 0 && <Button variant="contained" onClick={() => setPaying(true)}>{t('bill.pay')}</Button>}
        </Stack>
        {b.kind === 'card' && row(t('bill.owedNow'), money(b.owed_now))}
      </Stack>
      {paying && <PayBillDialog book={book} account={account} bill={b} minorUnit={minorUnit} onClose={() => setPaying(false)} />}
    </Paper>
  )
}

// Paying the bill: a transfer from the account the user picks, pre-filled with what's left to pay and today's
// date, to confirm or change. For a loan it also records the month's interest and the installment fee as expenses
// on the loan, so the loan goes down by the principal. Each transaction has an id made once (the interest's and
// the fee's by the server), so a retry can't pay twice.
function PayBillDialog({ book, account, bill, minorUnit, onClose }: {
  book: Book; account: Account; bill: Bill; minorUnit: number; onClose: () => void
}) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const invalidate = useInvalidateBook()
  const accounts = useAccounts(book.id, false)
  const transferId = useRef(newId())
  const [from, setFrom] = useState<string | null>(null)
  const [amount, setAmount] = useState(() => amountText(bill.remaining, minorUnit, lang))
  const [date, setDate] = useState(() => todayIn(book.timezone))
  const [badDate, setBadDate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // Accounts in the same currency (a payment between currencies stays an ordinary transfer), what's owned first;
  // the account of the last payment is chosen.
  const choices = (accounts.data ?? [])
    .filter((a) => a.id !== account.id && a.currency === account.currency)
    .sort((a, b) => Number(liabilityKinds.includes(a.kind)) - Number(liabilityKinds.includes(b.kind)))
  const payFrom = from ?? (choices.find((a) => a.id === bill.pay_from) ?? choices[0])?.id ?? ''
  const parsed = parseAmount(amount, minorUnit, lang)
  const valid = !!payFrom && parsed !== null && parsed > 0 && !!date && !badDate
  const money = (v: number) => formatMoney(v, account.currency, minorUnit, lang)
  const day = dateIn(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium' })

  async function confirm() {
    if (!valid || parsed === null) return
    setBusy(true)
    setError(null)
    const post = (id: string, type: 'expense' | 'transfer', entries: { account_id: string; amount: number }[], note: string) =>
      send('POST', `/v1/books/${book.id}/transactions`, { id, type, occurred_on: date, entries, category_id: null, payee: null, note })
    try {
      if (bill.fee > 0 && bill.fee_transaction_id) {
        await post(bill.fee_transaction_id, 'expense', [{ account_id: account.id, amount: -bill.fee }], t('bill.feeNote'))
      }
      if (bill.interest > 0 && bill.interest_transaction_id) {
        await post(bill.interest_transaction_id, 'expense', [{ account_id: account.id, amount: -bill.interest }],
          t('bill.interestNote', { date: day(bill.due_on) }))
      }
      await post(transferId.current, 'transfer', [{ account_id: payFrom, amount: -parsed }, { account_id: account.id, amount: parsed }],
        bill.kind === 'card' ? t('bill.cardNote', { date: day(bill.period_end) }) : t('bill.loanNote', { date: day(bill.due_on) }))
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await invalidate(book.id)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t('bill.payTitle', { account: account.name })}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {accounts.isSuccess && choices.length === 0 ? (
            <Alert severity="info">{t('bill.noAccounts', { currency: account.currency })}</Alert>
          ) : (
            <TextField select label={t('bill.payFrom')} value={payFrom} onChange={(e) => setFrom(e.target.value)}>
              {choices.map((a) => <MenuItem key={a.id} value={a.id}>{a.name} · {money(a.balance)}</MenuItem>)}
            </TextField>
          )}
          <AmountField label={t('bill.amount')} required value={amount} onChange={setAmount} minorUnit={minorUnit}
            helperText={account.currency} />
          <DateField label={t('bill.date')} required value={date} onChange={setDate} onInvalid={setBadDate} />
          {bill.interest > 0 && <DialogContentText variant="body2">{t('bill.interestPart', { amount: money(bill.interest) })}</DialogContentText>}
          {bill.fee > 0 && <DialogContentText variant="body2">{t('bill.feePart', { amount: money(bill.fee) })}</DialogContentText>}
          {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" loading={busy} disabled={!valid} onClick={confirm}>{t('bill.confirm')}</Button>
      </DialogActions>
    </Dialog>
  )
}
