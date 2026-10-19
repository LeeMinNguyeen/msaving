// Writes firebase.json for this environment's Firebase Hosting site, with a
// Content-Security-Policy naming exactly this environment's API and Supabase.
// Reads the same settings as the build: VITE_API_URL, VITE_SUPABASE_URL, plus
// FIREBASE_SITE (the app's Hosting site id). Runs in CI before deploying.
import fs from 'node:fs'

const need = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v.replace(/\/$/, '')
}
const api = need('VITE_API_URL')
const supabase = need('VITE_SUPABASE_URL')
const site = need('FIREBASE_SITE')

const csp = [
  "default-src 'self'",
  `connect-src 'self' ${api} ${supabase}`,
  "script-src 'self'",
  // MUI's styling (Emotion) adds <style> tags at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",          // the two-step verification QR code
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const config = {
  hosting: {
    site,
    public: 'dist',
    ignore: ['firebase.json', '**/.*'],
    rewrites: [{ source: '**', destination: '/index.html' }], // client-side routes
    headers: [
      {
        source: '**',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
      { source: '/assets/**', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ],
  },
}
fs.writeFileSync('firebase.json', JSON.stringify(config, null, 2) + '\n')
console.log(`firebase.json for ${site}`)
