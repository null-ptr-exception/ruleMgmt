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
 * `notChecked`: what is behind it was not looked at (notCheckedCode). `blocksRender`: Helm cannot
 * render the deployment, so it is not rendered to check its rules.
 */

// What keeps a check from looking, as check-deployment's exit 2 says it: a
// folder the walk cannot read (whether its deployments are there cannot be
// told), sync.yaml or the shared configs that cannot be read (whom each
// deployment follows, or sends to, cannot be told). A file of a deployment
// or a Template that cannot be read, or values whose reading by Helm
// cannot be told, is not here: Helm decides, and the deployment would not
// deploy as written (exit 1).
const NOT_CHECKED = new Set(['sync.unreadable', 'shared.unreadable', 'template.folder-unreadable'])

/** Whether a finding code says what is behind it was not looked at. */
// Values whose Chart.yaml names no Template were looked at: they deploy nothing (exit 1).
export const notCheckedCode = code => (code.startsWith('walk.') && code !== 'walk.values-no-template') || NOT_CHECKED.has(code)

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
