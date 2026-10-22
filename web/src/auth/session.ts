// The session token from /v1/auth (sign-in, join, setup, reset), kept in this
// browser until signing out. The API keeps only its hash; it stops working
// after 30 days unused, on sign-out, or when the admin disables the account.
const KEY = 'waterflow.session'
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return memory
  }
}
let memory: string | null = null       // private mode: lasts until the tab closes

export const session = {
  token: read,

  set(token: string | null) {
    memory = token
    try {
      if (token) localStorage.setItem(KEY, token)
      else localStorage.removeItem(KEY)
    } catch {
      // private mode: kept in memory only
    }
    listeners.forEach((l) => l())
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    // Signing in or out in another tab of this browser.
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(listener)
      window.removeEventListener('storage', onStorage)
    }
  },
}
