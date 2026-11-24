// The E2E port comes from E2E_PORT, so two worktrees can run E2E at once,
// and a server already on it is only used when asked (E2E_REUSE_SERVER=1).
import { describe, it, expect, vi, afterEach } from 'vitest'

async function load(env) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return (await import('../../playwright.config.js')).default
}
afterEach(() => vi.unstubAllEnvs())

describe('playwright.config.js', () => {
  it('serves and tests on E2E_PORT', async () => {
    const config = await load({ E2E_PORT: '3122' })
    expect(config.use.baseURL).toBe('http://127.0.0.1:3122')
    expect(config.webServer.port).toBe(3122)
    expect(config.webServer.env.PORT).toBe('3122')
  })

  it('is on 3111 without E2E_PORT', async () => {
    const config = await load({ E2E_PORT: '' })
    expect(config.use.baseURL).toBe('http://127.0.0.1:3111')
    expect(config.webServer.port).toBe(3111)
    expect(config.webServer.env.PORT).toBe('3111')
  })

  it('does not take over a server already on the port unless asked', async () => {
    expect((await load({ E2E_REUSE_SERVER: '', CI: '' })).webServer.reuseExistingServer).toBe(false)
    expect((await load({ E2E_REUSE_SERVER: '1' })).webServer.reuseExistingServer).toBe(true)
  })
})
