/**
 * Generate PrometheusRule YAML from schema with x- extensions.
 *
 * Schema shape per alert group:
 * {
 *   "type": "array",
 *   "x-promql": "rate(metric[5m]) > {{ THRESHOLD }}",
 *   "x-for": "5m",
 *   "x-custom-template": false,
 *   "items": {
 *     "properties": {
 *       "namespace": { "type": "string", "x-var-type": "selector" },
 *       "warn_pct": { "type": "number", "x-var-type": "threshold", "x-severity": "warning" }
 *     }
 *   }
 * }
 */

import { renderValue, expandVars, varsIn } from './ruleModel.js'
import { emitRuleObjects } from './crConverter.js'
import { isAlertGroup, getCommonSchema } from './schemaUtils.js'

function toPascalCase(str) {
  return str.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function getThresholds(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] === 'threshold')
    .map(([name, p]) => ({ name, severity: p['x-severity'] || 'warning' }))
}

function getSelectors(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] === 'selector')
    .map(([name]) => name)
}

/** Values that are a bare word render unquoted, matching hand-written rules. */
function needsQuote(value) {
  return value === '' || /[^A-Za-z0-9_.-]/.test(value)
}

function renderEntry(entry, ref, refVar, indent, defaults) {
  const rendered = renderValue(entry.value, ref, defaults) + (entry.helmSuffix || '')
  const line = `${indent}${entry.key}: ${needsQuote(entry.value) ? `"${rendered}"` : rendered}`
  if (!entry.guard) return line
  return (
    `${indent}{{- if hasKey ${refVar} "${entry.guard}" }}\n` +
    line + '\n' +
    `${indent}{{- end }}`
  )
}

/**
 * A hand-written rule entry, passed through with its YAML untouched.
 *
 * This is the escape hatch, and one `rules[]` entry is as large as it gets:
 * the CR shell, the row loop and sharding stay with the converter, so an
 * escaped rule can still be rendered as any kind of object and still be
 * sharded. Placeholders are resolved exactly as in a structured rule — ${var}
 * reads the row, {{ ... }} is Prometheus and survives Helm.
 */
function renderRawRule(raw, ref, defaults) {
  const lines = renderValue(raw, ref, defaults).replace(/\s+$/, '').split('\n')
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length)
  const base = indents.length ? Math.min(...indents) : 0
  const body = lines.map(l => (l.trim() ? l.slice(base) : ''))

  // Accept both a full list entry and just its body.
  const entry = body[0].startsWith('- ')
    ? body
    : [`- ${body[0]}`, ...body.slice(1).map(l => (l ? `  ${l}` : ''))]

  return entry.map(l => (l ? ' '.repeat(8) + l : '')).join('\n')
}

/**
 * A rule whose expression reads a column that may not be there at all is not
 * wrong for that row — it does not apply to it. Guarding the whole entry is
 * what "clearing a default means leaving this blank is meaningful" turns into:
 * four thresholds bounding three rules, and a row that fills only two of them
 * produces only the rules those two cover.
 *
 * The guard has to wrap the entry rather than the value, because omitting a
 * threshold from the middle of an expression would change the query rather
 * than drop the rule.
 */
function guarded(text, guards, refVar, indent) {
  if (!guards?.length) return text
  const condition = guards.length === 1
    ? `hasKey ${refVar} "${guards[0]}"`
    : `and ${guards.map(g => `(hasKey ${refVar} "${g}")`).join(' ')}`
  return (
    `${indent}{{- if ${condition} }}\n` +
    text + '\n' +
    `${indent}{{- end }}`
  )
}

function renderRule(rule, ref, refVar, defaults) {
  const indent = ' '.repeat(8)
  if (rule.raw) return guarded(renderRawRule(rule.raw, ref, defaults), rule.guards, refVar, indent)

  const parts = [
    `        - alert: ${rule.alert}\n` +
    `          expr: ${renderValue(rule.expr, ref, defaults)}\n` +
    `          for: ${renderValue(rule.for, ref, defaults)}`
  ]
  if (rule.labels?.length) {
    parts.push(`          labels:\n` + rule.labels.map(l => renderEntry(l, ref, refVar, ' '.repeat(12), defaults)).join('\n'))
  }
  if (rule.annotations?.length) {
    parts.push(`          annotations:\n` + rule.annotations.map(a => renderEntry(a, ref, refVar, ' '.repeat(12), defaults)).join('\n'))
  }
  return guarded(parts.join('\n'), rule.guards, refVar, indent)
}

