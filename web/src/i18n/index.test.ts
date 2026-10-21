import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshI18n() {
  vi.resetModules()
  return (await import('./index')).default
}

describe('the language a page opens in', () => {
  afterEach(() => localStorage.clear())

  it('is English before sign-in, whatever this browser remembers', async () => {
    localStorage.setItem('msaving.language', 'vi')
    expect((await freshI18n()).language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it("is the user's own once signed in", async () => {
    localStorage.setItem('msaving.session', 'token')
    localStorage.setItem('msaving.language', 'vi')
    expect((await freshI18n()).language).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })

  it('is English for a signed-in user with nothing remembered', async () => {
    localStorage.setItem('msaving.session', 'token')
    expect((await freshI18n()).language).toBe('en')
  })
})
