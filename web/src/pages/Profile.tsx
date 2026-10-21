import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../components/errors'
import { TimezonePicker } from '../components/TimezonePicker'
import { currentLanguage, languages, setLanguage, type Language } from '../i18n'
import { api, download, send, type DeviceSession, type Me, type Profile as ProfileT } from '../lib/api'
import { keys, useMe } from '../lib/queries'

const IDLE_CHOICES = [0, 5, 10, 15, 30, 60] // minutes; 0: never (30 days unused)
import { newAccountBody } from '../auth/forms'
import { PasswordFields } from '../components/AccountForm'
import { rememberedDevice } from '../auth/rememberedDevice'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>{title}</Typography>
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  )
}

export function Profile() {
  const { t } = useTranslation()
  const me = useMe()
  if (!me.data) return null
  return (
    <Stack spacing={2} sx={{ maxWidth: 720 }}>
      <Typography variant="h5">{t('profile.title')}</Typography>
      <ProfileForm profile={me.data.profile} />
      <Security />
      <Devices profile={me.data.profile} />
      <YourData profile={me.data.profile} />
    </Stack>
  )
}

function ProfileForm({ profile }: { profile: ProfileT }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const [username, setUsername] = useState(profile.username)
  const [displayName, setDisplayName] = useState(profile.display_name ?? '')
  const [language, setLang] = useState<Language>(profile.language)
  const [timezone, setTimezone] = useState<string | null>(profile.timezone)
  const [status, setStatus] = useState<{ error?: unknown; saved?: boolean }>({})
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus({})
    try {
      const me = await send<Me>('PATCH', '/v1/me', { username: username.trim().toLowerCase(), display_name: displayName.trim(), language, timezone })
      qc.setQueryData(keys.me, me)
      setLanguage(language)
      setStatus({ saved: true })
    } catch (err) {
      setStatus({ error: err })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('profile.profile')}>
      <Stack component="form" spacing={2} onSubmit={save}>
        <TextField label={t('profile.username')} required value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())}
          helperText={t('welcome.usernameHint')} slotProps={{ htmlInput: { pattern: '[a-z0-9][a-z0-9_.]{2,29}', autoCapitalize: 'none' } }} />
        <TextField label={t('profile.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextField select label={t('profile.language')} value={language} onChange={(e) => setLang(e.target.value as Language)}>
          {languages.map((l) => <MenuItem key={l} value={l}>{t(`language.${l}`)}</MenuItem>)}
        </TextField>
        <TimezonePicker label={t('profile.timezone')} value={timezone} onChange={setTimezone} />
        {status.error ? <Alert severity="error">{errorText(status.error)}</Alert> : null}
        {status.saved ? <Alert severity="success">{t('profile.saved')}</Alert> : null}
        <Button type="submit" variant="contained" loading={busy} disabled={!timezone} sx={{ alignSelf: 'start' }}>{t('profile.save')}</Button>
      </Stack>
    </Section>
  )
}

type TwoFactorState = { enabled: boolean; recovery_codes_left: number }
type Enrolment = { secret: string; uri: string; qr: string }

