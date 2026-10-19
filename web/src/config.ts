// Build-time settings, public values only (they end up in the bundle). The
// server serves this web app, so by default it talks to the address it was
// opened from: nothing to set.
const optional = (name: keyof ImportMetaEnv): string | undefined => {
  const value = import.meta.env[name]
  return typeof value === 'string' && value !== '' ? value.replace(/\/$/, '') : undefined
}

export const config = {
  // The API's address. Unset: this web app's own origin (the server, or Vite's proxy in development).
  apiUrl: optional('VITE_API_URL') ?? '',
  // Store pages of the mobile app. Once set, phones are offered it (StoreRedirect).
  appStoreUrl: optional('VITE_APP_STORE_URL'),
  playStoreUrl: optional('VITE_PLAY_STORE_URL'),
}
