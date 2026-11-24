/**
 * The rule-group fields a template owner may set, beyond the rules (#182):
 * what each value may be, and how it is written into a group of
 * `spec.groups[]`.
 *
 * Which of them a group may use is its output profile's call — `groupKeys`
 * in config/outputs.json — because each evaluator reads its own: Prometheus
 * 2.x has `query_offset` but no group `labels`, Prometheus 3.x has both,
 * vmalert has `labels` and its own `eval_offset`, `concurrency` and the rest
 * but no `query_offset`. A field the group's profile does not have is
 * refused at save, saying which ones it does have: a type change never
 * leaves behind a field the new evaluator would refuse, or drop unseen.
 *
 * Each check was measured against the tool that reads the field (promtool
 * 2.54.1, promtool 3.13.5, vmalert 1.155): AlertForge refuses what it
 * refuses, and in three places is stricter — said where.
 */

import { durationFault, durationNs, ruleDurationProblem } from './duration.js'
import { ROW_IDENTITY_LABEL } from './reservedNames.js'
import { durationScalar, keyScalar, nameScalar } from './yamlScalar.js'
import { hasUnclosedTemplate } from './ruleModel.js'

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v)
// The classic label name: what vmalert and VictoriaMetrics are kept to.
// (vmalert does not check a group label's name; a name it cannot store
// would only fail at write time, so AlertForge keeps to the safe set.)
const CLASSIC_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// A duration with a minus in front: a format error would hide what is wrong.
// promtool refuses a negative query_offset; vmalert takes a negative
// eval_offset (no further back than interval) and eval_delay — AlertForge
// does not, as for every other duration it writes.
const isNegative = value => typeof value === 'string' && value.startsWith('-') && durationFault(value.slice(1)).reason === null

// Otherwise as every duration in a rules file is read and worded.
function duration(key, value) {
  if (isNegative(value)) return `${key} ${value} is negative — a group's ${key} is 0s or more here`
  return ruleDurationProblem(key, value)
}

// A whole number the evaluator reads as one; JavaScript holds one exactly up
// to 2^53, far past any limit or concurrency anyone sets.
// The value as written: text in quotes, anything else as JSON.
const shownValue = value => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value))
const wholeNumber = (key, value) => (Number.isSafeInteger(value) && value >= 0 ? null : `${key} ${shownValue(value)} must be a whole number, 0 or more`)

function headerList(key, value) {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return `${key} must be a list of "Name: value" texts, e.g. ["X-Scope-OrgID: 1"]`
  const bad = value.find(v => !/^[^:\s][^:]*:/.test(v))
  if (bad !== undefined) return `${key} "${bad}" has no "Name:" — each entry is "Name: value"`
  const broken = value.find(v => /[\r\n]/.test(v))
  return broken === undefined ? null : `${key} "${broken.replace(/[\r\n]/g, ' ')}" has a line break — a header is one line`
}

function groupLabels(value, group, profile) {
  if (!isMap(value)) return 'labels must be a mapping of label name to text, e.g. {team: shop}'
  // The labels a selector matches (#60, #121): a group label of that name
  // would give every row's alert the same value — a duplicate labelset
  // Prometheus fails the whole rule on.
  // Read whatever shape the neighbours are in: a malformed selectors,
  // selectorLabels or rules is the parser's to report, not a reason to stop.
  const selectors = Array.isArray(group.selectors) ? group.selectors.filter(s => typeof s === 'string') : []
  const own = isMap(group.selectorLabels) ? group.selectorLabels : {}
  const rules = Array.isArray(group.rules) ? group.rules : []
  const matched = new Set(selectors.flatMap(col => [
    typeof own[col] === 'string' ? own[col] : col,
    ...rules.map(r => (isMap(r?.selectorLabels) ? r.selectorLabels[col] : undefined)).filter(v => typeof v === 'string'),
  ]))
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== 'string') return `labels "${name}": the value must be text — quote it, e.g. "${text}"`
    if (name === '') return 'labels: a label name cannot be empty'
    if (name.startsWith('__')) return `labels "${name}": a name starting with __ is reserved`
    if (name === ROW_IDENTITY_LABEL) return `labels "${name}": the name is reserved for AlertForge's row identity label`
    // Prometheus 3 takes any UTF-8 name (service.name); the others the
    // classic set.
    if (profile.validate !== 'promtool3' && !CLASSIC_NAME.test(name)) {
      return `labels "${name}": a ${profile.name} label name is letters, digits and _, not starting with a digit`
    }
    if (/\$\{/.test(text)) return `labels "${name}": a group label cannot read a column or vars entry — one object holds many rows; put it on the rule`
    if (/[\r\n]/.test(text)) return `labels "${name}": a label value is one line`
    if (hasUnclosedTemplate(text)) return `labels "${name}": has a {{ with no }} after it — the evaluator cannot read it as a template`
    if (matched.has(name)) return `labels "${name}": the group's selectors match this label — a group label would overwrite it on every rule`
  }
  return null
}

/**
 * Every field, in the order it is written. `kind` is what the editor offers
 * for it and how it is written; `check(value, group, profile)` says what is
 * wrong, or null. `label`, `placeholder` and `width` are the editor's, when
 * they are not the field's name, 'default' and its kind's width.
 */
