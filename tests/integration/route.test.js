// route(): a handler's failure is always answered — a file of the repo that
// cannot be read as a 409 naming it, anything else as a 500 with no path
// of the machine — and the commit lock is let go with the answer, at once.
// answerEveryRoute gives the same to a router's handlers not wrapped yet;
// jsonBody answers a body that is not JSON, or too big, as JSON.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import express from 'express'
import { route, answerEveryRoute, answerUncaught, FAILED } from '../../server/http/route.js'
import { jsonBody } from '../../server/http/body.js'
import { holdSyncRegistryLock } from '../../server/lib/sync.js'
import { UnreadableError } from '../../server/lib/readIfThere.js'
import { unreadable, invalidOwn } from '../../server/repo/loaded.js'
import { finding } from '../../server/repo/finding.js'
import { logger } from '../../server/lib/logger.js'

let server, baseURL, dir
const unhandled = []
const onUnhandled = err => unhandled.push(err)
const lateErrors = []

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(logger, 'error').mockImplementation(() => {})
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-'))
  const router = express.Router()
  router.use(holdSyncRegistryLock)
  router.get('/reject', route('t.reject', async () => { throw new Error(`EACCES: permission denied, realpath '${dir}/charts/demo/templates/x.yaml'`) }))
  router.get('/unreadable', route('t.unreadable', async () => { throw new UnreadableError(path.join(dir, 'charts/demo/templates'), { code: 'EACCES' }) }))
  router.get('/loaded', route('t.loaded', async () => unreadable('charts/demo/values.yaml', 'permission denied', 'permission').value))
  router.get('/invalid', route('t.invalid', async () => invalidOwn('sync.yaml', [finding({ code: 'sync.not-registry', file: 'sync.yaml', helm: 'n/a', message: 'sync.yaml: syncs is not a list' })]).value))
  router.get('/own-status', route('t.own-status', async () => { throw Object.assign(new Error('x'), { status: 404 }) }))
  router.get('/throw', route('t.throw', () => { throw new Error('thrown at once') }))
  router.post('/write-rejects', route('t.write-rejects', async () => { await new Promise(r => setTimeout(r, 10)); throw new Error('write failed') }))
  router.post('/write-silent', route('t.write-silent', async () => {}, { deadlineMs: 300 }))
  router.post('/write', route('t.write', (req, res) => res.json({ ok: true, body: req.body })))
  router.get('/after-headers', route('t.after-headers', async (req, res) => { res.status(200).write('partial'); throw new Error('late') }))
  // Answered later than the handler returns, and answered twice.
  router.get('/sendfile', route('t.sendfile', (req, res) => { res.sendFile(path.join(import.meta.dirname, 'route.test.js')) }))
  router.get('/callback', route('t.callback', (req, res) => { setTimeout(() => res.json({ later: true }), 50) }))
  router.get('/late', route('t.late', async (req, res) => {
    setTimeout(() => { try { res.json({ late: true }) } catch (err) { lateErrors.push(err.code) } }, 50)
    throw new Error('failed first')
  }))
  router.post('/never', route('t.never', () => {}, { deadlineMs: 300 }))
  router.get('/passes-on', route('t.passes-on', (req, res, next) => next()))
  router.get('/passes-on', (req, res) => res.json({ passed: true }))
  // Not wrapped by name: answerEveryRoute covers it, and a router inside.
  const inner = express.Router()
  inner.get('/deep', async () => { throw new Error(`failed at ${dir}/charts/demo`) })
  router.use('/inner', inner)
  router.get('/unwrapped', async () => { throw new Error('unwrapped') })
  router.get('/to-error-handler', (req, res, next) => next(new Error('passed on')))
  router.use((err, req, res, next) => res.status(418).json({ error: `handled: ${err.message}` }))
  answerEveryRoute(router)
  const app = express()
  app.use(jsonBody())
  app.use((req, res, next) => { req.gitopsDir = dir; next() })
  app.use(router)
  app.get('/param/:x', route('t.param', (req, res) => res.json({ x: req.params.x })))
  app.get('/next-error', (req, res, next) => next(new Error(`at ${dir}/x`)))
  app.use(answerUncaught)
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseURL = `http://127.0.0.1:${server.address().port}`; r() }) })
})

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  vi.restoreAllMocks()
  if (server) await new Promise(r => server.close(r))
  await fs.rm(dir, { recursive: true, force: true })
})

async function ask(method, p, { body, type = 'application/json', headers = {} } = {}) {
  const started = Date.now()
  try {
    const res = await fetch(baseURL + p, { method, body, headers: body === undefined ? headers : { 'Content-Type': type, ...headers }, signal: AbortSignal.timeout(5000) })
    return { status: res.status, text: await res.text(), ms: Date.now() - started }
  } catch (err) {
    return { status: 'no answer', text: err.name, ms: Date.now() - started }
  }
}

