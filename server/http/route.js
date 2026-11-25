/**
 * route(name, shape, handler): a route that declares its request, always
 * answers and always lets the commit lock go.
 *
 * Express 4 does not catch an async handler's rejection: no answer is sent,
 * Node may end the process, and a write holding the commit lock
 * (holdSyncRegistryLock, released when the answer ends) keeps it until its
 * time limit. A handler given to route() is answered whatever it does:
 *   - it throws or rejects with a file of the repo that cannot be read or
 *     used (an UnreadableError, or a Loaded that is `unreadable` or
 *     `invalid` asked for its value) → 409 naming the file in the repo,
 *     `unreadable: true`, as errorAnswer answers it
 *   - it throws or rejects with an error Express or the body parser gives a
 *     4xx (a URL whose %-encoding does not decode) → that 4xx, said plainly
 *   - it throws or rejects with anything else → 500 saying the server
 *     failed, with no path of the machine in it; the error is logged with
 *     the route's name
 *   - it does not answer (and does not pass the request on) by the
 *     deadline (route()'s `deadlineMs`) → the same 500, logged; an answer
 *     it gives after returning (res.sendFile, a callback) is waited for;
 *     one it started (headers, a chunk) and did not end is ended there
 *   - what it writes after the wrapper answered is dropped, not thrown
 * Answering ends the response, which lets the lock go at once.
 *
 * The request:
 *   shape: { params, query, body } — each a zod schema (left out: nothing
 *   of it is read); a value that becomes a path or a name is declared with
 *   repoPath(intent, …) or repoName(intent, …), which parsePath decides
 *   (server/repo/paths.js), not the schema. The wrapper parses the request
 *   before the handler runs; what does not fit is answered 400
 *   `{ error }` naming the field, and the handler is not called. A field
 *   the shape does not have is dropped, not refused.
 *   handler(input, ctx): input = { params, query, body } as parsed;
 *   ctx = { repo, gitopsDir, req, res } (req and res only where the
 *   answer is no JSON, or a header is needed). It answers with res, or
 *   returns { status, body } for the wrapper to send.
 *
 *   router.get('/:chart', route('templates.get', {
 *     params: z.object({ chart: repoName('name', { what: 'chart name' }) }),
 *   }, async ({ params }, { repo }) => ({ status: 200, body: … })))
 *   GET /bad%20name → 400 { error: 'Invalid chart name: a name is lower-case …' }
 *
 * declaredRoutes(router): every route of the router must declare its
 * request, or the router does not start; its other handlers (middleware,
 * routers mounted in it) are answered the same way, named after their
 * method and path.
 */
import express from 'express'
import { AsyncLocalStorage } from 'async_hooks'
import { z } from 'zod'
import { parsePath } from '../repo/paths.js'
import { openRepo } from '../repo/openRepo.js'
import { errorAnswer } from '../lib/readIfThere.js'
import { clientStatus, clientRefusal } from './body.js'
import { withoutPath, answersWithoutPaths } from '../lib/answerPaths.js'
import { logger } from '../lib/logger.js'
import { HOLD_LIMIT_MS, holdSyncRegistryLock } from '../repo/lock.js'

const WRAPPED = Symbol('route')
const DECLARED = Symbol('route declares its request')
const SEALED = Symbol('answered by route()')
const ANSWER_DEADLINE_MS = HOLD_LIMIT_MS
export const FAILED = 'The server could not answer this request; the cause is in its log'

/**
 * The answer to a failure: { status, body } — the routes' own answer to a
 * file of the repo that cannot be read or used (errorAnswer: 409 naming
 * it), without the workspace's path; anything else the neutral 500.
 */
export async function failureAnswer(err, gitopsDir) {
  // A request the server cannot take (a URL that does not decode, a body
  // that is no gzip): its own 4xx, said plainly.
  if (clientStatus(err)) {
    const { status, error } = clientRefusal(err)
    return { status, body: { error } }
  }
  const { status, body } = errorAnswer(err)
  if (status !== 409) return { status: 500, body: { error: FAILED } }
  return { status, body: { ...body, error: await withoutPath(body.error, gitopsDir) } }
}

