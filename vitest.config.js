import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Many tests run helm, promtool, vmalert or amtool: about a second each
    // alone, but with every worker starting them at once a single one can
    // take longer than vitest's default 5 s. A test that hangs still fails.
    testTimeout: 30000,
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'src/**/__tests__/**/*.test.js'],
  },
})