function toEntries(mapOrList) {
  if (!mapOrList) return []
  if (Array.isArray(mapOrList)) return mapOrList
  return Object.entries(mapOrList).map(([key, value]) => ({ key, value: String(value) }))
}

/**
 * Read-time adapter: a legacy `x-promql` group is one rule per threshold.
 * Emitting these through the same path as `x-rules` is what keeps the
 * round-trip byte-identical for charts that have not been rewritten yet.
 */
function legacyRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar) {
  const promql = alertDef['x-promql']
  const forDuration = alertDef['x-for'] || '5m'
  const requiredSel = allSelectors.find(s => requiredSet.has(s))

  return getThresholds(alertDef).map(threshold => {
    const alert = `${toPascalCase(alertGroup)}_${toPascalCase(threshold.name)}`
    const expr = promql
      .replace(/\{\{\s*THRESHOLD\s*\}\}/g, `\${${threshold.name}}`)
      .replace(/\{\{\s*\.(\w+)\s*\}\}/g, (m, name) => `\${${name}}`)

    const labels = [{ key: 'severity', value: threshold.severity }]
    for (const sel of allSelectors) {
      labels.push({ key: sel, value: `\${${sel}}`, guard: requiredSet.has(sel) ? null : sel })
    }

    const summary = { key: 'summary', value: `${alert} triggered` }
    if (requiredSel) {
      summary.value += ` on \${${requiredSel}}`
    } else if (allSelectors.length > 0) {
      summary.helmSuffix = `{{ if hasKey ${refVar} "${allSelectors[0]}" }} on {{ ${ref}${allSelectors[0]} }}{{ end }}`
    }

    return { alert, expr, for: forDuration, labels, annotations: [summary] }
  })
}

export function normalizeRules(alertGroup, alertDef, allSelectors = [], requiredSet = new Set(), ref = '.', refVar = '.') {
  if (Array.isArray(alertDef?.['x-rules'])) {
    // Edit-time variables are expanded here rather than at render time so that
    // everything downstream — the reference check included — sees the same
    // vars-free text. A `vars` name is not a column and must not be reported
    // as one.
    const vars = alertDef.vars || alertDef['x-vars']
    const expand = s => expandVars(s || '', vars)
    const expandEntries = entries => entries.map(e => ({ ...e, value: expand(e.value) }))

    return alertDef['x-rules'].map(rule => (rule.raw ? { raw: expand(rule.raw) } : {
      alert: rule.alert,
      expr: expand(rule.expr),
      for: expand(rule.for || alertDef['x-for'] || '5m'),
      labels: expandEntries(toEntries(rule.labels)),
      annotations: expandEntries(toEntries(rule.annotations))
    }))
  }
  if (!alertDef?.['x-promql']) return []
  return legacyRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
}

/**
 * Split a group into the pieces the converter needs: which values key the rows
 * come from, and one rendered block per rule. The resource that wraps them and
 * how the rows are chunked across objects is not this function's business.
 */
/**
 * Which columns can simply not be there in a given row: no default to fall
 * back on and not required, so `values.yaml` omits the key entirely when the
 * cell is empty.
 */
export function columnFallbacks(alertDef, commonProps, requiredSet) {
  const props = { ...commonProps, ...(alertDef?.items?.properties || {}) }
  const defaults = {}
  const mayBeAbsent = new Set()
  for (const [name, prop] of Object.entries(props)) {
    if (prop?.default !== undefined) defaults[name] = prop.default
    else if (!requiredSet.has(name)) mayBeAbsent.add(name)
  }
  return { defaults, mayBeAbsent }
}

