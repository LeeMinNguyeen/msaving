import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { send, type Book, type Member, type Role } from '../lib/api'
import { personName } from '../lib/people'
import { keys, useMembers } from '../lib/queries'
import { useErrorText } from './errors'

const ROLES: Role[] = ['owner', 'editor', 'viewer']

// Who's in a book (Book settings). Owners invite by username, change roles and
// remove people; everyone can leave. Invitees appear as pending until they accept.
export function BookMembers({ book }: { book: Book }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const members = useMembers(book.id)
  const owner = book.role === 'owner'
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ error?: unknown; invited?: string }>({})
  const [removing, setRemoving] = useState<Member | null>(null)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setStatus({})
    try {
      await action()
      return true
    } catch (err) {
      setStatus({ error: err })
      return false
    } finally {
      setBusy(false)
      await qc.invalidateQueries({ queryKey: keys.members(book.id) })
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    const name = username.trim()
    if (await run(() => send('POST', `/v1/books/${book.id}/members`, { username: name, role }))) {
      setUsername('')
      setStatus({ invited: name })
    }
  }

  async function remove(m: Member) {
    setRemoving(null)
    if (await run(() => send('DELETE', `/v1/books/${book.id}/members/${m.user_id}`)) && m.me) {
      await qc.invalidateQueries({ queryKey: keys.books })
      navigate('/', { replace: true })
    }
  }

  async function changeRole(m: Member, r: Role) {
    // Stepping down from owner changes what this screen allows.
    if (await run(() => send('PATCH', `/v1/books/${book.id}/members/${m.user_id}`, { role: r })) && m.me) {
      await qc.invalidateQueries({ queryKey: keys.books })
    }
  }

  const me = members.data?.find((m) => m.me)
  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t('members.title')}</Typography>
      <Typography color="text.secondary">{t('members.intro')}</Typography>
      <List disablePadding>
        {(members.data ?? []).map((m) => (
          <ListItem key={m.user_id} disableGutters
            secondaryAction={owner && !m.me && (
              <Tooltip title={m.pending ? t('members.cancelInvite') : t('members.remove')}>
                <IconButton edge="end" aria-label={m.pending ? t('members.cancelInvite') : t('members.remove')}
                  disabled={busy} onClick={() => setRemoving(m)}>
                  <CloseIcon />
                </IconButton>
              </Tooltip>
            )}>
            <ListItemText sx={{ minWidth: 0 }}
              primary={<>{personName(m.name, t)}{m.me && ` (${t('members.you')})`}{' '}
                {m.pending && <Chip size="small" label={t('members.pending')} />}</>}
              secondary={m.display_name}
            />
            {owner ? (
              <TextField select size="small" value={m.role} disabled={busy} sx={{ width: 160, flexShrink: 0, mr: 5 }}
                aria-label={t('members.roleLabel')} onChange={(e) => changeRole(m, e.target.value as Role)}>
                {ROLES.map((r) => <MenuItem key={r} value={r}>{t(`members.role.${r}`)}</MenuItem>)}
              </TextField>
            ) : (
              <Typography color="text.secondary">{t(`members.role.${m.role}`)}</Typography>
            )}
          </ListItem>
        ))}
      </List>
      {owner && (
        <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} onSubmit={invite}>
          <TextField size="small" label={t('members.username')} value={username} onChange={(e) => setUsername(e.target.value)}
            autoComplete="off" sx={{ flex: 1, minWidth: 200 }} />
          <TextField select size="small" label={t('members.roleLabel')} value={role} onChange={(e) => setRole(e.target.value as Role)}
            sx={{ width: { sm: 160 }, flexShrink: 0 }}>
            {ROLES.map((r) => <MenuItem key={r} value={r}>{t(`members.role.${r}`)}</MenuItem>)}
          </TextField>
          <Button type="submit" variant="contained" loading={busy} disabled={!username.trim()}>{t('members.invite')}</Button>
        </Stack>
      )}
      {owner && <Typography variant="body2" color="text.secondary">{t('members.roles')}</Typography>}
      {status.error ? <Alert severity="error">{errorText(status.error)}</Alert> : null}
      {status.invited ? <Alert severity="success">{t('members.invited', { name: status.invited })}</Alert> : null}
      {me && (
        <Button color="error" variant="outlined" onClick={() => setRemoving(me)} sx={{ alignSelf: 'start' }}>
          {t('members.leave')}
        </Button>
      )}
      <Dialog open={!!removing} onClose={() => setRemoving(null)} fullWidth maxWidth="xs">
        <DialogTitle>{removing?.me ? t('members.leaveTitle') : t('members.removeTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {removing?.me ? t('members.leaveBody', { book: book.name })
              : t('members.removeBody', { name: personName(removing?.name ?? '', t), book: book.name })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => removing && remove(removing)}>
            {removing?.me ? t('members.leave') : t('members.remove')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
