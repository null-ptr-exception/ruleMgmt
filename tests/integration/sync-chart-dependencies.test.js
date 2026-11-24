// A sync target renders what its source does (#180): sync copies the
// source's Chart.yaml dependencies too, so a target on another Template, or
// a new one at another folder depth, is not left on the wrong Template or
// with a file:// path that points nowhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
// chmod does not stop root from writing.
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-chart-deps-'))
  for (const c of ['demo', 'other']) await fs.mkdir(path.join(tmpDir, 'charts', c), { recursive: true })
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

  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/other/rules', { files: { 'mem.yaml': MEM } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: SRC, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn: 90 }] } })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    await fs.chmod(path.join(tmpDir, OTHER_TGT, 'values.yaml'), 0o644).catch(() => {})
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
const chartOf = async rel => yaml.load(await read(`${rel}/Chart.yaml`))
const q = f => `?folder=${encodeURIComponent(f)}`

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
const MEM = `group: mem
columns:
  pod: {type: string, required: true}
rules:
  - alert: MemHigh
    expr: mem{pod="\${pod}"} > 1
`
const SRC = 'deployments/team/src'
const OTHER_TGT = 'deployments/team/redis'

// What gets deployed: every alert the folder renders.
async function alertsOf(rel) {
  const abs = path.join(tmpDir, rel)
  const out = await renderChart(abs, ['template', path.basename(rel), abs])
  return yaml.loadAll(out).filter(d => d?.kind === 'PrometheusRule')
    .flatMap(d => d.spec.groups.flatMap(g => (g.rules || []).map(r => `${r.alert}: ${r.expr}`)))
}

describe('sync to a deployment on another Template', () => {
  beforeEach(async () => {
    expect((await api('POST', '/api/v2/folders/init', { folder: OTHER_TGT, chart: 'other' })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/other/redis${q(OTHER_TGT)}`, { values: { mem: [{ pod: 'r' }] } })).status).toBe(200)
  })

  it('moves the target onto the source\'s Template, keeping its own name', async () => {
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: OTHER_TGT })).status).toBe(200)
    expect(await chartOf(OTHER_TGT)).toMatchObject({
      name: 'redis',
      dependencies: [{ name: 'demo', repository: 'file://../../../charts/demo' }],
    })
  })

  it.skipIf(!HAS_HELM)('the target renders the source\'s alerts, not its old ones', async () => {
    expect(await alertsOf(OTHER_TGT)).toEqual(['MemHigh: mem{pod="r"} > 1'])
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: OTHER_TGT })).status).toBe(200)
    expect(await alertsOf(SRC)).toEqual(['CpuHigh: cpu{ns="p"} > 90'])
    expect(await alertsOf(OTHER_TGT)).toEqual(await alertsOf(SRC))
  })

  // The copy fails after Chart.yaml is written: the target is put back as it
  // was, Template included.
  it.skipIf(IS_ROOT)('a sync that fails part way leaves the target on its own Template', async () => {
    const before = await read(`${OTHER_TGT}/Chart.yaml`)
    await fs.chmod(path.join(tmpDir, OTHER_TGT, 'values.yaml'), 0o444)
    const errors = console.error
    console.error = () => {}
    try {
      expect((await api('POST', '/api/v2/sync', { source: SRC, target: OTHER_TGT })).status).toBe(500)
    } finally {
      console.error = errors
    }
    expect(await read(`${OTHER_TGT}/Chart.yaml`)).toBe(before)
    expect((await api('GET', '/api/v2/sync')).data).toEqual({ syncs: [] })
  })
})

describe('sync to a new deployment at another folder depth', () => {
  it.each([
    ['deeper', 'deployments/team/eu/west/prod', 'file://../../../../../charts/demo'],
    ['shallower', 'deployments/prod', 'file://../../charts/demo'],
  ])('%s: the file:// path is worked out from the target, and it is named after its folder', async (_, target, repository) => {
    expect((await api('POST', '/api/v2/sync', { source: SRC, target })).status).toBe(200)
    expect(await chartOf(target)).toMatchObject({ name: path.basename(target), dependencies: [{ name: 'demo', repository }] })
  })

  it.skipIf(!HAS_HELM).each([
    ['deeper', 'deployments/team/eu/west/prod'],
    ['shallower', 'deployments/prod'],
  ])('%s: the target renders the source\'s alerts', async (_, target) => {
    expect((await api('POST', '/api/v2/sync', { source: SRC, target })).status).toBe(200)
    expect(await alertsOf(target)).toEqual(await alertsOf(SRC))
  })
})

describe('a sync that fails for a new target', () => {
  // The routing copy fails after Chart.yaml and values.yaml are written: a
  // folder left with both would be a deployment of its own, unlinked.
  it.skipIf(IS_ROOT)('leaves no folder behind', async () => {
    const routing = await fs.readFile(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')
    expect((await api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing })).status).toBe(200)
    await fs.chmod(path.join(tmpDir, SRC, 'routing.yaml'), 0o000)
    const errors = console.error
    console.error = () => {}
    try {
      expect((await api('POST', '/api/v2/sync', { source: SRC, target: 'deployments/team/new' })).status).toBe(500)
    } finally {
      console.error = errors
      await fs.chmod(path.join(tmpDir, SRC, 'routing.yaml'), 0o644)
    }
    expect(await fs.access(path.join(tmpDir, 'deployments/team/new')).then(() => true, () => false)).toBe(false)
    expect((await api('GET', '/api/v2/folders/deployments')).data.map(d => d.path)).toEqual([SRC])
  })
})

describe('a source whose Template changes', () => {
  // A hand edit (or a merge) moves the source onto another Template: the
  // next save carries that to the target too.
  it('a values save moves the target with it', async () => {
    const tgt = 'deployments/team/tgt'
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: tgt })).status).toBe(200)
    const chart = yaml.load(await read(`${SRC}/Chart.yaml`))
    chart.dependencies = [{ ...chart.dependencies[0], name: 'other', repository: 'file://../../../charts/other' }]
    await fs.writeFile(path.join(tmpDir, SRC, 'Chart.yaml'), yaml.dump(chart))
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'other:\n  mem: []\n')
    expect((await api('POST', `/api/v2/deployments/other/src${q(SRC)}`, { values: { mem: [{ pod: 's' }] } })).status).toBe(200)
    expect((await chartOf(tgt)).dependencies).toEqual([expect.objectContaining({ name: 'other', repository: 'file://../../../charts/other' })])
  })
})

describe('the deployment list', () => {
  it('gives no row count for a deployment whose values.yaml cannot be read', async () => {
    await fs.writeFile(path.join(tmpDir, SRC, 'values.yaml'), 'demo: [\n')
    const row = (await api('GET', '/api/v2/folders/deployments')).data.find(d => d.path === SRC)
    expect(row).toMatchObject({ chart: 'demo', alertCount: null })
  })
})

describe('a target already on the source\'s Template', () => {
  it('keeps its Chart.yaml as written, comments included', async () => {
    const tgt = 'deployments/team/tgt'
    expect((await api('POST', '/api/v2/folders/init', { folder: tgt, chart: 'demo' })).status).toBe(200)
    const handWritten = `# owned by team-a\n${await read(`${tgt}/Chart.yaml`)}`
    await fs.writeFile(path.join(tmpDir, tgt, 'Chart.yaml'), handWritten)
    expect((await api('POST', '/api/v2/sync', { source: SRC, target: tgt })).status).toBe(200)
    expect((await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn: 70 }] } })).status).toBe(200)
    expect(await read(`${tgt}/Chart.yaml`)).toBe(handWritten)
  })
})
