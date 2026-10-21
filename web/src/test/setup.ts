import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library cleans up by itself only when the test runner's globals are on; they aren't here.
afterEach(() => cleanup())

// findBy and waitFor give up after 1 s by default: too short on a busy machine for a whole page, and the first
// test in a file also loads MUI (vite.config.ts allows 15 s a test).
configure({ asyncUtilTimeout: 5_000 })
