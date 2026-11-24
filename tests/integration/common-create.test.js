// Making and removing a folder's _common from the API (#101). What every
// deployment under it renders with the real helm is the same before and
// after, written by hand (each row gives a warn and a critical alert; the
// Template's example rows give 20 alerts in all, 18 without cpu's); the files
// written are what Helm needs: a chart named `common`, a link to what it
// inherits from in its own charts/, every group [] on the Template directly.
// Run with HELM_BIN set to each Helm version. Each case runs helm a dozen
// times or more: a minute, not the default 5 s.
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

async function shop() {
  // prod writes every group; stg only cpu (it deploys the Template's example
  // rows for the 12 others); dev is a folder further down.
  await direct('shop/prod', { _common: { owner: 'team-prod', namespace: 'p' }, ...empty, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] })
  await direct('shop/stg', { _common: { owner: 'team-stg', namespace: 's' }, [CPU]: [{ warn_pct: 71, critical_pct: 91 }] })
  await direct('shop/x/dev', { _common: { owner: 'team-dev', namespace: 'd' }, ...empty, [MEM]: [{ warn_pct: 60, critical_pct: 70 }] })
}
const SHOP_COUNTS = { 'shop/prod': 2, 'shop/stg': 20, 'shop/x/dev': 2 }

describe.skipIf(!HAS_HELM)('making a _common', { timeout: 60000 }, () => {
  it('one level: every deployment under the folder inherits from it, and deploys what it did', async () => {
    await shop()
    const before = await renderAll(Object.keys(SHOP_COUNTS))
    expect(counts(before)).toEqual(SHOP_COUNTS)
    const shown = await make('shop')
    expect(shown.changes.map(c => [c.path, c.change])).toEqual([['shop/prod', 'attached'], ['shop/stg', 'attached'], ['shop/x/dev', 'attached']])
    expect(shown.changes.find(c => c.path === 'shop/stg').exampleRows).toHaveLength(12)
    expect(shown.files).toEqual([
      `${SHOP}/Chart.yaml`, `${SHOP}/charts/${C}`, `${SHOP}/values.yaml`,
      'shop/prod/Chart.yaml', 'shop/prod/values.yaml', 'shop/stg/Chart.yaml', 'shop/stg/values.yaml', 'shop/x/dev/Chart.yaml', 'shop/x/dev/values.yaml',
    ])
    expect(await renderAll(Object.keys(SHOP_COUNTS))).toEqual(before)

    expect(await readYaml(`${SHOP}/Chart.yaml`)).toMatchObject({ name: 'common', dependencies: [{ name: C, version: '>=0.0.0-0' }] })
    expect(await fs.readlink(abs(`${SHOP}/charts/${C}`))).toBe(`../../../../charts/${C}`)
    expect(await readYaml(`${SHOP}/values.yaml`)).toEqual({ [C]: empty })
    expect((await readYaml('shop/x/dev/Chart.yaml')).dependencies).toEqual([{ name: 'common', version: '>=0.0.0-0', repository: `file://../../_common/${C}` }])
    expect(await readYaml('shop/prod/values.yaml')).toEqual({ common: { [C]: { _common: { owner: 'team-prod', namespace: 'p' }, ...empty, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] } } })
    // The example rows stg deployed are its own now.
    const stg = (await readYaml('shop/stg/values.yaml')).common[C]
    expect(stg[CPU]).toEqual([{ warn_pct: 71, critical_pct: 91 }])
    expect(stg[DISK]).toEqual([{ warn_pct: 75, critical_pct: 90 }])
    expect((await deploymentCommitBlockers(tmpDir)).findings).toEqual([])
  })

  it('two levels: a folder under one that has a _common', async () => {
    await shop()
    await direct('shop/team-b/q', { _common: { owner: 'team-q', namespace: 'q' }, ...empty, [DISK]: [{ warn_pct: 50, critical_pct: 60 }] })
    await make('shop')
    // shop's _common gives owner team-a and two disk rows to whoever has none.
    await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }, { warn_pct: 86, critical_pct: 96 }] } })
    const rels = [...Object.keys(SHOP_COUNTS), 'shop/team-b/q']
    const before = await renderAll(rels)
    expect(counts(before)).toEqual({ ...SHOP_COUNTS, 'shop/team-b/q': 2 })
    const shown = await make('shop/team-b')
    expect(shown.inheritsFrom).toBe(SHOP)
    expect(shown.changes.map(c => [c.path, c.change])).toEqual([['shop/team-b/q', 'attached']])
    expect(await renderAll(rels)).toEqual(before)
    expect(await readYaml(`${TEAM_B}/Chart.yaml`)).toMatchObject({ name: 'common', dependencies: [{ name: 'common', version: '>=0.0.0-0' }] })
    expect(await fs.readlink(abs(`${TEAM_B}/charts/common`))).toBe(`../../../../_common/${C}`)
    // Nothing of its own: whatever shop's gives still reaches team-b's.
    expect(await readYaml(`${TEAM_B}/values.yaml`)).toEqual({})
    expect(await readYaml('shop/team-b/q/values.yaml')).toEqual({ common: { common: { [C]: { _common: { owner: 'team-q', namespace: 'q' }, ...empty, [DISK]: [{ warn_pct: 50, critical_pct: 60 }] } } } })
    // A deployment that writes no disk of its own now gets shop's two rows,
    // through team-b's: 4 alerts, owner team-a.
    await api('POST', `/api/v2/deployments/${C}/q?folder=shop/team-b/q`, { values: { _common: { namespace: 'q' } } })
    expect(await helm('shop/team-b/q')).toEqual([
      'MariadbSaturationDisk_CriticalPct team-a q 95', 'MariadbSaturationDisk_CriticalPct team-a q 96',
      'MariadbSaturationDisk_WarnPct team-a q 85', 'MariadbSaturationDisk_WarnPct team-a q 86',
    ])
  })

  it('above a folder that already has one: the lower _common inherits from the new one', async () => {
    await direct('shop/team-b/q', { _common: { owner: 'team-q', namespace: 'q' }, ...empty, [DISK]: [{ warn_pct: 50, critical_pct: 60 }] })
    await direct('shop/prod', { _common: { owner: 'team-prod', namespace: 'p' }, ...empty, [CPU]: [{ warn_pct: 70, critical_pct: 90 }] })
    await make('shop/team-b')
    await api('POST', `/api/v2/deployments/${C}/q?folder=shop/team-b/q`, { values: { _common: { owner: 'team-q', namespace: 'q' } } })
    await api('POST', `/api/v2/deployments/${C}/${C}?folder=${TEAM_B}`, { values: { ...empty, [DISK]: [{ warn_pct: 51, critical_pct: 61 }] } })
    const rels = ['shop/team-b/q', 'shop/prod']
    const before = await renderAll(rels)
    expect(before['shop/team-b/q']).toEqual(['MariadbSaturationDisk_CriticalPct team-q q 61', 'MariadbSaturationDisk_WarnPct team-q q 51'])
    const shown = await make('shop')
    expect(shown.changes.map(c => [c.path, c.kind, c.change])).toEqual([
      ['shop/prod', 'deployment', 'attached'], [TEAM_B, 'common', 'attached'], ['shop/team-b/q', 'deployment', 'rewrapped'],
    ])
    expect(await renderAll(rels)).toEqual(before)
    expect((await readYaml(`${TEAM_B}/Chart.yaml`)).dependencies).toEqual([{ name: 'common', version: '>=0.0.0-0' }])
    expect(await fs.readdir(abs(`${TEAM_B}/charts`))).toEqual(['common'])
    expect(Object.keys((await readYaml('shop/team-b/q/values.yaml')).common.common)).toEqual([C])
  })

  it('a folder with no deployment: just the _common', async () => {
    await fs.mkdir(abs('empty'))
    const shown = await make('empty')
    expect(shown.changes).toEqual([])
    expect(shown.files).toEqual([`empty/_common/${C}/Chart.yaml`, `empty/_common/${C}/charts/${C}`, `empty/_common/${C}/values.yaml`])
    const tree = (await api('GET', '/api/v2/folders/tree?path=empty/_common')).data
    expect(tree).toMatchObject([{ name: C, isCommon: true, chart: C }])
    await remove(`empty/_common/${C}`)
    expect(await fs.readdir(abs('empty'))).toEqual([])
  })

  it('a sync source: its target, wherever it is, is re-attached with it; a target is not re-attached by itself', async () => {
    await shop()
    await direct('cart/prod', { ...empty })
    await direct('other/src', { _common: { owner: 'o', namespace: 'o' }, ...empty, [CPU]: [{ warn_pct: 1, critical_pct: 2 }] })
    await direct('shop/t', { ...empty })
    expect((await api('POST', '/api/v2/sync', { source: 'shop/prod', target: 'cart/prod' })).status).toBe(200)
    expect((await api('POST', '/api/v2/sync', { source: 'other/src', target: 'shop/t' })).status).toBe(200)
    const rels = ['shop/prod', 'cart/prod', 'shop/t', 'other/src']
    const before = await renderAll(rels)
    expect(counts(before)).toEqual({ 'shop/prod': 2, 'cart/prod': 2, 'shop/t': 2, 'other/src': 2 })
    const shown = await make('shop')
    expect(shown.changes.find(c => c.path === 'cart/prod')).toMatchObject({ change: 'attached', syncedFrom: 'shop/prod' })
    expect(shown.untouched).toEqual([{ path: 'shop/t', why: 'it is synced from other/src and follows that deployment\'s _common', syncedFrom: 'other/src' }])
    expect(await renderAll(rels)).toEqual(before)
    expect((await readYaml('cart/prod/Chart.yaml')).dependencies).toEqual([{ name: 'common', version: '>=0.0.0-0', repository: `file://../../shop/_common/${C}` }])
    expect(await read('cart/prod/values.yaml')).toBe(await read('shop/prod/values.yaml'))
    expect((await readYaml('shop/t/Chart.yaml')).dependencies[0].name).toBe(C)

    // A _common made in cart/ leaves its sync target as it is: it follows shop/prod.
    const cart = await make('cart')
    expect(cart.changes).toEqual([])
    expect(cart.untouched).toEqual([{ path: 'cart/prod', why: 'it is synced from shop/prod and follows that deployment\'s _common', syncedFrom: 'shop/prod' }])
    expect(await renderAll(rels)).toEqual(before)
  })

  it('a deployment with a dependency AlertForge cannot move refuses it all, naming it; nothing is written', async () => {
    await shop()
    await direct('shop/cond', { enabled: true, ...empty }, { condition: `${C}.enabled` })
    const files = await snapshot()
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    expect(shown.status).toBe(409)
    expect(shown.data.problems).toEqual([{ path: 'shop/cond', message: `cannot be re-attached: its dependency on ${C} has a condition or tags` }])
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: {} })).status).toBe(409)
    expect(await snapshot()).toEqual(files)
  })

  it('refuses a second one, one in a deployment or in a _common, and a repo that changed since the list', async () => {
    await shop()
    expect((await plan({ action: 'create', folder: 'shop/prod', chart: C })).data.error).toMatch(/shop\/prod is a deployment/)
    expect((await plan({ action: 'create', folder: 'shop', chart: 'nope' })).status).toBe(400)
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    await direct('shop/new', { ...empty })
    const stale = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: shown.data.expected })
    expect(stale.status).toBe(409)
    expect(stale.data.plan.files).toContain('shop/new/values.yaml')
    await make('shop')
    expect((await plan({ action: 'create', folder: 'shop', chart: C })).status).toBe(409)
    expect((await plan({ action: 'create', folder: SHOP, chart: C })).data.error).toMatch(/inside the _common chart/)
  })

  it('a file that cannot be written puts everything back, and is named by its path in the repo', async () => {
    await shop()
    const files = await snapshot()
    await fs.chmod(abs('shop/stg/Chart.yaml'), 0o444)
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    const done = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: shown.data.expected })
    expect(done.status).toBe(500)
    expect(done.data.error).toMatch(/^shop\/stg\/Chart\.yaml could not be written \(EACCES\): nothing was changed$/)
    expect(done.data.error).not.toContain(tmpDir)
    await fs.chmod(abs('shop/stg/Chart.yaml'), 0o644)
    expect(await snapshot()).toEqual(files)
  })
})

