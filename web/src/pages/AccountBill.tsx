import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import MenuItem from '@mui/material/MenuItem'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AmountField } from '../components/AmountField'
import { DateField } from '../components/DateField'
import { TimeField } from '../components/TimeField'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { liabilityKinds, send, type Account, type Bill, type Book, type InstallmentPlan } from '../lib/api'
import { timeIn, todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { useAccounts, useBills, useInstallments, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'
import { DialogFooter } from '../components/DialogFooter'
import { useToast } from '../lib/toast'

const dateIn = (locale: string, options: Intl.DateTimeFormatOptions) => (iso: string) =>
  new Intl.DateTimeFormat(locale, options).format(new Date(`${iso}T00:00:00`))

const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// The server works out the bills (backend/app/domain/bills.py): a card's last statement while it has something to
// pay, then the next one so far; a loan's installment.
export function BillPanel({ book, account, minorUnit, canPay }: { book: Book; account: Account; minorUnit: number; canPay: boolean }) {
  const { t } = useTranslation()
  const bills = useBills(book.id, account.id, true)
  if (!bills.isSuccess) return null
  if (!bills.data.length) return canPay ? <Alert severity="info">{t(account.kind === 'loan' ? 'bill.needsLoan' : 'bill.needsCard')}</Alert> : null
  return (
    <Stack spacing={2}>
      {bills.data.map((b, i) => (
        <BillCard key={b.period_end} book={book} account={account} bill={b} minorUnit={minorUnit} canPay={canPay}
          alone={bills.data.length === 1} last={i === bills.data.length - 1} />
      ))}
    </Stack>
  )
}

function BillCard({ book, account, bill: b, minorUnit, canPay, alone, last }: {
  book: Book; account: Account; bill: Bill; minorUnit: number; canPay: boolean; alone: boolean; last: boolean
}) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const [paying, setPaying] = useState(false)
  const locale = lang === 'vi' ? 'vi-VN' : 'en-GB'
  const day = dateIn(locale, { dateStyle: 'medium' })
  const short = dateIn(locale, { day: 'numeric', month: 'short' })
  const money = (v: number) => formatMoney(v, account.currency, minorUnit, lang)
  const daysLeft = Math.round((Date.parse(b.due_on) - Date.parse(todayIn(book.timezone))) / 86_400_000)
  const open = b.kind === 'card' && !!b.statement_open
  const status: { color: 'success' | 'error' | 'warning' | 'default'; label: string } =
    open ? { color: 'default', label: t('bill.open') }
      : b.remaining === 0 ? { color: 'success', label: t('bill.settled') }
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
            {b.kind === 'card' ? t(open ? 'bill.openTitle' : 'bill.cardTitle', { from: short(b.period_start), to: short(b.period_end) })
              : t('bill.loanTitle')}
          </Typography>
          <Chip size="small" color={status.color} label={status.label} />
        </Stack>
        {open && alone && <Typography variant="body2" color="text.secondary">{t('bill.lastSettled', { date: short(dayBefore(b.period_start)) })}</Typography>}
        {b.kind === 'card'
          ? row(t(open ? 'bill.soFar' : 'bill.statementBalance'), money(b.amount - b.fee))
          : row(t('bill.installment'), <>{money(b.amount - b.fee)}{b.interest > 0 && <Typography component="span" variant="caption"
            color="text.secondary" sx={{ display: 'block' }}>{t('bill.ofWhichInterest', { amount: money(b.interest) })}</Typography>}</>)}
        {(b.installments ?? []).map((i) => (
          <Box key={i.plan_id}>{row(t('bill.installmentLine', { payee: i.payee ?? t('plan.purchase'), number: i.number, months: i.months }), money(i.amount))}</Box>
        ))}
        {b.fee > 0 && row(t(b.kind === 'card' ? 'bill.installmentFees' : 'bill.fee'), money(b.fee))}
        {open ? row(t('bill.statementDate'), day(b.period_end)) : row(t(b.kind === 'card' ? 'bill.paidSince' : 'bill.paid'), money(b.paid))}
        {row(t('bill.due'), day(b.due_on))}
        <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between', alignItems: 'center', pt: 0.5 }}>
          <div>
            <Typography variant="body2" color="text.secondary">{t(open ? 'bill.toPaySoFar' : 'bill.remaining')}</Typography>
            <Typography variant="h6">{money(b.remaining)}</Typography>
          </div>
          {canPay && <Button variant="contained" onClick={() => setPaying(true)}>{t('bill.pay')}</Button>}
        </Stack>
        {b.kind === 'card' && last && row(t('bill.owedNow'), money(b.owed_now))}
        {b.kind === 'card' && last && account.credit_limit !== null && b.limit_used != null &&
          row(t('bill.limitUsed'), t('bill.limitOf', { used: money(b.limit_used), limit: money(account.credit_limit) }))}
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
  const toast = useToast()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const invalidate = useInvalidateBook()
  const accounts = useAccounts(book.id, false)
  const transferId = useRef(newId())
  const [from, setFrom] = useState<string | null>(null)
  const [amount, setAmount] = useState(() => bill.remaining > 0 ? amountText(bill.remaining, minorUnit, lang) : '')
  const [date, setDate] = useState(() => todayIn(book.timezone))
  const [time, setTime] = useState(() => timeIn(book.timezone))
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
      send('POST', `/v1/books/${book.id}/transactions`, { id, type, occurred_on: date, occurred_time: time, entries, category_id: null, payee: null, note })
    try {
      if (bill.fee > 0 && bill.fee_transaction_id) {
        await post(bill.fee_transaction_id, 'expense', [{ account_id: account.id, amount: -bill.fee }], t('bill.feeNote'))
      }
      for (const f of bill.fees ?? []) {
        await post(f.transaction_id, 'expense', [{ account_id: account.id, amount: -f.amount }],
          t('bill.installmentFeeNote', { payee: f.payee ?? t('plan.purchase') }))
      }
      if (bill.interest > 0 && bill.interest_transaction_id) {
        await post(bill.interest_transaction_id, 'expense', [{ account_id: account.id, amount: -bill.interest }],
          t('bill.interestNote', { date: day(bill.due_on) }))
      }
      await post(transferId.current, 'transfer', [{ account_id: payFrom, amount: -parsed }, { account_id: account.id, amount: parsed }],
        bill.kind === 'card' ? t('bill.cardNote', { date: day(bill.period_end) }) : t('bill.loanNote', { date: day(bill.due_on) }))
      toast(t('toast.paymentSaved'))
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
          <Stack direction="row" spacing={2}>
            <DateField label={t('bill.date')} required value={date} onChange={setDate} onInvalid={setBadDate} />
            <TimeField label={t('txn.time')} required value={time} onChange={setTime} sx={{ maxWidth: 110 }} />
          </Stack>
          {bill.interest > 0 && <DialogContentText variant="body2">{t('bill.interestPart', { amount: money(bill.interest) })}</DialogContentText>}
          {bill.fee > 0 && <DialogContentText variant="body2">{t('bill.feePart', { amount: money(bill.fee) })}</DialogContentText>}
          {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogFooter>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" loading={busy} disabled={!valid} onClick={confirm}>{t('bill.confirm')}</Button>
      </DialogFooter>
    </Dialog>
  )
}

// A card's purchases paid in installments that still have some to bill, with Pay off early.
export function InstallmentsPanel({ book, account, minorUnit, canEdit }: { book: Book; account: Account; minorUnit: number; canEdit: boolean }) {
  const { t } = useTranslation()
  const lang = currentLanguage()
  const errorText = useErrorText()
  const invalidate = useInvalidateBook()
  const plans = useInstallments(book.id, true)
  const [ending, setEnding] = useState<InstallmentPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const mine = (plans.data ?? []).filter((p) => p.account_id === account.id && p.left_to_bill > 0)
  if (!mine.length) return null
  const money = (v: number) => formatMoney(v, account.currency, minorUnit, lang)
  const day = dateIn(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium' })

  async function endEarly(p: InstallmentPlan) {
    setBusy(true)
    setError(null)
    try {
      await send('PATCH', `/v1/books/${book.id}/installments/${p.id}`, { version: p.version, ended_on: todayIn(book.timezone) })
      setEnding(null)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await invalidate(book.id)
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>{t('plan.title')}</Typography>
      <List dense disablePadding>
        {mine.map((p) => (
          <ListItem key={p.id} disableGutters sx={{ gap: 1 }}>
            <ListItemText primary={p.payee ?? t('plan.purchaseOn', { date: day(p.occurred_on) })}
              secondary={p.ended_on ? t('plan.endsNext', { left: money(p.left_to_bill) })
                : t('plan.progress', { billed: p.billed, months: p.months, installment: money(p.installment), left: money(p.left_to_bill) })} />
            {canEdit && !p.ended_on && <Button size="small" sx={{ flexShrink: 0 }} onClick={() => setEnding(p)}>{t('plan.endEarly')}</Button>}
          </ListItem>
        ))}
      </List>
      {error && !ending ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Dialog open={!!ending} onClose={() => setEnding(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t('plan.endEarlyTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('plan.endEarlyText')}</DialogContentText>
          {error ? <Alert severity="error" sx={{ mt: 2 }}>{errorText(error)}</Alert> : null}
        </DialogContent>
        <DialogFooter>
          <Button onClick={() => setEnding(null)}>{t('common.cancel')}</Button>
          <Button variant="contained" loading={busy} onClick={() => ending && endEarly(ending)}>{t('plan.endEarly')}</Button>
        </DialogFooter>
      </Dialog>
    </Paper>
  )
}
