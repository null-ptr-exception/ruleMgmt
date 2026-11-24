import { defineConfig } from '@playwright/test'

// E2E_PORT: the port this run's server listens on (default 3111), so two
// worktrees can run E2E at once. A server already on that port is not this
// run's: it may serve another worktree's code and gitops/. The run stops
// with "already used" instead of testing it, unless E2E_REUSE_SERVER=1.
const PORT = Number(process.env.E2E_PORT || 3111)

export default defineConfig({
  testDir: 'tests/e2e',
  // Empty e2e-* folders left by earlier runs (#168).
  globalSetup: './tests/e2e/global-setup.js',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
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
    // tests/e2e/web-server.js keeps an idle connection open longer than a test.
    command: 'node --import ./tests/e2e/web-server.js server.js',
    port: PORT,
    env: { PORT: String(PORT) },
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 10000,
  },
})
