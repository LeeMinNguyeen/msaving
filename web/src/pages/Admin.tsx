import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
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
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { api, send } from '../lib/api'
import { useInstance, useMe } from '../lib/queries'

type AdminUser = {
  id: string; username: string; display_name: string | null; is_admin: boolean; created_at: string
  disabled_at: string | null; deletion_requested_at: string | null; last_seen_at: string | null; two_factor: boolean
}
type Invite = {
  id: string; note: string | null; created_at: string; expires_at: string
  used_by_username: string | null; used_at: string | null; revoked_at: string | null
}
type CreatedInvite = { id: string; code: string; expires_at: string; link: string | null; qr: string | null }

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : ''

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>{title}</Typography>
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  )
}

// Something shown once (an invite or a reset link): copy it, or show the QR code.
function ShowOnce({ title, body, link, qr, code, onClose }: {
  title: string; body: string; link: string; qr?: string | null; code?: string; onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ alignItems: 'center' }}>
          <DialogContentText>{body}</DialogContentText>
          {qr && <Box component="img" src={qr} alt="QR" sx={{ width: 220, height: 220, bgcolor: '#fff', p: 1, borderRadius: 1 }} />}
          {code && <Typography variant="h5" sx={{ fontFamily: 'monospace', letterSpacing: 2 }}>{code}</Typography>}
          <TextField fullWidth value={link} slotProps={{ htmlInput: { readOnly: true } }} onFocus={(e) => e.target.select()} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => navigator.clipboard?.writeText(link)}>{t('common.copy')}</Button>
        <Button variant="contained" onClick={onClose}>{t('common.done')}</Button>
      </DialogActions>
    </Dialog>
  )
}

// The server's admin: its name, who can sign up, invites and accounts.
export function Admin() {
  const { t } = useTranslation()
  const me = useMe()
  if (!me.data?.profile.is_admin) return <Alert severity="info">{t('errors.admin_only')}</Alert>
  return (
    <Stack spacing={2} sx={{ maxWidth: 960 }}>
      <Typography variant="h5">{t('admin.title')}</Typography>
      <ServerSettings />
      <Updates />
      <Invites />
      <Users selfId={me.data.id} />
    </Stack>
  )
}

function ServerSettings() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const instance = useInstance()
  const [name, setName] = useState<string | null>(null)
  const [signup, setSignup] = useState<'invite' | 'open' | null>(null)
  const [state, setState] = useState<{ error?: unknown; saved?: boolean; busy?: boolean }>({})
  if (!instance.data) return null

  async function save(e: FormEvent) {
    e.preventDefault()
    setState({ busy: true })
    try {
      await send('PATCH', '/v1/admin/instance', { name: name ?? undefined, signup: signup ?? undefined })
      await qc.invalidateQueries({ queryKey: ['instance'] })
      setState({ saved: true })
    } catch (err) {
      setState({ error: err })
    }
  }

  return (
    <Section title={t('admin.server')}>
      <Stack component="form" spacing={2} onSubmit={save}>
        <TextField label={t('setup.serverName')} required value={name ?? instance.data.name} onChange={(e) => setName(e.target.value)}
          helperText={t('setup.serverNameHint')} slotProps={{ htmlInput: { maxLength: 60 } }} />
        <TextField select label={t('admin.signup')} value={signup ?? instance.data.signup}
          onChange={(e) => setSignup(e.target.value as 'invite' | 'open')} helperText={t('admin.signupHint')}>
          <MenuItem value="invite">{t('admin.signupInvite')}</MenuItem>
          <MenuItem value="open">{t('admin.signupOpen')}</MenuItem>
        </TextField>
        {state.error ? <Alert severity="error">{errorText(state.error)}</Alert> : null}
        {state.saved ? <Alert severity="success">{t('profile.saved')}</Alert> : null}
        <Button type="submit" variant="contained" loading={state.busy} sx={{ alignSelf: 'start' }}>{t('profile.save')}</Button>
      </Stack>
    </Section>
  )
}

