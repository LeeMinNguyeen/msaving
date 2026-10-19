import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Link from '@mui/material/Link'
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
import { config } from '../config'
import { languages, setLanguage, type Language } from '../i18n'
import { api, download, send, type ConsentStatus, type Me, type Profile as ProfileT } from '../lib/api'
import { keys, useMe } from '../lib/queries'
import { supabase } from '../lib/supabase'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>{title}</Typography>
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  )
}

// Screen 10: profile, two-step verification, devices, export, consent, delete.
export function Profile() {
  const { t } = useTranslation()
  const me = useMe()
  if (!me.data?.profile) return null
  return (
    <Stack spacing={2} sx={{ maxWidth: 720 }}>
      <Typography variant="h5">{t('profile.title')}</Typography>
      <ProfileForm profile={me.data.profile} />
      <Security />
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
        <TextField label={t('profile.email')} value={profile.email} disabled />
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

function Security() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: async () => (await supabase.auth.mfa.listFactors()).data })
  const qc = useQueryClient()
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const verified = factors.data?.totp ?? []

  async function start() {
    setError(null)
    // A setup that was never finished leaves an unverified factor: clear it first.
    for (const f of factors.data?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `MSaving ${new Date().toISOString().slice(0, 10)}` })
    if (error) return setError(error)
    const qr = data.totp.qr_code.startsWith('data:') ? data.totp.qr_code : `data:image/svg+xml;utf-8,${encodeURIComponent(data.totp.qr_code)}`
    setEnroll({ id: data.id, qr, secret: data.totp.secret })
  }

  async function finish(e: FormEvent) {
    e.preventDefault()
    if (!enroll) return
    setBusy(true)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code })
    setBusy(false)
    if (error) return setError(error)
    setEnroll(null)
    setCode('')
    await qc.invalidateQueries({ queryKey: ['mfa-factors'] })
  }

  async function turnOff() {
    setConfirmOff(false)
    for (const f of verified) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id })
      if (error) return setError(error)
    }
    await supabase.auth.refreshSession()
    await qc.invalidateQueries({ queryKey: ['mfa-factors'] })
  }

  async function signOutOthers() {
    setNotice('')
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (error) setError(error)
    else setNotice(t('profile.signedOutOthers'))
  }

  return (
    <Section title={t('profile.security')}>
      <Typography variant="subtitle1">{t('mfa.title')}</Typography>
      <Typography color="text.secondary">{t(verified.length ? 'mfa.enabled' : 'mfa.disabled')}</Typography>
      {!enroll && !verified.length && <Button variant="outlined" onClick={start} sx={{ alignSelf: 'start' }}>{t('mfa.enable')}</Button>}
      {!enroll && verified.length > 0 && <Button color="error" onClick={() => setConfirmOff(true)} sx={{ alignSelf: 'start' }}>{t('mfa.disable')}</Button>}
      {enroll && (
        <Stack component="form" spacing={2} onSubmit={finish}>
          <Typography>{t('mfa.setupStep1')}</Typography>
          <Box component="img" src={enroll.qr} alt="QR" sx={{ width: 180, height: 180, bgcolor: '#fff', p: 1, borderRadius: 1 }} />
          <TextField label={t('mfa.secret')} value={enroll.secret} slotProps={{ htmlInput: { readOnly: true } }} />
          <Typography>{t('mfa.setupStep2')}</Typography>
          <TextField label={t('mfa.codeLabel')} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code' } }} />
          <Button type="submit" variant="contained" loading={busy} disabled={code.length !== 6} sx={{ alignSelf: 'start' }}>{t('mfa.verify')}</Button>
        </Stack>
      )}
      <Divider />
      <Typography variant="subtitle1">{t('profile.devices')}</Typography>
      <Typography color="text.secondary">{t('profile.devicesHint')}</Typography>
      <Button variant="outlined" onClick={signOutOthers} sx={{ alignSelf: 'start' }}>{t('profile.signOutOthers')}</Button>
      {notice && <Alert severity="success">{notice}</Alert>}
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Dialog open={confirmOff} onClose={() => setConfirmOff(false)}>
        <DialogContent><DialogContentText>{t('mfa.disableConfirm')}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOff(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={turnOff}>{t('mfa.disable')}</Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}

function YourData({ profile }: { profile: ProfileT }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const consent = useQuery({ queryKey: ['consent'], queryFn: () => api<ConsentStatus>('/v1/me/consent') })
  const [confirm, setConfirm] = useState<'withdraw' | 'delete' | null>(null)
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
  const close = (path: string) => run(async () => {
    await send('POST', path)
    setConfirm(null)
    await qc.invalidateQueries({ queryKey: keys.me })
  })

  return (
    <Section title={t('profile.yourData')}>
      <Typography color="text.secondary">{t('profile.exportHint')}</Typography>
      <Button variant="outlined" loading={busy && !confirm} onClick={() => run(() => download('/v1/me/export'))} sx={{ alignSelf: 'start' }}>
        {t('profile.export')}
      </Button>
      <Divider />
      <Typography variant="subtitle1">{t('profile.privacy')}</Typography>
      {consent.data?.agreed_version && (
        <Typography color="text.secondary">
          {t('profile.policyAgreed', { version: consent.data.agreed_version })}{' '}
          {consent.data.current_path && <Link href={`${config.siteUrl}${consent.data.current_path}`} target="_blank" rel="noopener">{t('profile.viewPolicy')}</Link>}
        </Typography>
      )}
      <Button color="error" onClick={() => setConfirm('withdraw')} sx={{ alignSelf: 'start' }}>{t('profile.withdraw')}</Button>
      <Divider />
      <Typography variant="subtitle1">{t('profile.deleteTitle')}</Typography>
      <Typography color="text.secondary">{t('profile.deleteHint')}</Typography>
      <Button color="error" variant="outlined" onClick={() => { setTyped(''); setConfirm('delete') }} sx={{ alignSelf: 'start' }}>{t('profile.delete')}</Button>
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t(confirm === 'delete' ? 'profile.deleteTitle' : 'profile.withdraw')}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <DialogContentText>{t(confirm === 'delete' ? 'profile.deleteHint' : 'profile.withdrawConfirm')}</DialogContentText>
            {confirm === 'delete' && <TextField label={t('profile.deleteConfirmLabel')} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" loading={busy}
            disabled={confirm === 'delete' && typed.trim().toLowerCase() !== profile.username}
            onClick={() => close(confirm === 'delete' ? '/v1/me/delete' : '/v1/me/consent/withdraw')}>
            {t(confirm === 'delete' ? 'profile.delete' : 'profile.withdraw')}
          </Button>
        </DialogActions>
      </Dialog>
    </Section>
  )
}
