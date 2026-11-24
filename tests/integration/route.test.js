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
import { z } from 'zod'
import { route, answerEveryRoute, answerUncaught, declaredRoutes, repoPath, repoName, FAILED } from '../../server/http/route.js'
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

// route(name, { params, query, body }, handler): the request is parsed by
// its declared shape before the handler runs; what does not fit is a 400
// naming the field, and the handler is given only the parsed input.
describe('a route that declares its request', () => {
  let app2, server2, base2, root
  const calls = []
  const askAt = async (method, p, body, type = 'application/json') => {
    const res = await fetch(base2 + p, { method, ...(body === undefined ? {} : { body, headers: { 'Content-Type': type } }) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'route-declared-'))
    await fs.mkdir(path.join(root, 'deployments/team/a'), { recursive: true })
    await fs.writeFile(path.join(root, 'deployments/team/a/values.yaml'), 'a: 1\n')
    const router = express.Router()
    const values = z.union([z.string(), z.record(z.string(), z.unknown())])
    router.post('/save/:chart', route('t.save', {
      params: z.object({ chart: repoName('name', { what: 'chart name' }) }),
      query: z.object({ folder: repoPath('deployment', { what: 'folder path' }) }),
      body: z.object({ values, version: z.string().max(10).optional(), note: z.string().min(1).nullable().optional() }),
    }, async (input, ctx) => {
      calls.push(input)
      return { status: 200, body: { input, hasRepo: typeof ctx.repo?.file === 'function', root: ctx.gitopsDir === root } }
    }))
    router.get('/own-message', route('t.own-message', {
      query: z.object({ n: z.string({ error: 'n is the number of commits, as text' }) }),
    }, async ({ query }, { res }) => res.json(query)))
    router.get('/optional', route('t.optional', {
      query: z.object({ folder: repoPath('list', { what: 'folder' }).optional() }),
    }, async ({ query }) => ({ status: 200, body: { folder: query.folder ?? null } })))
    router.get('/fails', route('t.fails', {}, async () => { throw new Error(`EACCES at ${root}/x`) }))
    router.get('/unreadable', route('t.unreadable', { query: z.object({}) }, async () => { throw new UnreadableError(path.join(root, 'deployments/team/a/values.yaml'), { code: 'EACCES' }) }))
    app2 = express()
    app2.use(jsonBody())
    app2.use((req, res, next) => { req.gitopsDir = root; next() })
    app2.use(declaredRoutes(router))
    app2.use(answerUncaught)
    await new Promise(r => { server2 = app2.listen(0, '127.0.0.1', () => { base2 = `http://127.0.0.1:${server2.address().port}`; r() }) })
  })

  afterAll(async () => {
    if (server2) await new Promise(r => server2.close(r))
    await fs.rm(root, { recursive: true, force: true })
  })

  const SAVE = '/save/demo?folder=deployments/team/a'

  it('the handler is given the parsed input: a path as { rel, abs }, a name as itself, an extra field dropped', async () => {
    const r = await askAt('POST', `${SAVE}&extra=1`, JSON.stringify({ values: { a: 1 }, pinExtra: 'x' }))
    expect(r.status).toBe(200)
    expect(r.json.input).toEqual({
      params: { chart: 'demo' },
      query: { folder: { rel: 'deployments/team/a', abs: path.join(root, 'deployments/team/a') } },
      body: { values: { a: 1 } },
    })
    expect(r.json).toMatchObject({ hasRepo: true, root: true })
  })

  it.each([
    ['no body', undefined, 'values is required'],
    ['a body that is no JSON object', '[{"values":"a"}]', 'The request body must be a JSON object with values, version, note'],
    ['text/plain', '{"values":"a"}', 'values is required', 'text/plain'],
    ['a field of the wrong type', '{"values":5}', 'values must be text or a map'],
    ['null where it may not be', '{"values":null}', 'values must be text or a map'],
    ['a list for a map', '{"values":["a"]}', 'values must be text or a map'],
    ['a string too long', '{"values":"a","version":"12345678901"}', 'version can be at most 10 characters long'],
    ['an empty string', '{"values":"a","note":""}', 'note cannot be empty'],
  ])('%s → 400 naming the field, the handler not called', async (_, body, error, type) => {
    calls.length = 0
    const r = await askAt('POST', SAVE, body, type)
    expect(r).toEqual({ status: 400, json: { error } })
    expect(calls).toEqual([])
  })

  it('null where the shape takes it is taken', async () => {
    const r = await askAt('POST', SAVE, '{"values":"a","note":null}')
    expect(r.status).toBe(200)
    expect(r.json.input.body).toEqual({ values: 'a', note: null })
  })

  it.each([
    ['a path going up', '/save/demo?folder=../x', 'Invalid folder path: a path cannot go up with ..'],
    ['a path missing', '/save/demo', 'Invalid folder path: a path is needed'],
    ['a path given twice (a list)', '/save/demo?folder=a&folder=b', 'Invalid folder path: a path is text'],
    ['a name that is none', '/save/Bad?folder=deployments/team/a', 'Invalid chart name: a name is lower-case letters, digits, - and _, starting with a letter or a digit'],
  ])('%s → 400 as parsePath answers it', async (_, p, error) => {
    const r = await askAt('POST', p, '{"values":"a"}')
    expect(r).toEqual({ status: 400, json: { error } })
  })

  it('a message the schema gives is kept', async () => {
    expect(await askAt('GET', '/own-message')).toEqual({ status: 400, json: { error: 'n is the number of commits, as text' } })
    expect(await askAt('GET', '/own-message?n=3')).toEqual({ status: 200, json: { n: '3' } })
  })

  it('an optional path left out is undefined; given, it is still decided', async () => {
    expect(await askAt('GET', '/optional')).toEqual({ status: 200, json: { folder: null } })
    expect((await askAt('GET', '/optional?folder=.git')).status).toBe(400)
  })

  it('a failure is answered as route() answers it', async () => {
    expect(await askAt('GET', '/fails')).toEqual({ status: 500, json: { error: FAILED } })
    const r = await askAt('GET', '/unreadable')
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('deployments/team/a/values.yaml cannot be read: permission denied')
  })

  it('a router with a route that does not declare its request does not start, naming it', () => {
    const r = express.Router()
    r.get('/a', route('a', { query: z.object({}) }, async () => ({ status: 200, body: {} })))
    r.post('/b', route('b', async (req, res) => res.json({})))
    const inner = express.Router()
    inner.delete('/c', (req, res) => res.json({}))
    r.use('/inner', inner)
    expect(() => declaredRoutes(r)).toThrow('these routes do not declare their request (route(name, shape, handler)): POST /b, DELETE /c')
  })

  it('a shape that is not one is refused when the route is made', () => {
    expect(() => route('x', { body: { values: 'string' } }, () => {})).toThrow('route x: body is not a zod schema')
    expect(() => route('x', { headers: z.object({}) }, () => {})).toThrow('route x: a request has params, query and body, not headers')
  })
})
