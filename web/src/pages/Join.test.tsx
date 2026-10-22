import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { session } from '../auth/session'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Join, Setup } from './Join'

vi.mock('../lib/restart', () => ({ waitForServer: () => new Promise(() => {}) }))

describe('joining', () => {
  it('opens in English, and the new account gets the language picked', async () => {
    const api = fakeApi({
      'GET /v1/instance': { name: 'Nhà', signup: 'open', setup_needed: false },
      'POST /v1/auth/sign-up': { token: 'new-token' },
    })
    session.set(null)
    await renderApp(<Join />, { lang: 'vi' })
    expect(await screen.findByRole('button', { name: 'Create account' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Tiếng Việt' }))
    await userEvent.type(await screen.findByLabelText(/^Tên người dùng/), 'lan')
    await userEvent.type(screen.getByLabelText(/^Mật khẩu/), 'a long password')
    await userEvent.type(screen.getByLabelText(/^Nhập lại mật khẩu/), 'a long password')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ username: 'lan', language: 'vi' })
  })
})

describe('setting up a new server', () => {
  it('can restore a backup instead, with the setup code (msaving#72)', async () => {
    const api = fakeApi({
      'GET /v1/instance': { name: 'MSaving', signup: 'invite', setup_needed: true },
      'POST /v1/setup/restore': new Response(null, { status: 202 }),
    })
    session.set(null)
    await renderApp(<Setup />)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup instead' }))
    await userEvent.type(screen.getByLabelText(/^Setup code/), 'cjjv-sj9h-edwz')
    await userEvent.upload(screen.getByLabelText('Backup file'), new File(['dump'], 'msaving.dump'))
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    const form = api.writes()[0].body as FormData
    expect(api.writes()[0].path).toBe('/v1/setup/restore')
    expect([form.get('setup_code'), (form.get('file') as File).name]).toEqual(['CJJV-SJ9H-EDWZ', 'msaving.dump'])
    expect(await screen.findByText(/^Restoring\. The server restarts/)).toBeInTheDocument()
  })
})