describe.skipIf(!HAS_HELM)('editing a _common', { timeout: 60000 }, () => {
  it('is saved with the same checks as a deployment, and its deployments render what it gives', async () => {
    await shop()
    await make('shop')
    // A required owner left to the deployments is not refused here.
    const saved = await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: { ...empty, [CPU]: [{ warn_pct: 65, critical_pct: 85 }] } })
    expect(saved.status, JSON.stringify(saved.data)).toBe(200)
    expect(await readYaml(`${SHOP}/values.yaml`)).toEqual({ [C]: { ...empty, [CPU]: [{ warn_pct: 65, critical_pct: 85 }] } })
    const bad = await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: { _common: { owner: 'team"a' }, [CPU]: [{ warn_pct: 65, critical_pct: 85 }] } })
    expect(bad.status).toBe(400)
    const nulled = await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: `${C}:\n  ${CPU}: null\n` })
    expect(nulled.status).toBe(400)
    expect(nulled.data.error).toMatch(/null/)
    // prod and dev write their cpu ([]) and keep 2; stg had its own cpu row.
    expect(counts(await renderAll(Object.keys(SHOP_COUNTS)))).toEqual(SHOP_COUNTS)
    // Its page: who inherits, and how many rows each takes from it.
    const users = (await api('GET', `/api/v2/folders/common/users?path=${SHOP}`)).data
    expect(users.map(u => u.path)).toEqual(['shop/prod', 'shop/stg', 'shop/x/dev'])
    expect(users[0].groups[CPU]).toEqual({ from: 'own', rows: 0 })
    // Only what its page shows: who, how directly, and each group's rows and origin.
    expect(Object.keys(users[0]).sort()).toEqual(['direct', 'groups', 'path'])
    // A deployment that clears nothing of its own takes the _common's cpu row.
    await api('POST', `/api/v2/deployments/${C}/prod?folder=shop/prod`, { values: { _common: { owner: 'team-prod', namespace: 'p' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] } })
    expect((await api('GET', `/api/v2/folders/common/users?path=${SHOP}`)).data[0].groups[CPU]).toEqual({ from: SHOP, rows: 1 })
    expect(await helm('shop/prod')).toEqual([
      'MariadbSaturationCpu_CriticalPct team-prod p 85', 'MariadbSaturationCpu_WarnPct team-prod p 65',
      'MariadbSaturationDisk_CriticalPct team-prod p 92', 'MariadbSaturationDisk_WarnPct team-prod p 80',
    ])
  })
})

