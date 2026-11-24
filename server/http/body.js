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

/**
 * The 4xx of an error Express or the body parser raised about the request
 * itself, or null: an http-error they mark to show (`expose`), or the
 * URIError of a URL that does not decode. An error of AlertForge's own
 * with a `status` is not one of these.
 */
export function clientStatus(err) {
  const s = err?.status ?? err?.statusCode
  if (!Number.isInteger(s) || s < 400 || s >= 500) return null
  return err.expose === true || err instanceof URIError ? s : null
}

/** What a request the server cannot take is answered, in words. */
export function clientRefusal(err) {
  const status = clientStatus(err)
  if (err instanceof URIError) return { status, error: 'The request\'s URL holds a %-encoding that does not decode' }
  if (err?.type === 'entity.parse.failed') return { status, error: 'The request body is not JSON' }
  if (err?.type === 'entity.too.large' || status === 413) return { status, error: `The request body is over ${BODY_LIMIT}` }
  if (status === 415) return { status, error: 'The request body is in an encoding or a charset the server does not read' }
  return { status, error: 'The request cannot be read' }
}

function bodyRefused(err, req, res, next) {
  if (!err || res.headersSent || !clientStatus(err)) return next(err)
  const { status, error } = clientRefusal(err)
  return res.status(status).json({ error })
}

export function jsonBody() {
  return [express.json({ limit: BODY_LIMIT }), bodyRefused]
}
