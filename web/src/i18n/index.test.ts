import { afterEach, describe, expect, it, vi } from 'vitest'

async function freshI18n() {
  vi.resetModules()
  return (await import('./index')).default
}

describe('language before sign-in', () => {
  afterEach(() => localStorage.clear())

  it('is English when this browser remembers no choice', async () => {
    expect((await freshI18n()).language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('is Vietnamese when this browser remembers that choice', async () => {
    localStorage.setItem('msaving.language', 'vi')
    expect((await freshI18n()).language).toBe('vi')
    expect(document.documentElement.lang).toBe('vi')
  })
})
