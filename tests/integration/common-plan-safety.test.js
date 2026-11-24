// What making or removing a _common is allowed to do, and what it says
// (#101): every deployment under the folder in the dialog, once; a plan that
// is stale by a file's content refused; nothing made or removed through a
// link; a _common refused by the deployment routes; a deployment page that
// names a broken _common rather than 404. Run with HELM_BIN set to each Helm
// version.
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

const init = folder => api('POST', '/api/v2/folders/init', { folder, chart: C })
const expectedOf = async query => (await plan(query)).data.expected

describe.skipIf(!HAS_HELM)('the plan', { timeout: 60000 }, () => {
  it('lists every deployment under the folder under one heading: changed, left (with why), or a problem', async () => {
    await fs.cp(SAMPLE, abs('charts/other-alerts'), { recursive: true })
    const other = yaml.load(await read('charts/other-alerts/Chart.yaml'))
    await write('charts/other-alerts/Chart.yaml', { ...other, name: 'other-alerts' })
    await init('shop/a')
    await api('POST', '/api/v2/folders/init', { folder: 'shop/o', chart: 'other-alerts' })
    await write('shop/both/Chart.yaml', { apiVersion: 'v2', name: 'both', version: '0.1.0', dependencies: [
      { name: 'other-alerts', version: '>=0.0.0-0', repository: 'file://../../charts/other-alerts' },
      { name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}` }] })
    await write('shop/both/values.yaml', { [C]: empty, 'other-alerts': empty })
    await write('shop/h/Chart.yaml', { apiVersion: 'v2', name: 'h', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}` }] })
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    expect(shown.status).toBe(200)
    expect(shown.data.changes.map(c => c.path)).toEqual(['shop/a'])
    expect(Object.fromEntries(shown.data.untouched.map(u => [u.path, u.why]))).toEqual({
      'shop/both': `it depends on other-alerts and ${C}: AlertForge re-attaches only a deployment on one Template`,
      'shop/h': 'it has no values.yaml: it deploys the Template\'s example rows, as it did',
      'shop/o': 'a deployment of another Template (other-alerts)',
    })
  })

  it('a Chart.yaml-only folder on a lower _common that is re-attached is rendered before and after', async () => {
    await fs.mkdir(abs('shop/b'), { recursive: true })
    await make('shop/b')
    await write('shop/b/h/Chart.yaml', { apiVersion: 'v2', name: 'h', version: '0.1.0', dependencies: [{ name: 'common', version: '>=0.0.0-0', repository: `file://../_common/${C}` }] })
    await expect(helm('shop/b/h')).resolves.toEqual([])
    const shown = await make('shop')
    expect(shown.changes.find(c => c.path === 'shop/b/h')).toEqual({ path: 'shop/b/h', kind: 'chart-only', change: 'through', files: [] })
  })

  it('a sync source whose dependency AlertForge cannot move is a problem named, not an error', async () => {
    await write('shop/s/Chart.yaml', { apiVersion: 'v2', name: 's', version: '0.1.0', dependencies: [{ name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}`, condition: `${C}.on` }] })
    await write('shop/s/values.yaml', { [C]: { on: true, ...empty } })
    await init('cart/t')
    expect((await api('POST', '/api/v2/sync', { source: 'shop/s', target: 'cart/t' })).status).toBe(200)
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    expect(shown.status).toBe(409)
    expect(shown.data.problems.map(p => p.path).sort()).toEqual(['cart/t', 'shop/s'])
  })
})

describe.skipIf(!HAS_HELM)('writing a plan', { timeout: 60000 }, () => {
  it('needs the plan\'s expected, and refuses one a file changed since, though the list of files is the same', async () => {
    await init('shop/a')
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C })).status).toBe(400)
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: ['shop/a/values.yaml'] })).status).toBe(400)
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    await write('shop/a/values.yaml', { [C]: { [CPU]: [{ warn_pct: 1, critical_pct: 2 }] } })
    const stale = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: shown.data.expected })
    expect(stale.status).toBe(409)
    expect(stale.data.plan.files).toEqual(shown.data.files)
    await expect(fs.access(abs(SHOP))).rejects.toThrow()
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: stale.data.plan.expected })).status).toBe(200)
  })
})

describe.skipIf(!HAS_HELM)('links and the deployment routes', { timeout: 60000 }, () => {
  it('nothing is made or removed through a link, inside the repo or out', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'))
    try {
      await fs.symlink(outside, abs('ext'))
      await init('real/a')
      await fs.symlink('real', abs('linked'))
      // Why, in words; for a link in the repo, the folder to ask for instead.
      for (const [folder, why] of [
        ['ext', 'it is a link that leads outside the repo — AlertForge makes no _common through a link'],
        ['linked', 'it is a link to real — AlertForge makes no _common through a link: ask for real'],
      ]) {
        const shown = await plan({ action: 'create', folder, chart: C })
        expect(shown.status).toBe(400)
        expect(shown.data.error).toBe(`${folder}: ${why}`)
      }
      expect(await fs.readdir(outside)).toEqual([])
      await make('real')
      expect((await plan({ action: 'delete', path: `linked/_common/${C}` })).status).toBe(409)
      expect((await api('GET', `/api/v2/folders/common/users?path=linked/_common/${C}`)).status).toBe(400)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('a _common is not deleted, cloned or given routing as a deployment', async () => {
    await init('shop/a')
    await make('shop')
    const q = `?folder=${encodeURIComponent(SHOP)}`
    for (const [method, url] of [['DELETE', `/api/v2/deployments/${C}/${C}${q}`], ['POST', `/api/v2/deployments/${C}/${C}/clone${q}`], ['PUT', `/api/v2/deployments/${C}/${C}/routing${q}`], ['DELETE', `/api/v2/deployments/${C}/${C}/routing${q}`]]) {
      const r = await api(method, url, { newName: 'x', routing: 'cells: []\n' })
      expect(r.status, `${method} ${url}`).toBe(400)
      expect(r.data.error).toMatch(/is a _common chart, not a deployment/)
    }
    await expect(fs.access(abs(`${SHOP}/Chart.yaml`))).resolves.toBeUndefined()
    // A new deployment inside it is refused as before.
    expect((await init(`${SHOP}/x`)).status).toBe(400)
  })

  it('a deployment whose _common cannot be read opens, naming the problem', async () => {
    await init('shop/a')
    await make('shop')
    await init('shop/b')
    await write(`${SHOP}/values.yaml`, 'x: [\n')
    const got = await api('GET', `/api/v2/deployments/${C}/b?folder=shop/b`)
    expect(got.status).toBe(200)
    expect(got.data.stackProblems.join('\n')).toMatch(/shop\/_common\/mariadb-alerts\/values\.yaml cannot be read/)
  })

  it('a new deployment under a broken _common leaves no folder behind, nor one that was there', async () => {
    await init('shop/a')
    await make('shop')
    await fs.rm(abs(`${SHOP}/charts/${C}`))
    expect((await init('shop/new/deeper')).status).toBe(409)
    await expect(fs.access(abs('shop/new'))).rejects.toThrow()
    await fs.mkdir(abs('shop/kept'))
    expect((await init('shop/kept')).status).toBe(409)
    await expect(fs.access(abs('shop/kept'))).resolves.toBeUndefined()
  })
})