// After the wrapper answered, what the handler still writes is dropped: a
// late json() would throw ERR_HTTP_HEADERS_SENT in a timer nobody catches.
function seal(res, name) {
  if (res[SEALED]) return
  res[SEALED] = true
  const dropped = method => function () {
    logger.warn({ route: name, method }, 'a route answered after its request was answered: dropped')
    return res
  }
  for (const m of ['status', 'set', 'header', 'setHeader', 'writeHead', 'write', 'end', 'send', 'json', 'sendFile', 'sendStatus', 'redirect', 'render', 'type']) {
    if (typeof res[m] === 'function') res[m] = dropped(m)
  }
}

async function answer(name, err, req, res) {
  try {
    if (res.headersSent) {
      logger.error({ err, route: name, method: req.method, url: req.originalUrl }, 'a route failed after its answer started')
      if (!res.writableEnded) res.end()
      seal(res, name)
      return
    }
    const { status, body } = await failureAnswer(err, req.gitopsDir)
    // A refusal the wrapper understands (a file that cannot be read, a
    // request it cannot take) is no server failure: info, not error.
    const where = { route: name, method: req.method, url: req.originalUrl }
    if (status < 500) logger.info({ ...where, status, error: body.error }, 'a route answered a refusal')
    else logger.error({ err, ...where }, 'a route failed outside its own error handling')
    if (res.headersSent) return
    res.status(status).json(body)
    seal(res, name)
  } catch (e) {
    logger.error({ err: e }, 'could not answer a failed route')
    if (!res.writableEnded) res.end()
  }
}

/**
 * Whether the response is answered (ended, or the client gone) within
 * `ms`: a handler may answer after it returns (res.sendFile, a callback).
 * Headers or a first chunk written are not an answer: a response never
 * ended holds the connection, and a write's commit lock, until it is.
 */
function answeredWithin(res, ms) {
  if (res.writableEnded || res.destroyed) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = answered => { clearTimeout(timer); res.off('finish', yes); res.off('close', yes); resolve(answered) }
    const yes = () => done(true)
    const timer = setTimeout(() => done(res.writableEnded), ms)
    res.once('finish', yes)
    res.once('close', yes)
  })
}

function wrap(name, fn, { mustAnswer, deadlineMs = ANSWER_DEADLINE_MS }) {
  if (fn[WRAPPED]) return fn
  const run = (req, res, call) => {
    let passed = false
    let out
    try {
      out = call(() => { passed = true })
    } catch (err) {
      answer(name, err, req, res)
      return
    }
    Promise.resolve(out).then(
      async () => {
        if (!mustAnswer || passed) return
        // Decided by the response, not by the handler's return.
        if (await answeredWithin(res, deadlineMs)) return
        // Not ended: answered 500, or, an answer started, ended as it is.
        if (!passed) answer(name, new Error(`the route did not end its answer within ${deadlineMs} ms`), req, res)
      },
      err => answer(name, err, req, res),
    )
  }
  // The same number of parameters: Express tells an error handler by it.
  const wrapped = fn.length === 4
    ? function (err, req, res, next) { run(req, res, mark => fn.call(this, err, req, res, (...a) => { mark(); next(...a) })) }
    : function (req, res, next) { run(req, res, mark => fn.call(this, req, res, (...a) => { mark(); next(...a) })) }
  wrapped[WRAPPED] = true
  return wrapped
}

/**
 * `deadlineMs`: how long a route that has not answered is waited for, the
 * commit lock's own limit by default (HOLD_LIMIT_MS, 60 s): the longest a
 * write may hold the lock, so the answer and the lock's release come
 * together; a route that answers later than its handler returns (a file
 * sent, a callback) is not cut short before it.
 */
