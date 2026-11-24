// derived (#118) reading a Common Value: a row that leaves the cell out reads
// _common's, 0 included, as Helm's `merge $row $common` does — directly or
// through a _common stack. The save check computes the row the same way, so
// a 0 that would deploy as [0m] is refused, naming the row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync, execFile } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

const COMMON = 'columns:\n  base: {type: integer, default: 4}\n'
const SPC = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}

derived:
  w: {expr: "freq_num * base", unit: m}

rules:
  - alert: SpcErrors
    expr: rate(x{job="\${job}"}[\${w}]) > 0
    labels: {window: "\${w}"}
`
const DIRECT = 'deployments/team/spc'
const ON_STACK = 'deployments/shop/spc'
const LAYER = 'deployments/shop/_common/demo/values.yaml'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'derived-common-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routes = await Promise.all(['templates', 'deployments', 'folders'].map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  ;['templates', 'deployments', 'folders'].forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { '_common.yaml': COMMON, 'spc.yaml': SPC } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DIRECT, chart: 'demo' })).status).toBe(200)
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const q = f => `?folder=${encodeURIComponent(f)}`
const save = (folder, values) => api('POST', `/api/v2/deployments/demo/spc${q(folder)}`, { values })

async function makeStack() {
  await fs.mkdir(path.join(tmpDir, 'deployments/shop'), { recursive: true })
  const shown = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder: 'deployments/shop', chart: 'demo' })}`)
  expect(shown.status).toBe(200)
  expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/shop', chart: 'demo', expected: shown.data.expected })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: ON_STACK, chart: 'demo' })).status).toBe(200)
}
const layerKey = async () => Object.keys(yaml.load(await fs.readFile(path.join(tmpDir, LAYER), 'utf-8')) || {})[0] || 'demo'
const writeLayer = async common => fs.writeFile(path.join(tmpDir, LAYER), yaml.dump({ [await layerKey()]: { _common: common } }))

// What Helm puts in the window label, row by row, for a folder as it is on disk.
async function windows(folder) {
  const abs = path.join(tmpDir, folder)
  return yaml.loadAll(await renderChart(abs, ['template', 'spc', abs])).filter(d => d?.kind === 'PrometheusRule')
    .flatMap(d => d.spec.groups.flatMap(g => g.rules.map(r => r.labels.window)))
}

describe('a deployment whose Common Values give the cell', () => {
  it('0 there, the row leaving it out: the save is refused, naming the row', async () => {
    const { status, data } = await save(DIRECT, { _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }] })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toEqual(['spc row 1, derived "w": it comes to 0, and a range has to be more than 0'])
  })

  it('a row\'s own 0 under a Common Value of 5, and a row\'s own 2: saved', async () => {
    expect((await save(DIRECT, { _common: { base: 5 }, spc: [{ job: 'a', freq_num: 3, base: 0 }, { job: 'b', freq_num: 3, base: 2 }] })).status).toBe(200)
  })

  it.skipIf(!HAS_HELM)('Helm renders what the save check computed', async () => {
    // Refused above: written by hand, Helm renders it as 0.
    await fs.writeFile(path.join(tmpDir, DIRECT, 'values.yaml'), yaml.dump({ demo: { _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }] } }))
    expect(await windows(DIRECT)).toEqual(['0m'])
    // Saved above: the row's 0 takes the Common Value, its 2 stays.
    await fs.writeFile(path.join(tmpDir, DIRECT, 'values.yaml'), yaml.dump({ demo: { _common: { base: 5 }, spc: [{ job: 'a', freq_num: 3, base: 0 }, { job: 'b', freq_num: 3, base: 2 }, { job: 'c', freq_num: 3 }] } }))
    expect(await windows(DIRECT)).toEqual(['15m', '6m', '15m'])
    // No Common Values: the default.
    await fs.writeFile(path.join(tmpDir, DIRECT, 'values.yaml'), yaml.dump({ demo: { spc: [{ job: 'a', freq_num: 3 }] } }))
    expect(await windows(DIRECT)).toEqual(['12m'])
  })
})

describe('a deployment on a _common stack', () => {
  it('a layer giving 0: the deployment\'s save is refused, naming its row', async () => {
    await makeStack()
    await writeLayer({ base: 0 })
    const { status, data } = await save(ON_STACK, { spc: [{ job: 'a', freq_num: 3 }] })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toEqual(['spc row 1, derived "w": it comes to 0, and a range has to be more than 0'])
  })

  it('a layer giving 0 that the deployment\'s own Common Value replaces: saved', async () => {
    await makeStack()
    await writeLayer({ base: 0 })
    expect((await save(ON_STACK, { _common: { base: 2 }, spc: [{ job: 'a', freq_num: 3 }] })).status).toBe(200)
  })

  it.skipIf(!HAS_HELM)('Helm renders what the save check computed', async () => {
    await makeStack()
    await writeLayer({ base: 0 })
    const own = async values => fs.writeFile(path.join(tmpDir, ON_STACK, 'values.yaml'), yaml.dump({ common: { demo: values } }))
    const key = Object.keys(yaml.load(await fs.readFile(path.join(tmpDir, ON_STACK, 'values.yaml'), 'utf-8')) || {})
    expect(key).toEqual(['common'])
    await own({ spc: [{ job: 'a', freq_num: 3 }] })
    expect(await windows(ON_STACK)).toEqual(['0m'])
    await own({ _common: { base: 2 }, spc: [{ job: 'a', freq_num: 3 }] })
    expect(await windows(ON_STACK)).toEqual(['6m'])
  })
})

