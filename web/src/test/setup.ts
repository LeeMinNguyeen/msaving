import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library cleans up by itself only when the test runner's globals are on; they aren't here.
afterEach(() => cleanup())