export function route(name, shape, handler, options) {
  if (typeof name !== 'string' || !shape || typeof shape !== 'object' || typeof handler !== 'function') {
    throw new TypeError('route(name, { params, query, body }, handler)')
  }
  for (const k of Object.keys(shape)) {
    if (!PARTS.includes(k)) throw new TypeError(`route ${name}: a request has params, query and body, not ${k}`)
    if (!(shape[k] instanceof z.ZodType)) throw new TypeError(`route ${name}: ${k} is not a zod schema`)
  }
  const wrapped = wrap(name, declared(name, shape, handler), { mustAnswer: true, deadlineMs: options?.deadlineMs })
  wrapped[DECLARED] = true
  return wrapped
}

// ── the request's shape ────────────────────────────────────────────────

const PARTS = ['params', 'query', 'body']
// Where a value is, as an answer names it.
const LABEL = {
  params: k => `${k} in the URL`,
  query: k => `query parameter ${k}`,
  body: k => k,
}
// The request a path is decided for: repoPath's transform runs inside it.
const request = new AsyncLocalStorage()
const PATH_ISSUE = 'repo-path'

const TYPE_WORDS = {
  string: 'text', object: 'a map', record: 'a map', array: 'a list', number: 'a number', int: 'a whole number',
  boolean: 'true or false', null: 'null', literal: 'a fixed value',
}
const typeWord = t => TYPE_WORDS[t] ?? t

// What one issue says, without the field (it is put in front).
function issueText(iss) {
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? 'is required' : `must be ${typeWord(iss.expected)}`
    case 'invalid_union': {
      const words = [...new Set((iss.errors || []).flat().filter(e => e.code === 'invalid_type' && !e.path?.length).map(e => typeWord(e.expected)))]
      if (iss.input === undefined) return 'is required'
      return words.length ? `must be ${words.join(' or ')}` : 'is none of the forms it may take'
    }
    case 'too_small':
      if (iss.origin === 'string') return Number(iss.minimum) === 1 ? 'cannot be empty' : `must be at least ${iss.minimum} characters long`
      if (iss.origin === 'array') return Number(iss.minimum) === 1 ? 'cannot be an empty list' : `must have at least ${iss.minimum} items`
      return `must be at least ${iss.minimum}`
    case 'too_big':
      if (iss.origin === 'string') return `can be at most ${iss.maximum} characters long`
      if (iss.origin === 'array') return `can have at most ${iss.maximum} items`
      return `can be at most ${iss.maximum}`
    case 'invalid_value':
      return `must be one of ${iss.values.map(v => JSON.stringify(v)).join(', ')}`
    default:
      return 'does not fit'
  }
}

// A map's key named __proto__: JSON.parse keeps it as a key of its own,
// and a map the schema builds would drop it without a word (assigning it
// sets the new object's prototype). noProtoKey() refuses it instead.
const PROTO_KEY = 'proto-key'
const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `schema` (a map: z.record, z.looseObject), refusing a key named
 * __proto__ of the map it is given, naming it:
 *   noProtoKey(z.record(z.string(), z.unknown()))
 *   { values: { "__proto__": {} } } → 400 'values.__proto__: a key named __proto__ is not taken'
 * map(value, params) is noProtoKey(z.record(z.string(), value, params)).
 */
export const noProtoKey = schema => z.preprocess((input, ctx) => {
  if (isMap(input) && Object.hasOwn(input, '__proto__')) {
    ctx.issues.push({ code: 'custom', message: OURS, path: ['__proto__'], input, params: { [PROTO_KEY]: true } })
  }
  return input
}, schema)
export const map = (value = z.unknown(), params) => noProtoKey(z.record(z.string(), value, params))

// A key named __proto__ inside a union's branch: the union says only that
// no branch fits; the key is what to name.
function protoIssues(issues, at = []) {
  const out = []
  for (const iss of issues) {
    const path = [...at, ...(iss.path || [])]
    if (iss.code === 'custom' && iss.params?.[PROTO_KEY]) out.push({ ...iss, path })
    else if (iss.code === 'invalid_union') out.push(...protoIssues((iss.errors || []).flat(), path))
  }
  return out
}

const fieldOf = path => path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i ? `.${String(p)}` : String(p))).join('')

