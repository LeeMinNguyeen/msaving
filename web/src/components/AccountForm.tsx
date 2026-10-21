import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { showLanguage } from '../i18n'
import { useInstance } from '../lib/queries'
import { useErrorText } from './errors'
import { LanguagePicker } from './LanguagePicker'

// The title row of every screen before sign-in: the server's name and, but on sign-in, the language switch. These
// screens open in English; the switch changes the language for that screen.
export function PublicHeader({ title, languageSwitch = true }: { title: string; languageSwitch?: boolean }) {
  const instance = useInstance()
  useEffect(() => showLanguage('en'), [])
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'start' }}>
      <Stack>
        <Typography variant="h5">{title}</Typography>
        {instance.data && <Typography color="text.secondary">{instance.data.name}</Typography>}
      </Stack>
      {languageSwitch && <LanguagePicker />}
    </Stack>
  )
}

// Username, password (twice) and display name for a new account: setup and join.
export function NewAccountFields() {
  const { t } = useTranslation()
  return (
    <>
      <TextField name="username" label={t('auth.username')} required autoComplete="username"
        helperText={t('welcome.usernameHint')}
        slotProps={{ htmlInput: { pattern: '[A-Za-z0-9][A-Za-z0-9_.]{2,29}', autoCapitalize: 'none' } }} />
      <TextField name="display_name" label={t('welcome.displayName')} />
      <PasswordFields />
    </>
  )
}

export function PasswordFields({ label }: { label?: string }) {
  const { t } = useTranslation()
  return (
    <>
      <TextField name="password" label={label ?? t('auth.password')} type="password" required autoComplete="new-password"
        helperText={t('auth.passwordHint')} slotProps={{ htmlInput: { minLength: 10, maxLength: 256 } }} />
      <TextField name="password2" label={t('auth.passwordAgain')} type="password" required autoComplete="new-password" />
    </>
  )
}

export function FormError({ error }: { error: unknown }): ReactNode {
  const errorText = useErrorText()
  return error ? <Alert severity="error">{errorText(error)}</Alert> : null
}