type UpdateInfo = {
  current_version: string; latest_version: string | null; release_url: string | null; update_available: boolean
  updater: boolean; status: string | null
}

// The newest release, and a one-click Update when the operator turned on the
// updater helper; otherwise the two commands to run on the server.
// Whether the helper's status line ("done 2026-...", "failed ...") is about the update started at `since`.
function updateFinished(status: string | null | undefined, since: number | null): boolean {
  const [state, at] = (status ?? '').split(' ')
  return !!since && !!at && Date.parse(at) >= since - 5000 && (state === 'done' || state === 'failed')
}

function Updates() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [started, setStarted] = useState<number | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const info = useQuery({
    queryKey: ['admin', 'update'],
    queryFn: () => api<UpdateInfo>('/v1/admin/update'),
    // While updating, the server goes away for a moment: keep asking.
    refetchInterval: (q) => (started && !updateFinished(q.state.data?.status, started) ? 5000 : false),
    retry: started ? true : 1,
  })
  const d = info.data
  const updating = !!started && !updateFinished(d?.status, started)

  async function update() {
    setConfirm(false)
    setError(null)
    try {
      await send('POST', '/v1/admin/update')
      setStarted(Date.now())
    } catch (err) {
      setError(err)
    }
  }

  if (!d) return null
  return (
    <Section title={t('admin.updates')}>
      <Typography>
        {t('admin.version', { version: d.current_version })}
        {d.latest_version && ' · ' + t('admin.latest', { version: d.latest_version })}
      </Typography>
      {updating ? <Alert severity="info">{t('admin.updating')}</Alert> : null}
      {!updating && d.status?.startsWith('done') ? <Alert severity="success">{t('admin.updateDone')}</Alert> : null}
      {!updating && d.status?.startsWith('failed') ? <Alert severity="error">{t('admin.updateFailed', { detail: d.status })}</Alert> : null}
      {d.update_available && d.release_url && (
        <Button href={d.release_url} target="_blank" rel="noopener" sx={{ alignSelf: 'start' }}>{t('admin.releaseNotes')}</Button>
      )}
      {d.updater ? (
        <Button variant="contained" loading={updating} disabled={!d.update_available}
          onClick={() => setConfirm(true)} sx={{ alignSelf: 'start' }}>{t('admin.updateNow')}</Button>
      ) : (
        <>
          <Typography color="text.secondary">{t('admin.updateByHand')}</Typography>
          <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto' }}>
            git pull{'\n'}docker compose up -d --build
          </Box>
          <Typography variant="body2" color="text.secondary">{t('admin.updaterHint')}</Typography>
        </>
      )}
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Dialog open={confirm} onClose={() => setConfirm(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('admin.updateNow')}</DialogTitle>
        <DialogContent><DialogContentText>{t('admin.updateConfirm', { version: d.latest_version })}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={update}>{t('admin.updateNow')}</Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}

function Invites() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => api<Invite[]>('/v1/admin/invites') })
  const [note, setNote] = useState('')
  const [days, setDays] = useState(7)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const [now] = useState(() => Date.now())
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setCreated(await send<CreatedInvite>('POST', '/v1/admin/invites', { note: note.trim() || null, days, server: window.location.origin }))
      setNote('')
      await qc.invalidateQueries({ queryKey: ['admin', 'invites'] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    try {
      await send('DELETE', `/v1/admin/invites/${id}`)
      await qc.invalidateQueries({ queryKey: ['admin', 'invites'] })
    } catch (err) {
      setError(err)
    }
  }

  const status = (i: Invite) =>
    i.used_at ? t('admin.inviteUsed', { name: i.used_by_username ?? '' })
      : i.revoked_at ? t('admin.inviteRevoked')
        : Date.parse(i.expires_at) < now ? t('admin.inviteExpired')
          : t('admin.inviteOpen', { date: when(i.expires_at) })

  return (
    <Section title={t('admin.invites')}>
      <Typography color="text.secondary">{t('admin.invitesHint')}</Typography>
      <Stack component="form" direction={{ xs: 'column', sm: 'row' }} spacing={1} onSubmit={create}>
        <TextField size="small" label={t('admin.inviteNote')} value={note} onChange={(e) => setNote(e.target.value)}
          slotProps={{ htmlInput: { maxLength: 100 } }} fullWidth />
        <TextField size="small" select label={t('admin.inviteDays')} value={days} onChange={(e) => setDays(Number(e.target.value))}
          sx={{ width: { sm: 160 }, flexShrink: 0 }}>
          {[1, 7, 30].map((d) => <MenuItem key={d} value={d}>{t('admin.days', { count: d })}</MenuItem>)}
        </TextField>
        <Button type="submit" variant="contained" loading={busy} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{t('admin.createInvite')}</Button>
      </Stack>
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      {invites.data && invites.data.length > 0 && (
        <Box sx={{ overflowX: 'auto' }}>{/* phones: the table scrolls, not the page */}
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('admin.inviteNote')}</TableCell>
                <TableCell>{t('admin.created')}</TableCell>
                <TableCell>{t('admin.status')}</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {invites.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.note}</TableCell>
                  <TableCell>{when(i.created_at)}</TableCell>
                  <TableCell>{status(i)}</TableCell>
                  <TableCell align="right">
                    {!i.used_at && !i.revoked_at && Date.parse(i.expires_at) > now && (
                      <Button size="small" color="error" onClick={() => revoke(i.id)}>{t('admin.revoke')}</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
      {created && (
        <ShowOnce title={t('admin.inviteReady')} body={t('admin.inviteReadyBody', { date: when(created.expires_at) })}
          link={created.link ?? created.code} qr={created.qr} code={created.code} onClose={() => setCreated(null)} />
      )}
    </Section>
  )
}

function Users({ selfId }: { selfId: string }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/v1/admin/users') })
  const [reset, setReset] = useState<{ username: string; link: string } | null>(null)
  const [error, setError] = useState<unknown>(null)

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Section title={t('admin.users')}>
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Box sx={{ overflowX: 'auto' }}>{/* phones: the table scrolls, not the page */}
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('auth.username')}</TableCell>
              <TableCell>{t('admin.lastSeen')}</TableCell>
              <TableCell>{t('admin.status')}</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {users.data?.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  {u.username}{u.display_name ? ` (${u.display_name})` : ''}
                  {u.is_admin && <Chip size="small" label={t('admin.admin')} sx={{ ml: 1 }} />}
                </TableCell>
                <TableCell>{when(u.last_seen_at)}</TableCell>
                <TableCell>
                  {u.disabled_at ? t('admin.disabled') : u.deletion_requested_at ? t('admin.closing') : t('admin.active')}
                  {u.two_factor && ` · ${t('admin.twoFactor')}`}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  <Button size="small" onClick={() => act(async () => {
                    const r = await send<{ token: string }>('POST', `/v1/admin/users/${u.id}/reset`)
                    setReset({ username: u.username, link: `${window.location.origin}/reset?token=${r.token}` })
                  })}>{t('admin.resetLink')}</Button>
                  {u.id !== selfId && (
                    <Button size="small" color={u.disabled_at ? 'primary' : 'error'}
                      onClick={() => act(() => send('POST', `/v1/admin/users/${u.id}/disable`, { disabled: !u.disabled_at }))}>
                      {t(u.disabled_at ? 'admin.enable' : 'admin.disable')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      {reset && (
        <ShowOnce title={t('admin.resetReady', { name: reset.username })} body={t('admin.resetReadyBody')}
          link={reset.link} onClose={() => setReset(null)} />
      )}
    </Section>
  )
}
