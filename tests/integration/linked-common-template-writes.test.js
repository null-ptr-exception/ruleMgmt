// A deployment on a _common reached through a link made by hand is not
// supported: the writes of the Template side that touch it answer the one
// sentence every other write answers (server/lib/stack.js
// linkedStackRefusal) — 409, nothing written: a rules save that migrates
// it, its routing saved or removed, its routing as a sync target's copy,
// the shared configs saved or renamed while it uses one. Regenerate makes
// no file of it and lists it with the same sentence, the others made: it
// is a deployment that cannot be made again, not a file that cannot be
// written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

const CPU = (col = 'job') => `group: cpu\ncolumns:\n  ${col}: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{job="\${${col}}"} > 1\n    labels: {severity: critical}\n`
const ROUTING = to => `labels:\n  severity: [critical]\nconfigs:\n  ops: { type: email, to: ${to}@example.com }\ncells:\n  - match: { severity: critical }\n    configs: [ops]\n`
const SHARED_USE = 'labels:\n  severity: [critical]\nconfigs:\n  relay: { shared: true }\ncells:\n  - match: { severity: critical }\n    configs: [relay]\n'
const SHARED = port => `configs:\n  relay: { type: webhook, url: "http://relay.example.com:${port}" }\n`
const A = 'deployments/t/a'   // on deployments/t/_common, a link to deployments/s/_common
const X = 'deployments/s/x'   // on deployments/s/_common/demo, a folder of its own
const SRC = 'deployments/r/src'
const SAID = 'its _common chart deployments/t/_common/demo: deployments/t/_common is a link to deployments/s/_common — a _common reached through a link made by hand is not supported, and nothing is written to it: replace the link with a folder of its own in git, or depend on deployments/s/_common/demo'
const REFUSED = { error: `${A}: ${SAID}`, file: A }
const q = f => `?folder=${encodeURIComponent(f)}`
const dep = d => `/api/v2/deployments/demo/${path.basename(d)}${q(d)}`
const route = d => `/api/v2/deployments/demo/${path.basename(d)}/routing${q(d)}`

let server, base, root

