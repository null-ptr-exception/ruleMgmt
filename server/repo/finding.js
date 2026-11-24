/**
 * A fact about a file of the repo. It says what is there and what Helm does
 * with it; it never says whether a caller refuses — that is policy.js.
 *
 *   {
 *     code:    'yaml.not-yaml', 'values.schema', …  (lower case, dot-separated)
 *     file:    the path in the repo ('' when the text has no file yet)
 *     helm:    what Helm does with it:
 *                'fails'                Helm stops on it
 *                'renders'              Helm renders it as written
 *                'renders-differently'  Helm renders, but not what was written
 *                                       (or not the same way each time)
 *                'n/a'                  Helm never reads it (rules/, sync.yaml)
 *                'unknown'              AlertForge cannot tell what Helm does
 *     message: one line for the person who wrote the file
 *     at?:     where in the file: { line } for a YAML text, { path } for a
 *              value ([group, row, column] as the schema sees it)
 *     deploy?: 'fails' when Helm renders it but the rules it renders cannot
 *              be loaded (promtool refuses them)
 *   }
 */
export const HELM = Object.freeze(['fails', 'renders', 'renders-differently', 'n/a', 'unknown'])

const CODE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** A checked, frozen Finding; a wrong shape is a mistake in AlertForge, so it throws. */
export function finding({ code, file = '', helm, message, at, deploy }) {
  if (typeof code !== 'string' || !CODE.test(code)) throw new TypeError(`a finding's code is lower-case words with dots, not ${JSON.stringify(code)}`)
  if (!HELM.includes(helm)) throw new TypeError(`a finding's helm is one of ${HELM.join(', ')}, not ${JSON.stringify(helm)}`)
  if (typeof message !== 'string' || !message) throw new TypeError('a finding needs a message')
  if (typeof file !== 'string') throw new TypeError('a finding\'s file is a path in the repo')
  if (deploy !== undefined && deploy !== 'fails') throw new TypeError(`a finding's deploy is 'fails' or left out, not ${JSON.stringify(deploy)}`)
  const out = { code, file, helm, message }
  if (at !== undefined) out.at = Object.freeze({ ...at, ...(Array.isArray(at.path) ? { path: Object.freeze([...at.path]) } : {}) })
  if (deploy !== undefined) out.deploy = deploy
  return Object.freeze(out)
}
