import { useSyncExternalStore } from 'react'
import { session } from './session'

// True when this browser holds a session token. The API decides whether it
// still works: a 401 not_signed_in clears it (lib/api.ts).
export function useSession(): boolean {
  return useSyncExternalStore(session.subscribe, () => session.token() !== null)
}
