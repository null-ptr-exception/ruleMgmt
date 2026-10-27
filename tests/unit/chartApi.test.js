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

  it('getRouting and saveRouting say what failed instead of throwing', async () => {
    const { getRouting, saveRouting } = await import('../../src/utils/chartApi.js')
    await expect(getRouting('c', 'd', 'f')).resolves.toEqual({ error: 'network down' })
    await expect(saveRouting('c', 'd', 'f', 'labels: {}')).resolves.toEqual({ ok: false, error: 'network down' })
  })
})

describe('chartApi routing', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('getRouting is null for a deployment with no routing.yaml', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'none' }) })
    const { getRouting } = await import('../../src/utils/chartApi.js')
    await expect(getRouting('c', 'dev', 'team/dev')).resolves.toBeNull()
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/v2/deployments/c/dev/routing?folder=team%2Fdev')
  })
})
