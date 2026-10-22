import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { session } from '../auth/session'
import { fakeApi, type Call } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Join, Reset, Setup } from './Join'

vi.mock('../lib/restart', () => ({ waitForServer: () => new Promise(() => {}) }))

async function pick(name: string, option: string) {
  await userEvent.click(await screen.findByRole('combobox', { name }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

afterEach(() => localStorage.removeItem('msaving.language'))

describe('joining, in two steps', () => {
  function server(signup: 'open' | 'invite', valid: string[] = []) {
    const api = fakeApi({
      'GET /v1/instance': { name: 'Nhà', signup, setup_needed: false },
      'POST /v1/auth/invite-check': ({ body }: Call) => ({ valid: valid.includes((body as { code: string }).code) }),
      'POST /v1/auth/sign-up': { token: 'new-token' },
    })
    session.set(null)
    return api
  }

  it('takes the code from the invite link and the language first, then the account in that language', async () => {
    const api = server('invite', ['X7K2-9QPM'])
    await renderApp(<Join />, { route: '/join?code=X7K2-9QPM' })
    expect(await screen.findByLabelText(/^Invite code/)).toHaveValue('X7K2-9QPM')
    expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument()
    await pick('Language', 'Tiếng Việt')
    expect(localStorage.getItem('msaving.language')).toBe('vi')
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }))

    await userEvent.type(await screen.findByLabelText(/^Tên người dùng/), 'lan')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^Mật khẩu/), 'a long password')
    await userEvent.type(screen.getByLabelText(/^Nhập lại mật khẩu/), 'a long password')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    await waitFor(() => expect(api.writes()).toHaveLength(2))
    expect(api.writes()[0]).toMatchObject({ path: '/v1/auth/invite-check', body: { code: 'X7K2-9QPM' } })
    expect(api.writes()[1]).toMatchObject({ path: '/v1/auth/sign-up', body: { username: 'lan', language: 'vi', invite_code: 'X7K2-9QPM' } })
  })

  it('opens in the language this browser remembers', async () => {
    server('invite')
    await renderApp(<Join />, { lang: 'vi' })
    expect(await screen.findByRole('combobox', { name: 'Ngôn ngữ' })).toHaveTextContent('Tiếng Việt')
  })

  it('stays on the first step when the code is wrong', async () => {
    server('invite')
    await renderApp(<Join />)
    await userEvent.type(await screen.findByLabelText(/^Invite code/), 'AAAA-BBBB')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText(/^This invite code is wrong, used, revoked or expired/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument()
  })

  it('goes straight on without a code when sign-up is open', async () => {
    const api = server('open')
    await renderApp(<Join />)
    await screen.findByText(/An invite code is optional/)
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByLabelText(/^Username/)).toBeInTheDocument()
    expect(api.writes()).toEqual([])
  })

  it('goes back to the first step with the code kept', async () => {
    server('invite', ['X7K2-9QPM'])
    await renderApp(<Join />, { route: '/join?code=X7K2-9QPM' })
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(await screen.findByLabelText(/^Invite code/)).toHaveValue('X7K2-9QPM')
  })
})

describe('setting up a new server', () => {
  it("has the language dropdown, which changes the screen and is the admin's language", async () => {
    const api = fakeApi({
      'GET /v1/instance': { name: 'MSaving', signup: 'invite', setup_needed: true },
      'POST /v1/setup': { token: 'admin-token' },
    })
    session.set(null)
    await renderApp(<Setup />)
    await pick('Language', 'Tiếng Việt')
    await userEvent.type(screen.getByLabelText(/^Mã thiết lập/), 'CJJV-SJ9H-EDWZ')
    await userEvent.type(screen.getByLabelText(/^Tên người dùng/), 'lan')
    await userEvent.type(screen.getByLabelText(/^Mật khẩu/), 'a long password')
    await userEvent.type(screen.getByLabelText(/^Nhập lại mật khẩu/), 'a long password')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản quản trị' }))
    await waitFor(() => expect(api.writes()).toHaveLength(1))
    expect(api.writes()[0].body).toMatchObject({ username: 'lan', language: 'vi' })
  })

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

describe('a reset link', () => {
  it('opens in the language this browser remembers, with the dropdown to change it', async () => {
    fakeApi({ 'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false } })
    session.set(null)
    await renderApp(<Reset />, { route: '/reset?token=t', lang: 'vi' })
    expect(await screen.findByRole('combobox', { name: 'Ngôn ngữ' })).toHaveTextContent('Tiếng Việt')
    await pick('Ngôn ngữ', 'English')
    expect(await screen.findByRole('combobox', { name: 'Language' })).toHaveTextContent('English')
    expect(localStorage.getItem('msaving.language')).toBe('en')
  })
})
