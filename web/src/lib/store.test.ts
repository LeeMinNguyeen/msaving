import { describe, expect, it } from 'vitest'
import { storeUrlFor } from './store'

const stores = { appStoreUrl: 'https://apps.example/ios', playStoreUrl: 'https://play.example/android' }
const ua = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/150.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36',
}

describe('storeUrlFor', () => {
  it('sends phones to their store', () => {
    expect(storeUrlFor(ua.iphone, stores)).toBe(stores.appStoreUrl)
    expect(storeUrlFor(ua.androidPhone, stores)).toBe(stores.playStoreUrl)
  })

  it('keeps desktops and tablets on the web app', () => {
    for (const agent of [ua.desktop, ua.ipad, ua.androidTablet]) expect(storeUrlFor(agent, stores)).toBeUndefined()
  })

  it('does nothing until the app is published', () => {
    expect(storeUrlFor(ua.iphone, {})).toBeUndefined()
    expect(storeUrlFor(ua.androidPhone, {})).toBeUndefined()
  })
})
