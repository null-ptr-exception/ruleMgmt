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

function generateGroupYaml(alertGroup, alertDef, commonSelectors = []) {
  const promql = alertDef['x-promql']
  if (!promql) return null

  const forDuration = alertDef['x-for'] || '5m'
  const thresholds = getThresholds(alertDef)
  const selectors = getSelectors(alertDef)
  const allSelectors = [...new Set([...commonSelectors, ...selectors])]

  const rules = []
  for (const threshold of thresholds) {
    const alertName = `${toPascalCase(alertGroup)}_${toPascalCase(threshold.name)}`
    const expr = promql.replace(/\{\{\s*THRESHOLD\s*\}\}/g, `{{ .${threshold.name} }}`)

    const labelLines = [`            severity: ${threshold.severity}`]
    for (const sel of allSelectors) {
      labelLines.push(`            ${sel}: "{{ .${sel} }}"`)
    }

    rules.push(
      `        - alert: ${alertName}\n` +
      `          expr: ${expr}\n` +
      `          for: ${forDuration}\n` +
      `          labels:\n` +
      labelLines.join('\n') + '\n' +
      `          annotations:\n` +
      `            summary: "${alertName} triggered on {{ .${allSelectors[0] || 'namespace'} }}"`
    )
  }

  if (rules.length === 0) return null

  return (
    `    - name: ${alertGroup.replace(/_/g, '-')}\n` +
    `      rules:\n` +
    `        {{- range .Values.${alertGroup} }}\n` +
    rules.join('\n') + '\n' +
    `        {{- end }}`
  )
}

export function generateGroupTemplate(alertGroup, alertDef, releaseName, schema) {
  const commonSelectors = schema ? getCommonSelectors(schema) : []
  const groupYaml = generateGroupYaml(alertGroup, alertDef, commonSelectors)
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
  const groups = []

  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
    if (alertDef['x-custom-template']) continue

    const groupYaml = generateGroupYaml(alertGroup, alertDef, commonSelectors)
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
