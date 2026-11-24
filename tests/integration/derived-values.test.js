// derived (#118) end to end: a deployment save refuses a row whose value
// would deploy wrong, Helm refuses a decimal in an integer column, and what
// AlertForge computes for a row is what Helm renders for it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import yaml from 'js-yaml'
import { renderChart } from '../../server/lib/ruleCheck.js'
import { parseDerived, evalDerived } from '../../src/utils/derived.js'

const HAS_HELM = (() => { try { execFileSync(process.env.HELM_BIN || 'helm', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

let server, baseURL, tmpDir

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'derived-values-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'spc.yaml': SPC } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' })).status).toBe(200)
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
const DEP = 'deployments/team/spc'
const save = rows => api('POST', `/api/v2/deployments/demo/spc${q(DEP)}`, { values: { spc: rows } })

const EXPR = 'freq_num * (spc_point - 3) + 1'
const SPC = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}
  spc_point: {type: integer, default: 3}

derived:
  w: {expr: "${EXPR}", unit: m}

rules:
  - alert: SpcErrors
    expr: rate(spc_errors_total{job="\${job}"}[\${w}]) > 0
    labels: {severity: warning, window: "\${w}"}
`

describe('saving a deployment', () => {
  it('a row whose range comes to 0 is refused, naming the row', async () => {
    // 1 * (2 - 3) + 1 = 0
    const { status, data } = await save([{ job: 'a', freq_num: 2, spc_point: 4 }, { job: 'b', freq_num: 1, spc_point: 2 }])
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toEqual(['spc row 2, derived "w": it comes to 0, and a range has to be more than 0'])
  })

  it('a row whose value overflows is refused', async () => {
    const { status, data } = await save([{ job: 'a', freq_num: 9007199254740991, spc_point: 9007199254740991 }])
    expect(status).toBe(400)
    expect(data.problems.map(p => p.message)).toEqual(['spc row 1, derived "w": the result is past what a 64-bit integer holds'])
  })

  it('rows that come to a usable range are saved', async () => {
    expect((await save([{ job: 'a', freq_num: 2, spc_point: 5 }, { job: 'b', freq_num: 4 }])).status).toBe(200)
  })
})

describe.skipIf(!HAS_HELM)('what Helm renders', () => {
  const render = async rows => {
    await fs.writeFile(path.join(tmpDir, DEP, 'values.yaml'), yaml.dump({ demo: { spc: rows } }))
    const abs = path.join(tmpDir, DEP)
    return renderChart(abs, ['template', 'spc', abs])
  }

  it('refuses a decimal in an integer column, by the schema', async () => {
    await expect(render([{ job: 'a', freq_num: 2.5 }])).rejects.toThrow(/freq_num|integer/)
  })

  // The same rows, computed here and by Helm: what a save checks and Preview
  // shows is what deploys.
  it('is what AlertForge computes, row by row', async () => {
    const rows = [
      { job: 'a', freq_num: 2, spc_point: 5 },
      { job: 'b', freq_num: 7 },
      { job: 'c', freq_num: 1000000, spc_point: 1000003 },
      { job: 'd', freq_num: 0, spc_point: 9 },
      { job: 'e', freq_num: 3037000499, spc_point: 3037000502 },
    ]
    const out = await render(rows)
    const rendered = yaml.loadAll(out).filter(d => d?.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups.flatMap(g => g.rules.map(r => r.labels.window)))
    const tree = parseDerived(EXPR)
    const computed = rows.map(r => `${evalDerived(tree, { freq_num: r.freq_num, spc_point: r.spc_point ?? 3 }).value}m`)
    expect(rendered).toEqual(computed)
  })
})

describe.skipIf(!HAS_HELM)('the issue\'s example, rendered by Helm', () => {
  const EXAMPLE = `group: spc
columns:
  job: {type: string, required: true}
  freq_num: {type: integer, required: true}
  spc_point: {type: integer}

derived:
  short_w: {expr: "freq_num * (spc_point + 2)", unit: m}
  long_w: {expr: "freq_num * spc_point * 4", unit: m}

rules:
  - alert: SpcCustom
    expr: rate(x{job="\${job}"}[\${short_w}]) > 2 * rate(x{job="\${job}"}[\${long_w}])
`
  it('3 and 5 give [21m] and [60m]; a row that leaves spc_point out has no rule', async () => {
    // The chart already has a deployment: a new rules file is a breaking change.
    expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'spc.yaml': EXAMPLE }, confirmBreaking: true, migration: { columns: {} } })).status).toBe(200)
    await fs.writeFile(path.join(tmpDir, DEP, 'values.yaml'), yaml.dump({ demo: { spc: [{ job: 'a', freq_num: 3, spc_point: 5 }, { job: 'b', freq_num: 3 }] } }))
    const abs = path.join(tmpDir, DEP)
    const exprs = yaml.loadAll(await renderChart(abs, ['template', 'spc', abs])).filter(d => d?.kind === 'PrometheusRule')
      .flatMap(d => d.spec.groups.flatMap(g => g.rules.map(r => r.expr)))
    expect(exprs).toEqual(['rate(x{job="a"}[21m]) > 2 * rate(x{job="a"}[60m])'])
  })
})
