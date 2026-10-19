// Build-time settings, public values only (they end up in the bundle). Each
// environment sets them; no URL is written into the code.
function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is not set`)
  return value.replace(/\/$/, '')
}

// Optional: unset until the mobile app is published.
const optional = (name: keyof ImportMetaEnv): string | undefined => {
  const value = import.meta.env[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const config = {
  apiUrl: required('VITE_API_URL'),
  siteUrl: required('VITE_SITE_URL'),
  supabaseUrl: required('VITE_SUPABASE_URL'),
  // The publishable (anon) key: safe in a browser. Never the service_role key.
  supabasePublishableKey: required('VITE_SUPABASE_PUBLISHABLE_KEY'),
  // Store pages of the mobile app. Once set, phones are sent there (StoreRedirect).
  appStoreUrl: optional('VITE_APP_STORE_URL'),
  playStoreUrl: optional('VITE_PLAY_STORE_URL'),
}
