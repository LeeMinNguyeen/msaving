import { vi } from 'vitest'
import { session } from '../auth/session'

// A stand-in for the server: answers each "METHOD /path" (query string ignored
// unless the key has one) from a table, and records every call so a test can
// check what the app sent. A handler may be a value or a function of the call.
export type Call = { method: string; path: string; url: string; body: unknown }
type Handler = unknown | ((call: Call) => unknown)

export function fakeApi(routes: Record<string, Handler>) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.split('?')[0]
    const call: Call = { method, path, url, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const key = [`${method} ${url}`, `${method} ${path}`].find((k) => k in routes)
    if (!key) return new Response(JSON.stringify({ detail: 'not_found' }), { status: 404 })
    const handler = routes[key]
    const out = typeof handler === 'function' ? await (handler as (c: Call) => unknown)(call) : handler
    if (out instanceof Response) return out
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  session.set('test-token')
  return {
    calls,
    routes,
    writes: () => calls.filter((c) => c.method !== 'GET'),
  }
}

export const currencies = [
  { code: 'VND', minor_unit: 0, name: 'Vietnamese dong' },
  { code: 'USD', minor_unit: 2, name: 'US dollar' },
]
