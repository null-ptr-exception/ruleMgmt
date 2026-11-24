/**
 * Express 4 does not catch an async handler's rejection: an await that
 * fails outside the handler's own try (a path resolved before it, say) is
 * an unhandled rejection, no answer is sent, and Node ends the server
 * process on it. A router passed through this has every handler and
 * middleware in it — and in the routers it mounts — answer such a failure
 * the way the routes answer their own errors (errorAnswer): a file of the
 * repo that cannot be read is a 409 naming it, anything else a 500; either
 * without the workspace's path. Answering ends the response, which lets the
 * commit lock go (holdSyncRegistryLock). A synchronous throw is answered
 * the same way instead of Express's HTML error page.
 *
 * Called once, as a router factory returns its router, after every route
 * is added.
 */
import express from 'express'
import { errorAnswer } from './readIfThere.js'
import { withoutPath } from './answerPaths.js'
import { logger } from './logger.js'

const GUARDED = Symbol('answers its rejections')

async function answer(err, req, res) {
  try {
    logger.error({ err, method: req.method, url: req.originalUrl }, 'a route failed outside its own error handling')
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    const { status, body } = errorAnswer(err)
    res.status(status).json({ ...body, error: await withoutPath(body.error, req.gitopsDir) })
  } catch (e) {
    logger.error({ err: e }, 'could not answer a failed route')
    if (!res.writableEnded) res.end()
  }
}

function guard(fn) {
  if (fn[GUARDED]) return fn
  // The same number of parameters: Express tells an error handler by it.
  const guarded = fn.length === 4
    ? function (err, req, res, next) { run(() => fn.call(this, err, req, res, next), req, res) }
    : function (req, res, next) { run(() => fn.call(this, req, res, next), req, res) }
  guarded[GUARDED] = true
  return guarded
}

function run(call, req, res) {
  let out
  try {
    out = call()
  } catch (err) {
    answer(err, req, res)
    return
  }
  if (out && typeof out.then === 'function') out.then(undefined, err => answer(err, req, res))
}

export function answerRejections(router) {
  for (const layer of router.stack) {
    if (layer.route) {
      for (const l of layer.route.stack) l.handle = guard(l.handle)
    } else if (Object.getPrototypeOf(layer.handle) === express.Router) {
      answerRejections(layer.handle)
    } else {
      layer.handle = guard(layer.handle)
    }
  }
  return router
}