/** What a request part that does not fit is answered: one line per issue. */
function refusalOf(part, issues, schema) {
  const protos = protoIssues(issues)
  if (protos.length) return [...new Set(protos.map(iss => `${LABEL[part](fieldOf(iss.path))}: a key named __proto__ is not taken`))].join('; ')
  // After a field's wrong type, nothing more about the same field: `[]`
  // for a text is no text, not also an empty list.
  const pathKey = iss => JSON.stringify(iss.path)
  const wrongType = new Set(issues.filter(i => i.code === 'invalid_type' || i.code === 'invalid_union').map(pathKey))
  issues = issues.filter(i => i.code === 'invalid_type' || i.code === 'invalid_union' || !wrongType.has(pathKey(i)))
  const lines = issues.map(iss => {
    // A path or a name: parsePath's own answer, which names it.
    if (iss.code === 'custom' && iss.params?.[PATH_ISSUE]) return iss.message
    if (iss.message !== OURS) return iss.message
    if (!iss.path.length) {
      // The part as a whole: say which fields it has.
      const keys = schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
      const what = part === 'body' ? 'The request body' : `The request's ${part}`
      return keys.length ? `${what} must be a JSON object with ${keys.join(', ')}` : `${what} ${issueText(iss)}`
    }
    return `${LABEL[part](fieldOf(iss.path))} ${issueText(iss)}`
  })
  return [...new Set(lines)].join('; ')
}

// A message a schema gives (z.string({ error: '…' })) is kept whole: the
// map given to the parse is asked only when the schema has none, and its
// mark says the wrapper words the issue itself.
const OURS = '\u0000worded by route()'
const ourMessage = () => OURS

async function parseRequest(shape, req) {
  const input = {}
  for (const part of PARTS) {
    const schema = shape[part]
    if (!schema) continue
    const raw = part === 'body' ? (req.body ?? {}) : req[part]
    const r = await request.run(req, () => schema.safeParseAsync(raw ?? {}, { error: ourMessage, reportInput: true }))
    if (!r.success) return { refusal: refusalOf(part, r.error.issues, schema) }
    input[part] = r.data
  }
  return { input }
}

function declared(name, shape, handler) {
  return async (req, res) => {
    const { input, refusal } = await parseRequest(shape, req)
    if (refusal) return res.status(400).json({ error: refusal })
    let repo
    const ctx = {
      req, res, gitopsDir: req.gitopsDir,
      get repo() { return (repo ??= openRepo(req.gitopsDir)) },
    }
    const out = await handler(input, ctx)
    if (out && typeof out === 'object' && Number.isInteger(out.status) && 'body' in out && !res.headersSent) {
      res.status(out.status).json(out.body)
    }
  }
}

function pathSchema(intent, opts, pick) {
  const { what, suffix, under } = opts
  return z.any().transform(async (raw, ctx) => {
    const req = request.getStore()
    const root = req?.gitopsDir
    const base = typeof under === 'function' ? under({ root, params: req?.params ?? {} }) : under
    const p = await parsePath(raw, intent, { root, under: base, suffix, what })
    if (!p.ok) {
      ctx.addIssue({ code: 'custom', message: p.error, params: { [PATH_ISSUE]: true, kind: p.kind } })
      return z.NEVER
    }
    return pick(p)
  })
}

/**
 * A value that becomes a path in the repo, decided by parsePath as
 * `intent` takes it (paths.js: 'read', 'list', 'create', 'deployment', …),
 * in the repo of the request: the input is `{ rel, abs }` (the path as the
 * repo names it, where it is on disk). `what` names it in a refusal;
 * `under` (a folder, or ({ root, params }) → one) and `suffix` as parsePath
 * takes them. Left out, it is refused as missing; `.optional()` lets it be.
 *   query: z.object({ folder: repoPath('deployment', { what: 'folder path' }) })
 *   ?folder=../x → 400 { error: 'Invalid folder path: a path cannot go up with ..' }
 */
export const repoPath = (intent, opts = {}) => pathSchema(intent, opts, p => ({ rel: p.rel, abs: p.abs }))

