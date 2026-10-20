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
import { adjustmentFor, detailsPayload, showsLast4 } from '../lib/accounts'
import {
  accountKinds, api, interestKinds, last4Kinds, liabilityKinds, personKinds, send, type Account, type AccountKind, type Book,
} from '../lib/api'
import { todayIn } from '../lib/labels'
import { amountText, formatMoney, parseAmount } from '../lib/money'
import { useContacts, useCurrencies, useInvalidateBook } from '../lib/queries'
import { newId } from '../lib/uuid'

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

// Add (account = null), show or edit an account. An existing account opens
// with every field greyed out; Edit turns them on (msaving#23). Amounts owed
// (credit card, loan) are typed positive and saved negative. Editing the
// current balance adds an adjustment transaction for the difference, dated
// today, since balances only ever come from transactions (msaving#24).
function AccountForm({ book, account, editing: startEditing = false, onTransactions, onClose, minorOf }: Props & { minorOf: (currency: string) => number }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const lang = currentLanguage()
  const qc = useQueryClient()
  const invalidate = useInvalidateBook()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const contacts = useContacts(book.id, true)
  const id = useRef(account?.id ?? newId())
  const adjustmentId = useRef(newId()) // one per dialog, so a retried save can't adjust twice
  const newPersonId = useRef(newId())
  const canEdit = book.role !== 'viewer'
  const [editing, setEditing] = useState(!account || (startEditing && canEdit))
  const [form, setForm] = useState(() => toForm(account, book, lang, minorOf))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const minorUnit = minorOf(form.currency ?? '')
  const owed = liabilityKinds.includes(form.kind)
  const withPerson = personKinds.includes(form.kind)
  const card = form.kind === 'credit_card'
  const withInterest = interestKinds.includes(form.kind)
  const withLast4 = showsLast4(form.kind, account?.last4)
  const parse = (text: string, minor = minorUnit) => (text.trim() === '' ? 0 : parseAmount(text, minor, lang))
  const opening = parse(form.opening)
  const balance = parse(form.balance)
  const creditLimit = parse(form.creditLimit)
  const annualFee = parse(form.annualFee)
  const interest = parse(form.interest, 2)
  const valid = !!form.name.trim() && !!form.currency && [opening, balance, creditLimit, annualFee, interest].every((v) => v !== null)
    && (creditLimit ?? 0) >= 0 && (annualFee ?? 0) >= 0 && (interest ?? 0) >= 0 && (interest ?? 0) <= 100_000
  const money = (minor: number) => formatMoney(minor, form.currency ?? '', minorUnit, lang)

  function details() {
    const blank = (text: string, value: number | null) => (text.trim() === '' ? null : value)
    return detailsPayload(form.kind, {
      note: form.note,
      creditLimit: blank(form.creditLimit, creditLimit),
      annualFee: blank(form.annualFee, annualFee),
      statementDay: form.statementDay,
      dueDay: form.dueDay,
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
      if (account) {
        // The balance first: the adjustment's id makes a retry safe, and it's
        // worked out from the balance now, in case someone added a transaction meanwhile.
        if (form.balance !== form.balanceAtStart && balance !== null) {
          const all = await api<Account[]>(`/v1/books/${book.id}/accounts?include_archived=true`)
          const diff = adjustmentFor(form.kind, balance, all.find((a) => a.id === account.id)?.balance ?? account.balance)
          if (diff !== 0) {
            await send('POST', `/v1/books/${book.id}/transactions`, {
              id: adjustmentId.current, type: 'adjustment', occurred_on: todayIn(book.timezone),
              entries: [{ account_id: account.id, amount: diff }], category_id: null, payee: null, note: null,
            })
          }
        }
        await send('PATCH', `/v1/books/${book.id}/accounts/${account.id}`, {
          version: account.version,
          name: form.name.trim(),
          kind: form.kind,
          currency: form.currency === account.currency ? null : form.currency,
          last4: form.last4 === (account.last4 ?? '') ? null : form.last4,
          in_net_worth: form.inNetWorth,
          contact_id: contactId,
          no_contact: !contactId && !!account.contact_id,
          ...details(),
        })
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
          opened_on: form.openedOn,
          ...details(),
        })
      }
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await invalidate(book.id)
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'contacts'] })
    }
  }

  function cancel() {
    if (account && !startEditing) {
      setForm(toForm(account, book, lang, minorOf))
      setError(null)
      setEditing(false)
    } else onClose()
  }

  const ro = !editing
  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="sm">
      <form onSubmit={submit}>
        <DialogTitle>
          {t(!account ? 'accounts.add' : editing ? 'accounts.edit' : 'accounts.details')}
          {account?.archived_at && <Chip size="small" label={t('accounts.archived')} sx={{ ml: 1 }} />}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('accounts.name')} required disabled={ro} value={form.name} onChange={(e) => set({ name: e.target.value })}
              autoFocus={editing} />
            <TextField select label={t('accounts.kind')} disabled={ro} value={form.kind} onChange={(e) => set({ kind: e.target.value as AccountKind })}>
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
              helperText={account && editing ? t('accounts.currencyLocked') : undefined}
            />
            {account ? (
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
                <DateField label={t('accounts.openedOn')} value={form.openedOn} onChange={(openedOn) => set({ openedOn })} sx={{ maxWidth: 190 }} />
              </Stack>
            )}
            {card && (
              <>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <AmountField
                    label={t('accounts.creditLimit')}
                    disabled={ro}
                    value={form.creditLimit}
                    onChange={(creditLimit) => set({ creditLimit })}
                    minorUnit={minorUnit}
                    helperText={account && creditLimit ? t('accounts.available', { amount: money(creditLimit + account.balance) }) : undefined}
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
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
          {account && !editing && onTransactions && (
            <Button startIcon={<ReceiptLongIcon />} onClick={() => onTransactions(account)}>
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
  dueDay: string
  interest: string
}

function toForm(a: Account | null, book: Book, lang: 'vi' | 'en', minorOf: (currency: string) => number): Form {
  const minor = minorOf(a?.currency ?? book.base_currency)
  const text = (v: number | null | undefined, m = minor) => (v === null || v === undefined ? '' : amountText(v, m, lang))
  const owed = !!a && liabilityKinds.includes(a.kind)
  const balance = a ? text(owed ? -a.balance : a.balance) : ''
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
    interest: text(a?.interest_rate_bp, 2),
  }
}
