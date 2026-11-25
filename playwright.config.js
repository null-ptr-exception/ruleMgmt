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
  // sync.yaml is the whole workspace's too: while one spec makes it
  // unreadable, every save and sync is refused. That spec runs last. Run it
  // alone with `--no-deps`, or the projects it depends on run first, whole:
  //   npx playwright test sync-unreadable --no-deps
  projects: [
    { name: 'main', testIgnore: /(routing-shared|sync-unreadable)\.spec\.js/ },
    { name: 'shared-configs', testMatch: /routing-shared\.spec\.js/, dependencies: ['main'] },
    { name: 'sync-unreadable', testMatch: /sync-unreadable\.spec\.js/, dependencies: ['shared-configs'] },
  ],
  webServer: {
    // tests/e2e/web-server.js keeps an idle connection open longer than a test.
    command: 'node --import ./tests/e2e/web-server.js server.js',
    port: PORT,
    env: { PORT: String(PORT), ...(process.env.COVERAGE_E2E && { NODE_V8_COVERAGE: `${process.env.COVERAGE_E2E}/server` }) },
    // Playwright kills the server otherwise, before it can write its coverage.
    ...(process.env.COVERAGE_E2E && { gracefulShutdown: { signal: 'SIGTERM', timeout: 20000 } }),
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 10000,
  },
})
