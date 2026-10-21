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

const jobs = [
  { name: 'purge', at_minute: null, timezone: null, default_minute: 1140, enabled: true, next_run_at: '2026-10-21T19:00:00Z',
    last_started_at: '2026-10-20T19:00:01Z', last_finished_at: '2026-10-20T19:00:02Z', last_result: 'done', last_detail: 'purged 0 accounts' },
  { name: 'backup', at_minute: 150, timezone: 'Asia/Ho_Chi_Minh', default_minute: 1140, enabled: true, next_run_at: '2026-10-21T19:30:00Z',
    last_started_at: '2026-10-20T19:30:00Z', last_finished_at: '2026-10-20T19:30:09Z', last_result: 'failed', last_detail: 'backup failed: disk full' },
  { name: 'rates', at_minute: null, timezone: null, default_minute: 1140, enabled: false, next_run_at: '2026-10-21T19:00:00Z',
    last_started_at: null, last_finished_at: null, last_result: null, last_detail: null },
]

function server(idle: number | null = null) {
  return fakeApi({
    'GET /v1/me': admin,
    'GET /v1/instance': { ...instance, idle_sign_out_minutes: idle },
    'PATCH /v1/admin/instance': undefined,
    'GET /v1/admin/update': { current_version: '0.1.3', latest_version: '0.1.3', release_url: null, update_available: false, updater: false, status: null },
    'GET /v1/admin/invites': [],
    'GET /v1/admin/users': [],
    'GET /v1/admin/jobs': jobs,
    'PATCH /v1/admin/jobs/backup': undefined,
    'PATCH /v1/admin/jobs/rates': undefined,
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

describe('the daily jobs on Server admin (msaving#6)', () => {
  const row = async (name: string) => (await screen.findByText(name)).closest('tr')!

  it("shows each job's time in the admin's timezone and how it last ran", async () => {
    server()
    await renderApp(<Admin />)
    expect(await screen.findByText(/in your timezone \(Asia\/Ho_Chi_Minh\)/)).toBeInTheDocument()
    const purge = await row('Delete closed accounts and old sign-ins')
    expect(purge).toHaveTextContent('02:00')                       // JOBS_HOUR 19 UTC
    expect(purge).toHaveTextContent('Done 21 Oct 2026, 02:00')
    expect(purge).toHaveTextContent('purged 0 accounts')
    const backup = await row('Back up the database')
    expect(backup).toHaveTextContent('02:30')
    expect(backup).toHaveTextContent('Failed 21 Oct 2026, 02:30')
    expect(backup).toHaveTextContent('backup failed: disk full')
    const rates = await row('Update exchange rates')
    expect(rates).toHaveTextContent('Off: rates stay as they are')
    expect(rates).toHaveTextContent('Not run yet')
    expect(screen.getAllByRole('switch')).toHaveLength(1)          // only the rates can be turned off
  })

  it('saves a new time, in the admin\'s timezone, and the rates back on', async () => {
    const api = server()
    await renderApp(<Admin />)
    await pick('Time of Back up the database', '03:00')
    await userEvent.click(screen.getByRole('switch', { name: 'Update exchange rates every day' }))
    const save = screen.getAllByRole('button', { name: 'Save' })[1]
    await userEvent.click(save)
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes().map((c) => [c.path, c.body])).toEqual([
      ['/v1/admin/jobs/backup', { at_minute: 180, timezone: 'Asia/Ho_Chi_Minh' }],
      ['/v1/admin/jobs/rates', { enabled: true }],
    ])
  })
})
