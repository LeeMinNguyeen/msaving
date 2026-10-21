import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { session } from '../auth/session'
import { idleNotice } from '../lib/idle'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { SignIn } from './SignIn'

describe('the sign-in page', () => {
  afterEach(() => idleNotice.set(null))

  it('says when the user was signed out for inactivity (msaving#26)', async () => {
    fakeApi({ 'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false } })
    session.set(null)
    idleNotice.set(5)
    await renderApp(<SignIn />)
    expect(screen.getByRole('alert')).toHaveTextContent('You were signed out after 5 minutes without activity.')
    act(() => idleNotice.set(null)) // signed in again
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says nothing of the kind otherwise', async () => {
    fakeApi({ 'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false } })
    session.set(null)
    await renderApp(<SignIn />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('remembering this device for two-step verification', () => {
  const instance = { name: 'Nhà', signup: 'invite', setup_needed: false, language: 'en' }
  afterEach(() => localStorage.removeItem('msaving.device.lan'))

  function server(known: string[]) {
    return fakeApi({
      'GET /v1/instance': instance,
      'POST /v1/auth/sign-in': ({ body }: { body: unknown }) => {
        const b = body as { code: string | null; remember_device: boolean; device_token: string | null }
        if (b.device_token && known.includes(b.device_token)) return { token: 't2', device_token: null }
        if (!b.code) return new Response(JSON.stringify({ detail: 'code_required' }), { status: 401 })
        return { token: 't1', device_token: b.remember_device ? 'device-1' : null }
      },
    })
  }
  async function signIn() {
    await userEvent.type(await screen.findByLabelText(/^Username/), 'lan')
    await userEvent.type(screen.getByLabelText(/^Password/), 'a long password')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  it('asks for the code with the choice, and keeps what the server gives', async () => {
    const api = server([])
    session.set(null)
    await renderApp(<SignIn />)
    await signIn()
    await userEvent.type(await screen.findByLabelText(/^6-digit code/), '123456')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Remember this device for 30 days' }))
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(localStorage.getItem('msaving.device.lan')).toBe('device-1'))
    expect(api.writes()[1].body).toMatchObject({ code: '123456', remember_device: true, device_token: null })
  })

  it('sends the remembered device next time, and forgets one the server no longer knows', async () => {
    localStorage.setItem('msaving.device.lan', 'device-1')
    let api = server(['device-1'])
    session.set(null)
    const { unmount } = await renderApp(<SignIn />)
    await signIn()
    await waitFor(() => expect(session.token()).toBe('t2'))
    expect(api.writes()[0].body).toMatchObject({ device_token: 'device-1', code: null })
    unmount()

    api = server([])
    session.set(null)
    await renderApp(<SignIn />)
    await signIn()
    expect(await screen.findByLabelText(/^6-digit code/)).toBeInTheDocument()
    expect(localStorage.getItem('msaving.device.lan')).toBeNull()
    expect(api.writes()).toHaveLength(1)
  })
})
