/**
 * route(name, handler): a route that always answers and always lets the
 * commit lock go.
 *
 * Express 4 does not catch an async handler's rejection: no answer is sent,
 * Node may end the process, and a write holding the commit lock
 * (holdSyncRegistryLock, released when the answer ends) keeps it until its
 * time limit. A handler given to route() is answered whatever it does:
 *   - it throws or rejects with a file of the repo that cannot be read (an
 *     UnreadableError, or a Loaded that is `unreadable` asked for its value)
 *     → 409 naming the file in the repo, `unreadable: true`
 *   - it throws or rejects with anything else → 500 saying the server
 *     failed, with no path of the machine in it; the error is logged with
 *     the route's name
 *   - it ends without answering (and without passing the request on)
 *     → the same 500, logged as "no answer"
 * Answering ends the response, which lets the lock go at once.
 *
 *   router.get('/diff', route('git.diff', async (req, res) => { … }))
 *
 * answerEveryRoute(router) gives the same to every handler of a router
 * not wrapped yet (named after its method and path), and to the routers
 * mounted in it, until each route is wrapped by name.
 */
import express from 'express'
import { UnreadableError } from '../lib/readIfThere.js'
import { NotLoadedError } from '../repo/loaded.js'
import { withoutPath } from '../lib/answerPaths.js'
import { logger } from '../lib/logger.js'

const WRAPPED = Symbol('route')
export const FAILED = 'The server could not answer this request; the cause is in its log'

/** The answer to a failure: { status, body }. */
export async function failureAnswer(err, gitopsDir) {
  if (err instanceof NotLoadedError && err.loaded?.state === 'unreadable') {
    return { status: 409, body: { error: await withoutPath(err.message, gitopsDir), unreadable: true } }
  }
  if (err instanceof UnreadableError) {
    return { status: 409, body: { error: await withoutPath(err.message, gitopsDir), unreadable: true } }
  }
  return { status: 500, body: { error: FAILED } }
}

async function answer(name, err, req, res) {
  try {
    logger.error({ err, route: name, method: req.method, url: req.originalUrl }, 'a route failed outside its own error handling')
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    const { status, body } = await failureAnswer(err, req.gitopsDir)
    res.status(status).json(body)
  } catch (e) {
    logger.error({ err: e }, 'could not answer a failed route')
    if (!res.writableEnded) res.end()
  }
}

function wrap(name, fn, { mustAnswer }) {
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
      () => { if (mustAnswer && !passed && !res.headersSent) answer(name, new Error('the route ended without an answer'), req, res) },
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

export function route(name, handler) {
  if (typeof name !== 'string' || typeof handler !== 'function') throw new TypeError('route(name, handler)')
  return wrap(name, handler, { mustAnswer: true })
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
