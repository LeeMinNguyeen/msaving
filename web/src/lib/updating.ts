import { useSyncExternalStore } from 'react'

// What GET /v1/admin/update answers (admin only).
export type UpdateInfo = {
  current_version: string; latest_version: string | null; release_url: string | null; update_available: boolean
  updater: boolean; status: string | null
}

// Whether the updater helper's status line ("done 2026-...", "failed ...") is about the update started at `since`.
// A failed one reads "failed <time>: <reason>".
export function updateFinished(status: string | null | undefined, since: number): boolean {
  const m = /^(done|failed) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/.exec(status ?? '')
  return !!m && Date.parse(m[2]) >= since - 5000
}

// An update the admin started from this tab. The server goes away while it
// rebuilds and restarts, so every page shows a notice instead of errors
// (components/UpdatingNotice.tsx). Kept in memory: reloading ends it, which
// is what the notice asks for.
type Updating = { version: string | null; since: number; phase: 'running' | 'done' | 'failed'; detail?: string }
let state: Updating | null = null
const listeners = new Set<() => void>()
const set = (next: Updating | null) => {
  state = next
  listeners.forEach((l) => l())
}

export const updating = {
  start: (version: string | null) => set({ version, since: Date.now(), phase: 'running' }),
  finish: (status: string) =>
    state && set(status.startsWith('done') ? { ...state, phase: 'done' } : { ...state, phase: 'failed', detail: status }),
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const useUpdating = () => useSyncExternalStore(updating.subscribe, () => state)
