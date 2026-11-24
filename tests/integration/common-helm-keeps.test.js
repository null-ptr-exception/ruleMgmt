// Making and removing a _common keeps what Helm deploys, as Helm reads the
// files (#101): YAML 1.1, where `010` is 8 and `on` is true. Values are moved
// as written, never parsed and written again; a create and a remove give back
// the same bytes; every deployment touched is rendered with the real helm
// before and after, and one Helm cannot render, or renders otherwise, stops
// the change. Run with HELM_BIN set to each Helm version.
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

const MADE = (rel, dep = `file://../../charts/${C}`) => `apiVersion: v2\nname: ${path.basename(rel)}\nversion: 0.1.0\ndependencies:\n  - name: ${C}\n    version: ">=0.0.0-0"\n    repository: ${dep}\n`
async function byHand(rel, valuesText, chartText = MADE(rel)) {
  await write(`${rel}/Chart.yaml`, chartText)
  if (valuesText !== undefined) await write(`${rel}/values.yaml`, valuesText)
}
const files = async rels => Object.fromEntries(await Promise.all(rels.flatMap(r => [`${r}/values.yaml`, `${r}/Chart.yaml`]).map(async f => [f, await read(f).catch(() => null)])))

describe.skipIf(!HAS_HELM)('what Helm deploys, as Helm reads it', { timeout: 120000 }, () => {
  it('numbers YAML 1.1 reads otherwise stay as written, and deploy the same', async () => {
    await byHand('shop/oct', `${C}:\n  ${CPU}:\n    - warn_pct: 010\n      critical_pct: 90\n`)
    await byHand('shop/und', `${C}:\n  ${CPU}:\n    - warn_pct: 1_0\n      critical_pct: 90\n`)
    const rels = ['shop/oct', 'shop/und']
    const before = await renderAll(rels)
    // As Helm reads them: 010 is 8, 1_0 is 10.
    expect(before['shop/oct']).toContain('MariadbSaturationCpu_WarnPct sample-team default 8')
    expect(before['shop/und']).toContain('MariadbSaturationCpu_WarnPct sample-team default 10')
    await make('shop')
    expect(await renderAll(rels)).toEqual(before)
    expect(await read('shop/oct/values.yaml')).toMatch(/^common:\n {2}mariadb-alerts:\n {4}mariadb_saturation_cpu:\n {6}- warn_pct: 010\n/)
    expect(await read('shop/und/values.yaml')).toContain('warn_pct: 1_0')
  })

  it('a deployment Helm cannot render, or whose values are not a map of YAML, stops it: named, nothing written', async () => {
    await byHand('shop/ok', `${C}:\n  ${CPU}: []\n`)
    await byHand('shop/on', `${C}:\n  _common:\n    owner: on\n    namespace: ns\n  ${CPU}:\n    - {warn_pct: 1, critical_pct: 2}\n`)
    // 1:10 is text to Helm, where the schema wants a number.
    await byHand('shop/sexa', `${C}:\n  ${CPU}:\n    - warn_pct: 1:10\n      critical_pct: 90\n`)
    await byHand('shop/broken', `${C}:\n  _common: {owner: team-b, namespace: prod}\n  ${DISK}: [ {warn_pct: 3, critical_pct: 4}\n`)
    await byHand('shop/list', '- a\n- b\n')
    await byHand('shop/pinned', `${C}:\n  ${CPU}: []\n`, MADE('shop/pinned').replace('">=0.0.0-0"', '2.0.0'))
    const was = await snapshot()
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    expect(shown.status).toBe(409)
    // Each named once or more: all that stops it, at once.
    const said = {}
    for (const p of shown.data.problems) said[p.path] = said[p.path] ? `${said[p.path]}\n${p.message}` : p.message
    expect(Object.keys(said).sort()).toEqual(['shop/broken', 'shop/list', 'shop/on', 'shop/pinned', 'shop/sexa'])
    // owner: on is true to Helm, which its schema refuses.
    expect(said['shop/on']).toMatch(/^Helm cannot render it as it is \(.+\): fix it first$/m)
    expect(said['shop/sexa']).toMatch(/^Helm cannot render it as it is/)
    expect(said['shop/broken']).toMatch(/^values\.yaml is not valid YAML/m)
    expect(said['shop/list']).toMatch(/^values\.yaml does not hold a map at its top level$/m)
    expect(said['shop/pinned']).toMatch(/asks for version "2\.0\.0"/)
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: {} })).status).toBe(409)
    expect(await snapshot()).toEqual(was)
  })

  it('a file with no values (comments only) deploys the example rows, before and after', async () => {
    await byHand('shop/none', '# nothing here yet\n')
    const before = await renderAll(['shop/none'])
    expect(before['shop/none']).toHaveLength(20)
    await make('shop')
    expect(await renderAll(['shop/none'])).toEqual(before)
    expect(await read('shop/none/values.yaml')).toMatch(/^# nothing here yet\ncommon:\n {2}mariadb-alerts:\n {4}mariadb_latency_slow_queries:\n/)
  })

  it('a create and a remove give back every file byte for byte', async () => {
    const hand = [
      '# prod: kept as written',
      'global:',
      '  region: eu   # not the Template\'s',
      `${C}:`,
      '  # who gets paged',
      '  _common: { owner: team-a, namespace: "prod" }',
      ...groups.filter(g => g !== CPU && g !== DISK).map(g => `  ${g}: []`),
      `  ${CPU}: &cpu`,
      '    - {warn_pct: 070, critical_pct: 90}   # octal to Helm',
      `  ${DISK}:`,
      '    - warn_pct: 80',
      '      critical_pct: 9_0',
      'extra: *cpu',
      '',
    ].join('\n')
    await byHand('shop/prod', hand, MADE('shop/prod', '"file://../../charts/mariadb-alerts"').replace('name: prod', 'name: prod # the folder'))
    await byHand('shop/x/dev', `${C}:\n${groups.map(g => `  ${g}: []`).join('\n')}\n`, MADE('shop/x/dev', `file://../../../charts/${C}`))
    const rels = ['shop/prod', 'shop/x/dev']
    const was = await files(rels)
    const before = await renderAll(rels)
    await make('shop')
    expect(await renderAll(rels)).toEqual(before)
    expect((await read('shop/prod/Chart.yaml'))).toContain('name: common\n    version: ">=0.0.0-0"\n    repository: "file://../_common/mariadb-alerts"')
    await remove(SHOP)
    expect(await renderAll(rels)).toEqual(before)
    expect(await files(rels)).toEqual(was)
  })

  it('what Helm renders differently after the change is put back, naming the deployment', async () => {
    // A deployment with a template of its own that reads its top-level keys:
    // moving its values under common: changes what it renders.
    await byHand('shop/prod', `${C}:\n${groups.map(g => `  ${g}: []`).join('\n')}\n`)
    await byHand('shop/own', `${C}:\n${groups.map(g => `  ${g}: []`).join('\n')}\n`)
    await write('shop/own/templates/keys.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: keys\ndata:\n  keys: {{ keys .Values | sortAlpha | join "," | quote }}\n')
    const was = await snapshot()
    const shown = await plan({ action: 'create', folder: 'shop', chart: C })
    expect(shown.status).toBe(200)
    const done = await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'shop', chart: C, expected: shown.data.expected })
    expect(done.status).toBe(500)
    expect(done.data.error).toBe('Not changed: shop/own would no longer deploy what it does, so everything was put back')
    expect(done.data.differs).toEqual([{ path: 'shop/own', why: 'Helm renders other objects' }])
    expect(await snapshot()).toEqual(was)
  })

  it('with no helm to run, the values AlertForge works out are compared, and the plan says so', async () => {
    await byHand('shop/prod', `${C}:\n${groups.map(g => `  ${g}: []`).join('\n')}\n`)
    const bin = process.env.HELM_BIN
    process.env.HELM_BIN = path.join(tmpDir, 'no-helm-here')
    try {
      const shown = await plan({ action: 'create', folder: 'shop', chart: C })
      expect(shown.data.checkedWith).toBe('values')
    } finally {
      if (bin === undefined) delete process.env.HELM_BIN
      else process.env.HELM_BIN = bin
    }
    expect((await plan({ action: 'create', folder: 'shop', chart: C })).data.checkedWith).toBe('helm')
  })
})
