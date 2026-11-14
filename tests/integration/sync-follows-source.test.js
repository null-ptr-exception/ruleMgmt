// A sync target is a copy of its source (#175): after every action that
// writes the source, the target's files are the same bytes, and the target
// renders the same alerts. The write paths are one table: values save,
// routing save and a breaking change; a new path is checked by adding a row.
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-follows-'))
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const { default: templatesRouter } = await import('../../server/routes/templates.js')
  const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
  const { default: foldersRouter } = await import('../../server/routes/folders.js')
  const { default: syncRouter } = await import('../../server/routes/sync.js')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  app.use('/api/v2/templates', templatesRouter())
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
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
const read = rel => fs.readFile(path.join(tmpDir, rel), 'utf-8')
const q = f => `?folder=${encodeURIComponent(f)}`

const withWarn = `group: cpu
columns:
  namespace: {type: string, required: true}
  warn: {type: number}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > \${warn}
`
// `warn` renamed to `threshold`: a breaking change.
const withThreshold = withWarn.replace(/warn/g, 'threshold')

const SRC = 'deployments/team/src'
const TGT = 'deployments/team/tgt'

beforeEach(async () => {
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': withWarn } })).status).toBe(200)
  expect((await api('POST', '/api/v2/folders/init', { folder: SRC, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn: 90 }] } })).status).toBe(200)
  expect((await api('POST', '/api/v2/sync', { source: SRC, target: TGT })).status).toBe(200)
})

// Every action that writes the source.
const writePaths = [
  ['saving the values', () => api('POST', `/api/v2/deployments/demo/src${q(SRC)}`, { values: { cpu: [{ namespace: 'p', warn: 70 }] } })],
  ['saving the routing', async () => {
    const routing = await fs.readFile(path.resolve('tests/fixtures/routing/basic/routing.yaml'), 'utf-8')
    return api('PUT', `/api/v2/deployments/demo/src/routing${q(SRC)}`, { routing })
  }],
  ['a breaking change with a mapping', () => api('POST', '/api/v2/templates/demo/rules', {
    files: { 'cpu.yaml': withThreshold }, confirmBreaking: true, migration: { columns: { cpu: { warn: 'threshold' } } },
  })],
]

async function filesOf(dir) {
  const out = {}
  for (const rel of ['values.yaml', 'routing.yaml', 'templates/alertmanagerconfig.yaml']) {
    out[rel] = await read(`${dir}/${rel}`).catch(() => null)
  }
  return out
}

describe('a sync target stays a copy of its source', () => {
  it.each(writePaths)('after %s', async (_, write) => {
    const { status } = await write()
    expect(status).toBe(200)
    expect(await filesOf(TGT)).toEqual(await filesOf(SRC))
  })

  it('a breaking change says the target was copied from its source', async () => {
    const { data } = await writePaths[2][1]()
    const tgt = data.migrated.find(d => d.path === TGT)
    expect(tgt).toMatchObject({ readonly: true, copiedFrom: SRC })
    expect(await read(`${TGT}/values.yaml`)).toContain('threshold: 90')
  })

  it('the preview counts the rows a target really ends up changing', async () => {
    // A target edited by hand, out of step with its source: no `warn` left.
    await fs.writeFile(path.join(tmpDir, TGT, 'values.yaml'), 'demo:\n  cpu:\n    - namespace: q\n')
    const { data } = await api('POST', '/api/v2/templates/demo/migration-preview', {
      files: { 'cpu.yaml': withThreshold }, migration: { columns: { cpu: { warn: 'threshold' } } },
    })
    // It gets the source's row in place of its own, so that row changes.
    expect(data.deployments.find(d => d.path === TGT)).toMatchObject({ copiedFrom: SRC, rowsChanged: 1 })
  })

  // What gets deployed: the target renders the alert the source does.
  it.skipIf(!HAS_HELM)('after a breaking change the target renders the same alerts as the source', async () => {
    await writePaths[2][1]()
    const exprs = async dir => {
      const abs = path.join(tmpDir, dir)
      const out = await renderChart(abs, ['template', path.basename(dir), abs])
      return yaml.loadAll(out).filter(d => d?.kind === 'PrometheusRule')
        .flatMap(d => d.spec.groups.flatMap(g => (g.rules || []).map(r => `${r.alert}: ${r.expr}`)))
    }
    const src = await exprs(SRC)
    expect(src).toEqual(['CpuHigh: cpu{ns="p"} > 90'])
    expect(await exprs(TGT)).toEqual(src)
  })
})
