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

  it('getSyncRegistry says the registry could not be read, not that there are no syncs, when the network request fails', async () => {
    const { getSyncRegistry } = await import('../../src/utils/chartApi.js')
    await expect(getSyncRegistry()).resolves.toEqual({ failed: true, error: 'network down' })
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

describe('saveChartRules: what a 409 is', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const answer = (status, body) => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status, json: async () => body }) }

  it('is the breaking-change dialog only when it carries the breaking changes', async () => {
    const { saveChartRules } = await import('../../src/utils/chartApi.js')
    answer(409, { error: 'Breaking schema change', breaking: [{ kind: 'column-removed', group: 'cpu', column: 'warn' }], notices: [], added: {}, deployments: [] })
    expect(await saveChartRules('c', {})).toMatchObject({ blocked: true, breaking: [{ kind: 'column-removed' }] })
  })

  it('is a refusal with its migration problems', async () => {
    const { saveChartRules } = await import('../../src/utils/chartApi.js')
    answer(409, { error: 'The migration would write values a save refuses', migrationProblems: [{ path: 'deployments/a', problems: [] }] })
    const result = await saveChartRules('c', {})
    expect(result).toMatchObject({ refused: true })
    expect(result.blocked).toBeUndefined()
  })

  // The answers as server/routes/templates.js sends them (paths made the
  // repo's by answersWithoutPaths).
  it.each([
    ['rules/ is gone', { error: 'charts/c/rules is not there, and values.schema.json was generated from it (it holds no rules): restore rules/ (from git) — converting the schema would write every group with no rules' }],
    ['the Template would not render', {
      error: 'The Template would not render as written: charts/c/templates/old.yaml repeats the alert CpuHigh',
      findings: [{ code: 'template.drift-repeats', file: 'charts/c/templates/old.yaml', description: 'charts/c/templates/old.yaml repeats the alert CpuHigh' }],
    }],
    ['a file cannot be read', { error: 'charts/c/values.yaml cannot be read: permission denied', unreadable: true }],
  ])('is a failed save, not the breaking dialog, when %s', async (_, body) => {
    const { saveChartRules } = await import('../../src/utils/chartApi.js')
    answer(409, body)
    const result = await saveChartRules('c', {})
    expect(result).toMatchObject({ failed: true, ...body })
    expect(result.blocked).toBeUndefined()
  })
})

describe('chartApi: sync.yaml that cannot be read', () => {
  afterEach(() => { vi.restoreAllMocks() })
  // As server/routes/sync.js answers it.
  const unreadable = { error: 'sync.yaml cannot be read (permission denied)', file: 'sync.yaml', unreadable: true }
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => unreadable }) })

  it('getSyncRegistry returns the error, not an empty registry', async () => {
    const { getSyncRegistry } = await import('../../src/utils/chartApi.js')
    const read = await getSyncRegistry()
    expect(read).toEqual({ failed: true, error: unreadable.error, file: 'sync.yaml' })
    expect(read.syncs).toBeUndefined()
  })

  it('getSyncSource returns the error, not "no source"', async () => {
    const { getSyncSource } = await import('../../src/utils/chartApi.js')
    const read = await getSyncSource('deployments/a')
    expect(read).toEqual({ target: 'deployments/a', failed: true, error: unreadable.error, file: 'sync.yaml' })
    expect('source' in read).toBe(false)
  })
})

describe('saveChartMeta', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('says why a description was not saved, not {}', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "EACCES: permission denied, access 'charts/c/Chart.yaml'" }) })
    const { saveChartMeta } = await import('../../src/utils/chartApi.js')
    await expect(saveChartMeta('c', { description: 'd' })).resolves.toEqual({ ok: false, error: "EACCES: permission denied, access 'charts/c/Chart.yaml'" })
  })
})
