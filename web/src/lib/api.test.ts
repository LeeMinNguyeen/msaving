import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config', () => ({ config: { apiUrl: 'http://api.test' } }))
const getSession = vi.fn()
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: () => getSession() } } }))

const { api, ApiError } = await import('./api')

describe('api', () => {
  const fetchMock = vi.fn()
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('sends the access token as a bearer token', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'u', profile: null }), { status: 200 }))

    expect(await api('/v1/me')).toEqual({ id: 'u', profile: null })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/v1/me')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('sends no Authorization header when signed out', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await api('/v1/health')
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Authorization')).toBe(false)
  })

  it('turns an error response into an ApiError with its code', async () => {
    getSession.mockResolvedValue({ data: { session: null } })
    fetchMock.mockResolvedValue(new Response('{"detail":"not_signed_in"}', { status: 401 }))

    const err = await api('/v1/me').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, code: 'not_signed_in' })
  })
})