function Security() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const twoFactor = useQuery({ queryKey: ['two-factor'], queryFn: () => api<TwoFactorState>('/v1/auth/two-factor') })
  const [enroll, setEnroll] = useState<Enrolment | null>(null)
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState<'off' | 'codes' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const refresh = () => qc.invalidateQueries({ queryKey: ['two-factor'] })

  const finish = (e: FormEvent) => {
    e.preventDefault()
    if (!enroll) return
    void run(async () => {
      const r = await send<{ recovery_codes: string[] }>('POST', '/v1/auth/two-factor/enable', { secret: enroll.secret, code })
      setEnroll(null)
      setCode('')
      setRecovery(r.recovery_codes)
      await refresh()
    })
  }

  // Turning it off and new recovery codes both need a current code.
  const withCode = () => run(async () => {
    if (confirm === 'off') {
      await send('POST', '/v1/auth/two-factor/disable', { code })
    } else {
      setRecovery((await send<{ recovery_codes: string[] }>('POST', '/v1/auth/two-factor/recovery-codes', { code })).recovery_codes)
    }
    setConfirm(null)
    setCode('')
    await refresh()
  })

  const changePassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    void run(async () => {
      const { password } = newAccountBody(form)
      await send('POST', '/v1/auth/password', { current_password: String(new FormData(form).get('current')), new_password: password })
      form.reset()
      setNotice(t('profile.passwordChanged'))
    })
  }

  const codeField = (
    <TextField label={t('mfa.codeLabel')} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
      slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code' } }} />
  )
  const on = twoFactor.data?.enabled ?? false

  return (
    <Section title={t('profile.security')}>
      <Typography variant="subtitle1">{t('profile.password')}</Typography>
      <Stack component="form" spacing={2} onSubmit={changePassword}>
        <TextField name="current" label={t('profile.currentPassword')} type="password" required autoComplete="current-password" />
        <PasswordFields label={t('reset.newPassword')} />
        <Button type="submit" variant="outlined" loading={busy} sx={{ alignSelf: 'start' }}>{t('profile.changePassword')}</Button>
      </Stack>
      <Divider />
      <Typography variant="subtitle1">{t('mfa.title')}</Typography>
      <Typography color="text.secondary">
        {on ? t('mfa.enabled') : t('mfa.disabled')}
        {on && ' ' + t('mfa.codesLeft', { count: twoFactor.data?.recovery_codes_left ?? 0 })}
      </Typography>
      {!enroll && !on && (
        <Button variant="outlined" sx={{ alignSelf: 'start' }}
          onClick={() => run(async () => setEnroll(await send<Enrolment>('POST', '/v1/auth/two-factor/setup')))}>
          {t('mfa.enable')}
        </Button>
      )}
      {!enroll && on && (
        <Stack direction="row" spacing={1}>
          <Button onClick={() => { setCode(''); setConfirm('codes') }}>{t('mfa.newCodes')}</Button>
          <Button color="error" onClick={() => { setCode(''); setConfirm('off') }}>{t('mfa.disable')}</Button>
        </Stack>
      )}
      {enroll && (
        <Stack component="form" spacing={2} onSubmit={finish}>
          <Typography>{t('mfa.setupStep1')}</Typography>
          <Box component="img" src={enroll.qr} alt="QR" sx={{ width: 180, height: 180, bgcolor: '#fff', p: 1, borderRadius: 1 }} />
          <TextField label={t('mfa.secret')} value={enroll.secret} slotProps={{ htmlInput: { readOnly: true } }} />
          <Typography>{t('mfa.setupStep2')}</Typography>
          {codeField}
          <Button type="submit" variant="contained" loading={busy} disabled={code.length !== 6} sx={{ alignSelf: 'start' }}>{t('mfa.verify')}</Button>
        </Stack>
      )}
      {notice && <Alert severity="success">{notice}</Alert>}
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t(confirm === 'off' ? 'mfa.disable' : 'mfa.newCodes')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <DialogContentText>{t(confirm === 'off' ? 'mfa.disableConfirm' : 'mfa.newCodesConfirm')}</DialogContentText>
            {codeField}
            {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button color={confirm === 'off' ? 'error' : 'primary'} variant="contained" loading={busy} disabled={code.length !== 6}
            onClick={withCode}>
            {t(confirm === 'off' ? 'mfa.disable' : 'mfa.newCodes')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!recovery} fullWidth maxWidth="xs">
        <DialogTitle>{t('mfa.recoveryTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <DialogContentText>{t('mfa.recoveryBody')}</DialogContentText>
            <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, columns: 2, fontSize: 16 }}>
              {recovery?.join('\n')}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => navigator.clipboard?.writeText(recovery?.join('\n') ?? '')}>{t('common.copy')}</Button>
          <Button variant="contained" onClick={() => setRecovery(null)}>{t('mfa.recoverySaved')}</Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}

