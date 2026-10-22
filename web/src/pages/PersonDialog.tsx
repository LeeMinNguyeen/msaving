import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../components/errors'
import { send, type Book, type Contact } from '../lib/api'
import { newId } from '../lib/uuid'
import { DialogFooter } from '../components/DialogFooter'
import { useToast } from '../lib/toast'

// Only a name and a note are kept.
export function PersonDialog({ book, person, onClose }: { book: Book; person: Contact | null; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const id = useRef(person?.id ?? newId())
  const [name, setName] = useState(person?.name ?? '')
  const [note, setNote] = useState(person?.note ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (person) await send('PATCH', `/v1/books/${book.id}/contacts/${person.id}`, { version: person.version, name: name.trim(), note: note.trim() })
      else await send('POST', `/v1/books/${book.id}/contacts`, { id: id.current, name: name.trim(), note: note.trim() || null })
      toast(t('toast.personSaved'))
      onClose()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      await qc.invalidateQueries({ queryKey: ['books', book.id, 'contacts'] })
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <form onSubmit={submit}>
        <DialogTitle>{t(person ? 'people.edit' : 'people.add')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label={t('people.name')} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <TextField label={t('people.note')} value={note} onChange={(e) => setNote(e.target.value)} helperText={t('people.noteHint')} />
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogFooter>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="contained" loading={busy} disabled={!name.trim()}>{t('accounts.save')}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