describe('a route failing outside its own try', () => {
  it.each([
    ['an async rejection is a 500 with no path of the machine', '/reject', 500, { error: FAILED }],
    ['a file that cannot be read is a 409 naming it in the repo', '/unreadable', 409, { error: 'charts/demo/templates cannot be read: permission denied', unreadable: true }],
    ['a Loaded that is unreadable is a 409 naming the file', '/loaded', 409, { error: 'charts/demo/values.yaml cannot be read (permission denied)', file: 'charts/demo/values.yaml', unreadable: true }],
    ['a Loaded that is invalid is a 409 naming the file, as the routes answer it', '/invalid', 409, { error: 'sync.yaml: syncs is not a list', file: 'sync.yaml', unreadable: true }],
    ['an error of its own with a 4xx status is still a server failure', '/own-status', 500, { error: FAILED }],
    ['a synchronous throw is a JSON 500, not an HTML page', '/throw', 500, { error: FAILED }],
    ['a handler not wrapped by name is covered', '/unwrapped', 500, { error: FAILED }],
    ['a router mounted inside is covered too', '/inner/deep', 500, { error: FAILED }],
    ['an error passed on still reaches the error handler', '/to-error-handler', 418, { error: 'handled: passed on' }],
    ['a route that passes the request on is not answered by route()', '/passes-on', 200, { passed: true }],
    ['an error no route answers is a JSON 500 without a stack', '/next-error', 500, { error: FAILED }],
  ])('%s', async (_, p, status, body) => {
    const r = await ask('GET', p)
    expect(r.status, r.text).toBe(status)
    expect(JSON.parse(r.text)).toEqual(body)
    expect(r.text).not.toContain(dir)
    expect(unhandled).toEqual([])
  })

  it.each([['fails', '/write-rejects'], ['ends without answering', '/write-silent']])('a write that %s is answered 500 and lets the commit lock go with it', async (_, p) => {
    const r = await ask('POST', p)
    expect(r.status, r.text).toBe(500)
    expect(JSON.parse(r.text)).toEqual({ error: FAILED })
    const next = await ask('POST', '/write', { body: '{}' })
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

describe('what route() logs', () => {
  it('a file that cannot be read at info, a server failure at error', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    logger.error.mockClear()
    await ask('GET', '/unreadable')
    expect(logger.error).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ route: 't.unreadable', status: 409 }), 'a route answered a refusal')
    await ask('GET', '/reject')
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ route: 't.reject' }), 'a route failed outside its own error handling')
    info.mockRestore()
  })
})

describe('a route that answers later, twice or never', () => {
  it('a file sent after the handler returned is the answer', async () => {
    const r = await ask('GET', '/sendfile')
    expect(r.status).toBe(200)
    expect(r.text).toContain('a route that answers later')
  })
  it('an answer from a callback is the answer', async () => {
    const r = await ask('GET', '/callback')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({ later: true })
  })
  it('an answer after the wrapper answered does no harm', async () => {
    const r = await ask('GET', '/late')
    expect(r.status).toBe(500)
    await new Promise(res => setTimeout(res, 150))
    expect(lateErrors).toEqual([])
    expect(unhandled).toEqual([])
  })
  it('a write never answered is answered 500 at the deadline, and the lock is let go', async () => {
    const r = await ask('POST', '/never')
    expect(r.status).toBe(500)
    expect(r.ms).toBeLessThan(3000)
    const next = await ask('POST', '/write', { body: '{}' })
    expect(next.status).toBe(200)
    expect(next.ms).toBeLessThan(1000)
  })
})

describe('a URL that cannot be taken', () => {
  it.each([['/param/%E0%A4%A'], ['/param/%ZZ']])('%s → 400 as JSON saying its encoding does not decode', async p => {
    const r = await ask('GET', p)
    expect(r.status, r.text).toBe(400)
    expect(JSON.parse(r.text)).toEqual({ error: 'The request\'s URL holds a %-encoding that does not decode' })
  })
})

describe('a body that cannot be taken', () => {
  it('not JSON → 400 as JSON, no stack, no path', async () => {
    const r = await ask('POST', '/write', { body: '{"a":' })
    expect(r.status).toBe(400)
    expect(JSON.parse(r.text)).toEqual({ error: 'The request body is not JSON' })
    expect(r.text).not.toMatch(/at |node_modules|\//)
  })

  it('over the limit → 413 as JSON, no stack, no path', async () => {
    const r = await ask('POST', '/write', { body: JSON.stringify({ pad: 'x'.repeat(120_000) }) })
    expect(r.status).toBe(413)
    expect(JSON.parse(r.text)).toEqual({ error: 'The request body is over 100kb' })
  })

  it('a body whose gzip does not decode → 400 as JSON', async () => {
    const r = await ask('POST', '/write', { body: 'not gzip at all', headers: { 'Content-Encoding': 'gzip' } })
    expect(r.status, r.text).toBe(400)
    expect(JSON.parse(r.text)).toEqual({ error: 'The request cannot be read' })
  })

  it('a body that is JSON is taken', async () => {
    const r = await ask('POST', '/write', { body: '{"a":1}' })
    expect(JSON.parse(r.text)).toEqual({ ok: true, body: { a: 1 } })
  })
})
