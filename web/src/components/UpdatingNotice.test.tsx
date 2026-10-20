import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { updating } from '../lib/updating'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { UpdatingNotice } from './UpdatingNotice'

// The updater helper's status line, as docker-compose.yml writes it (date -u +%FT%TZ).
const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const info = (status: string | null) => ({
  current_version: '0.1.1', latest_version: '0.1.2', release_url: null, update_available: true, updater: true, status,
})

describe('the notice while the server updates itself', () => {
  it('shows nothing until an update is started from this tab', async () => {
    const api = fakeApi({ 'GET /v1/admin/update': info(null) })
    await renderApp(<UpdatingNotice />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.calls).toHaveLength(0)                                         // and doesn't ask the server
  })

  it('says to reload in a few minutes while the update runs, not an error', async () => {
    fakeApi({ 'GET /v1/admin/update': () => info(`running ${at(Date.now())}`) })
    await renderApp(<UpdatingNotice />)
    act(() => updating.start('0.1.2'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Updating to 0\.1\.2.*Reload it in about 5 minutes/)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('says when the new version is up, and ignores an earlier update', async () => {
    let status = `done ${at(Date.now() - 3_600_000)}`                        // an update an hour ago
    fakeApi({ 'GET /v1/admin/update': () => info(status) })
    const { client } = await renderApp(<UpdatingNotice />)
    act(() => updating.start('0.1.2'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Updating to 0\.1\.2/)
    status = `done ${at(Date.now() + 1000)}`
    await act(() => client.refetchQueries({ queryKey: ['admin', 'update'] }))
    expect(await screen.findByText(/Updated to 0\.1\.2\. Reload the page/)).toBeInTheDocument()
  })

  it('says why when the update failed', async () => {
    fakeApi({ 'GET /v1/admin/update': () => info(`failed ${at(Date.now() + 1000)}: no network`) })
    await renderApp(<UpdatingNotice />)
    act(() => updating.start('0.1.2'))
    expect(await screen.findByText(/The last update failed: failed .*: no network/)).toBeInTheDocument()
  })
})
