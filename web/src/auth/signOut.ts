import { send } from '../lib/api'
import { session } from './session'

// Ends this device's session at the server, then forgets it here (even if the
// server can't be reached: the token is useless without this browser).
export async function signOut(): Promise<void> {
  try {
    await send('POST', '/v1/auth/sign-out')
  } catch {
    // already ended, or offline
  } finally {
    session.set(null)
  }
}
