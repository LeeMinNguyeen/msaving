import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { BookInvites } from '../components/BookInvites'
import { Centered } from '../components/Centered'
import { CurrencyPicker } from '../components/CurrencyPicker'
import { useErrorText } from '../components/errors'
import { TimezonePicker } from '../components/TimezonePicker'
import { currentLanguage } from '../i18n'
import { deviceTimezone } from '../lib/labels'
import { send, type Book } from '../lib/api'
import { keys, useBooks } from '../lib/queries'
import { newId } from '../lib/uuid'

// Shown when the user has no book, and from the book switcher.
export function CreateBook() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const location = useLocation()
  const books = useBooks()
  const qc = useQueryClient()
  const id = useRef(newId()) // one id per screen, reused on retry
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<string | null>(currentLanguage() === 'vi' ? 'VND' : null)
  const [timezone, setTimezone] = useState<string | null>(deviceTimezone())
  const [starter, setStarter] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!currency || !timezone) return
    setBusy(true)
    setError(null)
    try {
      const book = await send<Book>('POST', '/v1/books', {
        id: id.current,
        name: name.trim(),
        base_currency: currency,
        timezone,
        starter_categories: starter,
      })
      await qc.invalidateQueries({ queryKey: keys.books, refetchType: 'all' })
      navigate(`/books/${book.id}`, { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // With a book to go back to, Cancel returns to the page before when the
  // app opened this one (its links say so in their state), else to the first
  // book: after opening it directly, or being sent here from "/", the entry
  // before isn't the app's. Without a book there's nowhere to go: this is the
  // first screen.
  const hasBook = (books.data ?? []).length > 0
  const fromApp = (location.state as { fromApp?: boolean } | null)?.fromApp
  const cancel = () => (fromApp ? navigate(-1) : navigate('/', { replace: true }))

  return (
    <Centered>
      <BookInvites />
      <Stack component="form" spacing={2} onSubmit={submit}>
        <Typography variant="h5">{t('book.createTitle')}</Typography>
        <Typography color="text.secondary">{t('book.createIntro')}</Typography>
        <TextField label={t('book.name')} required value={name} onChange={(e) => setName(e.target.value)} />
        <CurrencyPicker label={t('book.currency')} value={currency} onChange={setCurrency} helperText={t('book.currencyHint')} />
        <TimezonePicker label={t('book.timezone')} value={timezone} onChange={setTimezone} />
        <FormControlLabel
          control={<Checkbox checked={starter} onChange={(e) => setStarter(e.target.checked)} />}
          label={t('book.starterCategories')}
        />
        {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        <Button type="submit" variant="contained" size="large" loading={busy} disabled={!name.trim() || !currency || !timezone}>
          {t('book.create')}
        </Button>
        {hasBook && (
          <Button size="large" onClick={cancel}>
            {t('common.cancel')}
          </Button>
        )}
      </Stack>
    </Centered>
  )
}
