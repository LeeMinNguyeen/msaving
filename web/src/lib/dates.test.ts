import { act, renderHook } from '@testing-library/react'
import dayjs from 'dayjs'
import { describe, expect, it } from 'vitest'
import { isoOf, parseIso, useDraftDate } from './dates'

// A date with the year still to type, as MUI X hands it over: an invalid date.
const halfTyped = () => dayjs('2026-10-15').month(Number.NaN)

describe('dates (waterflow#27)', () => {
  it('reads and writes the API format', () => {
    expect(isoOf(parseIso('2026-10-03'))).toBe('2026-10-03')
    expect(parseIso('')).toBeNull()
    expect(isoOf(null)).toBe('')
    expect(isoOf(halfTyped())).toBe('')
  })

  it("keeps a half-typed date when the parent drops to '' for it", () => {
    const { result, rerender } = renderHook(({ value }) => useDraftDate(value), { initialProps: { value: '2026-10-01' } })
    let toParent = ''
    act(() => { toParent = result.current[1](halfTyped()) })
    expect(toParent).toBe('')
    rerender({ value: '' })                                     // the parent stores it: the filter goes
    expect(result.current[0]).not.toBeNull()                    // what's typed stays
    expect(result.current[0]!.isValid()).toBe(false)
  })

  it('takes a different date from the parent', () => {
    const { result, rerender } = renderHook(({ value }) => useDraftDate(value), { initialProps: { value: '2026-10-01' } })
    act(() => { result.current[1](halfTyped()) })
    rerender({ value: '2026-12-24' })                            // e.g. the filters were cleared and set elsewhere
    expect(isoOf(result.current[0])).toBe('2026-12-24')
    rerender({ value: '' })
    expect(result.current[0]).toBeNull()
  })

  it('hands the parent a whole date as YYYY-MM-DD', () => {
    const { result } = renderHook(() => useDraftDate(''))
    let toParent = ''
    act(() => { toParent = result.current[1](dayjs('2026-10-01')) })
    expect(toParent).toBe('2026-10-01')
  })
})
