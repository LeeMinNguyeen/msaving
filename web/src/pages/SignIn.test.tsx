import { act, screen } from '@testing-library/react'
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

  it('is in English, with no language switch', async () => {
    fakeApi({ 'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false } })
    session.set(null)
    await renderApp(<SignIn />, { lang: 'vi' })
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tiếng Việt' })).not.toBeInTheDocument()
  })

  it('says nothing of the kind otherwise', async () => {
    fakeApi({ 'GET /v1/instance': { name: 'Nhà', signup: 'invite', setup_needed: false } })
    session.set(null)
    await renderApp(<SignIn />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
