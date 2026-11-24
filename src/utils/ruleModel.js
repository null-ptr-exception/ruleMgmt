/**
 * Canonical rule model (`x-rules`) — see issue #57.
 *
 * A rule entry borrows its field names from a Prometheus rule group's
 * `rules[]` (alert / expr / for / labels / annotations). It is NOT a loadable
 * rules file: values carry `${var}` placeholders that are resolved when the
 * chart template is generated.
 *
 * {
 *   alert: 'MariadbNetworkReceiveHigh',
 *   expr:  'rate(node_network_receive_bytes_total{pod=~"${pod_regex}"}[5m]) > ${recv_warn}',
 *   for:   '5m',
 *   labels:      [{ key: 'severity', value: 'warning' }],
 *   annotations: [{ key: 'summary',  value: 'receive is {{ $value }} B/s' }]
 * }
 *
 * Two placeholder syntaxes coexist and must not be confused:
 *   ${var}    our variable   -> becomes a Helm reference ({{ $row.var }})
 *   {{ ... }} Prometheus     -> escaped so Helm passes it through untouched,
 *                               evaluated by Prometheus when the alert fires
 */

const VAR_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g
const HELM_PASSTHROUGH_RE = /\{\{([\s\S]*?)\}\}/g

// What escapePrometheusTemplates rewrites, leftmost first: a whole
// `{{ … }}`; else a run of `{` holding a `{{` that no `}}` follows; else one
// `{` right before a `${var}`, which becomes `{{ … }}` and would make `{{{`.
const ESCAPED_RE = new RegExp(`${HELM_PASSTHROUGH_RE.source}|\\{\\{+|\\{(?=${VAR_RE.source})`, 'g')

/**
 * Wrap Prometheus templates — and any other `{{` — so `helm template` emits
 * them verbatim. A `}}` on its own is text to Helm and stays.
 *
 * A raw string (backticks) holds the text as it is; one holding a backtick
 * (`{{ \`raw\` }}`) or a carriage return, which a raw string drops, is
 * written as a quoted string instead. Helm replaces the action before YAML
 * reads the line, so either form is fine inside a YAML double-quoted label.
 */
