import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { currentLanguage } from '../i18n'
import { ApiError, type Token } from '../lib/api'
import { session } from './session'

// The browser's own timezone, as a new account's default.
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

// Reads a new-account form; throws 'password_mismatch' when the two passwords differ.
export function newAccountBody(form: HTMLFormElement) {
  const f = new FormData(form)
  if (f.get('password') !== f.get('password2')) throw new ApiError(422, 'password_mismatch')
  return {
    username: String(f.get('username') ?? '').trim().toLowerCase(),
    display_name: String(f.get('display_name') ?? '').trim() || null,
    password: String(f.get('password')),
    language: currentLanguage(),
    timezone: browserTimezone(),
  }
}

// Submits a form that ends signed in: stores the session and opens the app.
export function useSignedInForm() {
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>, call: (form: HTMLFormElement) => Promise<Token>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { token } = await call(e.currentTarget)
      session.set(token)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return { submit, error, setError, busy }
}