// Signed-in devices, and the user's own sign-out after inactivity for every device, saved as soon as it's picked.
function Devices({ profile }: { profile: ProfileT }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<DeviceSession[]>('/v1/auth/sessions') })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const when = new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  const name = (s: DeviceSession) => s.device ?? t('profile.unknownDevice')
  const others = (sessions.data ?? []).filter((s) => !s.current)
  const idle = profile.idle_sign_out_minutes ?? 0
  const idleChoices = IDLE_CHOICES.includes(idle) ? IDLE_CHOICES : [...IDLE_CHOICES, idle].sort((a, b) => a - b)

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key)
    setError(null)
    setNotice('')
    try {
      await fn()
      setNotice(done)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    }
  }

  return (
    <Section title={t('profile.devices')}>
      <TextField select label={t('profile.idleSignOut')} value={idle} helperText={t('profile.idleSignOutHint')} disabled={busy === 'idle'}
        onChange={(e) => run('idle', async () => {
          await send('PATCH', '/v1/me', { idle_sign_out_minutes: Number(e.target.value) || null })
          await qc.invalidateQueries({ queryKey: keys.me })
        }, t('profile.saved'))}>
        {idleChoices.map((m) => <MenuItem key={m} value={m}>{m ? t('profile.idleMinutes', { minutes: m }) : t('profile.idleOff')}</MenuItem>)}
      </TextField>
      <Typography color="text.secondary">{t('profile.devicesHint')}</Typography>
      {sessions.isError && <Alert severity="error">{errorText(sessions.error)}</Alert>}
      {sessions.data && (
        <List disablePadding>
          {sessions.data.map((s) => (
            <ListItem key={s.id} disableGutters divider secondaryAction={!s.current && (
              <Button size="small" color="error" loading={busy === s.id}
                onClick={() => run(s.id, () => send('DELETE', `/v1/auth/sessions/${s.id}`), t('profile.signedOutDevice', { device: name(s) }))}>
                {t('profile.signOutDevice')}
              </Button>
            )}>
              <ListItemText
                primary={<>{name(s)}{s.current && <Chip size="small" color="primary" label={t('profile.thisDevice')} sx={{ ml: 1 }} />}</>}
                secondary={t('profile.deviceTimes', { signedIn: when.format(new Date(s.created_at)), lastUsed: when.format(new Date(s.last_used_at)) })}
                sx={{ pr: s.current ? 0 : 10 }} />
            </ListItem>
          ))}
        </List>
      )}
      {others.length > 0 && (
        <Button variant="outlined" loading={busy === 'others'} sx={{ alignSelf: 'start' }}
          onClick={() => run('others', () => send('POST', '/v1/auth/sign-out-others', { device_token: rememberedDevice.get(profile.username) }),
            t('profile.signedOutOthers'))}>
          {t('profile.signOutOthers')}
        </Button>
      )}
      {notice && <Alert severity="success">{notice}</Alert>}
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
    </Section>
  )
}

function YourData({ profile }: { profile: ProfileT }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  const close = () => run(async () => {
    await send('POST', '/v1/me/delete')
    setConfirm(false)
    await qc.invalidateQueries({ queryKey: keys.me })
  })

  return (
    <Section title={t('profile.yourData')}>
      <Typography color="text.secondary">{t('profile.exportHint')}</Typography>
      <Button variant="outlined" loading={busy && !confirm} onClick={() => run(() => download('/v1/me/export'))} sx={{ alignSelf: 'start' }}>
        {t('profile.export')}
      </Button>
      <Divider />
      <Typography variant="subtitle1">{t('profile.deleteTitle')}</Typography>
      <Typography color="text.secondary">{t('profile.deleteHint')}</Typography>
      <Button color="error" variant="outlined" onClick={() => { setTyped(''); setConfirm(true) }} sx={{ alignSelf: 'start' }}>{t('profile.delete')}</Button>
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Dialog open={confirm} onClose={() => setConfirm(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('profile.deleteTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <DialogContentText>{t('profile.deleteHint')}</DialogContentText>
            <TextField label={t('profile.deleteConfirmLabel')} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy}
            disabled={typed.trim().toLowerCase() !== profile.username} onClick={close}>
            {t('profile.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}
