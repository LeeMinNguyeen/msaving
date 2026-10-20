import { describe, expect, it } from 'vitest'
import { theme } from './theme'

type Schemes = Record<'light' | 'dark', { palette: { background: { default: string; sidebar: string } } }>

describe('theme (msaving#22)', () => {
  it('has a sidebar colour one shade darker than the page, in light and dark', () => {
    const { light, dark } = (theme as unknown as { colorSchemes: Schemes }).colorSchemes
    const level = (hex: string) => parseInt(hex.slice(1, 3), 16)
    expect(level(light.palette.background.sidebar)).toBeLessThan(level(light.palette.background.default))
    expect(level(dark.palette.background.sidebar)).toBeLessThan(level(dark.palette.background.default))
  })
})
