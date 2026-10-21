import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { session } from '../auth/session'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { Join } from './Join'

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
