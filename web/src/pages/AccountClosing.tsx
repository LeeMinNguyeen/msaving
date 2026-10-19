import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Centered } from '../components/Centered'
import { useErrorText } from '../components/errors'
import { currentLanguage } from '../i18n'
import { ApiError, send } from '../lib/api'
import { supabase } from '../lib/supabase'
import { AgreeToPolicy } from './UpdatedPolicy'

// Screen 12: a closed account sees only this until it's restored or purged.
export function AccountClosing({ requestedAt, needsConsent }: { requestedAt: string; needsConsent: boolean }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const qc = useQueryClient()
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [mustAgree, setMustAgree] = useState(needsConsent)
  const deletesOn = new Date(new Date(requestedAt).getTime() + 30 * 24 * 3600 * 1000)
  const date = new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'long' }).format(deletesOn)

  async function restore() {
    setBusy(true)
    setError(null)
    try {
      await send('POST', '/v1/me/restore')
      await qc.invalidateQueries()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'consent_outdated') setMustAgree(true)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Centered>
      <Stack spacing={2}>
        <Typography variant="h5">{t('closing.title')}</Typography>
        <Typography>{t('closing.body', { date })}</Typography>
        {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        {mustAgree ? (
          <>
            <Alert severity="info">{t('closing.needsConsent')}</Alert>
            <AgreeToPolicy onAgreed={() => { setMustAgree(false); void restore() }} />
          </>
        ) : (
          <Button variant="contained" size="large" loading={busy} onClick={restore}>{t('closing.restore')}</Button>
        )}
        <Button color="inherit" onClick={() => supabase.auth.signOut()}>{t('auth.signOut')}</Button>
      </Stack>
    </Centered>
  )
}
