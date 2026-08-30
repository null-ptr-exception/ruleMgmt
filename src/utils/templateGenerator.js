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

import { renderValue } from './ruleModel.js'
import { emitRuleObjects } from './crConverter.js'

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

function getCommonSelectors(schema) {
  const props = schema?.['x-common-vars']?.properties || {}
  return Object.keys(props)
}

function getCommonRequired(schema) {
  return schema?.['x-common-vars']?.required || []
}

/** Values that are a bare word render unquoted, matching hand-written rules. */
function needsQuote(value) {
  return value === '' || /[^A-Za-z0-9_.-]/.test(value)
}

function renderEntry(entry, ref, refVar, indent) {
  const rendered = renderValue(entry.value, ref) + (entry.helmSuffix || '')
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
function renderRawRule(raw, ref) {
  const lines = renderValue(raw, ref).replace(/\s+$/, '').split('\n')
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length)
  const base = indents.length ? Math.min(...indents) : 0
  const body = lines.map(l => (l.trim() ? l.slice(base) : ''))

  // Accept both a full list entry and just its body.
  const entry = body[0].startsWith('- ')
    ? body
    : [`- ${body[0]}`, ...body.slice(1).map(l => (l ? `  ${l}` : ''))]

  return entry.map(l => (l ? ' '.repeat(8) + l : '')).join('\n')
}

function renderRule(rule, ref, refVar) {
  if (rule.raw) return renderRawRule(rule.raw, ref)

  const parts = [
    `        - alert: ${rule.alert}\n` +
    `          expr: ${renderValue(rule.expr, ref)}\n` +
    `          for: ${renderValue(rule.for, ref)}`
  ]
  if (rule.labels?.length) {
    parts.push(`          labels:\n` + rule.labels.map(l => renderEntry(l, ref, refVar, ' '.repeat(12))).join('\n'))
  }
  if (rule.annotations?.length) {
    parts.push(`          annotations:\n` + rule.annotations.map(a => renderEntry(a, ref, refVar, ' '.repeat(12))).join('\n'))
  }
  return parts.join('\n')
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
    return alertDef['x-rules'].map(rule => (rule.raw ? { raw: rule.raw } : {
      alert: rule.alert,
      expr: rule.expr || '',
      for: rule.for || alertDef['x-for'] || '5m',
      labels: toEntries(rule.labels),
      annotations: toEntries(rule.annotations)
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
function buildGroupParts(alertGroup, alertDef, commonSelectors = [], commonRequired = []) {
  if (!alertDef['x-promql'] && !Array.isArray(alertDef['x-rules'])) return null

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

  const ruleTexts = normalizeRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
    .map(rule => renderRule(rule, ref, refVar))

  if (ruleTexts.length === 0) return null

  return {
    groupName: alertGroup.replace(/_/g, '-'),
    valuesKey: alertGroup,
    hasCommon,
    ruleTexts
  }
}

export function generateGroupTemplate(alertGroup, alertDef, releaseName, schema, options) {
  const parts = buildGroupParts(
    alertGroup,
    alertDef,
    schema ? getCommonSelectors(schema) : [],
    schema ? getCommonRequired(schema) : []
  )
  if (!parts) return null

  return emitRuleObjects({
    releaseName: releaseName || '{{ .Release.Name }}',
    group: alertGroup,
    ...parts
  }, options)
}

export function generateDefaultValues(schema) {
  if (!schema?.properties) return {}
  const commonProps = schema?.['x-common-vars']?.properties || {}
  const values = {}
  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
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
