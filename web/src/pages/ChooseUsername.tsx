import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Centered } from '../components/Centered'
import { useErrorText } from '../components/errors'
import { LanguagePicker } from '../components/LanguagePicker'
import { config } from '../config'
import { currentLanguage } from '../i18n'
import { deviceTimezone } from '../lib/labels'
import { send, type Me } from '../lib/api'
import { keys, usePolicy } from '../lib/queries'
import { supabase } from '../lib/supabase'

// Screen 2. Creates the account: the users row and the privacy policy consent,
// together. The consent box is its own tick, not bundled with anything else,
// and records the version this screen links to.
export function ChooseUsername() {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const policy = usePolicy()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!policy.data || !agreed) return
    setBusy(true)
    setError(null)
    try {
      const me = await send<Me>('POST', '/v1/me', {
        username: username.trim().toLowerCase(),
        display_name: displayName.trim() || null,
        language: currentLanguage(),
        timezone: deviceTimezone(),
        policy_version: policy.data.version,
      })
      qc.setQueryData(keys.me, me)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <Stack component="form" spacing={2} onSubmit={submit}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h5">{t('welcome.title')}</Typography>
          <LanguagePicker />
        </Stack>
        <Typography color="text.secondary">{t('welcome.intro')}</Typography>
        <TextField
          label={t('welcome.username')}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          helperText={t('welcome.usernameHint')}
          slotProps={{ htmlInput: { pattern: '[a-z0-9][a-z0-9_.]{2,29}', autoCapitalize: 'none', autoComplete: 'username' } }}
        />
        <TextField label={t('welcome.displayName')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <FormControlLabel
          control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />}
          label={
            <Trans
              i18nKey="welcome.consent"
              components={{
                policy: (
                  <Link
                    href={policy.data ? `${config.siteUrl}${policy.data.path}` : undefined}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                  />
                ),
              }}
            />
          }
        />
        {policy.isError || error ? <Alert severity="error">{errorText(error ?? policy.error)}</Alert> : null}
        <Button type="submit" variant="contained" size="large" loading={busy} disabled={!agreed || !policy.data}>
          {t('welcome.submit')}
        </Button>
        <Button color="inherit" onClick={() => supabase.auth.signOut()}>
          {t('auth.signOut')}
        </Button>
      </Stack>
    </Centered>
  )
}
