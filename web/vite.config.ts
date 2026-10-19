/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // The API on this machine (uvicorn on 8000, or the compose stack on 8080 with
  // MSAVING_API), on the same origin as the app, as the server serves it.
  server: {
    host: 'localhost', port: 5173, strictPort: true,
    proxy: { '/v1': process.env.MSAVING_API ?? 'http://127.0.0.1:8000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
})