/**
 * Work out what has to be guarded, per rule.
 *
 * A column that may be absent is guarded at the largest unit that still means
 * something: the whole rule when the expression reads it, one line when it is
 * a label's entire value. A reference in the middle of a longer string has no
 * meaningful omission and is rejected before it gets here.
 */
function attachGuards(rules, mayBeAbsent) {
  if (!mayBeAbsent.size) return rules

  return rules.map(rule => {
    const guards = new Set()
    for (const text of [rule.expr, rule.for, rule.raw]) {
      for (const name of varsIn(text || '')) if (mayBeAbsent.has(name)) guards.add(name)
    }
    // A line whose entire value is one reference disappears with it. Already
    // guarded at the rule level means the line guard would be dead weight.
    const guardLine = entry => {
      const whole = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}$/.exec(String(entry.value).trim())
      const name = whole?.[1]
      return name && mayBeAbsent.has(name) && !guards.has(name) ? { ...entry, guard: name } : entry
    }

    return {
      ...rule,
      guards: [...guards].sort(),
      ...(rule.labels ? { labels: rule.labels.map(guardLine) } : {}),
      ...(rule.annotations ? { annotations: rule.annotations.map(guardLine) } : {})
    }
  })
}

function buildGroupParts(alertGroup, alertDef, commonVars) {
  if (!alertDef['x-promql'] && !Array.isArray(alertDef['x-rules'])) return null

  const commonProps = commonVars?.properties || {}
  const commonRequired = commonVars?.required || []
  const commonSelectors = Object.keys(commonProps)
  const selectors = getSelectors(alertDef)
  const allSelectors = [...new Set([...commonSelectors, ...selectors])]
  const hasCommon = commonSelectors.length > 0
  const ref = hasCommon ? '$row.' : '.'
  const refVar = hasCommon ? '$row' : '.'
  // "Set" means "key present": optional vars are omitted from values.yaml
  // entirely when empty, so key presence (hasKey) — not truthiness — is the
  // correct guard, and it keeps numeric enum selectors with a legitimate 0
  // rendering. Unguarded references to a missing key render the literal
  // string "<no value>".
  const requiredSet = new Set([...(alertDef?.items?.required || []), ...commonRequired])

  // A legacy `x-promql` group renders exactly as it always has. Defaults and
  // guards are part of the x-rules model, and quietly changing what an
  // un-migrated chart deploys is the surprise this whole design avoids — it
  // picks them up when it is rewritten, not before.
  const legacy = !Array.isArray(alertDef['x-rules'])
  const { defaults, mayBeAbsent } = legacy
    ? { defaults: undefined, mayBeAbsent: new Set() }
    : columnFallbacks(alertDef, commonProps, requiredSet)

  const rules = normalizeRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
  const ruleTexts = attachGuards(rules, mayBeAbsent)
    .map(rule => renderRule(rule, ref, refVar, defaults))

  if (ruleTexts.length === 0) return null

  return {
    groupName: alertGroup.replace(/_/g, '-'),
    valuesKey: alertGroup,
    hasCommon,
    ruleTexts
  }
}

export function generateGroupTemplate(alertGroup, alertDef, releaseName, schema, options) {
  const parts = buildGroupParts(alertGroup, alertDef, getCommonSchema(schema))
  if (!parts) return null

  return emitRuleObjects({
    releaseName: releaseName || '{{ .Release.Name }}',
    group: alertGroup,
    ...parts
  }, options)
}

export function generateDefaultValues(schema) {
  if (!schema?.properties) return {}
  const commonProps = getCommonSchema(schema)?.properties || {}
  const values = {}
  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (!isAlertGroup(alertGroup)) continue
    const props = alertDef?.items?.properties || {}
    const row = {}
    for (const [name, prop] of Object.entries(commonProps)) {
      if (prop.default !== undefined) row[name] = prop.default
      else if (prop.type === 'number') row[name] = 0
      else row[name] = ''
    }
    for (const [name, prop] of Object.entries(props)) {
      if (prop.default !== undefined) row[name] = prop.default
      else if (prop.type === 'number') row[name] = 0
      else row[name] = ''
    }
    values[alertGroup] = [row]
  }
  return values
}
