import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Centered } from '../components/Centered'
import { useErrorText } from '../components/errors'
import { LanguagePicker } from '../components/LanguagePicker'
import { config } from '../config'
import { currentLanguage } from '../i18n'
import { usePolicy } from '../lib/queries'
import { supabase } from '../lib/supabase'

type Mode = 'signIn' | 'signUp' | 'checkEmail'

// Screen 1. Two-factor sign-in and the Turnstile CAPTCHA come with milestone 6
// and the hosted setup.
export function SignIn() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const policy = usePolicy()
  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const password = String(new FormData(e.currentTarget).get('password'))
    setBusy(true)
    setError(null)
    const { error } =
      mode === 'signUp'
        ? await supabase.auth.signUp({
            email,
            password,
            // Auth emails use this language; the confirmation link opens the app.
            options: { data: { language: currentLanguage() }, emailRedirectTo: window.location.origin },
          })
        : await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error)
    else if (mode === 'signUp') setMode('checkEmail')
    else navigate('/', { replace: true })
  }

  if (mode === 'checkEmail') {
    return (
      <Centered>
        <Stack spacing={2}>
          <Typography variant="h5">{t('auth.checkEmailTitle')}</Typography>
          <Typography>{t('auth.checkEmailBody', { email })}</Typography>
          <Button onClick={() => setMode('signIn')}>{t('auth.signIn')}</Button>
        </Stack>
      </Centered>
    )
  }

  const signUp = mode === 'signUp'
  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={submit}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h5">{t(signUp ? 'auth.signUpTitle' : 'auth.signInTitle')}</Typography>
          <LanguagePicker />
        </Stack>
        <TextField
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          name="password"
          label={t('auth.password')}
          type="password"
          autoComplete={signUp ? 'new-password' : 'current-password'}
          required
          helperText={signUp ? t('auth.passwordHint') : undefined}
          slotProps={{ htmlInput: { minLength: signUp ? 10 : undefined } }}
        />
        {signUp && (
          <Typography variant="body2" color="text.secondary">
            {t('auth.emailUse')}{' '}
            <Link href={policy.data ? `${config.siteUrl}${policy.data.path}` : undefined} target="_blank" rel="noopener">
              {t('auth.privacyLink')}
            </Link>
          </Typography>
        )}
        {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        <Button type="submit" variant="contained" size="large" loading={busy}>
          {t(signUp ? 'auth.signUp' : 'auth.signIn')}
        </Button>
        <Button
          onClick={() => {
            setMode(signUp ? 'signIn' : 'signUp')
            setError(null)
          }}
        >
          {t(signUp ? 'auth.toSignIn' : 'auth.toSignUp')}
        </Button>
      </Stack>
    </Centered>
  )
}
