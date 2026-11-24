// Sync across folders with different _commons (#103): the target renders
// its source's files, its source's _common included, so it deploys what the
// source does (written by hand, from the real helm); the tree, the Sync to
// list and its page say which _common it inherits, and that it is not its
// folder's. Nothing is refused. Run with HELM_BIN set to each Helm version.
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

const save = (rel, values) => api('POST', `/api/v2/deployments/${C}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`, { values })
const node = async rel => (await api('GET', `/api/v2/folders/tree?path=${encodeURIComponent(path.posix.dirname(rel))}`)).data.find(n => n.path === rel)

describe.skipIf(!HAS_HELM)('a sync target on another folder\'s _common', { timeout: 60000 }, () => {
  it('deploys what its source does, and is said to inherit its source\'s _common', async () => {
    await fs.mkdir(abs('shop'))
    await fs.mkdir(abs('cart'))
    await make('shop')
    await make('cart')
    await save(SHOP, { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] })
    await save(`cart/_common/${C}`, { _common: { owner: 'team-cart', namespace: 'cc' }, ...empty, [CPU]: [{ warn_pct: 60, critical_pct: 80 }] })
    for (const rel of ['shop/prod', 'cart/prod']) expect((await api('POST', '/api/v2/folders/init', { folder: rel, chart: C })).status).toBe(200)
    expect(await helm('cart/prod')).toEqual(['MariadbSaturationCpu_CriticalPct team-cart cc 80', 'MariadbSaturationCpu_WarnPct team-cart cc 60'])
    expect((await node('cart/prod'))).toMatchObject({ inheritsFrom: `cart/_common/${C}`, folderCommon: `cart/_common/${C}` })

    const synced = await api('POST', '/api/v2/sync', { source: 'shop/prod', target: 'cart/prod' })
    expect(synced.status).toBe(200)
    const shopAlerts = ['MariadbSaturationDisk_CriticalPct team-a c1 95', 'MariadbSaturationDisk_WarnPct team-a c1 85']
    expect(await helm('shop/prod')).toEqual(shopAlerts)
    expect(await helm('cart/prod')).toEqual(shopAlerts)
    expect(await node('cart/prod')).toMatchObject({ inheritsFrom: SHOP, folderCommon: `cart/_common/${C}` })
    const listed = (await api('GET', '/api/v2/folders/deployments')).data
    expect(listed.find(d => d.path === 'cart/prod')).toMatchObject({ inheritsFrom: SHOP, folderCommon: `cart/_common/${C}` })
    expect(listed.find(d => d.path === 'shop/prod')).toMatchObject({ inheritsFrom: SHOP, folderCommon: SHOP })
    expect((await api('GET', `/api/v2/deployments/${C}/prod?folder=cart/prod`)).data.stack).toEqual({ inheritsFrom: SHOP, folderCommon: `cart/_common/${C}` })

    // A new target with no _common of its own: on shop's too.
    expect((await api('POST', '/api/v2/sync', { source: 'shop/prod', target: 'other/x' })).status).toBe(200)
    expect(await helm('other/x')).toEqual(shopAlerts)
    expect(await node('other/x')).toMatchObject({ inheritsFrom: SHOP, folderCommon: null })
  })

  it('a source on the Template directly: its target in a folder with a _common does not inherit it', async () => {
    await fs.mkdir(abs('cart'))
    await make('cart')
    await save(`cart/_common/${C}`, { _common: { owner: 'team-cart', namespace: 'cc' }, ...empty, [CPU]: [{ warn_pct: 60, critical_pct: 80 }] })
    await direct('plain/src', { _common: { owner: 'p', namespace: 'p' }, ...empty, [DISK]: [{ warn_pct: 1, critical_pct: 2 }] })
    await api('POST', '/api/v2/folders/init', { folder: 'cart/t', chart: C })
    expect((await api('POST', '/api/v2/sync', { source: 'plain/src', target: 'cart/t' })).status).toBe(200)
    expect(await helm('cart/t')).toEqual(['MariadbSaturationDisk_CriticalPct p p 2', 'MariadbSaturationDisk_WarnPct p p 1'])
    expect(await node('cart/t')).toMatchObject({ inheritsFrom: null, folderCommon: `cart/_common/${C}` })
  })
})
