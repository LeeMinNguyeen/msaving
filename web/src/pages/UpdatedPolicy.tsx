import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Centered } from '../components/Centered'
import { useErrorText } from '../components/errors'
import { config } from '../config'
import { api, send, type ConsentStatus } from '../lib/api'
import { keys } from '../lib/queries'

// Agree to the policy in force: own checkbox, records the version shown.
export function AgreeToPolicy({ onAgreed, children }: { onAgreed: () => void; children?: ReactNode }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const status = useQuery({ queryKey: ['consent'], queryFn: () => api<ConsentStatus>('/v1/me/consent') })
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const href = status.data?.current_path ? `${config.siteUrl}${status.data.current_path}` : undefined

  async function agree() {
    if (!status.data?.current_version) return
    setBusy(true)
    setError(null)
    try {
      await send('POST', '/v1/me/consent', { policy_version: status.data.current_version })
      onAgreed()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack spacing={2}>
      <FormControlLabel
        control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />}
        label={<Trans i18nKey="policy.agree" components={{ policy: <Link href={href} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()} /> }} />}
      />
      {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
      <Button variant="contained" size="large" loading={busy} disabled={!agreed || !status.data?.current_version} onClick={agree}>
        {t('policy.continue')}
      </Button>
      {children}
    </Stack>
  )
}

// Screen 11: shown alone until the user agrees to the new version or withdraws.
export function UpdatedPolicy() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const errorText = useErrorText()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function withdraw() {
    try {
      await send('POST', '/v1/me/consent/withdraw')
      await qc.invalidateQueries({ queryKey: keys.me })
    } catch (err) {
      setError(err)
    }
    setConfirm(false)
  }

  return (
    <Centered>
      <Stack spacing={2}>
        <Typography variant="h5">{t('policy.updatedTitle')}</Typography>
        <Typography color="text.secondary">{t('policy.updatedBody')}</Typography>
        {error ? <Alert severity="error">{errorText(error)}</Alert> : null}
        <AgreeToPolicy onAgreed={() => qc.invalidateQueries({ queryKey: keys.me })}>
          <Button color="error" onClick={() => setConfirm(true)}>{t('profile.withdraw')}</Button>
        </AgreeToPolicy>
      </Stack>
      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogContent><DialogContentText>{t('profile.withdrawConfirm')}</DialogContentText></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={withdraw}>{t('profile.withdraw')}</Button>
        </DialogActions>
      </Dialog>
    </Centered>
  )
}