/**
 * A name (a one-segment intent: 'name', 'folder-name', 'file',
 * 'rules-file'), decided by parsePath: the input is the name itself.
 *   params: z.object({ chart: repoName('name', { what: 'chart name' }) })
 */
export const repoName = (intent, opts = {}) => pathSchema(intent, opts, p => p.rel)

// The path a router or middleware is mounted at (router.use(path, …)):
// Express 4 keeps only its regexp. '' at the router's own path.
//   ^\/inner\/?(?=\/|$) → '/inner';  ^(?:\/([^/]+?))\/x… → '/:chart/x'
function mountOf(layer) {
  if (layer.regexp?.fast_slash || !layer.regexp) return ''
  let i = 0
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => `/:${layer.keys[i++]?.name ?? 'param'}`)
    .replace(/\\(.)/g, '$1')
}

/**
 * A middleware that only passes a request on (next()), never answering it
 * itself, for declaredRoutes to take: what answers a request is a declared
 * route. A failure of it is still answered (500), as a route's is.
 *   router.use(passesOn((req, res, next) => (req.method === 'GET' ? next() : hold(req, res, next))))
 */
export function passesOn(fn) {
  fn[PASSES_ON] = true
  return fn
}
const PASSES_ON = Symbol('passes the request on')
// The app's own, which only pass a request on.
const KNOWN_PASS_ON = new Set([answersWithoutPaths, holdSyncRegistryLock])
const passes = fn => !!fn[PASSES_ON] || KNOWN_PASS_ON.has(fn)

/**
 * Every route of `router` declares its request (route(name, shape,
 * handler)), or this throws naming each that does not, with the path it
 * is mounted at: a router whose route reads an undeclared request does
 * not start. Refused the same way: a method and path declared twice, a
 * router.param (a route declares its params), a middleware not known to
 * only pass the request on (passesOn). Middleware is answered as a route
 * is, named after its path; a router mounted in it is held to the same.
 */
export function declaredRoutes(router) {
  const missing = []
  const twice = []
  const other = []
  const walk = (r, prefix) => {
    if (r.params && Object.keys(r.params).length) other.push(`router.param(${Object.keys(r.params).join(', ')}) at ${prefix || '/'}`)
    const seen = new Set()
    for (const layer of r.stack) {
      if (layer.route) {
        const at = `${prefix}${layer.route.path}`
        const name = `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${at}`
        for (const m of Object.keys(layer.route.methods)) {
          const key = `${m.toUpperCase()} ${at}`
          if (seen.has(key)) twice.push(key)
          seen.add(key)
        }
        // The last handler of a route answers it; what runs before it is middleware.
        const handlers = layer.route.stack
        if (!handlers.length || !handlers.at(-1).handle[DECLARED]) missing.push(name)
        for (const l of handlers) l.handle = wrap(name, l.handle, { mustAnswer: false })
      } else if (Object.getPrototypeOf(layer.handle) === express.Router) {
        walk(layer.handle, `${prefix}${mountOf(layer)}`)
      } else {
        const at = `${prefix}${mountOf(layer)}` || '/'
        if (!passes(layer.handle)) other.push(`middleware ${layer.handle.name || 'anonymous'} at ${at} may answer a request itself (passesOn() takes one that only passes it on)`)
        layer.handle = wrap(`middleware ${layer.handle.name || 'anonymous'} at ${at}`, layer.handle, { mustAnswer: false })
      }
    }
  }
  walk(router, '')
  const problems = [
    missing.length && `these routes do not declare their request (route(name, shape, handler)): ${missing.join(', ')}`,
    twice.length && `these routes are declared twice: ${[...new Set(twice)].join(', ')}`,
    ...other,
  ].filter(Boolean)
  if (problems.length) throw new Error(problems.join('; '))
  return router
}

/**
 * The app's last error handler: an error no route answered (one passed on
 * with next(err)) is a JSON 500 without a stack or a path of the machine,
 * not Express's HTML page.
 */
export function answerUncaught(err, req, res, next) {
  if (res.headersSent) return next(err)
  answer('app', err, req, res)
}