async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
async function must(p) {
  const r = await p
  if (r.status !== 200) throw new Error(`setup: ${r.status} ${JSON.stringify(r.data)}`)
  return r
}
const put = async (rel, text) => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), text) }
// Every entry of the repo: a file's text, a link, a folder.
async function everything(rel = '') {
  const out = {}
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isSymbolicLink()) out[p] = `link:${await fs.readlink(path.join(root, p))}`
    else if (e.isDirectory()) Object.assign(out, { [`${p}/`]: 'folder' }, await everything(p))
    else out[p] = await fs.readFile(path.join(root, p), 'utf-8')
  }
  return out
}
// Asked, it answers the one sentence about A, and nothing is written.
async function refused(ask) {
  const before = await everything()
  const r = await ask()
  expect(r.status, JSON.stringify(r.data)).toBe(409)
  expect(r.data).toMatchObject(REFUSED)
  expect(await everything()).toEqual(before)
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-common-writes-'))
  const mounts = [['templates', 'templates'], ['charts', 'charts'], ['deployments', 'deployments'], ['folders', 'folders'], ['sync', 'sync'], ['git', 'git'], ['routing/shared', 'routingShared']]
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = root; next() })
  for (const [at, f] of mounts) app.use(`/api/v2/${at}`, (await import(`../../server/routes/${f}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r() }) })
  await must(api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU() } }))
  for (const f of [A, X, SRC]) await must(api('POST', '/api/v2/folders/init', { folder: f, chart: 'demo' }))
  await must(api('POST', dep(SRC), { values: { cpu: [{ job: 'src' }] } }))
  const plan = await must(api('GET', '/api/v2/folders/common/plan?folder=deployments/s&chart=demo'))
  await must(api('POST', '/api/v2/folders/common', { action: 'create', folder: 'deployments/s', chart: 'demo', expected: plan.data.expected }))
  await must(api('PUT', route(SRC), { routing: ROUTING('src') }))
  // By hand: t/_common is a link to s/_common, and A renders on it.
  await put('deployments/s/_common/demo/values.yaml', 'demo:\n  cpu:\n    - { job: shared }\n')
  await fs.symlink('../s/_common', path.join(root, 'deployments/t/_common'))
  await put(`${A}/Chart.yaml`, "apiVersion: v2\nname: a\nversion: 0.1.0\ndependencies:\n  - name: common\n    version: '>=0.0.0-0'\n    repository: file://../_common/demo\n")
  await put(`${A}/values.yaml`, 'common:\n  demo:\n    cpu:\n      - { job: own }\n')
})

afterEach(async () => {
  if (server) await new Promise(r => server.close(r))
  await fs.rm(root, { recursive: true, force: true })
})

describe('a deployment on a _common reached through a hand-made link, and the Template side\'s writes', () => {
  it('a rules save that migrates is refused for it: neither the Template nor any deployment is written', async () => {
    await refused(() => api('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU('name') }, confirmBreaking: true, migration: { columns: { cpu: { job: 'name' } } } }))
  })

  it('the migration\'s preview lists it with the sentence, as a deployment it does not migrate', async () => {
    const r = await api('POST', '/api/v2/templates/demo/migration-preview', { files: { 'cpu.yaml': CPU('name') }, migration: { columns: { cpu: { job: 'name' } } } })
    expect(r.status).toBe(200)
    expect(r.data.deployments.find(d => d.path === A)).toMatchObject({ rowsChanged: 0, problems: [{ message: `${A}: ${SAID}`, before: false }] })
  })

  it('its routing is not saved', async () => {
    await refused(() => api('PUT', route(A), { routing: ROUTING('a') }))
  })

  it('its routing is not removed', async () => {
    await put(`${A}/routing.yaml`, ROUTING('a'))
    await refused(() => api('DELETE', route(A)))
  })

  it('a routing save of its sync source is refused: it would be copied to it', async () => {
    await put('sync.yaml', `syncs:\n  - source: ${SRC}\n    targets: [${A}]\n`)
    await refused(() => api('PUT', route(SRC), { routing: ROUTING('other') }))
    await put(`${SRC}/routing.yaml`, ROUTING('src'))
    await refused(() => api('DELETE', route(SRC)))
  })

  it('the shared configs are not saved or renamed while it uses one', async () => {
    await must(api('PUT', '/api/v2/routing/shared', { shared: SHARED(8080) }))
    await put(`${A}/routing.yaml`, SHARED_USE)
    await refused(() => api('PUT', '/api/v2/routing/shared', { shared: SHARED(9090) }))
    await refused(() => api('POST', '/api/v2/routing/shared/rename', { from: 'relay', to: 'relay2' }))
  })

  it('Regenerate makes the others again and lists it with the sentence: nothing of it is written', async () => {
    // Both have a routing.yaml edited by hand: their resource is stale.
    await put(`${A}/routing.yaml`, ROUTING('a'))
    await put(`${SRC}/routing.yaml`, ROUTING('by-hand'))
    const before = await everything()
    for (const url of ['/api/v2/git/routing/regenerate', '/api/v2/routing/shared/regenerate']) {
      const r = await api('POST', url)
      expect(r.status, JSON.stringify(r.data)).toBe(200)
      expect(r.data.failed).toContainEqual({ deployment: A, error: `${A}: ${SAID}` })
      expect(r.data.regenerated).not.toContain(A)
    }
    const after = await everything()
    expect(after[`${SRC}/templates/alertmanagerconfig.yaml`]).toContain('by-hand@example.com')
    // Nothing of A, or of the _common it is on, changed.
    for (const [p, v] of Object.entries(before)) if (p.startsWith('deployments/t/') || p.startsWith('deployments/s/')) expect(after[p], p).toBe(v)
    expect(Object.keys(after).filter(p => p.startsWith('deployments/t/')).sort()).toEqual(Object.keys(before).filter(p => p.startsWith('deployments/t/')).sort())
  })

  it('Regenerate does not copy its source\'s routing to it as a sync target: listed, the source made again', async () => {
    await put('sync.yaml', `syncs:\n  - source: ${SRC}\n    targets: [${A}]\n`)
    await put(`${SRC}/routing.yaml`, ROUTING('by-hand'))
    const before = await everything()
    const r = await api('POST', '/api/v2/git/routing/regenerate')
    expect(r.status, JSON.stringify(r.data)).toBe(200)
    expect(r.data.regenerated).toEqual([SRC])
    expect(r.data.failed).toContainEqual({ deployment: A, error: `${A}: ${SAID}` })
    const after = await everything()
    for (const [p, v] of Object.entries(before)) if (p.startsWith('deployments/t/')) expect(after[p], p).toBe(v)
    expect(after[`${A}/routing.yaml`]).toBeUndefined()
  })
})