describe.skipIf(!HAS_HELM)('removing a _common', { timeout: 60000 }, () => {
  it('copies what each deployment inherited into it: it deploys what it did', async () => {
    await shop()
    await make('shop')
    await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: { _common: { owner: 'team-a', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] } })
    // stg writes nothing but its cpu now; prod overrides owner and disk.
    await api('POST', `/api/v2/deployments/${C}/stg?folder=shop/stg`, { values: { [CPU]: [{ warn_pct: 71, critical_pct: 91 }] } })
    await api('POST', `/api/v2/deployments/${C}/prod?folder=shop/prod`, { values: { _common: { owner: 'team-prod' }, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] } })
    const rels = ['shop/prod', 'shop/stg', 'shop/x/dev']
    const before = await renderAll(rels)
    expect(before['shop/stg']).toEqual([
      'MariadbSaturationCpu_CriticalPct team-a c1 91', 'MariadbSaturationCpu_WarnPct team-a c1 71',
      'MariadbSaturationDisk_CriticalPct team-a c1 95', 'MariadbSaturationDisk_WarnPct team-a c1 85',
    ])
    expect(before['shop/prod']).toEqual(['MariadbSaturationDisk_CriticalPct team-prod c1 92', 'MariadbSaturationDisk_WarnPct team-prod c1 80'])
    const shown = await remove(SHOP)
    expect(shown.changes.map(c => [c.path, c.change])).toEqual([['shop/prod', 'detached'], ['shop/stg', 'detached'], ['shop/x/dev', 'detached']])
    expect(shown.changes.find(c => c.path === 'shop/stg').copiedDown).toEqual(expect.arrayContaining(['_common', DISK]))
    expect(await renderAll(rels)).toEqual(before)
    expect(await fs.readdir(abs('shop'))).toEqual(['prod', 'stg', 'x'])
    expect((await readYaml('shop/stg/Chart.yaml')).dependencies).toEqual([{ name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}` }])
    expect(await readYaml('shop/prod/values.yaml')).toEqual({ [C]: { _common: { owner: 'team-prod', namespace: 'c1' }, ...empty, [DISK]: [{ warn_pct: 80, critical_pct: 92 }] } })
  })

  it('the upper of two levels: the lower one gets its values, the deployments on it one level less', async () => {
    await direct('shop/team-b/q', { _common: { owner: 'team-q', namespace: 'q' } })
    await make('shop')
    await make('shop/team-b')
    await api('POST', `/api/v2/deployments/${C}/${C}?folder=${SHOP}`, { values: { ...empty, [DISK]: [{ warn_pct: 85, critical_pct: 95 }] } })
    await api('POST', `/api/v2/deployments/${C}/q?folder=shop/team-b/q`, { values: { _common: { owner: 'team-q', namespace: 'q' } } })
    const before = await helm('shop/team-b/q')
    expect(before).toEqual(['MariadbSaturationDisk_CriticalPct team-q q 95', 'MariadbSaturationDisk_WarnPct team-q q 85'])
    const shown = await remove(SHOP)
    expect(shown.changes.map(c => [c.path, c.change])).toEqual([[TEAM_B, 'detached'], ['shop/team-b/q', 'rewrapped']])
    expect(await helm('shop/team-b/q')).toEqual(before)
    expect(await fs.readdir(abs(`${TEAM_B}/charts`))).toEqual([C])
    expect(await readYaml('shop/team-b/q/values.yaml')).toEqual({ common: { [C]: { _common: { owner: 'team-q', namespace: 'q' } } } })
  })

  it('a sync target of a deployment on it is detached with it', async () => {
    await shop()
    await direct('cart/prod', { ...empty })
    await api('POST', '/api/v2/sync', { source: 'shop/prod', target: 'cart/prod' })
    await make('shop')
    const before = await renderAll(['shop/prod', 'cart/prod'])
    const shown = await remove(SHOP)
    expect(shown.changes.find(c => c.path === 'cart/prod')).toMatchObject({ change: 'detached' })
    expect(await renderAll(['shop/prod', 'cart/prod'])).toEqual(before)
    expect((await readYaml('cart/prod/Chart.yaml')).dependencies[0]).toEqual({ name: C, version: '>=0.0.0-0', repository: `file://../../charts/${C}` })
  })
})
