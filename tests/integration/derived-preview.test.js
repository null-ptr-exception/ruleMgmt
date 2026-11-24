// Preview's table of derived values (#118): each row's value is the one Helm
// renders for it — the row, its Common Values (the deployment's, a
// _common folder's, the Template's values.yaml), then the default.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

const COMMON = 'columns:\n  base: {type: integer, default: 4}\n'
const SPC = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}
  extra: {type: integer}

derived:
  w: {expr: "freq_num * base", unit: m}
  x: {expr: "freq_num + extra", unit: s}

rules:
  - alert: Wide
    expr: rate(x{job="\${job}"}[\${w}]) > 0
    labels: {window: "\${w}"}
  - alert: Extra
    expr: rate(x{job="\${job}"}[\${x}]) > 0
    labels: {window: "\${x}"}
`
const DIRECT = 'deployments/team/spc'
const ON_STACK = 'deployments/shop/spc'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'derived-preview-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const names = ['templates', 'deployments', 'folders', 'render']
  const routes = await Promise.all(names.map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  names.forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
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
const preview = folder => api('POST', `/api/v2/render/demo/spc${q(folder)}`)

// What Helm rendered, per alert: the job and the window label, in row order.
function rendered(output) {
  const out = { Wide: {}, Extra: {} }
  for (const d of yaml.loadAll(output).filter(d => d?.kind === 'PrometheusRule')) {
    for (const g of d.spec.groups) for (const r of g.rules) out[r.alert][/job="([^"]+)"/.exec(r.expr)[1]] = r.labels.window
  }
  return out
}
// The same, from the summary's table: the value of each row Helm renders.
function shown(summary) {
  const table = summary.groups.find(g => g.valuesKey === 'spc').derived
  const out = { Wide: {}, Extra: {} }
  for (const r of table.rows) {
    const job = /job=([^,]+)/.exec(r.label)[1]
    if (r.values.w.value) out.Wide[job] = `${r.values.w.value}${r.values.w.unit}`
    if (r.values.x.value) out.Extra[job] = `${r.values.x.value}${r.values.x.unit}`
  }
  return { out, table }
}

describe.skipIf(!HAS_HELM)('Preview\'s derived values are what Helm renders', () => {
  it('the row, the deployment\'s Common Value (its 0 replaced), the default, and a row left out', async () => {
    const values = { _common: { base: 5 }, spc: [{ job: 'a', freq_num: 3 }, { job: 'b', freq_num: 3, base: 0 }, { job: 'c', freq_num: 2, base: 2, extra: 7 }] }
    expect((await api('POST', `/api/v2/deployments/demo/spc${q(DIRECT)}`, { values })).status).toBe(200)
    const { data } = await preview(DIRECT)
    expect(data.ok).toBe(true)
    const { out, table } = shown(data.summary)
    expect(out).toEqual(rendered(data.output))
    expect(out).toEqual({ Wide: { a: '15m', b: '15m', c: '4m' }, Extra: { c: '9s' } })
    expect(table.names).toEqual(['w', 'x'])
    expect(table.rows.map(r => r.values.x)).toEqual([{ omitted: true }, { omitted: true }, { value: '9', unit: 's' }])
  })

  it('the Template\'s own Common Value of 0: shown as the problem it is, and Helm renders [0m]', async () => {
    expect((await api('POST', '/api/v2/templates/demo/values', { values: { _common: { base: 0 }, spc: [] } })).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, DIRECT, 'values.yaml'), yaml.dump({ demo: { spc: [{ job: 'a', freq_num: 3 }] } }))
    const { data } = await preview(DIRECT)
    expect(rendered(data.output).Wide).toEqual({ a: '0m' })
    expect(shown(data.summary).table.rows[0].values.w).toEqual({ problem: 'it comes to 0, and a range has to be more than 0' })
  })

  it('on a _common stack: what the layer gives', async () => {
    expect((await api('POST', '/api/v2/folders', { path: 'deployments/shop' })).status).toBe(200)
    const plan = await api('GET', `/api/v2/folders/common/plan?${new URLSearchParams({ action: 'create', folder: 'deployments/shop', chart: 'demo' })}`)
    expect((await api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/shop', chart: 'demo', expected: plan.data.expected })).status).toBe(200)
    expect((await api('POST', '/api/v2/folders/init', { folder: ON_STACK, chart: 'demo' })).status).toBe(200)
    const layer = path.join(tmpDir, 'deployments/shop/_common/demo/values.yaml')
    const key = Object.keys(yaml.load(await fs.readFile(layer, 'utf-8')) || {})[0] || 'demo'
    await fs.writeFile(layer, yaml.dump({ [key]: { _common: { base: 7 } } }))
    expect((await api('POST', `/api/v2/deployments/demo/spc${q(ON_STACK)}`, { values: { spc: [{ job: 'a', freq_num: 3 }] } })).status).toBe(200)
    const { data } = await preview(ON_STACK)
    const { out } = shown(data.summary)
    expect(out).toEqual(rendered(data.output))
    expect(out.Wide).toEqual({ a: '21m' })
  })
})