export const GROUP_FIELDS = {
  interval: { kind: 'duration', check: v => duration('interval', v), label: 'Interval', width: 90 },
  // A whole number JavaScript holds exactly: 1e20 is one to YAML, and
  // promtool refuses it.
  limit: { kind: 'integer', check: v => wholeNumber('limit', v), label: 'Limit', placeholder: 'none', width: 90 },
  query_offset: { kind: 'duration', check: v => duration('query_offset', v) },
  labels: { kind: 'labels', check: groupLabels },
  eval_offset: {
    kind: 'duration',
    check: (v, group) => {
      const why = duration('eval_offset', v)
      if (why) return why
      if (group.eval_delay !== undefined) return 'eval_offset and eval_delay cannot both be set — vmalert refuses the pair'
      // vmalert takes `eval_offset: 0s` with no interval; refused here, as
      // an offset into an interval that is not set says nothing.
      if (group.interval === undefined) return 'eval_offset needs interval — it is a point inside each interval'
      // A malformed interval is reported as such; nothing to compare with.
      const iv = typeof group.interval === 'string' ? durationNs(group.interval) : null
      if (iv !== null && durationNs(v) > iv) return `eval_offset ${v} is more than interval ${group.interval} — it is a point inside each interval`
      return null
    },
  },
  eval_delay: { kind: 'duration', check: v => duration('eval_delay', v) },
  concurrency: { kind: 'integer', check: v => wholeNumber('concurrency', v) },
  eval_alignment: { kind: 'boolean', check: v => (typeof v === 'boolean' ? null : `eval_alignment must be true or false, not ${JSON.stringify(v)}`) },
  headers: { kind: 'list', check: v => headerList('headers', v) },
  notifier_headers: { kind: 'list', check: v => headerList('notifier_headers', v) },
  params: {
    kind: 'params',
    check: v => (isMap(v) && Object.values(v).every(l => Array.isArray(l) && l.every(x => typeof x === 'string'))
      ? null
      : 'params must be a mapping of name to a list of texts, e.g. {nocache: ["1"]}'),
  },
}

/** Every field's name, in the order it is written. */
export const GROUP_FIELD_NAMES = Object.keys(GROUP_FIELDS)

/** The fields a group of no profile's choosing has always had. */
export const BASE_GROUP_FIELDS = ['interval', 'limit']

/** What is wrong with a group's fields for its profile, one message each. */
// `shown` is the type as the file says it (`prometheus` for prometheus2);
// `typesWith(key)` the other types that have a field, to say where it is.
// With no profile (a type that is none), only the fields every group has
// are checked: which others it has cannot be told.
export function groupFieldProblems(group, profile, { shown = profile?.name, typesWith = () => [] } = {}) {
  const out = []
  for (const key of GROUP_FIELD_NAMES) {
    if (group[key] === undefined) continue
    if (!profile) {
      if (BASE_GROUP_FIELDS.includes(key)) {
        const why = GROUP_FIELDS[key].check(group[key], group, profile)
        if (why) out.push(why)
      }
      continue
    }
    if (!profile.groupKeys.includes(key)) {
      const others = typesWith(key).filter(t => t !== profile.name)
      out.push(`${key} is not a group field of a ${shown} group — it has ${profile.groupKeys.join(', ')}${others.length ? `; ${others.join(', ')} ${others.length > 1 ? 'have' : 'has'} ${key}` : ''}`)
      continue
    }
    const why = GROUP_FIELDS[key].check?.(group[key], group, profile)
    if (why) out.push(why)
  }
  return out
}

const indent = '        '

/**
 * One extra field's lines under `- name:` in a generated template. Names
 * and texts go through the same quoting as everything else the generator
 * writes: bare unless YAML 1.1 would read them as something else, and a
 * `{{ }}` printed rather than run by Helm. An empty map or list writes
 * nothing, which is what the evaluator makes of it.
 */
/**
 * The value as the evaluator receives it: an empty list in params is no
 * values (vmalert takes `q: []` and `q:` alike), so it is left out, as an
 * empty map or list is. What the generated helm-unittest suite expects.
 */
export function renderedGroupValue(key, value) {
  if (GROUP_FIELDS[key].kind !== 'params') return value
  return Object.fromEntries(Object.entries(value).filter(([, list]) => list.length))
}

export function renderGroupField(key, given) {
  const kind = GROUP_FIELDS[key].kind
  const value = renderedGroupValue(key, given)
  // '0' is a duration; written bare YAML reads it as a number, and the
  // resource's field is text (#172).
  if (kind === 'duration') return `      ${key}: ${durationScalar(value)}\n`
  if (kind === 'integer' || kind === 'boolean') return `      ${key}: ${value}\n`
  if (kind === 'list') {
    return value.length ? `      ${key}:\n` + value.map(v => `${indent}- ${nameScalar(v)}\n`).join('') : ''
  }
  const entries = Object.entries(value)
  if (!entries.length) return ''
  if (kind === 'labels') return `      ${key}:\n` + entries.map(([k, v]) => `${indent}${keyScalar(k)}: ${nameScalar(v)}\n`).join('')
  // params: name → list of values, in block style — a value may hold a comma.
  return `      ${key}:\n` + entries.map(([k, list]) => `${indent}${keyScalar(k)}:\n` + list.map(v => `${indent}  - ${nameScalar(v)}\n`).join('')).join('')
}
