// The one write path for a deployment's values and its sync targets (#180):
// what a save would refuse is not copied by POST /sync, a target that cannot
// be written is reported instead of swallowed, a hand-edited sync.yaml does
// not take every save down, and a save racing a sync link leaves the target
// a copy of its source.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'

// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir, errors

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-write-path-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  errors.mockRestore()
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    // Undo the chmods, or the folder cannot be removed.
    for (const rel of [TGT, `${TGT}/templates`, `${TGT}/values.yaml`]) {
      await fs.chmod(path.join(tmpDir, rel), 0o755).catch(() => {})
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const exists = rel => fs.access(path.join(tmpDir, rel)).then(() => true, () => false)
const q = f => `?folder=${encodeURIComponent(f)}`

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'
const T2 = 'deployments/team/t2'
const saveSrc = warn => api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn }] } })
const routingFixture = () => fs.readFile(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')

// A source on the demo Template; `targets` are made and synced to it.
async function setup(targets = [TGT]) {
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  for (const dep of [SRC, ...targets]) {
    expect((await api('POST', '/api/v2/folders/init', { folder: dep, chart: 'demo' })).status).toBe(200)
  }
  expect((await saveSrc(90)).status).toBe(200)
  for (const t of targets) expect((await api('POST', '/api/v2/sync', { source: SRC, target: t })).status).toBe(200)
}

describe('POST /sync refuses a source a values save would refuse', () => {
  it.each([
    ['a required value is missing', 'demo:\n  cpu:\n    - warn: 90\n', 'Some values cannot be rendered'],
    ['values.yaml is not YAML', 'demo:\n  cpu: [\n', 'values.yaml is not valid YAML'],
  ])('when %s, and the target is left as it was', async (_, text, error) => {
    await setup([])
    expect((await api('POST', '/api/v2/folders/init', { folder: TGT, chart: 'demo' })).status).toBe(200)
    const before = await read(`${TGT}/values.yaml`)
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), text)

    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })

    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: ${error}`)
    expect(data.problems.length).toBeGreaterThan(0)
    expect(await read(`${TGT}/values.yaml`)).toBe(before)
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })

  it('says which cell, for a required value', async () => {
    await setup([])
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'demo:\n  cpu:\n    - warn: 90\n')
    const { data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(data.problems).toEqual([expect.objectContaining({ group: 'cpu', row: 0, column: 'namespace' })])
  })
})

describe('POST /sync checks a source whose Chart.yaml dependency has no name', () => {
  it('refuses its values.yaml when it is not YAML', async () => {
    await setup([])
    const chart = path.join(tmpDir, SRC, 'Chart.yaml')
    const doc = yaml.load(await fs.readFile(chart, 'utf-8'))
    delete doc.dependencies[0].name
    await fs.writeFile(chart, yaml.dump(doc))
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'cpu: [\n')
    const { status, data } = await api('POST', '/api/v2/sync', { source: SRC, target: TGT })
    expect(status).toBe(400)
    expect(data.error).toBe(`${SRC} cannot be synced: values.yaml is not valid YAML`)
    expect(await exists(TGT)).toBe(false)
  })
})

describe('a values save refuses text that is not YAML', () => {
  it('and leaves values.yaml as it was', async () => {
    await setup([])
    const before = await read(`${SRC}/values.yaml`)
    const { status, data } = await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: 'demo:\n  cpu: [\n' })
    expect(status).toBe(400)
    expect(data.error).toBe('values.yaml is not valid YAML')
    expect(await read(`${SRC}/values.yaml`)).toBe(before)
  })
})

describe.skipIf(IS_ROOT)('a target that cannot be written is reported, and the source is saved', () => {
  it('saving the values', async () => {
    await setup([TGT, T2])
    await fs.chmod(path.join(tmpDir, TGT, 'values.yaml'), 0o444)

    const { status, data } = await saveSrc(50)

    expect(status).toBe(200)
    expect(data).toEqual({ ok: true, syncFailed: [{ target: TGT, error: 'EACCES' }] })
    expect(await read(`${SRC}/values.yaml`)).toContain('warn: 50')
    expect(await read(`${T2}/values.yaml`)).toBe(await read(`${SRC}/values.yaml`))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`could not be copied to ${TGT}`), expect.anything())
  })

  it.each([
    ['saving the routing', async () => api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: await routingFixture() })],
    ['deleting the routing', () => api('DELETE', `/api/v2/deployments/demo/src/routing${q(SRC)}`)],
  ])('%s', async (_, act) => {
    await setup()
    expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: (await routingFixture()).replace('4h', '3h') })).status).toBe(200)
    const before = await read(`${TGT}/routing.yaml`)
    await fs.chmod(path.join(tmpDir, TGT, 'templates'), 0o555)
    await fs.chmod(path.join(tmpDir, TGT), 0o555)

    const { status, data } = await act()

    expect(status).toBe(200)
    expect(data).toEqual({ ok: true, syncFailed: [{ target: TGT, error: 'EACCES' }] })
    expect(await read(`${SRC}/routing.yaml`).catch(() => null)).not.toBe(before)
    expect(await read(`${TGT}/routing.yaml`)).toBe(before)
  })
})

describe('a hand-edited sync.yaml', () => {
  it('an entry without a targets list does not stop saves', async () => {
    await setup([])
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: 'deployments/team/other' }] }))
    expect(await saveSrc(60)).toEqual({ status: 200, data: { ok: true } })
  })

  it('a target that is not a deployment on disk is reported, not created', async () => {
    await setup([])
    const ghost = 'deployments/team/ghost'
    await fs.writeFile(path.join(tmpDir, 'sync.yaml'), yaml.dump({ syncs: [{ source: SRC, targets: [ghost] }] }))

    const saved = await saveSrc(60)
    const routed = await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: await routingFixture() })

    for (const { status, data } of [saved, routed]) {
      expect(status).toBe(200)
      expect(data.syncFailed).toEqual([{ target: ghost, error: 'not a deployment on disk' }])
    }
    expect(await exists(ghost)).toBe(false)
  })
})

describe('saves racing sync changes leave the target a copy of its source', () => {
  it('a values save at the same time as a new sync link', async () => {
    await setup([])
    let behind = 0
    for (let i = 0; i < 20; i++) {
      const t = `deployments/team/r${i}`
      expect((await api('POST', '/api/v2/folders/init', { folder: t, chart: 'demo' })).status).toBe(200)
      const [s, y] = await Promise.all([saveSrc(100 + i), api('POST', '/api/v2/sync', { source: SRC, target: t })])
      expect([s.status, y.status]).toEqual([200, 200])
      if ((await read(`${t}/values.yaml`)) !== (await read(`${SRC}/values.yaml`))) behind++
    }
    expect(behind).toBe(0)
  })

  it('two routing saves of the same source at once', async () => {
    await setup()
    const routing = await routingFixture()
    let differs = 0
    for (let i = 0; i < 20; i++) {
      const saves = await Promise.all([
        api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: routing.replace('4h', `${i + 1}h`) }),
        api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing: routing.replace('4h', `${i + 30}h`) }),
      ])
      // Unlocked, both writes share one temp file: one fails, and its
      // rollback can remove the source's routing.yaml altogether.
      expect(saves.map(s => s.status)).toEqual([200, 200])
      expect(await exists(`${SRC}/routing.yaml`)).toBe(true)
      for (const rel of ['routing.yaml', 'templates/alertmanagerconfig.yaml']) {
        if ((await read(`${TGT}/${rel}`).catch(() => null)) !== (await read(`${SRC}/${rel}`))) { differs++; break }
      }
    }
    expect(differs).toBe(0)
  })
})
