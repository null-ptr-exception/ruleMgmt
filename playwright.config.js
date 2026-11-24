import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // Empty e2e-* folders left by earlier runs (#168).
  globalSetup: './tests/e2e/global-setup.js',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3111',
    headless: true,
  },
  // The shared notification configs (#123) are the whole workspace's: a
  // change to them is refused while any deployment's routing.yaml cannot be
  // read, which other specs write on purpose. Their spec runs after the rest.
  projects: [
    { name: 'main', testIgnore: /routing-shared\.spec\.js/ },
    { name: 'shared-configs', testMatch: /routing-shared\.spec\.js/, dependencies: ['main'] },
  ],
  webServer: {
    command: 'node server.js',
    port: 3111,
    env: { PORT: '3111' },
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
})
