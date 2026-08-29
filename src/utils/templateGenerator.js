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

function renderRule(rule, ref, refVar) {
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
    return alertDef['x-rules'].map(rule => ({
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

function generateGroupYaml(alertGroup, alertDef, commonSelectors = [], commonRequired = []) {
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

  const rules = normalizeRules(alertGroup, alertDef, allSelectors, requiredSet, ref, refVar)
    .map(rule => renderRule(rule, ref, refVar))

  if (rules.length === 0) return null

  const rangeBlock = hasCommon
    ? `        {{- $common := .Values._common | default dict }}\n` +
      `        {{- range .Values.${alertGroup} }}\n` +
      `        {{- $row := merge . $common }}\n`
    : `        {{- range .Values.${alertGroup} }}\n`

  return (
    `    - name: ${alertGroup.replace(/_/g, '-')}\n` +
    `      rules:\n` +
    rangeBlock +
    rules.join('\n') + '\n' +
    `        {{- end }}`
  )
}

export function generateGroupTemplate(alertGroup, alertDef, releaseName, schema) {
  const commonSelectors = schema ? getCommonSelectors(schema) : []
  const groupYaml = generateGroupYaml(alertGroup, alertDef, commonSelectors, schema ? getCommonRequired(schema) : [])
  if (!groupYaml) return null

  const name = releaseName || '{{ .Release.Name }}'
  return (
    `apiVersion: monitoring.coreos.com/v1\n` +
    `kind: PrometheusRule\n` +
    `metadata:\n` +
    `  name: ${name}-${alertGroup.replace(/_/g, '-')}\n` +
    `  labels:\n` +
    `    app.kubernetes.io/managed-by: Helm\n` +
    `spec:\n` +
    `  groups:\n` +
    groupYaml
  ) + '\n'
}

export function generatePrometheusRule(schema, releaseName) {
  if (!schema?.properties) return ''

  const commonSelectors = getCommonSelectors(schema)
  const commonRequired = getCommonRequired(schema)
  const groups = []

  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
    if (alertDef['x-custom-template']) continue

    const groupYaml = generateGroupYaml(alertGroup, alertDef, commonSelectors, commonRequired)
    if (groupYaml) groups.push(groupYaml)
  }

  if (groups.length === 0) return ''

  const name = releaseName || '{{ .Release.Name }}'
  return (
    `apiVersion: monitoring.coreos.com/v1\n` +
    `kind: PrometheusRule\n` +
    `metadata:\n` +
    `  name: ${name}-alerts\n` +
    `  labels:\n` +
    `    app.kubernetes.io/managed-by: Helm\n` +
    `spec:\n` +
    `  groups:\n` +
    groups.join('\n\n')
  ) + '\n'
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
