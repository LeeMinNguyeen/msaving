import { describe, expect, it, vi } from 'vitest'
import { newId } from './uuid'

describe('newId', () => {
  it('makes version 4 UUIDs without crypto.randomUUID (plain HTTP on a home network)', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    try {
      const ids = new Set(Array.from({ length: 100 }, newId))
      expect(ids.size).toBe(100)
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
