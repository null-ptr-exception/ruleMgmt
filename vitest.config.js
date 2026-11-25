import { defineConfig } from 'vitest/config'
import { INCLUDE, EXCLUDE } from './tests/coverage/lib.mjs'

export default defineConfig({
  test: {
    globals: true,
    // Many tests run helm, promtool, vmalert or amtool: about a second each
    // alone, but with every worker starting them at once a single one can
    // take longer than vitest's default 5 s. A test that hangs still fails.
    testTimeout: 30000,
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'src/**/__tests__/**/*.test.js'],
    setupFiles: ['tests/coverage/children.setup.mjs'],
    // Only with --coverage, which `npm run test:coverage` passes (tests/coverage/unit.mjs).
    // Every file of INCLUDE, imported by a test or not. The summary and the
    // thresholds are that script's: vitest's own could not count what the
    // started processes and the E2E tests ran.
    coverage: { provider: 'v8', include: INCLUDE, exclude: EXCLUDE, reporter: ['json'], reportsDirectory: 'coverage/vitest' },
  },
})