describe('the other ways in', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..')
  const genRules = () => new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'scripts/gen-rules.mjs'), 'charts/demo', '--check'], { cwd: tmpDir },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` })))

  it('gen-rules warns of the Template\'s own values.yaml whose Common Value of 0 makes a range of 0', async () => {
    await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), yaml.dump({ _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }] }))
    const { out } = await genRules()
    expect(out).toContain('warn   values.yaml: spc row 1, derived "w": it comes to 0, and a range has to be more than 0')
  })

  it.skipIf(!HAS_HELM)('which Helm renders as [0m]', async () => {
    await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), yaml.dump({ _common: { base: 0 }, spc: [{ job: 'a', freq_num: 3 }] }))
    const abs = path.join(tmpDir, 'charts/demo')
    const windows = yaml.loadAll(await renderChart(abs, ['template', 'demo', abs])).filter(d => d?.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups.flatMap(g => g.rules.map(r => r.labels.window)))
    expect(windows).toEqual(['0m'])
  })

  it('a page saving over a newer save is refused, and the newer one kept', async () => {
    const first = await save(DIRECT, { spc: [{ job: 'a', freq_num: 3 }] })
    expect(first.status).toBe(200)
    const newer = await api('POST', `/api/v2/deployments/demo/spc${q(DIRECT)}`, { values: { spc: [{ job: 'a', freq_num: 5 }] }, version: first.data.version })
    expect(newer.status).toBe(200)
    const stale = await api('POST', `/api/v2/deployments/demo/spc${q(DIRECT)}`, { values: { spc: [{ job: 'a', freq_num: 4 }] }, version: first.data.version })
    expect(stale.status).toBe(409)
    expect(yaml.load(await fs.readFile(path.join(tmpDir, DIRECT, 'values.yaml'), 'utf-8')).demo.spc).toEqual([{ job: 'a', freq_num: 5 }])
  })

  it('values text that is not YAML is a 400 saying so, nothing written', async () => {
    const before = await fs.readFile(path.join(tmpDir, DIRECT, 'values.yaml'), 'utf-8')
    const { status, data } = await save(DIRECT, 'demo:\n  spc: [\n')
    expect(status).toBe(400)
    expect(data.error).toBe('values.yaml is not valid YAML')
    expect(await fs.readFile(path.join(tmpDir, DIRECT, 'values.yaml'), 'utf-8')).toBe(before)
  })

  it('a rules file with a syntax error beside a derived value is a 400 naming the file, nothing written', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'charts/demo/rules/spc.yaml'), 'utf-8')
    const { status, data } = await api('POST', '/api/v2/templates/demo/rules', { files: { '_common.yaml': COMMON, 'spc.yaml': SPC.replace('rules:', 'rules: [') } })
    expect(status).toBe(400)
    expect(data.errors.join('\n')).toMatch(/^spc\.yaml/m)
    expect(await fs.readFile(path.join(tmpDir, 'charts/demo/rules/spc.yaml'), 'utf-8')).toBe(before)
  })
})

describe('a rules file edited by hand into one the parser refuses', () => {
  it('a derived unit not one of ours: a deployment save says why, not a 500', async () => {
    await fs.writeFile(path.join(tmpDir, 'charts/demo/rules/spc.yaml'), SPC.replace('unit: m', 'unit: q'))
    const { status, data } = await save(DIRECT, { spc: [{ job: 'a', freq_num: 3 }] })
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toEqual(['spc row 1, derived "w": its unit "q" is not one of ms, s, m, h, d, w, y — fix the rules file'])
  })
})

describe('a new deployment that could not deploy', () => {
  const IS_ROOT = process.getuid?.() === 0
  it.skipIf(IS_ROOT)('is not made when its Template\'s rules cannot be read, and the folder is left as it was', async () => {
    await fs.chmod(path.join(tmpDir, 'charts/demo/rules'), 0o000)
    try {
      const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/new', chart: 'demo' })
      expect(status).toBe(409)
      expect(data.error).toMatch(/Not made: deployments\/team\/new would not deploy .*charts\/demo\/rules/)
      await expect(fs.stat(path.join(tmpDir, 'deployments/team/new'))).rejects.toThrow()
    } finally {
      await fs.chmod(path.join(tmpDir, 'charts/demo/rules'), 0o755)
    }
  })

  it.skipIf(IS_ROOT)('leaves a folder that was there, with its own Chart.yaml, as it was', async () => {
    const dir = path.join(tmpDir, 'deployments/team/kept')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: kept\nversion: 0.1.0\n# mine\n')
    const tree = async () => {
      const out = {}
      const walk = async rel => {
        for (const e of await fs.readdir(path.join(tmpDir, rel), { withFileTypes: true })) {
          const r = path.join(rel, e.name)
          if (e.isDirectory()) await walk(r)
          else out[r] = await fs.readFile(path.join(tmpDir, r), 'utf-8').catch(() => '<unreadable>')
        }
      }
      await walk('deployments')
      return out
    }
    const before = await tree()
    await fs.chmod(path.join(tmpDir, 'charts/demo/rules'), 0o000)
    try {
      expect((await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/kept', chart: 'demo' })).status).toBe(409)
    } finally {
      await fs.chmod(path.join(tmpDir, 'charts/demo/rules'), 0o755)
    }
    expect(await tree()).toEqual(before)
  })

  it('is not made when the Template\'s values.yaml is not YAML, naming it', async () => {
    await fs.writeFile(path.join(tmpDir, 'charts/demo/values.yaml'), 'spc: [\n')
    const { status, data } = await api('POST', '/api/v2/folders/init', { folder: 'deployments/team/new', chart: 'demo' })
    expect(status).toBe(409)
    expect(data.file).toBe('charts/demo/values.yaml')
    await expect(fs.stat(path.join(tmpDir, 'deployments/team/new'))).rejects.toThrow()
  })
})
