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

describe('saveDeployment: an answer that cannot be read', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it.each([
    ['a proxy\'s error page', 504],
    ['a body cut off', 200],
  ])('%s says whether it was saved is not known', async (_, status) => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => { throw new SyntaxError('Unexpected token') } })
    const { saveDeployment } = await import('../../src/utils/chartApi.js')
    const result = await saveDeployment('c', 'd', {}, 'f')
    expect(result.ok).toBe(false)
    expect(result.unknown).toBe(true)
    expect(result.error).toContain('whether the change was made is not known')
  })
})

describe('chartApi: answers a page used to misread', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const cutOff = status => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => { throw new SyntaxError('Unexpected end of JSON input') } }) }
  const refusal = (status, body) => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status, json: async () => body }) }

  // It was an empty plan, and the dialog read plan.changes of it.
  it('getCommonPlan: a 200 that cannot be read says so, not an empty plan', async () => {
    const { getCommonPlan } = await import('../../src/utils/chartApi.js')
    cutOff(200)
    const result = await getCommonPlan({ action: 'delete', path: 'team/_common/c' })
    expect(result).toEqual({ error: expect.stringContaining('could not be read'), problems: [] })
  })

  // It was {}, which the dialogs and the tree said was "Sync failed".
  it.each(['createSync', 'unlinkSync'])('%s: a 200 that cannot be read says whether it was made is not known', async name => {
    const api = await import('../../src/utils/chartApi.js')
    cutOff(200)
    const result = await (name === 'createSync' ? api.createSync('a', 'b') : api.unlinkSync('b'))
    expect(result).toMatchObject({ ok: false, unknown: true })
    expect(result.error).toContain('whether the change was made is not known')
  })

  // It was {}, which Preview showed as "Error: Unknown error".
  it('renderDeployment: a refusal keeps its reason', async () => {
    const { renderDeployment } = await import('../../src/utils/chartApi.js')
    refusal(409, { error: 'deployments/a/values.yaml cannot be read (permission denied)', file: 'deployments/a/values.yaml' })
    await expect(renderDeployment('c', 'a', 'deployments/a')).resolves.toMatchObject({ ok: false, error: 'deployments/a/values.yaml cannot be read (permission denied)' })
  })

  it('renderDeployment: a network failure and a proxy page say what happened', async () => {
    const { renderDeployment } = await import('../../src/utils/chartApi.js')
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(renderDeployment('c', 'a', 'deployments/a')).resolves.toEqual({ ok: false, error: 'Failed to fetch' })
    cutOff(504)
    await expect(renderDeployment('c', 'a', 'deployments/a')).resolves.toEqual({ ok: false, error: 'the server answered 504' })
  })

  // It was { deployments: [] }: a preview with nothing affected, and Change
  // in place on.
  it('migrationPreview: a refusal throws its reason, not an empty preview', async () => {
    const { migrationPreview } = await import('../../src/utils/chartApi.js')
    refusal(409, { error: 'deployments/a/values.yaml cannot be read (permission denied)' })
    await expect(migrationPreview('c', {}, {})).rejects.toThrow('deployments/a/values.yaml cannot be read (permission denied)')
    cutOff(504)
    await expect(migrationPreview('c', {}, {})).rejects.toThrow('the server answered 504')
  })
})

describe('saveChartRules: a 400 or 409 that cannot be read', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it.each([400, 409])('%s throws AnswerCutOff, the result not known', async status => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected token <') } })
    const { saveChartRules } = await import('../../src/utils/chartApi.js')
    const { AnswerCutOff } = await import('../../src/lib/apiFetch.js')
    const err = await saveChartRules('c', {}).catch(e => e)
    expect(err).toBeInstanceOf(AnswerCutOff)
    expect(err.uncertain).toBe(true)
  })
})

describe('chartApi: a refusal whose error is not a sentence', () => {
  afterEach(() => { vi.restoreAllMocks() })
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { file: 'a.yaml' } }) }) })

  it('renderDeployment says the status, not [object Object]', async () => {
    const { renderDeployment } = await import('../../src/utils/chartApi.js')
    const result = await renderDeployment('c', 'a', 'deployments/a')
    expect(result).toMatchObject({ ok: false, error: 'the server answered 409' })
  })

  it('migrationPreview says the status, not [object Object]', async () => {
    const { migrationPreview } = await import('../../src/utils/chartApi.js')
    await expect(migrationPreview('c', {}, {})).rejects.toThrow(/^the server answered 409$/)
  })
})

describe('migrationPreview: a 200 that cannot be read', () => {
  afterEach(() => { vi.restoreAllMocks() })
  it('throws the sentence every unreadable answer says, not the engine\'s', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new TypeError("Failed to execute 'json' on 'Response': Unexpected end of JSON input") } })
    const { migrationPreview } = await import('../../src/utils/chartApi.js')
    const { cutOffMessage } = await import('../../src/lib/apiFetch.js')
    const err = await migrationPreview('c', {}, {}).catch(e => e)
    expect(err.message).toBe(cutOffMessage({ uncertain: false }))
  })
})

describe('chartApi: a refusal whose body never ends', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  // A proxy that sends a 504's headers and then nothing.
  const stalled = () => { globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 504, json: () => new Promise(() => {}) }) }
  const settledWithin = async (promise, ms) => {
    const pending = Symbol('pending')
    const result = promise.catch(err => ({ threw: err.message }))
    await vi.advanceTimersByTimeAsync(ms)
    return Promise.race([result, Promise.resolve(pending)]).then(v => (v === pending ? 'still waiting' : v))
  }

  it.each([
    ['listCharts', api => api.listCharts(), []],
    ['getUserInfo', api => api.getUserInfo(), { user: null, logoutUrl: null }],
    ['renderDeployment', api => api.renderDeployment('c', 'a', 'deployments/a'), { ok: false, error: 'the server answered 504' }],
    ['migrationPreview', api => api.migrationPreview('c', {}, {}), { threw: 'the server answered 504' }],
    ['getChartInfo', api => api.getChartInfo('c'), { failed: true, error: 'the server answered 504' }],
  ])('%s answers after a bounded wait', async (_, call, expected) => {
    vi.useFakeTimers()
    stalled()
    const api = await import('../../src/utils/chartApi.js')
    expect(await settledWithin(call(api), 10000)).toEqual(expected)
  })
})
