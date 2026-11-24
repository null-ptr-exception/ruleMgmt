/**
 * route(name, handler): a route that always answers and always lets the
 * commit lock go.
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
 *     it gives after returning (res.sendFile, a callback) is waited for
 *   - what it writes after the wrapper answered is dropped, not thrown
 * Answering ends the response, which lets the lock go at once.
 *
 *   router.get('/diff', route('git.diff', async (req, res) => { … }))
 *
 * answerEveryRoute(router) gives the same to every handler of a router
 * not wrapped yet (named after its method and path), and to the routers
 * mounted in it, until each route is wrapped by name.
 */
import express from 'express'
import { errorAnswer } from '../lib/readIfThere.js'
import { clientStatus, clientRefusal } from './body.js'
import { withoutPath } from '../lib/answerPaths.js'
import { logger } from '../lib/logger.js'
import { HOLD_LIMIT_MS } from '../lib/sync.js'

const WRAPPED = Symbol('route')
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
 * Whether the response is answered (finished, or the client gone) within
 * `ms`: a handler may answer after it returns (res.sendFile, a callback).
 */
function answeredWithin(res, ms) {
  if (res.writableEnded || res.destroyed) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = answered => { clearTimeout(timer); res.off('finish', yes); res.off('close', yes); resolve(answered) }
    const yes = () => done(true)
    const timer = setTimeout(() => done(res.writableEnded || res.headersSent), ms)
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
        if (!passed) answer(name, new Error(`the route did not answer within ${deadlineMs} ms`), req, res)
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
export function route(name, handler, { deadlineMs } = {}) {
  if (typeof name !== 'string' || typeof handler !== 'function') throw new TypeError('route(name, handler)')
  return wrap(name, handler, { mustAnswer: true, deadlineMs })
}

export function answerEveryRoute(router) {
  for (const layer of router.stack) {
    if (layer.route) {
      const name = `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`
      for (const l of layer.route.stack) l.handle = wrap(name, l.handle, { mustAnswer: false })
    } else if (Object.getPrototypeOf(layer.handle) === express.Router) {
      answerEveryRoute(layer.handle)
    } else {
      layer.handle = wrap(`middleware ${layer.handle.name || 'anonymous'}`, layer.handle, { mustAnswer: false })
    }
  }
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
