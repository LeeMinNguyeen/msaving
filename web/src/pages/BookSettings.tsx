import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { BookMembers } from '../components/BookMembers'
import { CurrencyPicker } from '../components/CurrencyPicker'
import { useErrorText } from '../components/errors'
import { TimezonePicker } from '../components/TimezonePicker'
import { send, type Book } from '../lib/api'
import { keys } from '../lib/queries'

// Screen 9: rename, currency, time zone, members, delete. Settings and delete: owners only.
export function BookSettings({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState(book.name)
  const [currency, setCurrency] = useState<string | null>(book.base_currency)
  const [timezone, setTimezone] = useState<string | null>(book.timezone)
  const [status, setStatus] = useState<{ error?: unknown; saved?: boolean }>({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const owner = book.role === 'owner'

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus({})
    try {
      await send('PATCH', `/v1/books/${book.id}`, {
        version: book.version,
        name: name.trim() === book.name ? null : name.trim(),
        base_currency: currency === book.base_currency ? null : currency,
        timezone: timezone === book.timezone ? null : timezone,
      })
      setStatus({ saved: true })
    } catch (err) {
      setStatus({ error: err })
    } finally {
      setBusy(false)
      await qc.invalidateQueries({ queryKey: keys.books })
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await send('DELETE', `/v1/books/${book.id}?version=${book.version}`)
      await qc.invalidateQueries({ queryKey: keys.books })
      navigate('/', { replace: true })
    } catch (err) {
      setConfirming(false)
      setStatus({ error: err })
      await qc.invalidateQueries({ queryKey: keys.books })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h5">{t('book.settingsTitle')}</Typography>
      {!owner && <Alert severity="info">{t('book.ownerOnly')}</Alert>}
      <Stack component="form" spacing={2} onSubmit={save}>
        <TextField label={t('book.name')} required value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} />
        <CurrencyPicker label={t('book.currency')} value={currency} onChange={setCurrency} helperText={t('book.currencyHint')} disabled={!owner} />
        <TimezonePicker label={t('book.timezone')} value={timezone} onChange={setTimezone} disabled={!owner} />
        {status.error ? <Alert severity="error">{errorText(status.error)}</Alert> : null}
        {status.saved ? <Alert severity="success">{t('book.saved')}</Alert> : null}
        {owner && (
          <Button type="submit" variant="contained" loading={busy} disabled={!name.trim() || !currency || !timezone} sx={{ alignSelf: 'start' }}>
            {t('book.save')}
          </Button>
        )}
      </Stack>
      <Divider />
      <BookMembers book={book} />
      {owner && (
        <>
          <Divider />
          <Button color="error" variant="outlined" onClick={() => setConfirming(true)} sx={{ alignSelf: 'start' }}>
            {t('book.delete')}
          </Button>
        </>
      )}
      <Dialog open={confirming} onClose={() => setConfirming(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('book.deleteTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <DialogContentText>{t('book.deleteBody', { name: book.name })}</DialogContentText>
            <TextField label={t('book.deleteConfirmLabel')} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy} disabled={confirmName !== book.name} onClick={remove}>
            {t('book.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
