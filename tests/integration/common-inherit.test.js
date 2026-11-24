// A deployment under a folder's _common (#102): made on it, writing nothing
// of its own; told what it inherits and from where; a group overridden and
// reset. What Helm renders is written by hand (each row gives a warn and a
// critical alert). Run with HELM_BIN set to each Helm version.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'
import { deploymentCommitBlockers } from '../../server/lib/commitChecks.js'

const HELM = process.env.HELM_BIN || 'helm'
const HAS_HELM = (() => { try { execFileSync(HELM, ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const SAMPLE = path.resolve('sample/charts/mariadb-alerts')
const C = 'mariadb-alerts'
const DISK = 'mariadb_saturation_disk'
const CPU = 'mariadb_saturation_cpu'
const MEM = 'mariadb_saturation_memory'
const SHOP = `shop/_common/${C}`
const TEAM_B = `shop/team-b/_common/${C}`

let server, baseURL, tmpDir, groups, empty

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'common-create-'))
  await fs.cp(SAMPLE, path.join(tmpDir, 'charts', C), { recursive: true })
  groups = Object.entries(yaml.load(await fs.readFile(path.join(SAMPLE, 'values.yaml'), 'utf-8'))).filter(([, v]) => Array.isArray(v)).map(([k]) => k)
  empty = Object.fromEntries(groups.map(g => [g, []]))
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) {
    await fs.chmod(path.join(tmpDir, 'shop/stg'), 0o755).catch(() => {})
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}
const abs = rel => path.join(tmpDir, rel)
const read = rel => fs.readFile(abs(rel), 'utf-8')
const readYaml = async rel => yaml.load(await read(rel))
const write = async (rel, doc) => {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true })
  await fs.writeFile(abs(rel), typeof doc === 'string' ? doc : yaml.dump(doc))
}
// A deployment as AlertForge made one before any _common: on the Template.
async function direct(rel, values, extra = {}) {
  await write(`${rel}/Chart.yaml`, { apiVersion: 'v2', name: path.basename(rel), version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0', repository: `file://${path.relative(abs(rel), abs(`charts/${C}`))}`, ...extra }] })
  await write(`${rel}/values.yaml`, { [C]: values })
}
const plan = query => api('GET', `/api/v2/folders/common/plan?${new URLSearchParams(query)}`)
async function make(folder, chart = C) {
  const shown = await plan({ action: 'create', folder, chart })
  expect(shown.status, JSON.stringify(shown.data)).toBe(200)
  const done = await api('POST', '/api/v2/folders/common', { action: 'create', folder, chart, expected: shown.data.expected })
  expect(done.status, JSON.stringify(done.data)).toBe(200)
  return shown.data
}
async function remove(commonPath) {
  const shown = await plan({ action: 'delete', path: commonPath })
  expect(shown.status, JSON.stringify(shown.data)).toBe(200)
  const done = await api('POST', '/api/v2/folders/common', { action: 'delete', path: commonPath, expected: shown.data.expected })
  expect(done.status, JSON.stringify(done.data)).toBe(200)
  return shown.data
}

// Each alert as `name owner namespace threshold`, sorted.
const alertsOf = out => yaml.loadAll(out).filter(Boolean).flatMap(d => d.spec?.groups || []).flatMap(g => g.rules || []).filter(r => r.alert)
  .map(r => `${r.alert} ${r.labels?.owner} ${r.labels?.namespace} ${/>\s*(\S+)\s*$/.exec(r.expr)?.[1]}`).sort()
const helm = async rel => alertsOf(await renderChart(abs(rel), ['template', 'x', abs(rel)]))
async function renderAll(rels) {
  const out = {}
  for (const rel of rels) out[rel] = await helm(rel)
  return out
}
const counts = rendered => Object.fromEntries(Object.entries(rendered).map(([k, v]) => [k, v.length]))
// Every file under a folder, with its text or link: to tell nothing changed.
async function snapshot(rel = '') {
  const out = {}
  async function walk(dir) {
    for (const e of await fs.readdir(abs(dir), { withFileTypes: true })) {
      const child = dir ? `${dir}/${e.name}` : e.name
      if (e.name === 'Chart.lock' || e.name.endsWith('.tgz')) continue
      if (e.isSymbolicLink()) out[child] = `-> ${await fs.readlink(abs(child))}`
      else if (e.isDirectory()) await walk(child)
      else out[child] = await read(child)
    }
  }
  await walk(rel)
  return out
}

const DISK2 = [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }]
const INHERIT = [
  'MariadbSaturationDisk_CriticalPct team-a c1 95', 'MariadbSaturationDisk_CriticalPct team-a c1 96',
  'MariadbSaturationDisk_WarnPct team-a c1 85', 'MariadbSaturationDisk_WarnPct team-a c1 86',
]
const init = folder => api('POST', '/api/v2/folders/init', { folder, chart: C })
const save = (rel, values) => api('POST', `/api/v2/deployments/${C}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`, { values })
const get = rel => api('GET', `/api/v2/deployments/${C}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`)

// shop/ with a _common giving owner team-a, namespace c1 and two disk rows.
async function shopCommon() {
  await fs.mkdir(abs('shop'))
  await make('shop')
  expect((await save(SHOP, { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: DISK2 })).status).toBe(200)
}

describe.skipIf(!HAS_HELM)('a new deployment under a _common', { timeout: 60000 }, () => {
  it('is made on it, writing nothing of its own, and deploys what it gives', async () => {
    await shopCommon()
    const made = await init('shop/qa')
    expect(made.data).toMatchObject({ status: 'created', chart: C, inheritsFrom: SHOP })
    expect((await readYaml('shop/qa/Chart.yaml')).dependencies).toEqual([{ name: 'common', version: '>=0.0.0-0', repository: `file://../_common/${C}` }])
    expect(await readYaml('shop/qa/values.yaml')).toEqual({ common: { [C]: {} } })
    expect(await helm('shop/qa')).toEqual(INHERIT)
    // A group the _common gives later reaches it too.
    expect((await save(SHOP, { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: DISK2, [CPU]: [{ warn_pct: 70, critical_pct: 90 }] })).status).toBe(200)
    expect(await helm('shop/qa')).toEqual([
      'MariadbSaturationCpu_CriticalPct team-a c1 90', 'MariadbSaturationCpu_WarnPct team-a c1 70', ...INHERIT,
    ].sort())
  })

  it('two levels: on the nearest _common, wrapped for both', async () => {
    await shopCommon()
    await fs.mkdir(abs('shop/team-b'))
    await make('shop/team-b')
    const made = await init('shop/team-b/dev')
    expect(made.data.inheritsFrom).toBe(TEAM_B)
    expect(await readYaml('shop/team-b/dev/values.yaml')).toEqual({ common: { common: { [C]: {} } } })
    expect(await helm('shop/team-b/dev')).toEqual(INHERIT)
  })

  it('a folder with no _common: on the Template, every group [], as before', async () => {
    await init('plain/prod')
    expect((await readYaml('plain/prod/Chart.yaml')).dependencies).toEqual([{ name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}` }])
    expect(await readYaml('plain/prod/values.yaml')).toEqual({ [C]: empty })
    expect((await get('plain/prod')).data.inherited).toBeUndefined()
  })

  it('a _common with a problem is not made on, and says so', async () => {
    await shopCommon()
    await fs.rm(abs(`${SHOP}/charts/${C}`))
    const made = await init('shop/qa')
    expect(made.status).toBe(409)
    expect(made.data.error).toMatch(/shop\/qa would inherit from shop\/_common\/mariadb-alerts, which has a problem/)
    await expect(fs.access(abs('shop/qa/Chart.yaml'))).rejects.toThrow()
  })
})

describe.skipIf(!HAS_HELM)('what a deployment inherits', { timeout: 60000 }, () => {
  it('is read with it: the values its _common gives, and from where', async () => {
    await shopCommon()
    await init('shop/qa')
    const { data } = await get('shop/qa')
    expect(data.parsed).toEqual({})
    expect(data.inherited.values[DISK]).toEqual(DISK2)
    expect(data.inherited.values._common).toEqual({ owner: 'team-a', namespace: 'c1' })
    expect(data.inherited.from.groups[DISK]).toEqual({ from: SHOP, rows: 2 })
    expect(data.inherited.from.common).toEqual({ owner: SHOP, namespace: SHOP })
  })

  it('a group overridden here is its own; reset (the key removed), it inherits again', async () => {
    await shopCommon()
    await init('shop/qa')
    // Override: the two rows copied, one changed, one added.
    expect((await save('shop/qa', { [DISK]: [{ warn_pct: 80, critical_pct: 92 }, { warn_pct: 86, critical_pct: 96 }, { warn_pct: 87, critical_pct: 97 }] })).status).toBe(200)
    expect(await helm('shop/qa')).toEqual([
      'MariadbSaturationDisk_CriticalPct team-a c1 92', 'MariadbSaturationDisk_CriticalPct team-a c1 96', 'MariadbSaturationDisk_CriticalPct team-a c1 97',
      'MariadbSaturationDisk_WarnPct team-a c1 80', 'MariadbSaturationDisk_WarnPct team-a c1 86', 'MariadbSaturationDisk_WarnPct team-a c1 87',
    ])
    // The _common changes its rows: an overriding deployment keeps its own.
    expect((await save(SHOP, { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 75, critical_pct: 90 }] })).status).toBe(200)
    expect(await helm('shop/qa')).toHaveLength(6)
    // Cleared here ([]): nothing for disk.
    expect((await save('shop/qa', { [DISK]: [] })).status).toBe(200)
    expect(await helm('shop/qa')).toEqual([])
    // Reset: the key gone, never a null; the _common's row again.
    expect((await save('shop/qa', {})).status).toBe(200)
    expect(await read('shop/qa/values.yaml')).not.toMatch(/null|mariadb_saturation_disk/)
    expect(await helm('shop/qa')).toEqual(['MariadbSaturationDisk_CriticalPct team-a c1 90', 'MariadbSaturationDisk_WarnPct team-a c1 75'])
  })
})
