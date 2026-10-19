import { describe, expect, it } from 'vitest'
import en from './en.json'
import vi from './vi.json'

// Every language file has the same keys (CLAUDE.md: CI fails otherwise).
function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  )
}

describe('string files', () => {
  it('vi and en have the same keys', () => {
    expect(keys(en).sort()).toEqual(keys(vi).sort())
  })

  it('no string is empty', () => {
    for (const file of [vi, en]) {
      const values = keys(file).map((k) => k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], file))
      expect(values.every((v) => typeof v === 'string' && v.trim() !== '')).toBe(true)
    }
  })
})
