import { afterEach, describe, expect, it } from 'vitest'
import { moveOldStorage } from './oldStorage'

function stored() {
  return Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    .map((k) => [k, localStorage.getItem(k)]))
}

describe("what this browser kept under the app's former name, MSaving", () => {
  afterEach(() => localStorage.clear())

  it('moves to the new names, so nobody is signed out or loses a choice', () => {
    localStorage.setItem('msaving.session', 'token')
    localStorage.setItem('msaving.language', 'vi')
    localStorage.setItem('msaving.theme', 'dark')
    localStorage.setItem('msaving.device.lan', 'device-1')
    localStorage.setItem('something.else', 'x')
    moveOldStorage(localStorage)
    expect(stored()).toEqual({
      'waterflow.session': 'token', 'waterflow.language': 'vi', 'waterflow.theme': 'dark',
      'waterflow.device.lan': 'device-1', 'something.else': 'x',
    })
  })

  it('never replaces what is already kept under the new name', () => {
    localStorage.setItem('msaving.language', 'vi')
    localStorage.setItem('waterflow.language', 'en')
    moveOldStorage(localStorage)
    expect(stored()).toEqual({ 'waterflow.language': 'en' })
  })
})
