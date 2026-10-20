import { describe, expect, it } from 'vitest'
import { updateFinished, updating } from './updating'

describe('updating', () => {
  const since = Date.parse('2026-10-20T05:00:00Z')

  it('counts only a finished status from after the update started', () => {
    expect(updateFinished('done 2026-10-20T05:03:00Z', since)).toBe(true)
    expect(updateFinished('failed 2026-10-20T05:02:00Z: git pull ...', since)).toBe(true)
    expect(updateFinished('running 2026-10-20T05:00:01Z', since)).toBe(false)
    expect(updateFinished('done 2026-10-19T19:00:00Z', since)).toBe(false)   // an earlier update
    expect(updateFinished(null, since)).toBe(false)
  })

  it('moves from running to done or failed', () => {
    const seen: string[] = []
    const stop = updating.subscribe(() => seen.push('change'))
    updating.start('0.1.2')
    updating.finish('done 2026-10-20T05:03:00Z')
    updating.start('0.1.3')
    updating.finish('failed 2026-10-20T05:04:00Z: no network')
    stop()
    expect(seen).toHaveLength(4)
  })
})
