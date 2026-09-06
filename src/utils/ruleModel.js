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

/**
 * Wrap Prometheus templates so `helm template` emits them verbatim.
 * The backtick form is used rather than `{{ "..." }}` because annotation
 * values are usually already inside YAML double quotes.
 */
export function escapePrometheusTemplates(str) {
  return String(str).replace(HELM_PASSTHROUGH_RE, (_, inner) => '{{ `{{' + inner + '}}` }}')
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
function helmLiteral(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '`' + String(value) + '`'
}

/**
 * Replace our `${var}` placeholders with Helm references.
 * A column listed in `defaults` falls back to that value when the row omits it.
 */
export function substituteVars(str, ref = '.', defaults) {
  return String(str).replace(VAR_RE, (_, name) => {
    const fallback = defaults?.[name]
    return fallback === undefined
      ? `{{ ${ref}${name} }}`
      : `{{ ${ref}${name} | default ${helmLiteral(fallback)} }}`
  })
}

/** Escape first, substitute second — our placeholders must not be escaped. */
export function renderValue(str, ref = '.', defaults) {
  return substituteVars(escapePrometheusTemplates(str), ref, defaults)
}

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
  for (const [k, v] of pairs(rule.labels)) { add(k); add(v) }
  for (const [k, v] of pairs(rule.annotations)) { add(k); add(v) }
  return names
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
