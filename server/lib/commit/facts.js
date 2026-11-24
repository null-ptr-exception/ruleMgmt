/**
 * What the commit check collects (commitChecks.js, chartChecks.js), one
 * entry per fact, with what the table it was asked with does with it — for
 * check-repo, which prints each naming its file; Commit answers its own
 * shape and does not show these.
 *
 *   { action: 'refuse' | 'warn' | 'list', code, file, owner, message,
 *     notChecked?, blocksRender? }
 *
 * `owner`: the deployment, Template folder or repo file it is said under.
 * `notChecked`: the file could not be read, or what Helm makes of it cannot
 * be told: what is behind it was not checked. `blocksRender`: Helm cannot
 * render the deployment, so it is not rendered to check its rules.
 */

const CANNOT_TELL = new Set(['yaml.cannot-read', 'template.values-cannot-tell', 'template.chart-cannot-tell', 'template.schema-unchecked', 'template.schema-unusable'])

/** Whether a finding code says the file was not read, or cannot be told. */
export const notCheckedCode = code => /(^|[.-])unreadable$/.test(code) || code.startsWith('walk.') || CANNOT_TELL.has(code)

export function fact(action, f, owner, more = {}) {
  const out = { action, code: f.code, file: f.file || owner, owner, message: f.message }
  if (more.notChecked ?? notCheckedCode(f.code)) out.notChecked = true
  if (more.blocksRender) out.blocksRender = true
  return out
}

/** decide()'s answer as facts, each under `owner`. */
export const factsOf = (d, owner, more) => [
  ...d.refuse.map(f => fact('refuse', f, owner, more)),
  ...d.warn.map(f => fact('warn', f, owner, more)),
  ...d.list.map(f => fact('list', f, owner, more)),
]
