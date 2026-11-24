/**
 * The facts about a deployment's values, from what loadDeployment read:
 * what the Template's schema says of the values the Template sees (Helm
 * fails on those), and — only when the schema is satisfied — the editor's
 * own checks (a required cell left empty, a value a label cannot take, a
 * derived value promtool refuses, selectors that cannot be matched on, rows
 * the row identity label cannot tell apart). Each names its group, row and
 * column in the words the editor uses ("cpu row 1, "threshold": …").
 *
 * A problem in a part of the values the deployment does not write itself
 * (a group it inherits from a _common, a Common Value a layer gives) is the
 * layer's: its code is under `stack.` (policy.js: a save warns, Commit lists).
 *
 *   valueFindings(dep, { every }) → Finding[]
 *     every  each kind of check, not only up to the first that finds a
 *            problem: a migration tells a new problem from one the values
 *            had, which a problem of the first kind would hide
 */
import { finding } from '../finding.js'
import { valueProblems, rowIdentityRepeats } from '../../../src/utils/rulesFile.js'
import { selectorValueProblems } from '../../../src/utils/selectorContract.js'
import { durationCellFault } from '../../../src/utils/duration.js'

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const kindOf = v => (v === null ? 'null' : Array.isArray(v) ? 'a list' : isMap(v) ? 'a map' : JSON.stringify(v))
const get = (v, path) => path.reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), v)
const TYPE_WORDS = { string: 'text', number: 'a number', integer: 'a whole number', boolean: 'true or false', object: 'a map', array: 'a list', null: 'null' }

/** Where a schema problem is, in the editor's words: `cpu row 1, "threshold"`. */
function placeOf(path) {
  const [group, row, column, ...rest] = path
  if (group === undefined) return { where: 'the values' }
  if (group === '_common') return row === undefined ? { where: 'Common Values', group } : { where: `Common Values, "${row}"`, group, column: row }
  if (row === undefined) return { where: group, group }
  if (typeof row !== 'number') return { where: [group, row, column, ...rest].filter(x => x !== undefined).join('.'), group }
  if (column === undefined) return { where: `${group} row ${row + 1}`, group, row }
  return { where: `${group} row ${row + 1}, "${[column, ...rest].join('.')}"`, group, row, column }
}

/** One schema problem in the editor's words; today's wording where there is one. */
export function schemaWording(f, values, model = null) {
  const path = f.at?.path ?? []
  const { keyword, params = {} } = f.detail ?? {}
  const v = get(values, path)
  const place = placeOf(path)
  let what
  if (keyword === 'required') {
    const name = params.missingProperty
    const inner = placeOf([...path, name])
    return { ...inner, column: name, message: `${inner.where}: required — fill it in` }
  }
  if (keyword === 'type') {
    const want = String(params.type ?? '').split(',')
    const col = place.group === '_common' ? model?.common?.columns?.[place.column] : model?.groups?.[place.group]?.columns?.[place.column]
    if (col?.type === 'duration' && typeof v === 'number') what = durationCellFault(v, null)
    else if (want.includes('array') && place.row === undefined && place.group && place.group !== '_common') what = `must be a list of rows, not ${kindOf(v)}`
    else if (want.includes('object') && place.row !== undefined && place.column === undefined) what = `must be a map of column to value, not ${kindOf(v)}`
    else if (want.includes('object') && place.group === '_common' && place.column === undefined) what = `must be a map of name to value, not ${kindOf(v)}`
    else if (isMap(v) || Array.isArray(v)) what = `${kindOf(v)} — a value is text, a number or true/false`
    else what = `${kindOf(v)} is not ${want.map(t => TYPE_WORDS[t] ?? t).join(' or ')}`
  } else if (keyword === 'enum') {
    what = `${kindOf(v)} is not one of ${(params.allowedValues ?? []).join(', ')}`
  } else if (keyword === 'pattern' || keyword === 'x-af-pattern') {
    // A duration column says what to write, as the editor does.
    const col = place.group === '_common' ? model?.common?.columns?.[place.column] : model?.groups?.[place.group]?.columns?.[place.column]
    what = (col?.type === 'duration' && durationCellFault(v, null)) || `${kindOf(v)} is not in the form the Template asks for (${params.pattern ?? 'its pattern'})`
  } else if (keyword === 'minLength') {
    what = `${kindOf(v)} is too short`
  } else {
    what = f.message.replace(/^\S+: (\S+ )?/, '')
  }
  const sep = place.group === '_common' && place.column === undefined ? ' ' : ': '
  return { ...place, message: `${place.where}${sep}${what}` }
}