export function escapePrometheusTemplates(str) {
  return String(str).replace(ESCAPED_RE, text => (/[`\r]/.test(text)
    ? `{{ ${JSON.stringify(text)} }}`
    : '{{ `' + text + '` }}'))
}

/**
 * Whether a text has a `{{` with no `}}` after it — a template Prometheus,
 * vmalert and Alertmanager cannot read. A `}}` on its own is plain text to
 * them.
 */
export function hasUnclosedTemplate(value) {
  for (let at = value.indexOf('{{'); at >= 0; at = value.indexOf('{{', value.indexOf('}}', at + 2) + 2)) {
    if (value.indexOf('}}', at + 2) < 0) return true
  }
  return false
}

/**
 * Expand edit-time variables — see issue #57.
 *
 * A `vars` entry is text, substituted before anything else happens: it never
 * becomes a column and the rule owner never sees it. Its text may reference
 * columns, and those are resolved afterwards like any other reference. A vars
 * entry may not reference another vars entry, so one pass is enough.
 */
export function expandVars(str, vars) {
  if (!vars) return String(str)
  return String(str).replace(VAR_RE, (whole, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole))
}

/**
 * A default written into the template rather than left in the schema: Helm
 * does not apply `default` from values.schema.json, so a column that has one
 * has to carry it here or an empty cell renders "<no value>".
 *
 * Strings use Go's raw string literal because the reference is often already
 * inside a YAML double-quoted scalar, where a nested double quote would break
 * the document.
 */
export function helmLiteral(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '`' + String(value) + '`'
}

/**
 * Replace our `${var}` placeholders with Helm references.
 *
 * A column listed in `defaults` falls back to that value when the row omits
 * the key — and only then. "Not set" is "key absent" (#51): an empty cell is
 * dropped from values.yaml on save, and an explicit 0 is kept. So the lookup
 * is `dig`, which falls back on a missing key, not Sprig's `default`, which
 * also replaces 0, "" and false — a row setting a threshold of 0 against a
 * default of 80 rendered `> 80`.
 */
// A group's compiled derived values (#118) ride on the defaults object under
// this key, so every renderValue call site sees them without a new
// parameter threaded through each one.
export const DERIVED = Symbol('derived')

export function substituteVars(str, ref = '.', defaults) {
  const dict = ref === '.' ? '.' : ref.replace(/\.$/, '')
  const derived = defaults?.[DERIVED]
  return String(str).replace(VAR_RE, (_, name) => {
    if (derived && Object.hasOwn(derived, name)) return derived[name].helm
    const fallback = defaults?.[name]
    return fallback === undefined
      ? `{{ ${ref}${name} }}`
      : `{{ dig "${name}" ${helmLiteral(fallback)} ${dict} }}`
  })
}

/** Escape first, substitute second — our placeholders must not be escaped. */
export function renderValue(str, ref = '.', defaults) {
  return substituteVars(escapePrometheusTemplates(str), ref, defaults)
}

/**
 * `{{ … }}` spans that contain a `${…}`.
 *
 * This nesting cannot be written: escaping (step 4) runs before substitution
 * (step 5), so the whole span is passed through as literal text and the
 * column's value is never substituted — silently. Callers reject a rule that
 * has any. Run this after `vars` expansion so nesting a `vars` entry
 * introduces is caught too.
 */
export function nestedPlaceholders(str) {
  const spans = []
  String(str).replace(HELM_PASSTHROUGH_RE, whole => {
    if (whole.match(VAR_RE)) spans.push(whole.trim())
    return ''
  })
  return spans
}

/**
 * The `{{ … }}` spans a string carries, verbatim — what the generator escapes
 * so Helm passes them through, and so what must reappear, character for
 * character, in the rendered output.
 */
export function prometheusTemplatesIn(str) {
  return String(str).match(HELM_PASSTHROUGH_RE) || []
}

/** A string with its `${var}` references taken out. */
export const withoutVars = str => String(str).replace(VAR_RE, '')

/** Every `${var}` name referenced by a string. */
export function varsIn(str) {
  const names = []
  String(str).replace(VAR_RE, (_, name) => { names.push(name); return '' })
  return names
}

/**
 * Variables a rule references, across expr / for / labels / annotations —
 * not just expr. A variable used only in an annotation still belongs to
 * that rule.
 */
export function ruleVars(rule) {
  const names = new Set()
  const add = s => { for (const n of varsIn(s || '')) names.add(n) }
  // A hand-written entry still takes part in the variable model — the escape
  // hatch is about YAML structure, not about opting out of rows.
  add(rule.raw)
  add(rule.expr)
  add(rule.for)
  add(rule.keep_firing_for)
  for (const [k, v] of pairs(rule.labels)) { add(k); add(v) }
  for (const [k, v] of pairs(rule.annotations)) { add(k); add(v) }
  return names
}

/**
 * Columns a rule reads: its variables with the group's `vars` expanded, as
 * expandVars does, and, since `${selector}` stands for them, its group's
 * selector columns.
 */
export function ruleColumns(rule, selectors, vars, derived) {
  const names = new Set()
  // A derived value (#118) stands for the columns its expression reads.
  const addName = name => {
    if (derived && Object.hasOwn(derived, name)) for (const col of derived[name].columns || []) names.add(col)
    else names.add(name)
  }
  for (const name of ruleVars(rule)) {
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
      for (const inner of varsIn(vars[name])) addName(inner)
    } else {
      addName(name)
    }
  }
  if (names.has('selector')) for (const name of selectors || []) names.add(name)
  return names
}

// Both usage maps have no prototype: a column can be called `constructor`.

/** Which rules read each column of a group: { column: [rule name, …] }. */
export function columnUsage(group) {
  const usage = Object.create(null)
  for (const r of group.rules || []) {
    for (const n of ruleColumns(r, group.selectors, group.vars, group.derived)) (usage[n] ||= []).push(r.alert || r.record || '(unnamed)')
  }
  return usage
}

/** Which groups read each common column: { column: Set of group names }. */
export function commonColumnUsage(groups, commonColumns) {
  const usage = Object.create(null)
  for (const g of Object.values(groups)) {
    if (g.custom) continue
    for (const r of g.rules || []) {
      for (const n of ruleColumns(r, g.selectors, g.vars, g.derived)) {
        if (Object.prototype.hasOwnProperty.call(commonColumns, n)) (usage[n] ||= new Set()).add(g.group)
      }
    }
  }
  return usage
}

/**
 * Labels and annotations are a map in the schema and an ordered entry list
 * once normalized. Both shapes reach here — the editor reads a rule straight
 * out of the schema.
 */
function pairs(mapOrList) {
  if (!mapOrList) return []
  if (Array.isArray(mapOrList)) return mapOrList.map(e => [e.key, e.value])
  return Object.entries(mapOrList)
}

/**
 * Which columns belong to which rule, derived from placeholder references —
 * template owners never declare this.
 *
 * shared: referenced by more than one rule (fill once, every rule reads it)
 * owned:  referenced by exactly one rule
 */
export function fieldOwnership(rules) {
  const byVar = new Map()
  for (const rule of rules) {
    for (const name of ruleVars(rule)) {
      if (!byVar.has(name)) byVar.set(name, [])
      byVar.get(name).push(rule.alert)
    }
  }
  const shared = []
  const owned = {}
  for (const [name, alerts] of byVar) {
    if (alerts.length > 1) shared.push(name)
    else (owned[alerts[0]] ||= []).push(name)
  }
  return { shared: shared.sort(), owned }
}

/** Variables referenced but not defined as columns — blocks save. */
export function danglingRefs(rules, definedVars) {
  const defined = new Set(definedVars)
  const missing = new Set()
  for (const rule of rules) {
    for (const name of ruleVars(rule)) {
      if (!defined.has(name)) missing.add(name)
    }
  }
  return [...missing].sort()
}
