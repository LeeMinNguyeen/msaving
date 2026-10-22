import { describe, expect, it } from 'vitest'
import { idleState } from './idle'

const min = 60_000

describe('signing out after inactivity (waterflow#26)', () => {
  it('warns in the last minute and is due when the time is up', () => {
    expect(idleState(0, 3 * min, 5)).toEqual({ due: false, secondsLeft: null })
    expect(idleState(0, 4 * min, 5)).toEqual({ due: false, secondsLeft: 60 })
    expect(idleState(0, 4 * min + 30_500, 5)).toEqual({ due: false, secondsLeft: 30 })
    expect(idleState(0, 5 * min, 5)).toEqual({ due: true, secondsLeft: null })
    expect(idleState(0, 60 * min, 5).due).toBe(true) // a device waking up after an hour
  })

  it('counts from the last activity', () => {
    expect(idleState(2 * min, 6 * min, 5)).toEqual({ due: false, secondsLeft: 60 })
  })

  it('warns halfway through a setting shorter than two minutes', () => {
    expect(idleState(0, 20_000, 1)).toEqual({ due: false, secondsLeft: null })
    expect(idleState(0, 30_000, 1)).toEqual({ due: false, secondsLeft: 30 })
  })
})
