import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link as RouterLink } from 'react-router'
import { useSignedInForm } from '../auth/forms'
import { rememberedDevice } from '../auth/rememberedDevice'
import { Centered } from '../components/Centered'
import { FormError, PublicHeader } from '../components/AccountForm'
import { ApiError, send, type SignedIn } from '../lib/api'
import { useIdleNotice } from '../lib/idle'
import { useInstance } from '../lib/queries'
// Sign in: username, password, and the authenticator's code (or a recovery
// code) once the server says two-factor is on.
export function SignIn() {
  const { t } = useTranslation()
  const instance = useInstance()
  const idleMinutes = useIdleNotice()
  const [needsCode, setNeedsCode] = useState(false)
  const { submit, error, busy } = useSignedInForm()

  async function signIn(form: HTMLFormElement) {
    const f = new FormData(form)
    const username = String(f.get('username')).trim()
    const deviceToken = rememberedDevice.get(username)
    try {
      const signedIn = await send<SignedIn>('POST', '/v1/auth/sign-in', {
        username, password: String(f.get('password')), code: needsCode ? String(f.get('code') ?? '').trim() : null,
        remember_device: needsCode && f.get('remember') === 'on', device_token: deviceToken,
      })
      if (signedIn.device_token) rememberedDevice.set(username, signedIn.device_token)
      return signedIn
    } catch (err) {
      if (err instanceof ApiError && err.code === 'code_required') {
        if (deviceToken) rememberedDevice.forget(username)
        setNeedsCode(true)
      }
      throw err
    }
  }

  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={(e) => submit(e, signIn)}>
        <PublicHeader title={t('auth.signInTitle')} languageSwitch={false} />
        {idleMinutes && <Alert severity="info">{t('idle.signedOut', { minutes: idleMinutes })}</Alert>}
        <TextField name="username" label={t('auth.username')} required autoComplete="username"
          slotProps={{ htmlInput: { autoCapitalize: 'none' } }} />
        <TextField name="password" label={t('auth.password')} type="password" required autoComplete="current-password" />
        {needsCode && (
          <>
            <TextField name="code" label={t('mfa.codeOrRecovery')} required autoFocus
              slotProps={{ htmlInput: { autoComplete: 'one-time-code', autoCapitalize: 'characters' } }} />
            <FormControlLabel control={<Checkbox name="remember" />} label={t('mfa.rememberDevice')} />
          </>
        )}
        {error instanceof ApiError && error.code === 'code_required' ? null : <FormError error={error} />}
        <Button type="submit" variant="contained" size="large" loading={busy}>{t('auth.signIn')}</Button>
        <Typography variant="body2" color="text.secondary">
          {instance.data?.signup === 'open'
            ? <>{t('auth.noAccount')} <Button component={RouterLink} to="/join" size="small">{t('auth.toSignUp')}</Button></>
            : t('auth.inviteOnly')}
        </Typography>
        <Typography variant="body2" color="text.secondary">{t('auth.forgotPassword')}</Typography>
      </Stack>
    </Centered>
  )
}
