// Build-time settings, public values only (they end up in the bundle). The
// server serves this web app and it calls the API on the address it was opened
// from (the server refuses any other origin), so there's no API address here.
const optional = (name: keyof ImportMetaEnv): string | undefined => {
  const value = import.meta.env[name]
  return typeof value === 'string' && value !== '' ? value.replace(/\/$/, '') : undefined
}

export const config = {
  // Store pages of the mobile app. Once set, phones are sent there (main.tsx).
  appStoreUrl: optional('VITE_APP_STORE_URL'),
  playStoreUrl: optional('VITE_PLAY_STORE_URL'),
}
