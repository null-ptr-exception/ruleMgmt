import { defineConfig } from '@playwright/test'

const isFullstack = process.argv.includes('fullstack')

export default defineConfig({
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
  },
  ...(isFullstack
    ? { globalSetup: './tests/e2e-fullstack/global-setup.js' }
    : {
        webServer: {
          command: 'node server.js',
          port: 3111,
          env: { PORT: '3111' },
          reuseExistingServer: !process.env.CI,
          timeout: 10000,
        },
      }),
  projects: [
    {
      name: 'unit',
      testDir: 'tests/e2e',
      use: {
        baseURL: 'http://127.0.0.1:3111',
      },
    },
    {
      name: 'fullstack',
      testDir: 'tests/e2e-fullstack',
      use: {
        storageState: 'tests/e2e-fullstack/.auth/session.json',
        ignoreHTTPSErrors: true,
      },
      timeout: 120_000,
    },
  ],
})
