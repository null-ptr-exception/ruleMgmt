// A page opened before a _common was made or removed above it, or before
// someone else saved, cannot write its values over what is there now (#102):
// they would be of the old shape, and what the _common gave would be lost.
// Each save sends what the page was loaded from. Helm's output is written by
// hand. Run with HELM_BIN set to each Helm version.
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

const DISK2 = [{ warn_pct: 81, critical_pct: 91 }, { warn_pct: 82, critical_pct: 92 }]
const save = (rel, values, version) => api('POST', `/api/v2/deployments/${C}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`, { values, ...(version ? { version } : {}) })
const get = rel => api('GET', `/api/v2/deployments/${C}/${path.basename(rel)}?folder=${encodeURIComponent(rel)}`)
const cnt = list => ({ disk: list.filter(a => a.startsWith('MariadbSaturationDisk')).length, cpu: list.filter(a => a.startsWith('MariadbSaturationCpu')).length })

describe.skipIf(!HAS_HELM)('a save from a page opened before the stack changed', { timeout: 60000 }, () => {
  it('is refused: changed since you opened it; nothing written; a fresh page saves', async () => {
    await fs.mkdir(abs('shop'))
    await make('shop')
    expect((await save(SHOP, { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: DISK2, [CPU]: [{ warn_pct: 71, critical_pct: 72 }] })).status).toBe(200)
    await api('POST', '/api/v2/folders/init', { folder: 'shop/a', chart: C })
    expect((await save('shop/a', { _common: { owner: 'mine', namespace: 'x' } })).status).toBe(200)
    const opened = (await get('shop/a')).data.version
    expect(opened).toMatch(/^[0-9a-f]{20}$/)
    expect(cnt(await helm('shop/a'))).toEqual({ disk: 4, cpu: 2 })
    // Removed underneath the page: the rows it inherited are copied into it.
    await remove(SHOP)
    const was = await read('shop/a/values.yaml')
    const stale = await save('shop/a', { _common: { owner: 'mine', namespace: 'x' }, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] }, opened)
    expect(stale.status).toBe(409)
    expect(stale.data).toEqual({ error: 'shop/a changed since you opened it: reload it to see what is there now', changed: true })
    expect(await read('shop/a/values.yaml')).toBe(was)
    expect(cnt(await helm('shop/a'))).toEqual({ disk: 4, cpu: 2 })
    // Reloaded, it saves; the answer is what it was saved as.
    const fresh = (await get('shop/a')).data.version
    const ok = await save('shop/a', { ...(await get('shop/a')).data.parsed, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] }, fresh)
    expect(ok.status).toBe(200)
    expect(ok.data.version).toBe((await get('shop/a')).data.version)
  })

  it('a _common changed by someone else: its own page, and an override from a deployment page, are refused too', async () => {
    await fs.mkdir(abs('shop'))
    await make('shop')
    await api('POST', '/api/v2/folders/init', { folder: 'shop/a', chart: C })
    const commonPage = (await get(SHOP)).data.version
    const deploymentPage = (await get('shop/a')).data.version
    expect((await save(SHOP, { ...empty, [DISK]: DISK2 })).status).toBe(200)
    expect((await save(SHOP, { ...empty }, commonPage)).status).toBe(409)
    // Overriding disk with the rows the page showed, which are not there now.
    expect((await save('shop/a', { [DISK]: [] }, deploymentPage)).status).toBe(409)
  })
})