// A problem is the deployment's own unless the place it is in (a group, a
// Common Value) is given below it — by a _common or the Template's own
// values.yaml — and not written by the deployment.
const has = (v, group, column) => {
  if (!isMap(v) || !Object.hasOwn(v, group)) return false
  if (group !== '_common' || column === undefined) return true
  return isMap(v._common) && Object.hasOwn(v._common, column)
}
function ownsIt(bare, below, group, column) {
  if (group === undefined || group === null) return true
  if (has(bare, group, column)) return true
  return !below.some(v => has(v, group, column))
}

export function valueFindings(dep, { every = false } = {}) {
  const { file, effective, bare, template, model, layers, isLayer } = dep
  const out = []
  if (!template) return out
  const below = [...layers.map(l => l.values), template.defaults]
  const mine = (group, column) => ownsIt(bare, below, group, column)
  const cell = (code, p, extra = {}) => ({ group: p.group, row: p.row ?? null, column: p.column, ...extra })

  // 1. The Template's schema, on what the Template sees.
  const schema = template.validate(effective)
  for (const f of schema) {
    // A _common need not be complete: a group or a Common Value it leaves
    // out is its deployments' to give, and each deployment is checked whole.
    const at = f.at?.path ?? []
    if (isLayer && f.detail?.keyword === 'required' && (at.length === 0 || (at.length === 1 && at[0] === '_common'))) continue
    const w = schemaWording(f, effective, model)
    const own = (f.detail?.keyword === 'required' && w.group === '_common') || mine(w.group, w.column)
    // A value the schema requires and nothing gives: to be filled in.
    const code = !own ? 'stack.schema' : f.detail?.keyword === 'required' ? 'values.required' : 'values.schema'
    out.push(finding({ code, file, helm: template.columnsSchema ? 'renders-differently' : 'fails', at: { path: f.at?.path ?? [] }, message: own ? w.message : `${w.message} (given by a _common above, or the Template)`, detail: cell('', w) }))
  }
  // A value only missing (to be filled in) leaves the rest to check.
  if (!model || (schema.some(f => f.detail?.keyword !== 'required') && !every)) return out

  // 2. The editor's checks, only on values the schema lets through.
  // A required value the schema already said is missing is said once.
  const said = new Set(out.filter(f => f.code === 'values.required').map(f => [f.detail?.group, f.detail?.row ?? null, f.detail?.column].join('|')))
  for (const p of valueProblems(effective, model)) {
    if (isLayer && p.required && p.group === '_common') continue
    if (p.required && said.has([p.group, p.row ?? null, p.column].join('|'))) continue
    // A required Common Value left empty is the deployment's to fill,
    // whoever left it so; a cell of a row a _common gives is the _common's.
    const own = (p.required && p.group === '_common') || mine(p.group, p.column)
    const kind = p.required ? 'required-empty' : /derived/.test(p.message) ? 'derived' : 'cell'
    out.push(finding({
      code: `${own ? 'values' : 'stack'}.${kind}`, file, helm: 'renders',
      ...(kind === 'derived' ? { deploy: 'fails' } : {}),
      message: own ? p.message : `${p.message} (given by a _common above, or the Template)`,
      detail: cell('', p, p.required ? { required: true } : {}),
    }))
  }
  if (out.length && !every) return out
  const sel = selectorValueProblems(effective, model)
  for (const p of sel.problems) {
    const own = mine(p.group, p.column)
    out.push(finding({ code: own ? 'values.selector' : 'stack.selector', file, helm: 'renders', message: p.message, detail: { ...cell('', p), cellProblem: !!p.cell, ...(p.cell !== undefined ? { cell: p.cell } : {}) } }))
  }
  if (out.length) {
    dep.proposals = sel.proposals
    return out
  }
  // 3. Said, never refused: rows the row identity label cannot tell apart.
  for (const r of rowIdentityRepeats(effective, model)) {
    out.push(finding({ code: 'values.rows-alike', file, helm: 'renders', message: r.message }))
  }
  return out
}
