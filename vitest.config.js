import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'src/**/__tests__/**/*.test.js'],
  },
})
