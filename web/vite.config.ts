/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // The API on this machine (uvicorn on 8000, or the compose stack on 8080 with
  // MSAVING_API), on the same origin as the app, as the server serves it. xfwd
  // sends X-Forwarded-Host, like a reverse proxy: the API only accepts browsers
  // on its own address, and the proxy changes Host.
  server: {
    host: 'localhost', port: 5173, strictPort: true,
    proxy: { '/v1': { target: process.env.MSAVING_API ?? 'http://127.0.0.1:8000', xfwd: true } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // A screen's first test also loads MUI and its date pickers: 3 to 5 s on a
    // busy machine, too close to the default 5 s.
    testTimeout: 15_000,
  },
})
