const basePath = () => (typeof window !== 'undefined' && window.__BASE_PATH__) || '/'

/**
 * The server answered, but its answer could not be read: cut off on the way,
 * or not JSON (#147). For a change (POST, PUT, DELETE) the server may well
 * have made it, so the page cannot say it failed: `uncertain` says so.
 */
export class AnswerCutOff extends Error {
  constructor(method, path, cause) {
    super(`The server's answer to ${method} ${path} could not be read: ${cause?.message || cause}`)
    this.name = 'AnswerCutOff'
    this.method = method
    this.uncertain = method !== 'GET' && method !== 'HEAD'
  }
}

/** What the page says when nothing else caught one (main.jsx). */
// Not "cut off": an answer that is not JSON (a proxy's login page when the
// session has run out, say) lands here too.
export const cutOffMessage = err => (err.uncertain
  ? 'The server\'s answer could not be read, so whether the change was made is not known. Reload the page to see what the server has (and to sign in again, if asked).'
  : 'The server\'s answer could not be read. Reload the page (and sign in again, if asked).')

export async function apiFetch(path, opts) {
  const base = basePath().replace(/\/$/, '')
  const url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`
  let res
  try {
    res = await fetch(url, opts)
  } catch (err) {
    return { ok: false, status: 0, json: async () => ({ error: err.message }) }
  }
  // Every caller reads the answer with res.json(): wrapped here, once, so a
  // failure to read it is one known error rather than any of them.
  // Anything without a json() (a stand-in, say) is passed on as it is.
  if (typeof res?.json !== 'function') return res
  const json = res.json.bind(res)
  const method = (opts?.method || 'GET').toUpperCase()
  Object.defineProperty(res, 'json', {
    value: async () => {
      try {
        return await json()
      } catch (err) {
        throw new AnswerCutOff(method, path, err)
      }
    },
  })
  return res
}
