import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
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
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { accountKinds, liabilityKinds, personKinds, send, type Account, type AccountKind, type Book } from '../lib/api'
import { todayIn } from '../lib/labels'
import { parseAmount } from '../lib/money'
import { useContacts, useCurrencies } from '../lib/queries'

type Props = { book: Book; account: Account | null; onClose: () => void }

// Add (account = null) or edit an account. On add, the opening balance is
// entered as a positive amount; for a credit card or loan it's the amount owed
// and is saved negative.
export function AccountDialog({ book, account, onClose }: Props) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'))
  const currencies = useCurrencies()
  const id = useRef(account?.id ?? crypto.randomUUID())
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'cash')
  const [currency, setCurrency] = useState<string | null>(account?.currency ?? book.base_currency)
  const [opening, setOpening] = useState('')
  const [openedOn, setOpenedOn] = useState(todayIn(book.timezone))
  const [last4, setLast4] = useState(account?.last4 ?? '')
  const [inNetWorth, setInNetWorth] = useState(account?.in_net_worth ?? true)
  const contacts = useContacts(book.id, true)
  const [person, setPerson] = useState(account?.contact_id ?? '') // '' = none, 'new' = type a name
  const [newPerson, setNewPerson] = useState('')
  const newPersonId = useRef(crypto.randomUUID())
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const minorUnit = currencies.data?.get(currency ?? '')?.minor_unit ?? 2
  const owed = liabilityKinds.includes(kind)
  const withPerson = personKinds.includes(kind)
  const amount = opening.trim() === '' ? 0 : parseAmount(opening, minorUnit, currentLanguage())

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (amount === null || !currency) return
    setBusy(true)
    setError(null)
    try {
      // A new person is created first, then linked.
      let contactId: string | null = withPerson && person && person !== 'new' ? person : null
      if (withPerson && person === 'new' && newPerson.trim()) {
        await send('POST', `/v1/books/${book.id}/contacts`, { id: newPersonId.current, name: newPerson.trim() })
        contactId = newPersonId.current
      }
      if (account) {
        await send('PATCH', `/v1/books/${book.id}/accounts/${account.id}`, {
          version: account.version,
          name: name.trim(),
          kind,
          currency: currency === account.currency ? null : currency,
          last4: last4 === (account.last4 ?? '') ? null : last4,
          in_net_worth: inNetWorth,
          contact_id: contactId,
          no_contact: !contactId && !!account.contact_id,
        })
      } else {
        await send('POST', `/v1/books/${book.id}/accounts`, {
          id: id.current,
          name: name.trim(),
          kind,
          currency,
          last4: last4 || null,
          in_net_worth: inNetWorth,
          contact_id: contactId,
          opening_balance: owed ? -Math.abs(amount) : amount,
          opened_on: openedOn,
        })
      }
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'accounts'] })
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'contacts'] })
    }
  }

  return (
    <Dialog open onClose={onClose} fullScreen={fullScreen} fullWidth maxWidth="xs">
      <form onSubmit={submit}>
        <DialogTitle>{t(account ? 'accounts.edit' : 'accounts.add')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('accounts.name')} required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <TextField select label={t('accounts.kind')} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
              {accountKinds.map((k) => (
                <MenuItem key={k} value={k}>
                  {t(`accounts.kinds.${k}`)}
                </MenuItem>
              ))}
            </TextField>
            {withPerson && (
              <>
                <TextField select label={t('people.person')} value={person} onChange={(e) => setPerson(e.target.value)}
                  slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} helperText={t('people.lendHint')}>
                  <MenuItem value=""><em>{t('people.noPerson')}</em></MenuItem>
                  {(contacts.data ?? []).filter((c) => !c.archived_at || c.id === person).map((c) => (
                    <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>
                  ))}
                  <MenuItem value="new">{t('people.newPerson')}</MenuItem>
                </TextField>
                {person === 'new' && (
                  <TextField label={t('people.newPersonName')} required value={newPerson} onChange={(e) => setNewPerson(e.target.value)} />
                )}
              </>
            )}
            <CurrencyPicker
              label={t('accounts.currency')}
              value={currency}
              onChange={setCurrency}
              helperText={account ? t('accounts.currencyLocked') : undefined}
            />
            {!account && (
              <Stack direction="row" spacing={2}>
                <AmountField
                  label={t(owed ? 'accounts.amountOwed' : 'accounts.openingBalance')}
                  value={opening}
                  onChange={setOpening}
                  minorUnit={minorUnit}
                />
                <TextField
                  label={t('accounts.openedOn')}
                  type="date"
                  value={openedOn}
                  onChange={(e) => setOpenedOn(e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={{ maxWidth: 170 }}
                />
              </Stack>
            )}
            <TextField
              label={t('accounts.last4')}
              value={last4}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
              helperText={t('accounts.last4Hint')}
              slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '[0-9]{4}' } }}
            />
            <FormControlLabel
              control={<Switch checked={inNetWorth} onChange={(e) => setInNetWorth(e.target.checked)} />}
              label={t('accounts.inNetWorth')}
            />
            {!inNetWorth && <Alert severity="info">{t('accounts.inNetWorthHint')}</Alert>}
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('accounts.cancel')}</Button>
          <Button type="submit" variant="contained" loading={busy} disabled={!name.trim() || !currency || amount === null}>
            {t('accounts.save')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
