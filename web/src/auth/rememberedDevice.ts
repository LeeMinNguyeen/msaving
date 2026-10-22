// What lets sign-in skip the two-factor code in this browser: one token per username, kept until it stops working.
const key = (username: string) => `waterflow.device.${username.trim().toLowerCase()}`

export const rememberedDevice = {
  get(username: string): string | null {
    try {
      return localStorage.getItem(key(username))
    } catch {
      return null
    }
  },
  set(username: string, token: string) {
    try {
      localStorage.setItem(key(username), token)
    } catch {
      // private mode: nothing is remembered
    }
  },
  forget(username: string) {
    try {
      localStorage.removeItem(key(username))
    } catch {
      // private mode: nothing was remembered
    }
  },
}
