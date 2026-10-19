import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import { useErrorText } from './errors'

// The second step of signing in for a user with two-step verification: a code
// from their authenticator app turns the session into aal2.
export function MfaChallenge({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [code, setCode] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const factors = await supabase.auth.mfa.listFactors()
    const factor = factors.data?.totp[0]
    if (!factor) {
      setBusy(false)
      setError(factors.error ?? { code: 'unexpected_error' })
      return
    }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() })
    setBusy(false)
    if (error) setError(error)
    else onDone()
  }

  return (
    <Stack component="form" spacing={2} onSubmit={submit}>
      <Typography variant="h5">{t('mfa.title')}</Typography>
      <Typography color="text.secondary">{t('mfa.prompt')}</Typography>
      <TextField label={t('mfa.codeLabel')} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        slotProps={{ htmlInput: { inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9]{6}' } }} />
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Button type="submit" variant="contained" size="large" loading={busy} disabled={code.length !== 6}>{t('mfa.verify')}</Button>
      <Button color="inherit" onClick={() => supabase.auth.signOut()}>{t('auth.signOut')}</Button>
    </Stack>
  )
}
