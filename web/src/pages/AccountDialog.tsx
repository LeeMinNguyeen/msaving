import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AmountField } from '../components/AmountField'
import { CurrencyPicker } from '../components/CurrencyPicker'
import { DateField } from '../components/DateField'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { adjustmentFor, detailsPayload, ledgerBalance, showsLast4 } from '../lib/accounts'
import {
  accountKinds, api, ApiError, interestKinds, last4Kinds, liabilityKinds, personKinds, send, type Account, type AccountKind, type Book,
} from '../lib/api'
import { timeIn, todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { useContacts, useCurrencies, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'
import { BillPanel } from './AccountBill'

type Props = {
  book: Book
  account: Account | null
  editing?: boolean // open an existing account straight in edit mode (its menu's Edit)
  onTransactions?: (account: Account) => void
  onClose: () => void
}

const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1))

// Amounts need each currency's decimals, so the form waits for them.
export function AccountDialog(props: Props) {
  const currencies = useCurrencies()
  if (!currencies.data) return null
  const map = currencies.data
  return <AccountForm {...props} minorOf={(code) => map.get(code)?.minor_unit ?? 2} />
}

// Add (account = null), show or edit an account. Amounts owed are typed
// positive and saved negative. Editing the current balance adds an adjustment
// for the difference, dated today, since balances only come from transactions.
function AccountForm({ book, account, editing: startEditing = false, onTransactions, onClose, minorOf }: Props & { minorOf: (currency: string) => number }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const qc = useQueryClient()
  const invalidate = useInvalidateBook()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const contacts = useContacts(book.id, true)
  const id = useRef(account?.id ?? newId())
  // One adjustment id per balance typed: a retry can't add it twice, and a
  // different balance after a failed save is a new adjustment.
  const adjustment = useRef<{ id: string; target: number } | null>(null)
  const newPersonId = useRef(newId())
  const canEdit = book.role !== 'viewer'
  const [base, setBase] = useState(account) // the account as last loaded or saved
  const [editing, setEditing] = useState(!account || (startEditing && canEdit))
  const [form, setForm] = useState(() => toForm(account, book, lang, minorOf))
  const [badDate, setBadDate] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const minorUnit = minorOf(form.currency ?? '')
  const owed = liabilityKinds.includes(form.kind)
  const withPerson = personKinds.includes(form.kind)
  const card = form.kind === 'credit_card'
  const loan = form.kind === 'loan'
  const withInterest = interestKinds.includes(form.kind)
  const withLast4 = showsLast4(form.kind, base?.last4)
  const parse = (text: string, minor = minorUnit) => (text.trim() === '' ? 0 : parseAmount(text, minor, lang))
  const opening = parse(form.opening)
  // An untouched balance isn't read back: its text has the decimals of the currency it was shown in.
  const balanceChanged = !!base && form.balance !== form.balanceAtStart
  const balance = balanceChanged ? parse(form.balance) : 0
  const creditLimit = parse(form.creditLimit)
  const annualFee = parse(form.annualFee)
  const installment = parse(form.installment)
  const installmentFee = parse(form.installmentFee)
  const interest = parse(form.interest, 2)
  // Only the fields the kind shows count: a hidden one is sent as null.
  const valid = !!form.name.trim() && !!form.currency && opening !== null && balance !== null && !badDate
    && (!card || (creditLimit !== null && creditLimit >= 0 && annualFee !== null && annualFee >= 0))
    && (!loan || ((form.installment.trim() === '' || (installment !== null && installment > 0))
      && installmentFee !== null && installmentFee >= 0))
    && (!withInterest || (interest !== null && interest >= 0 && interest <= 100_000))
  const money = (minor: number) => formatMoney(minor, form.currency ?? '', minorUnit, lang)

  // An untouched balance follows the kind, since what's owed is shown positive.
  function changeKind(kind: AccountKind) {
    const shown = base && !balanceChanged ? balanceText(base, kind, lang, minorOf) : null
    set({ kind, ...(shown !== null ? { balance: shown, balanceAtStart: shown } : {}) })
  }

  function details() {
    const blank = (text: string, value: number | null) => (text.trim() === '' ? null : value)
    return detailsPayload(form.kind, {
      note: form.note,
      creditLimit: blank(form.creditLimit, creditLimit),
      annualFee: blank(form.annualFee, annualFee),
      statementDay: form.statementDay,
      dueDay: form.dueDay,
      installment: blank(form.installment, installment),
      installmentFee: blank(form.installmentFee, installmentFee),
      interestBp: blank(form.interest, interest),
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || !form.currency) return
    setBusy(true)
    setError(null)
    try {
      // A new person is created first, then linked.
      let contactId: string | null = withPerson && form.person && form.person !== 'new' ? form.person : null
      if (withPerson && form.person === 'new' && form.newPerson.trim()) {
        await send('POST', `/v1/books/${book.id}/contacts`, { id: newPersonId.current, name: form.newPerson.trim() })
        contactId = newPersonId.current
      }
      if (base) {
        // The account first, then the balance: an edit refused after its
        // adjustment was saved would leave half the change, and an adjustment
        // would lock a currency being changed.
        const saved = await send<Account>('PATCH', `/v1/books/${book.id}/accounts/${base.id}`, {
          version: base.version,
          name: form.name.trim(),
          kind: form.kind,
          currency: form.currency === base.currency ? null : form.currency,
          last4: form.last4 === (base.last4 ?? '') ? null : form.last4,
          in_net_worth: form.inNetWorth,
          contact_id: contactId,
          no_contact: !contactId && !!base.contact_id,
          ...details(),
        })
        setBase(saved) // a retry carries on from what's saved
        // Worked out from the balance the save returned, in case someone added a transaction meanwhile.
        if (balanceChanged && balance !== null) {
          const target = ledgerBalance(form.kind, balance)
          if (adjustment.current?.target !== target) adjustment.current = { id: newId(), target }
          const diff = adjustmentFor(form.kind, balance, saved.balance)
          if (diff !== 0) {
            await send('POST', `/v1/books/${book.id}/transactions`, {
              id: adjustment.current.id, type: 'adjustment', occurred_on: todayIn(book.timezone), occurred_time: timeIn(book.timezone),
              entries: [{ account_id: base.id, amount: diff }], category_id: null, payee: null, note: null,
            })
          }
        }
      } else {
        await send('POST', `/v1/books/${book.id}/accounts`, {
          id: id.current,
          name: form.name.trim(),
          kind: form.kind,
          currency: form.currency,
          last4: (last4Kinds.includes(form.kind) && form.last4) || null,
          in_net_worth: form.inNetWorth,
          contact_id: contactId,
          opening_balance: owed ? -Math.abs(opening ?? 0) : (opening ?? 0),
          opened_on: form.openedOn || null, // none: today
          ...details(),
        })
      }
      onClose()
    } catch (err) {
      if (base && err instanceof ApiError && err.code === 'conflict') await reload(base, err)
      else setError(err)
    } finally {
      setBusy(false)
      await invalidate(book.id)
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'contacts'] })
    }
  }

  // Someone else saved the account first: show their version and say so, as the
  // transaction dialog does. Saving again then starts from it.
  async function reload(current: Account, message: unknown) {
    try {
      const all = await api<Account[]>(`/v1/books/${book.id}/accounts?include_archived=true`)
      const latest = all.find((a) => a.id === current.id)
      if (!latest) return onClose()
      setBase(latest)
      setForm(toForm(latest, book, lang, minorOf))
      setError(message)
    } catch {
      onClose()
    }
  }

  function cancel() {
    if (base && !startEditing) {
      setForm(toForm(base, book, lang, minorOf))
      setError(null)
      setEditing(false)
    } else onClose()
  }

  const ro = !editing
  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm">
      <form onSubmit={submit}>
        <DialogTitle>
          {t(!base ? 'accounts.add' : editing ? 'accounts.edit' : 'accounts.details')}
          {base?.archived_at && <Chip size="small" label={t('accounts.archived')} sx={{ ml: 1 }} />}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('accounts.name')} required disabled={ro} value={form.name} onChange={(e) => set({ name: e.target.value })}
              autoFocus={editing} />
            <TextField select label={t('accounts.kind')} disabled={ro} value={form.kind} onChange={(e) => changeKind(e.target.value as AccountKind)}>
              {accountKinds.map((k) => (
                <MenuItem key={k} value={k}>
                  {t(`accounts.kinds.${k}`)}
                </MenuItem>
              ))}
            </TextField>
            {withPerson && (
              <>
                <TextField select label={t('people.person')} disabled={ro} value={form.person} onChange={(e) => set({ person: e.target.value })}
                  slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} helperText={editing ? t('people.lendHint') : undefined}>
                  <MenuItem value=""><em>{t('people.noPerson')}</em></MenuItem>
                  {(contacts.data ?? []).filter((c) => !c.archived_at || c.id === form.person).map((c) => (
                    <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
                  ))}
                  <MenuItem value="new">{t('people.newPerson')}</MenuItem>
                </TextField>
                {form.person === 'new' && (
                  <TextField label={t('people.newPersonName')} required value={form.newPerson} onChange={(e) => set({ newPerson: e.target.value })} />
                )}
              </>
            )}
            <CurrencyPicker
              label={t('accounts.currency')}
              value={form.currency}
              onChange={(currency) => set({ currency })}
              disabled={ro}
              helperText={base && editing ? t('accounts.currencyLocked') : undefined}
            />
            {base ? (
              <AmountField
                label={t(owed ? 'accounts.owedNow' : 'accounts.currentBalance')}
                disabled={ro}
                value={form.balance}
                onChange={(balance) => set({ balance })}
                minorUnit={minorUnit}
                helperText={editing ? t('accounts.balanceHint') : form.currency ?? undefined}
              />
            ) : (
              <Stack direction="row" spacing={2}>
                <AmountField
                  label={t(owed ? 'accounts.amountOwed' : 'accounts.openingBalance')}
                  value={form.opening}
                  onChange={(opening) => set({ opening })}
                  minorUnit={minorUnit}
                />
                <DateField label={t('accounts.openedOn')} value={form.openedOn} onChange={(openedOn) => set({ openedOn })} onInvalid={setBadDate}
                  sx={{ maxWidth: 190 }} />
              </Stack>
            )}
            {base && !editing && (card || loan) && <BillPanel book={book} account={base} minorUnit={minorUnit} canPay={canEdit} />}
            {card && (
              <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <AmountField
                    label={t('accounts.creditLimit')}
                    disabled={ro}
                    value={form.creditLimit}
                    onChange={(creditLimit) => set({ creditLimit })}
                    minorUnit={minorUnit}
                    helperText={base && creditLimit ? t('accounts.available', { amount: money(creditLimit + base.balance) }) : undefined}
                  />
                  <AmountField label={t('accounts.annualFee')} disabled={ro} value={form.annualFee} onChange={(annualFee) => set({ annualFee })}
                    minorUnit={minorUnit} />
                </Stack>
                <Stack direction="row" spacing={2}>
                  <DaySelect label={t('accounts.statementDay')} disabled={ro} value={form.statementDay} onChange={(statementDay) => set({ statementDay })} />
                  <DaySelect label={t('accounts.dueDay')} disabled={ro} value={form.dueDay} onChange={(dueDay) => set({ dueDay })} />
                </Stack>
              </>
            )}
            {loan && (
              <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <AmountField label={t('accounts.installment')} disabled={ro} value={form.installment}
                    onChange={(installment) => set({ installment })} minorUnit={minorUnit} />
                  <DaySelect label={t('accounts.paymentDay')} disabled={ro} value={form.dueDay} onChange={(dueDay) => set({ dueDay })} />
                </Stack>
                <AmountField label={t('accounts.installmentFee')} disabled={ro} value={form.installmentFee}
                  onChange={(installmentFee) => set({ installmentFee })} minorUnit={minorUnit}
                  helperText={editing ? t('accounts.installmentFeeHint') : undefined} />
              </>
            )}
            {withInterest && (
              <AmountField label={t('accounts.interestRate')} disabled={ro} value={form.interest} onChange={(interest) => set({ interest })}
                minorUnit={2} helperText={editing ? t('accounts.interestHint') : undefined} />
            )}
            {withLast4 && (
              <TextField
                label={t('accounts.last4')}
                disabled={ro}
                value={form.last4}
                onChange={(e) => set({ last4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                helperText={editing ? t('accounts.last4Hint') : undefined}
                slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '[0-9]{4}' } }}
              />
            )}
            <TextField label={t('accounts.note')} disabled={ro} value={form.note} onChange={(e) => set({ note: e.target.value })}
              multiline minRows={1} maxRows={4} slotProps={{ htmlInput: { maxLength: 500 } }} />
            <FormControlLabel
              disabled={ro}
              control={<Switch checked={form.inNetWorth} onChange={(e) => set({ inNetWorth: e.target.checked })} />}
              label={t('accounts.inNetWorth')}
            />
            {!form.inNetWorth && editing && <Alert severity="info">{t('accounts.inNetWorthHint')}</Alert>}
            {error ? <Alert severity={error instanceof ApiError && error.code === 'conflict' ? 'warning' : 'error'}>{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          {base && !editing && onTransactions && (
            <Button startIcon={<ReceiptLongIcon />} onClick={() => onTransactions(base)}>
              {t('common.viewTransactions')}
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          {editing ? (
            <>
              <Button onClick={cancel}>{t('accounts.cancel')}</Button>
              <Button key="save" type="submit" variant="contained" loading={busy} disabled={!valid}>
                {t('accounts.save')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.close')}</Button>
              {/* Its own key: reusing the Save button's element would submit the form on this click */}
              {canEdit && (
                <Button key="edit" variant="contained" onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
              )}
            </>
          )}
        </DialogActions>
      </form>
    </Dialog>
  )
}

function DaySelect({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const { t } = useTranslation()
  return (
    <TextField select label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)}
      slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
      <MenuItem value=""><em>{t('accounts.noDay')}</em></MenuItem>
      {DAYS.map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
    </TextField>
  )
}

type Form = {
  name: string
  kind: AccountKind
  currency: string | null
  opening: string
  openedOn: string
  balance: string
  balanceAtStart: string
  last4: string
  inNetWorth: boolean
  person: string // '' = none, 'new' = type a name
  newPerson: string
  note: string
  creditLimit: string
  annualFee: string
  statementDay: string
  dueDay: string // a card's repayment day, a loan's payment day
  installment: string
  installmentFee: string
  interest: string
}

// An account's balance as its edit dialog shows it for this kind: what's owed is positive.
function balanceText(a: Account, kind: AccountKind, lang: 'vi' | 'en', minorOf: (currency: string) => number) {
  return amountText(liabilityKinds.includes(kind) ? -a.balance : a.balance, minorOf(a.currency), lang)
}

function toForm(a: Account | null, book: Book, lang: 'vi' | 'en', minorOf: (currency: string) => number): Form {
  const minor = minorOf(a?.currency ?? book.base_currency)
  const text = (v: number | null | undefined, m = minor) => (v === null || v === undefined ? '' : amountText(v, m, lang))
  const balance = a ? balanceText(a, a.kind, lang, minorOf) : ''
  return {
    name: a?.name ?? '',
    kind: a?.kind ?? 'cash',
    currency: a?.currency ?? book.base_currency,
    opening: '',
    openedOn: todayIn(book.timezone),
    balance,
    balanceAtStart: balance,
    last4: a?.last4 ?? '',
    inNetWorth: a?.in_net_worth ?? true,
    person: a?.contact_id ?? '',
    newPerson: '',
    note: a?.note ?? '',
    creditLimit: text(a?.credit_limit),
    annualFee: text(a?.annual_fee),
    statementDay: a?.statement_day ? String(a.statement_day) : '',
    dueDay: a?.payment_due_day ? String(a.payment_due_day) : '',
    installment: text(a?.installment),
    installmentFee: text(a?.installment_fee),
    interest: text(a?.interest_rate_bp, 2),
  }
}
