import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Instance, Me } from '../lib/api'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { UpdatingNotice } from '../components/UpdatingNotice'
import { Admin } from './Admin'

// The server restarting never comes back here: the notice stays.
vi.mock('../lib/restart', () => ({ waitForServer: () => new Promise(() => {}) }))

const admin: Me = {
  id: 'u1',
  profile: { username: 'admin', display_name: null, timezone: 'Asia/Ho_Chi_Minh', language: 'en', created_at: '2026-10-01T00:00:00Z',
    deletion_requested_at: null, is_admin: true, idle_sign_out_minutes: null },
}
const instance: Instance = { name: 'Nhà', server_version: '0.1.3', api_version: 1, signup: 'invite', setup_needed: false }

const jobs = [
  { name: 'purge', at_minute: null, timezone: null, default_minute: 1140, enabled: true, next_run_at: '2026-10-21T19:00:00Z',
    last_started_at: '2026-10-20T19:00:01Z', last_finished_at: '2026-10-20T19:00:02Z', last_result: 'done', last_detail: 'purged 0 accounts' },
  { name: 'backup', at_minute: 150, timezone: 'Asia/Ho_Chi_Minh', default_minute: 1140, enabled: true, next_run_at: '2026-10-21T19:30:00Z',
    last_started_at: '2026-10-20T19:30:00Z', last_finished_at: '2026-10-20T19:30:09Z', last_result: 'failed', last_detail: 'backup failed: disk full' },
  { name: 'rates', at_minute: null, timezone: null, default_minute: 1140, enabled: false, next_run_at: '2026-10-21T19:00:00Z',
    last_started_at: null, last_finished_at: null, last_result: null, last_detail: null },
]

function server() {
  return fakeApi({
    'GET /v1/me': admin,
    'GET /v1/instance': instance,
    'PATCH /v1/admin/instance': undefined,
    'GET /v1/admin/update': { current_version: '0.1.3', latest_version: '0.1.3', release_url: null, changelog_url: null,
      update_available: false, updater: false, status: null },
    'GET /v1/admin/invites': [],
    'GET /v1/admin/users': [],
    'GET /v1/admin/jobs': jobs,
    'PATCH /v1/admin/jobs/backup': undefined,
    'PATCH /v1/admin/jobs/rates': undefined,
    'GET /v1/admin/restore': null,
    'GET /v1/auth/two-factor': { enabled: false, recovery_codes_left: 0 },
  })
}
const pick = async (name: string | RegExp, option: string) => {
  await userEvent.click(await screen.findByRole('combobox', { name }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}
describe('the daily jobs on Server admin (waterflow#6)', () => {
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

describe('updates on Server admin', () => {
  const update = (over: object) => ({
    current_version: '0.1.5', latest_version: '0.2.0', release_url: 'https://github.com/x/releases/tag/v0.2.0',
    changelog_url: 'https://waterflow.example/docs/changelog/', update_available: true, updater: true, status: null, ...over,
  })

  it("opens the changelog from What's new", async () => {
    const api = server()
    api.routes['GET /v1/admin/update'] = update({})
    await renderApp(<Admin />)
    expect(await screen.findByRole('link', { name: "What's new" })).toHaveAttribute('href', 'https://waterflow.example/docs/changelog/')
  })

  it('shows no commands to run while the server is up to date', async () => {
    server()
    await renderApp(<Admin />)
    expect(await screen.findByText('Server version 0.1.3 · newest 0.1.3')).toBeInTheDocument()
    expect(screen.queryByText(/docker compose up -d --build/)).not.toBeInTheDocument()
  })

  it('shows the commands when a new version is out and there is no helper', async () => {
    const api = server()
    api.routes['GET /v1/admin/update'] = update({ updater: false })
    await renderApp(<Admin />)
    expect(await screen.findByText(/docker compose up -d --build/)).toBeInTheDocument()
  })

  it('starts the update and shows the notice, though the server answers with no body', async () => {
    const api = server()
    api.routes['GET /v1/admin/update'] = update({})
    api.routes['POST /v1/admin/update'] = () => new Response(null, { status: 202 })
    await renderApp(<><UpdatingNotice /><Admin /></>)
    await userEvent.click(await screen.findByRole('button', { name: 'Update now' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Update now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([expect.stringMatching(/^Updating to 0\.2\.0/)])
    expect(api.writes().map((c) => c.path)).toEqual(['/v1/admin/update'])
  })
})

describe('restoring a backup (waterflow#72)', () => {
  const section = async () => {
    const title = await screen.findByText('Restore a backup')
    return within(title.closest('.MuiPaper-root') as HTMLElement)
  }

  it('asks for the file, the password and the confirmation, then waits for the server', async () => {
    const api = server()
    api.routes['POST /v1/admin/restore'] = new Response(null, { status: 202 })
    await renderApp(<Admin />)
    const restore = await section()
    const button = restore.getByRole('button', { name: 'Restore' })
    expect(button).toBeDisabled()
    await userEvent.upload(restore.getByLabelText('Backup file'), new File(['dump'], 'waterflow-20261021T190000Z.dump'))
    expect(restore.getByText('waterflow-20261021T190000Z.dump')).toBeInTheDocument()
    await userEvent.type(restore.getByLabelText(/^Your password/), 'a long password')
    expect(button).toBeDisabled()
    await userEvent.click(restore.getByRole('checkbox', { name: /everything on this server will be replaced/ }))
    await userEvent.click(button)
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    const sent = api.writes()[0]
    expect(sent.path).toBe('/v1/admin/restore')
    const form = sent.body as FormData
    expect((form.get('file') as File).name).toBe('waterflow-20261021T190000Z.dump')
    expect([form.get('password'), form.get('confirm'), form.get('code')]).toEqual(['a long password', 'true', null])
    expect(await screen.findByText(/^Restoring\. The server restarts/)).toBeInTheDocument()
  })

  it('asks for the two-step code when it is on', async () => {
    const api = server()
    api.routes['GET /v1/auth/two-factor'] = { enabled: true, recovery_codes_left: 10 }
    await renderApp(<Admin />)
    const restore = await section()
    expect(await restore.findByLabelText(/^Two-step code/)).toBeInTheDocument()
  })

  it('shows how the last restore went', async () => {
    const api = server()
    api.routes['GET /v1/admin/restore'] = { status: 'failed', at: '2026-10-22T01:00:00Z', detail: 'pg_restore failed: disk full' }
    await renderApp(<Admin />)
    const restore = await section()
    expect(await restore.findByText(/^Last restore: failed/)).toBeInTheDocument()
    expect(restore.getByText(/pg_restore failed: disk full/)).toBeInTheDocument()
  })
})
