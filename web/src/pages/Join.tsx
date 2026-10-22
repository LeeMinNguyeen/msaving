import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link as RouterLink, useSearchParams } from 'react-router'
import { Centered } from '../components/Centered'
import { send, upload, type Token } from '../lib/api'
import { waitForServer } from '../lib/restart'
import { FileField } from '../components/FileField'
import { useInstance } from '../lib/queries'
import { newAccountBody, useSignedInForm } from '../auth/forms'
import { FormError, NewAccountFields, PasswordFields, PublicHeader } from '../components/AccountForm'

// Join with an invite (/join?code=X7K2-9QPM, from the admin's link or QR
// code), or without one when the admin has opened sign-up.
export function Join() {
  const { t } = useTranslation()
  const instance = useInstance()
  const [params] = useSearchParams()
  const [code, setCode] = useState(params.get('code') ?? '')
  const { submit, error, busy } = useSignedInForm()
  const open = instance.data?.signup === 'open'

  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={(e) => submit(e, (form) =>
        send<Token>('POST', '/v1/auth/sign-up', { ...newAccountBody(form), invite_code: code.trim() || null }))}>
        <PublicHeader title={t('join.title')} />
        <Typography color="text.secondary">{t(open ? 'join.introOpen' : 'join.intro')}</Typography>
        <TextField label={t('join.code')} value={code} onChange={(e) => setCode(e.target.value)} required={!open}
          helperText={t('join.codeHint')} slotProps={{ htmlInput: { autoCapitalize: 'characters', autoComplete: 'off' } }} />
        <NewAccountFields />
        <FormError error={error} />
        <Button type="submit" variant="contained" size="large" loading={busy}>{t('join.submit')}</Button>
        <Button component={RouterLink} to="/sign-in">{t('auth.toSignIn')}</Button>
      </Stack>
    </Centered>
  )
}

// The first start: the admin account, with the setup code from the server's log.
export function Setup() {
  const { t } = useTranslation()
  const { submit, error, busy } = useSignedInForm()
  const [restoring, setRestoring] = useState(false)
  if (restoring) return <SetupRestore onBack={() => setRestoring(false)} />
  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={(e) => submit(e, (form) => {
        const f = new FormData(form)
        return send<Token>('POST', '/v1/setup', {
          ...newAccountBody(form), setup_code: String(f.get('setup_code')).trim(),
          server_name: String(f.get('server_name') ?? '').trim() || null,
        })
      })}>
        <PublicHeader title={t('setup.title')} />
        <Typography color="text.secondary">{t('setup.intro')}</Typography>
        <TextField name="setup_code" label={t('setup.code')} required helperText={t('setup.codeHint')}
          slotProps={{ htmlInput: { autoCapitalize: 'characters', autoComplete: 'off' } }} />
        <TextField name="server_name" label={t('setup.serverName')} helperText={t('setup.serverNameHint')}
          slotProps={{ htmlInput: { maxLength: 60 } }} />
        <Typography variant="subtitle1">{t('setup.adminAccount')}</Typography>
        <NewAccountFields />
        <FormError error={error} />
        <Button type="submit" variant="contained" size="large" loading={busy}>{t('setup.submit')}</Button>
        <Button onClick={() => setRestoring(true)}>{t('restore.instead')}</Button>
      </Stack>
    </Centered>
  )
}

// A new server brought back from a backup: the setup code proves who installed it, as for creating the admin.
function SetupRestore({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [purged, setPurged] = useState<File | null>(null)
  const [state, setState] = useState<{ busy?: boolean; error?: unknown; restarting?: boolean }>({})

  async function start(e: FormEvent) {
    e.preventDefault()
    if (!file || !code.trim()) return
    const form = new FormData()
    form.append('setup_code', code.trim().toUpperCase())
    form.append('file', file)
    if (purged) form.append('purged', purged)
    setState({ busy: true })
    try {
      await upload('/v1/setup/restore', form)
    } catch (err) {
      setState({ error: err })
      return
    }
    setState({ restarting: true })
    await waitForServer()
    window.location.reload()
  }

  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={start}>
        <PublicHeader title={t('restore.title')} />
        {state.restarting ? <Alert severity="info">{t('restore.setupRestarting')}</Alert> : (
          <>
            <Typography color="text.secondary">{t('restore.setupIntro')}</Typography>
            <TextField label={t('setup.code')} required value={code} onChange={(e) => setCode(e.target.value)} helperText={t('setup.codeHint')}
              slotProps={{ htmlInput: { autoCapitalize: 'characters', autoComplete: 'off' } }} />
            <FileField label={t('restore.file')} button={t('restore.choose')} file={file} onChange={setFile} accept=".dump" />
            <FileField label={t('restore.purged')} button={t('restore.choose')} file={purged} onChange={setPurged} accept=".jsonl" />
            <Typography variant="body2" color="text.secondary">{t('restore.purgedHint')}</Typography>
            <FormError error={state.error} />
            <Button type="submit" variant="contained" size="large" loading={state.busy} disabled={!file || !code.trim()}>{t('restore.submit')}</Button>
            <Button onClick={onBack}>{t('restore.back')}</Button>
          </>
        )}
      </Stack>
    </Centered>
  )
}

// A reset link from the admin (/reset?token=...): a new password, then signed in.
export function Reset() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const { submit, error, busy } = useSignedInForm()
  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={(e) => submit(e, (form) => {
        const { password } = newAccountBody(form)
        return send<Token>('POST', '/v1/auth/reset', { token: params.get('token') ?? '', new_password: password })
      })}>
        <PublicHeader title={t('reset.title')} />
        <Typography color="text.secondary">{t('reset.intro')}</Typography>
        <PasswordFields label={t('reset.newPassword')} />
        <FormError error={error} />
        <Button type="submit" variant="contained" size="large" loading={busy}>{t('reset.submit')}</Button>
      </Stack>
    </Centered>
  )
}
