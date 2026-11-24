// What the routes that write through a plan answer when the plan throws:
// a file of the repo that cannot be read is a 409 naming it, and anything
// else the neutral 500 — never the error's own message, which may hold a
// path of the machine or whatever the failing call put in it. The plan is
// made to throw here; the routes that leave it to the route wrapper are
// asked beside the ones that used to catch by themselves.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let thrown
vi.mock('../../server/repo/changes/index.js', async original => {
  const real = await original()
  return { ...real, planChange: async () => { throw thrown() } }
})
const { default: routingSharedRouter } = await import('../../server/routes/routingShared.js')
const { default: deploymentsRouter } = await import('../../server/routes/deployments.js')
const { default: foldersRouter } = await import('../../server/routes/folders.js')
const { default: syncRouter } = await import('../../server/routes/sync.js')
const { UnreadableError } = await import('../../server/lib/readIfThere.js')
const { NotLoadedError, unreadable } = await import('../../server/repo/loaded.js')
const { answerUncaught, FAILED } = await import('../../server/http/route.js')

const DEP = 'deployments/t/a'
let dir, app, logged
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-failure-'))
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  put('charts/demo/Chart.yaml', 'apiVersion: v2\nname: demo\nversion: 0.1.0\nannotations: {app: alertforge}\n')
  put('charts/demo/values.yaml', '{}\n')
  put(`${DEP}/Chart.yaml`, 'apiVersion: v2\nname: a\nversion: 0.1.0\ndependencies:\n  - {name: demo, version: 0.1.0, repository: "file://../../../charts/demo"}\n')
  put(`${DEP}/values.yaml`, '{}\n')
  app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  app.use('/api/v2/deployments', deploymentsRouter())
  app.use('/api/v2/folders', foldersRouter())
  app.use('/api/v2/sync', syncRouter())
  app.use('/api/v2/routing/shared', routingSharedRouter())
  app.use(answerUncaught)
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { logged.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }) })

const calls = {
  'Regenerate': () => request(app).post('/api/v2/routing/shared/regenerate').send({}),
  'a values save': () => request(app).post(`/api/v2/deployments/demo/a?folder=${DEP}`).send({ values: {} }),
  'making a _common': () => request(app).post('/api/v2/folders/common').send({ action: 'create', folder: 'deployments/t', chart: 'demo', expected: {} }),
  // These two never caught by themselves: what the wrapper answers.
  'a sync link': () => request(app).post('/api/v2/sync').send({ source: DEP, target: 'deployments/t/b' }),
  'a shared configs save': () => request(app).put('/api/v2/routing/shared').send({ shared: 'configs: {}\n' }),
}

describe.each(Object.entries(calls))('%s, when its plan throws', (_, call) => {
  it.each([
    ['an error whose message holds a path and more', () => new Error(`EIO: i/o error, read '${dir}/${DEP}/values.yaml' (made-up detail)`)],
    ['a file system error with a code', () => Object.assign(new Error(`EIO: i/o error, read '${dir}/x'`), { code: 'EIO' })],
    ['a mistake in the code', () => new TypeError("Cannot read properties of undefined (reading 'rows')")],
  ])('%s: the neutral 500, nothing of the message', async (__, make) => {
    thrown = make
    const res = await call()
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: FAILED })
  })

  it('a file that cannot be read (UnreadableError): 409 naming it in the repo', async () => {
    thrown = () => new UnreadableError(`${dir}/sync.yaml`, { code: 'EACCES' })
    const res = await call()
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'sync.yaml cannot be read: permission denied', unreadable: true })
  })

  it('a file the repo could not load (NotLoadedError): 409 naming it', async () => {
    thrown = () => new NotLoadedError(unreadable('sync.yaml', 'permission denied', 'permission'))
    const res = await call()
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'sync.yaml cannot be read (permission denied)', file: 'sync.yaml', unreadable: true })
  })
})
