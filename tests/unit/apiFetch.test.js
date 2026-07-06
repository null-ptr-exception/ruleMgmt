import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('apiFetch', () => {
  let originalBasePath

  beforeEach(() => {
    originalBasePath = globalThis.window?.__BASE_PATH__
    globalThis.window = globalThis.window || {}
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    if (originalBasePath !== undefined) {
      globalThis.window.__BASE_PATH__ = originalBasePath
    } else {
      delete globalThis.window.__BASE_PATH__
    }
    vi.restoreAllMocks()
  })

  it('prepends base path to relative URL', async () => {
    globalThis.window.__BASE_PATH__ = '/user/testuser/'
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    await apiFetch('/api/v2/charts')
    expect(globalThis.fetch).toHaveBeenCalledWith('/user/testuser/api/v2/charts', undefined)
  })

  it('defaults to / when no base path set', async () => {
    delete globalThis.window.__BASE_PATH__
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    await apiFetch('/api/v2/charts')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/charts', undefined)
  })

  it('passes options through', async () => {
    delete globalThis.window.__BASE_PATH__
    const { apiFetch } = await import('../../src/lib/apiFetch.js')
    const opts = { method: 'POST', body: '{}' }
    await apiFetch('/api/v2/git/commit', opts)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v2/git/commit', opts)
  })

  it('resolves to a failed response instead of throwing when fetch rejects', async () => {
    delete globalThis.window.__BASE_PATH__
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const { apiFetch } = await import('../../src/lib/apiFetch.js')

    const res = await apiFetch('/api/v2/charts')
    expect(res.ok).toBe(false)
    await expect(res.json()).resolves.toEqual({ error: 'network down' })
  })
})
