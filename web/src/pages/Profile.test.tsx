import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useTheme } from '@mui/material/styles'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceSession, Me } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { desktop, renderApp } from '../test/render'
import { Profile } from './Profile'

const me: Me = {
  id: 'u1',
  profile: { username: 'lan', display_name: null, timezone: 'Asia/Ho_Chi_Minh', language: 'en', created_at: '2026-10-01T00:00:00Z',
    deletion_requested_at: null, is_admin: false, idle_sign_out_minutes: 5 },
}
const laptop: DeviceSession = { id: 's1', device: 'Chrome · Windows', created_at: '2026-10-20T01:00:00Z', last_used_at: '2026-10-21T02:00:00Z', current: true }
const phone: DeviceSession = { id: 's2', device: 'Safari · iOS', created_at: '2026-10-18T01:00:00Z', last_used_at: '2026-10-20T09:30:00Z', current: false }
const script: DeviceSession = { id: 's3', device: null, created_at: '2026-10-19T01:00:00Z', last_used_at: '2026-10-19T01:00:00Z', current: false }

function server(sessions: DeviceSession[], idle: number | null = 5) {
  let listed = sessions
  let profile = { ...me.profile, idle_sign_out_minutes: idle }
  return fakeApi({
    'GET /v1/me': () => ({ ...me, profile }),
    'PATCH /v1/me': (c: { body: unknown }) => {
      profile = { ...profile, ...(c.body as object) }
      return { ...me, profile }
    },
    'GET /v1/auth/two-factor': { enabled: false, recovery_codes_left: 0 },
    'GET /v1/auth/sessions': () => listed,
    'DELETE /v1/auth/sessions/s2': () => { listed = listed.filter((s) => s.id !== 's2') },
    'POST /v1/auth/sign-out-others': () => { listed = listed.filter((s) => s.current) },
  })
}
const devices = async () => within((await screen.findByText('Chrome · Windows')).closest('ul')!)

describe('signed-in devices (waterflow#5)', () => {
  it('lists where the account is signed in, this device first and marked', async () => {
    server([laptop, phone, script])
    await renderApp(<Profile />)
    const list = await devices()
    expect(list.getAllByRole('listitem').map((li) => li.textContent?.split('Signed in')[0])).toEqual(
      ['Chrome · WindowsThis device', 'Safari · iOS', 'Unknown device'])
    expect(list.getByText('Safari · iOS').closest('li')).toHaveTextContent(/Signed in 18 Oct 2026, \d\d:\d\d · last used 20 Oct 2026/)
    expect(list.getAllByRole('button', { name: 'Sign out' })).toHaveLength(2)          // not on this device
  })

  it('signs out one other device', async () => {
    const api = server([laptop, phone])
    await renderApp(<Profile />)
    const list = await devices()
    await userEvent.click(within(list.getByText('Safari · iOS').closest('li')!).getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Safari · iOS is signed out.')).toBeInTheDocument()
    expect(api.writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/v1/auth/sessions/s2' })])
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out other devices' })).not.toBeInTheDocument())
  })

  it('signs out every other device at once, and offers nothing to sign out when there are none', async () => {
    const api = server([laptop, phone, script])
    await renderApp(<Profile />)
    await devices()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out other devices' }))
    expect(await screen.findByText('Other devices are signed out.')).toBeInTheDocument()
    expect(api.writes().map((c) => c.path)).toEqual(['/v1/auth/sign-out-others'])
    await waitFor(() => expect(screen.queryByText('Safari · iOS')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^Sign out/ })).not.toBeInTheDocument()
  })
})

describe('signing out the other devices', () => {
  it("keeps this device's remembered two-step verification", async () => {
    localStorage.setItem('waterflow.device.lan', 'device-1')
    const api = server([laptop, phone])
    await renderApp(<Profile />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out other devices' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0]).toMatchObject({ path: '/v1/auth/sign-out-others', body: { device_token: 'device-1' } })
    localStorage.removeItem('waterflow.device.lan')
  })
})

describe('the language', () => {
  afterEach(() => localStorage.removeItem('waterflow.language'))

  it('is a dropdown of each language in its own name, saved with the profile', async () => {
    const api = server([laptop])
    await renderApp(<Profile />)
    await userEvent.click(await screen.findByRole('combobox', { name: 'Language' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['English', 'Tiếng Việt'])
    await userEvent.click(screen.getByRole('option', { name: 'Tiếng Việt' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.writes()[0]).toMatchObject({ method: 'PATCH', path: '/v1/me', body: { language: 'vi' } }))
    expect(await screen.findByRole('combobox', { name: 'Ngôn ngữ' })).toHaveTextContent('Tiếng Việt')
    expect(localStorage.getItem('waterflow.language')).toBe('vi')
  })
})

describe('signing out after inactivity, the user\'s own choice (waterflow#26)', () => {
  const setting = () => screen.findByRole('combobox', { name: 'Sign me out after inactivity' })
  const pick = async (option: string) => {
    await userEvent.click(await setting())
    await userEvent.click(await screen.findByRole('option', { name: option }))
  }

  it('is 5 minutes by default, and saved for every device as soon as it\'s picked', async () => {
    const api = server([laptop])
    await renderApp(<Profile />)
    expect(await setting()).toHaveTextContent('After 5 minutes')
    await pick('After 15 minutes')
    await waitFor(() => expect(api.writes()).toEqual([expect.objectContaining({ method: 'PATCH', path: '/v1/me',
      body: { idle_sign_out_minutes: 15 } })]))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    await waitFor(async () => expect(await setting()).toHaveTextContent('After 15 minutes'))
  })

  it('can be never', async () => {
    const api = server([laptop], 30)
    await renderApp(<Profile />)
    expect(await setting()).toHaveTextContent('After 30 minutes')
    await pick('Never (only after 30 days unused)')
    await waitFor(() => expect(api.writes()[0]?.body).toEqual({ idle_sign_out_minutes: null }))
  })
})

describe('light or dark', () => {
  function Mode() {
    return <span data-testid="mode">{useTheme().palette.mode}</span>
  }
  afterEach(() => {
    localStorage.removeItem('waterflow.theme')
    desktop(true)
  })

  it("follows the device until the user picks one, kept in this browser", async () => {
    server([laptop])
    desktop(true, { dark: true })
    await renderApp(<><Mode /><Profile /></>)
    expect(await screen.findByRole('combobox', { name: 'Light or dark' })).toHaveTextContent('Same as the device')
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    await userEvent.click(screen.getByRole('combobox', { name: 'Light or dark' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Light' }))
    expect(screen.getByTestId('mode')).toHaveTextContent('light')
    expect(localStorage.getItem('waterflow.theme')).toBe('light')
  })
})
