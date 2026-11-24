// A write request whose body leaves out what it writes, or gives it as the
// wrong type, is refused and writes nothing: never an empty file, nor one
// that reads "undefined", "null" or "[object Object]".
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'

let server, baseURL, tmpDir

const CPU = `group: cpu
columns:
  namespace: {type: string, required: true}
rules:
  - alert: CpuHigh
    expr: cpu{ns="\${namespace}"} > 1
`
const DEP = 'deployments/team/a'
const OTHER = 'deployments/team/b'
const q = f => `?folder=${encodeURIComponent(f)}`
const ROUTING = 'labels:\n  severity: [critical]\nconfigs:\n  ops: {type: email, to: ops@example.com}\ncells:\n  - match: {severity: critical}\n    configs: [ops]\n'

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-routes-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpDir })
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const names = { charts: 'charts', templates: 'templates', deployments: 'deployments', folders: 'folders', sync: 'sync', 'routing/shared': 'routingShared' }
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const [at, file] of Object.entries(names)) app.use(`/api/v2/${at}`, (await import(`../../server/routes/${file}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  expect((await api('POST', '/api/v2/templates/demo/values', { values: { cpu: [] } })).status).toBe(200)
  for (const d of [DEP, OTHER]) expect((await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' })).status).toBe(200)
  expect((await api('POST', `/api/v2/deployments/demo/a${q(DEP)}`, { values: { cpu: [{ namespace: 'p' }] } })).status).toBe(200)
  expect((await api('PUT', `/api/v2/deployments/demo/a/routing${q(DEP)}`, { routing: ROUTING })).status).toBe(200)
  expect((await api('PUT', '/api/v2/routing/shared', { shared: 'configs:\n  team: {type: email, to: team@example.com}\n' })).status).toBe(200)
})

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text }
}

// Every file in the repo but .git, with its text.
async function snapshot() {
  const out = {}
  const walk = async rel => {
    for (const e of await fs.readdir(path.join(tmpDir, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = path.posix.join(rel, e.name)
      if (e.isDirectory()) await walk(p)
      else out[p] = await fs.readFile(path.join(tmpDir, p), 'utf-8')
    }
  }
  await walk('.')
  return out
}

const WRONG = [undefined, null, 5, true, [], ['x']]
const each = (field, values = WRONG) => values.map(v => (v === undefined ? {} : { [field]: v }))
const label = body => (Object.keys(body).length ? JSON.stringify(body) : 'no body field')

// [route, method, url, bodies]
const ROUTES = [
  ['a Template\'s values', 'POST', '/api/v2/templates/demo/values', each('values')],
  ['a Template\'s rules', 'POST', '/api/v2/templates/demo/rules', [...each('files'), { files: { 'cpu.yaml': null } }, { files: { 'cpu.yaml': 5 } }]],
  ['a Template\'s migration', 'POST', '/api/v2/templates/demo/rules', [{ files: { 'cpu.yaml': CPU.replace('namespace', 'ns').replace('namespace', 'ns') }, confirmBreaking: true, migration: 'x' }, { files: { 'cpu.yaml': CPU.replace('namespace', 'ns').replace('namespace', 'ns') }, confirmBreaking: true, migration: [] }]],
  ['a Template\'s Chart.yaml', 'POST', '/api/v2/templates/demo/chart-meta', [...each('chartMeta'), { chartMeta: { description: 5 } }]],
  ['a template file', 'POST', '/api/v2/templates/demo/cpu', [...each('content'), { content: { a: 1 } }]],
  ['a template file\'s name', 'POST', '/api/v2/templates/demo/cpu/rename', each('newName')],
  ['a deployment\'s values', 'POST', `/api/v2/deployments/demo/a${q(DEP)}`, each('values', [undefined, null, 5, true, [], ['x']])],
  ['a deployment\'s routing', 'PUT', `/api/v2/deployments/demo/a/routing${q(DEP)}`, each('routing')],
  ['a deployment\'s clone', 'POST', `/api/v2/deployments/demo/a/clone${q(DEP)}`, each('newName')],
  ['the shared configs', 'PUT', '/api/v2/routing/shared', [...each('shared'), { shared: { configs: [] } }, { shared: { configs: 5 } }]],
  ['a shared config\'s name', 'POST', '/api/v2/routing/shared/rename', [{}, { from: 'team' }, { from: 'team', to: 5 }, { from: 5, to: 'x' }]],
  ['a sync link', 'POST', '/api/v2/sync', [{}, { source: DEP }, { source: DEP, target: 5 }, { source: 5, target: OTHER }, { source: [], target: OTHER }, { source: DEP, target: {} }]],
  ['a sync link removed', 'DELETE', '/api/v2/sync', [{}, { target: 5 }, { target: [] }, { target: {} }]],
  ['a folder', 'POST', '/api/v2/folders', each('path')],
  ['a _common', 'POST', '/api/v2/folders/common', [{}, { action: 'create' }, { action: 'create', folder: 'deployments/team', chart: 'demo', expected: 5 }, { action: 'create', folder: 5, chart: 'demo', expected: {} }, { action: 'delete', path: 5, expected: {} }]],
  ['a deployment made', 'POST', '/api/v2/folders/init', [{}, { folder: 'deployments/team/c' }, { folder: 'deployments/team/c', chart: 5 }, { folder: 5, chart: 'demo' }, { folder: [], chart: 'demo' }]],
  ['a Template made', 'POST', '/api/v2/charts', each('name')],
  ['a Template cloned', 'POST', '/api/v2/charts/demo/clone', each('newName')],
]

describe.each(ROUTES)('%s', (_, method, url, bodies) => {
  it.each(bodies.map(b => [label(b), b]))('%s: refused, nothing written', async (__, body) => {
    const before = await snapshot()
    const { status, text } = await api(method, url, body)
    expect(status, text).toBeGreaterThanOrEqual(400)
    expect(status, text).toBeLessThan(500)
    expect(await snapshot()).toEqual(before)
  })
})
