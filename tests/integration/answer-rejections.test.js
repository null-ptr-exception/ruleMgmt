// answerRejections: a handler's failure that its own try does not catch is
// answered as the routes answer their errors, without the workspace's
// path, and the commit lock is let go with the answer.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import express from 'express'
import { answerRejections } from '../../server/lib/answerRejections.js'
import { holdSyncRegistryLock } from '../../server/lib/sync.js'
import { UnreadableError } from '../../server/lib/readIfThere.js'
import { logger } from '../../server/lib/logger.js'

let server, baseURL, dir
const unhandled = []
const onUnhandled = err => unhandled.push(err)

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(logger, 'error').mockImplementation(() => {})
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-rejections-'))
  const inner = express.Router()
  inner.get('/deep', async () => { throw new Error(`failed at ${dir}/charts/demo`) })
  const router = express.Router()
  router.use(holdSyncRegistryLock)
  router.get('/reject', async () => { throw new Error(`EACCES: permission denied, realpath '${dir}/charts/demo/templates/x.yaml'`) })
  router.get('/unreadable', async () => { throw new UnreadableError(path.join(dir, 'charts/demo/templates'), { code: 'EACCES' }) })
  router.get('/throw', () => { throw new Error('thrown at once') })
  router.use('/inner', inner)
  router.post('/write-rejects', async (req, res) => { await new Promise(r => setTimeout(r, 10)); throw new Error('write failed') })
  router.post('/write', (req, res) => res.json({ ok: true }))
  router.get('/after-headers', async (req, res) => { res.status(200).write('partial'); throw new Error('late') })
  // An error handler keeps its four parameters: Express tells it by them.
  router.get('/to-error-handler', (req, res, next) => next(new Error('passed on')))
  router.use((err, req, res, next) => res.status(418).json({ error: `handled: ${err.message}` }))
  answerRejections(router)
  const app = express()
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  app.use(router)
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  vi.restoreAllMocks()
  if (server) await new Promise(r => server.close(r))
  await fs.rm(dir, { recursive: true, force: true })
})

async function ask(method, p) {
  const started = Date.now()
  try {
    const res = await fetch(baseURL + p, { method, signal: AbortSignal.timeout(5000) })
    return { status: res.status, text: await res.text(), ms: Date.now() - started }
  } catch (err) {
    return { status: 'no answer', text: err.name, ms: Date.now() - started }
  }
}

describe('a route failing outside its own try', () => {
  it.each([
    ['an async rejection is a 500 without the workspace path', '/reject', 500, { error: "EACCES: permission denied, realpath 'charts/demo/templates/x.yaml'" }],
    ['a file that cannot be read is a 409 naming it', '/unreadable', 409, { error: 'charts/demo/templates cannot be read: permission denied', unreadable: true }],
    ['a synchronous throw is a JSON 500, not an HTML page', '/throw', 500, { error: 'thrown at once' }],
    ['a router mounted inside is covered too', '/inner/deep', 500, { error: 'failed at charts/demo' }],
    ['an error passed on still reaches the error handler', '/to-error-handler', 418, { error: 'handled: passed on' }],
  ])('%s', async (_, p, status, body) => {
    const r = await ask('GET', p)
    expect(r.status, r.text).toBe(status)
    expect(JSON.parse(r.text)).toEqual(body)
    expect(unhandled).toEqual([])
  })

  it('a write that fails lets the commit lock go with its answer', async () => {
    expect((await ask('POST', '/write-rejects')).status).toBe(500)
    const next = await ask('POST', '/write')
    expect(next.status).toBe(200)
    expect(next.ms).toBeLessThan(1000)
    expect(unhandled).toEqual([])
  })

  it('a failure after the answer started ends the answer', async () => {
    const r = await ask('GET', '/after-headers')
    expect(r).toMatchObject({ status: 200, text: 'partial' })
    expect(unhandled).toEqual([])
  })
})
