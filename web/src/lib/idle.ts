import { useSyncExternalStore } from 'react'

// The server ends a session unused for the user's chosen minutes, but a tab left
// open keeps its session in use with its background refreshes, so the web app
// also watches for the user (components/IdleSignOut.tsx): a click, key, touch,
// scroll or mouse move in any tab of this browser counts.

const WARN_MS = 60_000 // the warning comes a minute before, or halfway through a shorter setting

// How long the user has left, from their last activity: due once it's up, and
// the seconds left while the warning shows.
export function idleState(lastActivity: number, now: number, minutes: number): { due: boolean; secondsLeft: number | null } {
  const limit = minutes * 60_000
  const left = limit - (now - lastActivity)
  return { due: left <= 0, secondsLeft: left > 0 && left <= Math.min(WARN_MS, limit / 2) ? Math.ceil(left / 1000) : null }
}

// After a sign-out for inactivity, the sign-in page says why, in every tab of
// this browser. Kept in memory: a reload forgets it, and signing in clears it.
let signedOutAfter: number | null = null
const listeners = new Set<() => void>()

export const idleNotice = {
  minutes: () => signedOutAfter,
  set(minutes: number | null) {
    if (minutes === signedOutAfter) return
    signedOutAfter = minutes
    listeners.forEach((l) => l())
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const useIdleNotice = () => useSyncExternalStore(idleNotice.subscribe, idleNotice.minutes)
