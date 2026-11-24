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
import { unreadable } from '../../server/repo/loaded.js'
import { logger } from '../../server/lib/logger.js'

let server, baseURL, dir
const unhandled = []
const onUnhandled = err => unhandled.push(err)

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  vi.spyOn(logger, 'error').mockImplementation(() => {})
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-'))
  const router = express.Router()
  router.use(holdSyncRegistryLock)
  router.get('/reject', route('t.reject', async () => { throw new Error(`EACCES: permission denied, realpath '${dir}/charts/demo/templates/x.yaml'`) }))
  router.get('/unreadable', route('t.unreadable', async () => { throw new UnreadableError(path.join(dir, 'charts/demo/templates'), { code: 'EACCES' }) }))
  router.get('/loaded', route('t.loaded', async () => unreadable('charts/demo/values.yaml', 'permission denied', 'permission').value))
  router.get('/throw', route('t.throw', () => { throw new Error('thrown at once') }))
  router.post('/write-rejects', route('t.write-rejects', async () => { await new Promise(r => setTimeout(r, 10)); throw new Error('write failed') }))
  router.post('/write-silent', route('t.write-silent', async () => {}))
  router.post('/write', route('t.write', (req, res) => res.json({ ok: true, body: req.body })))
  router.get('/after-headers', route('t.after-headers', async (req, res) => { res.status(200).write('partial'); throw new Error('late') }))
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

async function ask(method, p, { body, type = 'application/json' } = {}) {
  const started = Date.now()
  try {
    const res = await fetch(baseURL + p, { method, body, headers: body === undefined ? {} : { 'Content-Type': type }, signal: AbortSignal.timeout(5000) })
    return { status: res.status, text: await res.text(), ms: Date.now() - started }
  } catch (err) {
    return { status: 'no answer', text: err.name, ms: Date.now() - started }
  }
}

describe('a route failing outside its own try', () => {
  it.each([
    ['an async rejection is a 500 with no path of the machine', '/reject', 500, { error: FAILED }],
    ['a file that cannot be read is a 409 naming it in the repo', '/unreadable', 409, { error: 'charts/demo/templates cannot be read: permission denied', unreadable: true }],
    ['a Loaded that is unreadable is a 409 naming the file', '/loaded', 409, { error: 'charts/demo/values.yaml cannot be read: permission denied', unreadable: true }],
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

  it.each([['fails', '/write-rejects'], ['ends without answering', '/write-silent']])('a write that %s is answered 500 and lets the commit lock go at once', async (_, p) => {
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

  it('a body that is JSON is taken', async () => {
    const r = await ask('POST', '/write', { body: '{"a":1}' })
    expect(JSON.parse(r.text)).toEqual({ ok: true, body: { a: 1 } })
  })
})
