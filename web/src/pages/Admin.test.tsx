import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Instance, Me } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Admin } from './Admin'

const admin: Me = {
  id: 'u1',
  profile: { username: 'admin', display_name: null, timezone: 'Asia/Ho_Chi_Minh', language: 'en', created_at: '2026-10-01T00:00:00Z',
    deletion_requested_at: null, is_admin: true },
}
const instance: Instance = { name: 'Nhà', server_version: '0.1.3', api_version: 1, signup: 'invite', setup_needed: false,
  idle_sign_out_minutes: null }

function server(idle: number | null = null) {
  return fakeApi({
    'GET /v1/me': admin,
    'GET /v1/instance': { ...instance, idle_sign_out_minutes: idle },
    'PATCH /v1/admin/instance': undefined,
    'GET /v1/admin/update': { current_version: '0.1.3', latest_version: '0.1.3', release_url: null, update_available: false, updater: false, status: null },
    'GET /v1/admin/invites': [],
    'GET /v1/admin/users': [],
    'GET /v1/admin/jobs': [],
  })
}
const pick = async (name: string | RegExp, option: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}
const saved = async (api: ReturnType<typeof server>) => {
  await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])
  await waitFor(() => expect(api.writes()).toHaveLength(1))
  return api.writes()[0].body as Record<string, unknown>
}

describe('signing out after inactivity on Server admin (msaving#26)', () => {
  it('is off by default, and sets minutes for everyone', async () => {
    const api = server()
    await renderApp(<Admin />)
    expect(await screen.findByRole('combobox', { name: 'Sign out after inactivity' })).toHaveTextContent('Off')
    await pick('Sign out after inactivity', '15 minutes')
    expect(await saved(api)).toMatchObject({ idle_sign_out_minutes: 15 })
  })

  it('turns it off', async () => {
    const api = server(30)
    await renderApp(<Admin />)
    expect(await screen.findByRole('combobox', { name: 'Sign out after inactivity' })).toHaveTextContent('30 minutes')
    await pick('Sign out after inactivity', 'Off')
    expect(await saved(api)).toMatchObject({ idle_sign_out_minutes: null })
  })

  it('leaves it as it is when only the name changes, and shows a value set some other way', async () => {
    const api = server(45)
    await renderApp(<Admin />)
    expect(await screen.findByRole('combobox', { name: 'Sign out after inactivity' })).toHaveTextContent('45 minutes')
    await userEvent.type(screen.getByRole('textbox', { name: /server name/i }), ' 2')
    expect(await saved(api)).not.toHaveProperty('idle_sign_out_minutes')
  })
})
