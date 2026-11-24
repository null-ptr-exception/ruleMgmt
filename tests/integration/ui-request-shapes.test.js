// Every request the pages send to the deployments, folders, sync, render and
// shared-configs routes, built as src/utils/chartApi.js builds it (optional
// fields left out, a version the page has none of left out, a body of '{}'):
// none is refused for its shape. A route that declares its request
// (server/http/route.js) more strictly than a page sends it is a bug.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import express from 'express'
import { parseRouting, toSave } from '../../src/utils/routingModel.js'
import { pruneAllValues } from '../../src/utils/valueUtils.js'
import { jsonBody } from '../../server/http/body.js'

let server, baseURL, tmpDir

const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'
const ROUTING = 'labels:\n  severity: [critical]\nconfigs:\n  ops: {type: email, to: ops@example.com}\ncells:\n  - match: {severity: critical}\n    configs: [ops]\n'
const DEP = 'deployments/team/a'
const OTHER = 'deployments/team/b'
const enc = encodeURIComponent
const q = f => (f ? `?folder=${enc(f)}` : '')

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-shapes-'))
  execFileSync('git', ['init', '-q'], { cwd: tmpDir })
  await fs.mkdir(path.join(tmpDir, 'charts', 'demo'), { recursive: true })
  const names = { charts: 'charts', templates: 'templates', deployments: 'deployments', folders: 'folders', sync: 'sync', 'routing/shared': 'routingShared', render: 'render' }
  const app = express()
  app.use(jsonBody())
  app.use((req, res, next) => { req.gitopsDir = tmpDir; next() })
  for (const [at, file] of Object.entries(names)) app.use(`/api/v2/${at}`, (await import(`../../server/routes/${file}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  expect((await api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } })).status).toBe(200)
  await fs.writeFile(path.join(tmpDir, 'charts', 'demo', 'values.yaml'), 'cpu: []\n')
}, 60_000)

afterAll(async () => {
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

// As chartApi.js sends it: a JSON body only where it sends one, and as it
// writes it (a string body as is: render's '{}').
async function api(method, urlPath, body) {
  const res = await fetch(`${baseURL}${urlPath}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

const notRefused = r => expect(r.status, r.text).toBeLessThan(400)

describe('the requests the pages send are taken', () => {
  it('a new deployment, as AlertUserView makes one (initDeploymentFolder)', async () => {
    for (const d of [DEP, OTHER]) notRefused(await api('POST', '/api/v2/folders/init', { folder: d, chart: 'demo' }))
  })

  it('a deployment opened, saved with and without the version it was loaded with, rendered (getDeployment, saveDeployment, renderDeployment)', async () => {
    const opened = await api('GET', `/api/v2/deployments/demo/a${q(DEP)}`)
    notRefused(opened)
    const values = pruneAllValues({ cpu: [{ namespace: 'p' }], _common: {} }, null)
    // saveDeployment leaves a version out when the page has none (null).
    for (const version of [opened.json.version, null]) {
      notRefused(await api('POST', `/api/v2/deployments/demo/a${q(DEP)}`, { values, ...(version ? { version } : {}) }))
    }
    notRefused(await api('POST', `/api/v2/render/demo/a${q(DEP)}`, '{}'))
  })

  it('routing saved as the table writes it and as its text, read, removed (saveRouting, getRouting, removeRouting)', async () => {
    const url = `/api/v2/deployments/demo/a/routing?folder=${enc(DEP)}`
    notRefused(await api('PUT', url, { routing: ROUTING }))
    notRefused(await api('PUT', url, { routing: toSave(parseRouting(ROUTING)) }))
    notRefused(await api('GET', url))
    notRefused(await api('DELETE', url))
  })

  it('the tree, the flat list with and without a Template (getFolderTree, listAllDeployments)', async () => {
    notRefused(await api('GET', '/api/v2/folders/tree'))
    notRefused(await api('GET', `/api/v2/folders/tree?path=${enc('deployments/team')}`))
    notRefused(await api('GET', '/api/v2/folders/deployments'))
    notRefused(await api('GET', '/api/v2/folders/deployments?chart=demo'))
  })

  it('sync made, asked about, let go (createSync, getSyncRegistry, getSyncSource, unlinkSync)', async () => {
    notRefused(await api('POST', '/api/v2/sync', { source: DEP, target: OTHER }))
    notRefused(await api('GET', '/api/v2/sync'))
    notRefused(await api('GET', `/api/v2/sync?target=${enc(OTHER)}`))
    notRefused(await api('DELETE', '/api/v2/sync', { target: OTHER }))
  })

  it('a _common planned, made, looked at, planned for removal and removed (getCommonPlan, applyCommon, getCommonUsers)', async () => {
    // CommonModal's two queries, sent as getCommonPlan writes them.
    const asQuery = o => Object.entries(o).map(([k, v]) => `${k}=${enc(v)}`).join('&')
    const create = { action: 'create', folder: 'deployments/team', chart: 'demo' }
    const plan = await api('GET', `/api/v2/folders/common/plan?${asQuery(create)}`)
    notRefused(plan)
    notRefused(await api('POST', '/api/v2/folders/common', { ...create, expected: plan.json.expected }))
    const commonPath = 'deployments/team/_common/demo'
    notRefused(await api('GET', `/api/v2/folders/common/users?path=${enc(commonPath)}`))
    const del = { action: 'delete', path: commonPath }
    const delPlan = await api('GET', `/api/v2/folders/common/plan?${asQuery(del)}`)
    notRefused(delPlan)
    notRefused(await api('POST', '/api/v2/folders/common', { ...del, expected: delPlan.json.expected }))
  })

  it('the shared configs read, saved as { configs }, renamed, made again (SharedConfigs)', async () => {
    notRefused(await api('GET', '/api/v2/routing/shared'))
    notRefused(await api('PUT', '/api/v2/routing/shared', { shared: { configs: { team: { type: 'email', to: 'team@example.com' } } } }))
    notRefused(await api('POST', '/api/v2/routing/shared/rename', { from: 'team', to: 'crew' }))
    // regenerateShared sends no body.
    notRefused(await api('POST', '/api/v2/routing/shared/regenerate'))
  })

  it('a deployment deleted (deleteDeployment)', async () => {
    notRefused(await api('DELETE', `/api/v2/deployments/demo/b${q(OTHER)}`))
  })
})

// What no page sends: refused before anything is read or written, naming
// the field (server/http/route.js).
describe('a request of another shape is refused naming the field', () => {
  it.each([
    ['a version that is no text', 'POST', `/api/v2/deployments/demo/a?folder=${enc(DEP)}`, { values: {}, version: 5 }, 'version must be text'],
    ['values that are a list', 'POST', `/api/v2/deployments/demo/a?folder=${enc(DEP)}`, { values: [] }, 'values must be the text of values.yaml, or the values as a map'],
    ['routing that is a list', 'PUT', `/api/v2/deployments/demo/a/routing?folder=${enc(DEP)}`, { routing: [] }, 'routing must be the text of routing.yaml, or its table'],
    ['a _common\'s Template that is no text', 'POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/team', chart: 5, expected: {} }, 'chart must be text'],
    ['a _common\'s path that is a list', 'POST', '/api/v2/folders/common', { action: 'delete', path: ['deployments/team/_common/demo'], expected: {} }, 'path must be text'],
    ['a sync source that is no text', 'POST', '/api/v2/sync', { source: 5, target: OTHER }, 'source must be text: a deployment\'s folder'],
    ['a sync target asked for twice', 'GET', `/api/v2/sync?target=${enc(OTHER)}&target=x`, undefined, 'query parameter target must be text'],
    ['a shared config renamed from no name', 'POST', '/api/v2/routing/shared/rename', { from: '', to: 'crew' }, 'from cannot be empty'],
    ['values nested 16000 levels deep', 'POST', `/api/v2/deployments/demo/a?folder=${enc(DEP)}`, `{"values":${'{"a":'.repeat(16000)}1${'}'.repeat(16000)}}`, 'The request body is nested too deeply: values.a goes more than 256 levels deep'],
    ['a _common\'s folder that is a list', 'POST', '/api/v2/folders/common', { action: 'create', folder: [], chart: 'demo', expected: {} }, 'folder must be text'],
    ['a rename from a list', 'POST', '/api/v2/routing/shared/rename', { from: [], to: 'crew' }, 'from must be text'],
    ['a folder given twice', 'GET', `/api/v2/deployments/demo/a?folder=${enc(DEP)}&folder=x`, undefined, 'Invalid folder path: a path is text'],
  ])('%s', async (_, method, url, body, error) => {
    expect(await api(method, url, body)).toMatchObject({ status: 400, json: { error } })
  })
})

describe('a legacy deployment folder that leads out of the repo', () => {
  it('is not rendered: refused as the deployment routes refuse it', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-shapes-outside-'))
    try {
      await fs.symlink(outside, path.join(tmpDir, 'deployments', 'outchart'))
      const r = await api('POST', '/api/v2/render/outchart/x', '{}')
      expect(r).toMatchObject({ status: 400, json: { error: 'deployments/outchart: it leads outside the repo' } })
      expect(r.text).not.toContain(outside)
    } finally {
      await fs.rm(path.join(tmpDir, 'deployments', 'outchart'), { force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

// A map's key named __proto__ (JSON.parse keeps it as a key of its own)
// would be dropped by the schema without a word, and the rest written:
// refused, naming it. constructor and prototype are keys like any other.
describe('a map with a key named __proto__', () => {
  const at = `?folder=${enc(DEP)}`
  it.each([
    ['values', 'POST', `/api/v2/deployments/demo/a${at}`, '{"values":{"__proto__":{"polluted":"yes"},"cpu":[]}}', 'values.__proto__'],
    ['routing', 'PUT', `/api/v2/deployments/demo/a/routing${at}`, '{"routing":{"__proto__":{"polluted":"yes"},"labels":{}}}', 'routing.__proto__'],
    ['shared', 'PUT', '/api/v2/routing/shared', '{"shared":{"__proto__":{"polluted":"yes"},"configs":{}}}', 'shared.__proto__'],
    ['expected', 'POST', '/api/v2/folders/common', '{"action":"create","folder":"deployments/team","chart":"demo","expected":{"__proto__":"x"}}', 'expected.__proto__'],
    ['a rules file', 'POST', '/api/v2/templates/demo/rules', '{"files":{"__proto__":"x"}}', 'files.__proto__'],
    ['a migration, two maps deep', 'POST', '/api/v2/templates/demo/migration-preview', '{"files":{},"migration":{"columns":{"cpu":{"__proto__":"y"}}}}', 'migration.columns.cpu.__proto__'],
    ['a migration itself', 'POST', '/api/v2/templates/demo/migration-preview', '{"files":{},"migration":{"__proto__":{"columns":{}}}}', 'migration.__proto__'],
  ])('in %s is refused 400 naming it', async (_, method, url, body, field) => {
    const r = await api(method, url, body)
    expect(r.status, r.text).toBe(400)
    expect(r.json.error).toBe(`${field}: a key named __proto__ is not taken`)
    expect({}.polluted).toBeUndefined()
  })

  it('constructor and prototype are taken and written as before', async () => {
    const r = await api('POST', `/api/v2/deployments/demo/a${at}`, '{"values":{"constructor":{"x":1},"prototype":{"y":2},"cpu":[]}}')
    expect(r.status, r.text).toBe(200)
    const written = await fs.readFile(path.join(tmpDir, DEP, 'values.yaml'), 'utf-8')
    expect(written).toContain('constructor:')
    expect(written).toContain('prototype:')
    expect({}.x).toBeUndefined()
  })
})

// A deployment name that is not its folder's own is a legacy
// <name>-values.yaml there: a name too long for that file is refused alike
// by opening, saving and deleting it (a 409, a 409 and a 500 before).
describe('a deployment name too long for its values file', () => {
  const name = 'a'.repeat(250)
  const url = `/api/v2/deployments/demo/${name}?folder=${enc(DEP)}`
  const error = `Invalid deployment name: its values file, ${name}-values.yaml, would be longer than 255 bytes, what the file system takes`
  it.each([['GET'], ['POST'], ['DELETE']])('%s → 400 saying so', async method => {
    const r = await api(method, url, method === 'POST' ? { values: {} } : undefined)
    expect(r.status, r.text).toBe(400)
    expect(r.json.error).toBe(error)
  })
  it('one that fits is still asked as before', async () => {
    const r = await api('GET', `/api/v2/deployments/demo/${'a'.repeat(243)}?folder=${enc(DEP)}`)
    expect(r.status, r.text).not.toBe(400)
  })
})
