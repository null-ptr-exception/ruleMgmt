/**
 * The app's JSON body parser, and the answer when a body cannot be taken:
 * a body that is not JSON is a 400, one over the size limit a 413, either
 * as JSON saying so — not Express's error page, which carries a stack trace
 * with the server's paths. The parser runs before any route, so a route
 * cannot answer this itself.
 *
 *   app.use(jsonBody())
 *   POST {"a":   → 400 { error: 'The request body is not JSON' }
 * A body nested deeper than BODY_MAX_DEPTH is a 400 too (tooDeep).
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

/**
 * How deep a body's maps and lists may go. What the pages send is a few
 * levels (values: chart, group, row, cell; a routing table: cells, match,
 * a label); the routes read a body by recursion (the schema, YAML), which
 * runs out of stack near 3000 levels. 256 is far from both.
 */
export const BODY_MAX_DEPTH = 256

// How deep `v` goes, a map or a list being one level; stops counting past `max`.
function depthOf(v, max) {
  let deepest = 0
  const stack = [[v, 1]]
  while (stack.length) {
    const [x, d] = stack.pop()
    if (x === null || typeof x !== 'object') continue
    if (d > deepest) deepest = d
    if (deepest > max) return deepest
    for (const k in x) if (Object.hasOwn(x, k)) stack.push([x[k], d + 1])
  }
  return deepest
}

/**
 * A body nested deeper than BODY_MAX_DEPTH: a 400 naming where it goes
 * that deep, before any route reads it.
 *   { "values": {"a":{"a": … 300 levels }} }
 *     → 400 { error: 'The request body is nested too deeply: values.a goes more than 256 levels deep' }
 */
function tooDeep(req, res, next) {
  const body = req.body
  if (body === null || typeof body !== 'object') return next()
  if (depthOf(body, BODY_MAX_DEPTH) <= BODY_MAX_DEPTH) return next()
  // Where it goes that deep, named two levels down (chartMeta.description,
  // values.cpu): the body is a level, and each key below it.
  const at = []
  let node = body
  for (let left = BODY_MAX_DEPTH - 1; at.length < 2 && node !== null && typeof node === 'object'; left--) {
    const key = Object.keys(node).find(k => depthOf(node[k], left) > left)
    if (key === undefined) break
    at.push(Array.isArray(node) ? `[${key}]` : (at.length ? `.${key}` : key))
    node = node[key]
  }
  const what = at.length && !Array.isArray(body) ? `${at.join('')} goes` : 'it goes'
  return res.status(400).json({ error: `The request body is nested too deeply: ${what} more than ${BODY_MAX_DEPTH} levels deep` })
}

export function jsonBody() {
  return [express.json({ limit: BODY_LIMIT }), bodyRefused, tooDeep]
}
