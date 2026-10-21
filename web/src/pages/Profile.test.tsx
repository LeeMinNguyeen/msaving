import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { DeviceSession, Me } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Profile } from './Profile'

const me: Me = {
  id: 'u1',
  profile: { username: 'lan', display_name: null, timezone: 'Asia/Ho_Chi_Minh', language: 'en', created_at: '2026-10-01T00:00:00Z',
    deletion_requested_at: null, is_admin: false },
}
const laptop: DeviceSession = { id: 's1', device: 'Chrome · Windows', created_at: '2026-10-20T01:00:00Z', last_used_at: '2026-10-21T02:00:00Z', current: true }
const phone: DeviceSession = { id: 's2', device: 'Safari · iOS', created_at: '2026-10-18T01:00:00Z', last_used_at: '2026-10-20T09:30:00Z', current: false }
const script: DeviceSession = { id: 's3', device: null, created_at: '2026-10-19T01:00:00Z', last_used_at: '2026-10-19T01:00:00Z', current: false }

function server(sessions: DeviceSession[]) {
  let listed = sessions
  return fakeApi({
    'GET /v1/me': me,
    'GET /v1/auth/two-factor': { enabled: false, recovery_codes_left: 0 },
    'GET /v1/auth/sessions': () => listed,
    'DELETE /v1/auth/sessions/s2': () => { listed = listed.filter((s) => s.id !== 's2') },
    'POST /v1/auth/sign-out-others': () => { listed = listed.filter((s) => s.current) },
  })
}
const devices = async () => within((await screen.findByText('Chrome · Windows')).closest('ul')!)

describe('signed-in devices (msaving#5)', () => {
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
