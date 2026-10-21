import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link as RouterLink } from 'react-router'
import { useSignedInForm } from '../auth/forms'
import { Centered } from '../components/Centered'
import { FormError, PublicHeader } from '../components/AccountForm'
import { ApiError, send, type Token } from '../lib/api'
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
    try {
      return await send<Token>('POST', '/v1/auth/sign-in', {
        username: String(f.get('username')).trim(), password: String(f.get('password')),
        code: needsCode ? String(f.get('code') ?? '').trim() : null,
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'code_required') setNeedsCode(true)
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
          <TextField name="code" label={t('mfa.codeOrRecovery')} required autoFocus
            slotProps={{ htmlInput: { autoComplete: 'one-time-code', autoCapitalize: 'characters' } }} />
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
