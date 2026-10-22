import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshI18n() {
  vi.resetModules()
  return (await import('./index')).default
}

describe('the language a page opens in', () => {
  afterEach(() => localStorage.clear())

  it('is the one this browser remembers, before sign-in too', async () => {
    localStorage.setItem('msaving.language', 'vi')
    expect((await freshI18n()).language).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })

  it('is English when this browser remembers none, or one the app does not have', async () => {
    expect((await freshI18n()).language).toBe('en')
    localStorage.setItem('msaving.language', 'xx')
    expect((await freshI18n()).language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
