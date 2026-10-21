import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { session } from '../auth/session'
import { idleNotice } from '../lib/idle'
import { fakeApi } from '../test/fakeApi'
import { renderApp } from '../test/render'
import { IdleSignOut } from './IdleSignOut'

// Time passing with nobody there: the interval ticks, and any sign-out request settles.
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const signedOut = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.path === '/v1/auth/sign-out').length

describe('signing out an idle tab (msaving#26)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing while the admin has it off', async () => {
    const api = fakeApi({ 'POST /v1/auth/sign-out': undefined })
    await renderApp(<IdleSignOut minutes={null} />)
    await wait(3 * 3_600_000)
    expect(signedOut(api)).toBe(0)
    expect(session.token()).toBe('test-token')
  })

  it('warns a minute before, then signs out and says why on the sign-in page', async () => {
    const api = fakeApi({ 'POST /v1/auth/sign-out': undefined })
    await renderApp(<IdleSignOut minutes={5} />)
    await wait(3 * 60_000 + 59_000)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await wait(1_000)
    expect(screen.getByRole('dialog')).toHaveTextContent("You'll be signed out in 60 seconds")
    await wait(30_000)
    expect(screen.getByRole('dialog')).toHaveTextContent('in 30 seconds')
    await wait(30_000)
    expect(signedOut(api)).toBe(1)
    expect(session.token()).toBeNull()
    expect(idleNotice.minutes()).toBe(5)
  })

  it('starts again from any click, key, touch or scroll', async () => {
    const api = fakeApi({ 'POST /v1/auth/sign-out': undefined })
    await renderApp(<IdleSignOut minutes={5} />)
    await wait(4 * 60_000 + 10_000)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'a' })
    await wait(1_000)
    await wait(1_000) // the warning's closing transition
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await wait(4 * 60_000)
    fireEvent.scroll(window)
    await wait(4 * 60_000)
    expect(signedOut(api)).toBe(0)
    await wait(60_000)
    expect(signedOut(api)).toBe(1)
  })

  it('keeps the user signed in from the warning', async () => {
    const api = fakeApi({ 'POST /v1/auth/sign-out': undefined })
    await renderApp(<IdleSignOut minutes={5} />)
    await wait(4 * 60_000 + 30_000)
    act(() => screen.getByRole('button', { name: 'Stay signed in' }).click())
    await wait(4 * 60_000)
    expect(signedOut(api)).toBe(0)
    expect(session.token()).toBe('test-token')
  })
})
