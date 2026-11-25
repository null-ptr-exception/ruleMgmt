// Columns named valueOf and constructor, a derived value reading valueOf: a
// row that leaves them out is saved and has no rule; one that fills them in
// renders what it says. Expected values are what Helm renders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
let server, baseURL, tmpDir
const DEP = 'deployments/team/g'
const RULES = `columns:
  valueOf: {type: integer}
  b: {type: integer, required: true}
  constructor: {type: string}
derived:
  w: {expr: "valueOf * b", unit: m}
rules:
  - alert: A
    expr: rate(x{c="\${constructor}"}[\${w}]) > 0
`

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proto-names-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const routes = await Promise.all(['templates', 'deployments', 'folders'].map(n => import(`../../server/routes/${n}.js`)))
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  ;['templates', 'deployments', 'folders'].forEach((n, i) => app.use(`/api/v2/${n}`, routes[i].default()))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'g.yaml': RULES } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
})
afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})
async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: res.status, data: await res.json() }
}

describe.skipIf(!HAS_HELM)('names that are also Object.prototype\'s', () => {
  it('are saved and rendered as written', async () => {
    const save = await api('POST', `/api/v2/deployments/demo/g?folder=${encodeURIComponent(DEP)}`, { values: { g: [{ b: 2 }, { b: 2, valueOf: 3, constructor: 'x' }] } })
    expect(save.status, JSON.stringify(save.data)).toBe(200)
    const abs = path.join(tmpDir, DEP)
    const exprs = yaml.loadAll(await renderChart(abs, ['template', 'g', abs])).filter(d => d?.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups.flatMap(g => g.rules.map(r => r.expr)))
    expect(exprs).toEqual(['rate(x{c="x"}[6m]) > 0'])
  })
})
