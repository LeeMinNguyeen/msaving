import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api, ApiError } = await import('./api')
const { session } = await import('../auth/session')

describe('api', () => {
  const fetchMock = vi.fn()
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
    session.set(null)
  })

  it('sends the session token as a bearer token', async () => {
    session.set('tok')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'u' }), { status: 200 }))

    expect(await api('/v1/me')).toEqual({ id: 'u' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/v1/me')                       // same origin: the server that served the app
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('sends no Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    await api('/v1/health')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Authorization')).toBe(false)
  })

  it('turns an error response into an ApiError with its code', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"forbidden"}', { status: 403 }))
    const err = await api('/v1/me').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('says server_unreachable when there is no answer at all (restarting, offline)', async () => {
    session.set('tok')
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const err = await api('/v1/me').catch((e) => e)
    expect(err).toMatchObject({ status: 0, code: 'server_unreachable' })
    expect(session.token()).toBe('tok')                   // still signed in
  })

  it('forgets a session the server no longer accepts', async () => {
    session.set('expired')
    fetchMock.mockResolvedValue(new Response('{"detail":"not_signed_in"}', { status: 401 }))
    await api('/v1/me').catch(() => null)
    expect(session.token()).toBeNull()
  })

  it('keeps the session for a wrong password on a signed-in form', async () => {
    session.set('tok')
    fetchMock.mockResolvedValue(new Response('{"detail":"invalid_credentials"}', { status: 401 }))
    await api('/v1/auth/password').catch(() => null)
    expect(session.token()).toBe('tok')
  })
})
