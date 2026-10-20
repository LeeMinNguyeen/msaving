import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { send, type BookInvite } from '../lib/api'
import { personName } from '../lib/people'
import { keys, useBookInvites } from '../lib/queries'
import { useErrorText } from './errors'

// Invites to other people's books, answered here: on top of every book page
// and on Create a book (someone invited before they had a book of their own).
export function BookInvites() {
  const invites = useBookInvites()
  if (!invites.data?.length) return null
  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {invites.data.map((i) => <InviteRow key={i.book_id} invite={i} />)}
    </Stack>
  )
}

function InviteRow({ invite }: { invite: BookInvite }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function answer(accept: boolean) {
    setBusy(accept ? 'accept' : 'decline')
    setError(null)
    try {
      if (accept) await send('POST', `/v1/me/book-invites/${invite.book_id}/accept`)
      else await send('DELETE', `/v1/me/book-invites/${invite.book_id}`)
      // 'all': on Create a book nothing shows the book list, and the book page
      // must find the new book in it or it sends the user back here.
      await qc.invalidateQueries({ queryKey: keys.books, refetchType: 'all' })
      if (accept) navigate(`/books/${invite.book_id}`)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: keys.bookInvites })
    }
  }

  return (
    <Alert
      severity={error ? 'error' : 'info'}
      action={
        <Stack direction="row" spacing={1}>
          <Button color="inherit" size="small" loading={busy === 'decline'} disabled={!!busy} onClick={() => answer(false)}>
            {t('members.decline')}
          </Button>
          <Button variant="contained" size="small" loading={busy === 'accept'} disabled={!!busy} onClick={() => answer(true)}>
            {t('members.accept')}
          </Button>
        </Stack>
      }
    >
      {t('members.invitedYou', { who: personName(invite.invited_by, t), book: invite.book_name, role: t(`members.role.${invite.role}`) })}
      {error ? <> {errorText(error)}</> : null}
    </Alert>
  )
}
