/**
 * The app's JSON body parser, and the answer when a body cannot be taken:
 * a body that is not JSON is a 400, one over the size limit a 413, either
 * as JSON saying so — not Express's error page, which carries a stack trace
 * with the server's paths. The parser runs before any route, so a route
 * cannot answer this itself.
 *
 *   app.use(jsonBody())
 *   POST {"a":   → 400 { error: 'The request body is not JSON' }
 */
import express from 'express'

// express.json()'s own default.
export const BODY_LIMIT = '100kb'

function bodyRefused(err, req, res, next) {
  if (!err || typeof err.type !== 'string' || res.headersSent) return next(err)
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not JSON' })
  if (err.type === 'entity.too.large') return res.status(413).json({ error: `The request body is over ${BODY_LIMIT}` })
  // An encoding or a charset the parser does not read, a body cut short.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 400
  return res.status(status).json({ error: 'The request body cannot be read' })
}

export function jsonBody() {
  return [express.json({ limit: BODY_LIMIT }), bodyRefused]
}
