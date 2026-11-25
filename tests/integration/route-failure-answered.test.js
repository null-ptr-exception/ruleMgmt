// Every route answers when what it waits on fails, wherever in the handler
// that is: the routes are read from the routers themselves, and each is
// sent with every file system call and every git call failing. An answer
// arrives (a 4xx or 5xx, or a 200 saying what could not be read), nothing is left unhandled — in the server that
// ends the process (tests/integration/server-survives-route-failure.test.js)
// — and the commit lock is free for the next write.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import express from 'express'

const failing = vi.hoisted(() => ({ on: false }))
vi.mock('../../server/lib/git.js', async importOriginal => {
  const real = (await importOriginal()).default
  return { default: (...args) => (failing.on ? Promise.reject(new Error('git failed (injected)')) : real(...args)) }
})

const MOUNTS = [['charts', 'charts'], ['templates', 'templates'], ['deployments', 'deployments'], ['render', 'render'], ['git', 'git'], ['folders', 'folders'], ['sync', 'sync'], ['routing/shared', 'routingShared']]
const CPU = 'group: cpu\ncolumns:\n  namespace: {type: string, required: true}\nrules:\n  - alert: CpuHigh\n    expr: cpu{ns="${namespace}"} > 1\n'
const DEP = 'deployments/team/d'
// Enough for most routes to get past their checks of the request to where
// they read or write.
const BODY = {
  name: 'other', newName: 'renamed', content: 'a: b\n', files: { 'cpu.yaml': CPU }, values: { a: 1 }, valuesText: 'a: 1\n',
  chartMeta: { description: 'x' }, folder: DEP, chart: 'demo', source: DEP, target: 'deployments/team/e', message: 'm',
  routing: {}, paths: [DEP], path: DEP, from: 'a', to: 'b',
}
const PARAMS = { chart: 'demo', name: 'demo', deployment: 'd', template: 'x' }

let server, baseURL, tmpDir, workspace
let n = 0
// ROUTE_TABLE=<file> writes each route's outcome, one line each.
const table = []
const unhandled = []
const onUnhandled = err => unhandled.push(err)

function routesOf(router, prefix, out = []) {
  for (const layer of router.stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) out.push([method.toUpperCase(), prefix + layer.route.path])
    } else if (Object.getPrototypeOf(layer.handle) === express.Router) {
      routesOf(layer.handle, prefix, out)
    }
  }
  return out
}
const routes = []
for (const [mount, file] of MOUNTS) {
  const { default: router } = await import(`../../server/routes/${file}.js`)
  for (const [method, p] of routesOf(router(), `/api/v2/${mount}`)) routes.push([method, p])
}

// Every fs/promises call fails while `failing.on`.
const realFs = { ...fs }
function failFs(on) {
  failing.on = on
  for (const [k, v] of Object.entries(realFs)) {
    if (typeof v !== 'function' || k === 'constants') continue
    fs[k] = on ? async () => { const e = new Error(`EIO: i/o error (injected), ${k}`); e.code = 'EIO'; throw e } : v
  }
}

async function ask(method, p, body, ms) {
  const started = performance.now()
  try {
    const res = await fetch(`${baseURL}${p}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms),
    })
    return { status: res.status, text: await res.text(), ms: Math.round(performance.now() - started) }
  } catch (err) {
    return { status: 'no answer', text: err.name, ms: Math.round(performance.now() - started) }
  }
}

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-failure-'))
  workspace = path.join(tmpDir, 'base')
  await fs.mkdir(workspace)
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = workspace; next() })
  for (const [mount, file] of MOUNTS) app.use(`/api/v2/${mount}`, (await import(`../../server/routes/${file}.js`)).default())
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect((await ask('POST', '/api/v2/templates/demo/rules', { files: { 'cpu.yaml': CPU } }, 30_000)).status).toBe(200)
  expect((await ask('POST', '/api/v2/folders/init', { folder: DEP, chart: 'demo' }, 30_000)).status).toBe(200)
})

afterAll(async () => {
  failFs(false)
  if (process.env.ROUTE_TABLE) await fs.writeFile(process.env.ROUTE_TABLE, table.join('\n') + '\n')
  process.off('unhandledRejection', onUnhandled)
  vi.restoreAllMocks()
  if (server) await new Promise(r => server.close(r))
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('every route, with every file and git call failing', () => {
  it('finds the routes', () => expect(routes.length).toBeGreaterThan(30))

  it.each(routes)('%s %s is answered, leaves nothing unhandled and the lock free', async (method, route) => {
    const p = route.replace(/:(\w+)/g, (_, k) => PARAMS[k]) + `?folder=${encodeURIComponent(DEP)}&path=${encodeURIComponent(DEP)}`
    // A workspace of its own: the commit lock is one per workspace, so a
    // lock one route kept does not hold up the next.
    workspace = path.join(tmpDir, `w${++n}`)
    await fs.cp(path.join(tmpDir, 'base'), workspace, { recursive: true })
    const before = unhandled.length
    failFs(true)
    let r
    try {
      r = await ask(method, p, method === 'GET' || method === 'DELETE' ? undefined : BODY, 10_000)
    } finally {
      failFs(false)
    }
    // A rejection is reported on the next turn of the loop.
    await new Promise(res => setTimeout(res, 20))
    const left = unhandled.slice(before).map(e => `${e?.code || ''} ${e?.message}`)
    // A write after it is not kept waiting on the commit lock (held up to 60 s).
    const next = await ask('POST', '/api/v2/charts', { name: 'NOT A NAME' }, 5_000)
    table.push([method, route, r.status, left.length ? `unhandled: ${left.join('; ')}` : 'none unhandled', `next write ${next.status} in ${next.ms} ms`].join('\t'))
    expect(left, 'unhandled').toEqual([])
    // Answered: some reads say what they could not read in a 200.
    expect(typeof r.status, r.text).toBe('number')
    // No answer carries the workspace's path.
    expect(r.text).not.toContain(tmpDir)
    expect(next.status).toBe(400)
  })
})
