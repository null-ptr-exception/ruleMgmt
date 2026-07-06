import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('chartApi fetch-failure fallbacks', () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {}
    delete globalThis.window.__BASE_PATH__
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('listCharts returns [] instead of throwing when the network request fails', async () => {
    const { listCharts } = await import('../../src/utils/chartApi.js')
    await expect(listCharts()).resolves.toEqual([])
  })

  it('getSyncRegistry returns an empty registry instead of throwing when the network request fails', async () => {
    const { getSyncRegistry } = await import('../../src/utils/chartApi.js')
    await expect(getSyncRegistry()).resolves.toEqual({ syncs: [] })
  })

  it('createSync returns an ok:false result instead of throwing when the network request fails', async () => {
    const { createSync } = await import('../../src/utils/chartApi.js')
    await expect(createSync('a', 'b')).resolves.toEqual({ ok: false, error: 'network down' })
  })
})
