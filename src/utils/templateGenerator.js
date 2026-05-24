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
 *
 * Schema root may also contain:
 *   "x-global-selectors": ["cluster", "group"]
 * These keys are rendered as {{ $.Values.key }} (Zone-level scope, outside range)
 * instead of {{ .key }} (per-row scope, inside range).
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

/**
 * Replace {{ .key }} and {{.key}} occurrences for a given key with
 * {{ $.Values.key }} so they resolve at Zone scope (outside range).
 */
function replaceGlobalSelectorInExpr(expr, gsKeys) {
  let result = expr
  for (const key of gsKeys) {
    result = result.replace(
      new RegExp(`\\{\\{\\s*\\.${key}\\s*\\}\\}`, 'g'),
      `{{ $.Values.${key} }}`
    )
  }
  return result
}

export function generatePrometheusRule(schema, releaseName) {
  if (!schema?.properties) return ''

  // Global selector keys live at schema root, rendered as {{ $.Values.key }}
  const gsKeys = (schema['x-global-selectors'] || []).filter(k => k && k.trim())

  const groups = []

  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
    if (alertDef['x-custom-template']) continue

    const promql = alertDef['x-promql']
    if (!promql) continue

    const forDuration = alertDef['x-for'] || '5m'
    const thresholds = getThresholds(alertDef)
    // Regular selectors = those NOT in global selector keys
    const selectors = getSelectors(alertDef).filter(s => !gsKeys.includes(s))

    const rules = []
    for (const threshold of thresholds) {
      const alertName = `${toPascalCase(alertGroup)}_${toPascalCase(threshold.name)}`

      // 1. Replace {{ THRESHOLD }} placeholder with per-row var
      let expr = promql.replace(/\{\{\s*THRESHOLD\s*\}\}/g, `{{ .${threshold.name} }}`)
      // 2. Replace global selector vars: {{ .key }} → {{ $.Values.key }}
      expr = replaceGlobalSelectorInExpr(expr, gsKeys)

      // Labels: global selectors (Zone-scope) first, then per-row selectors
      const labelLines = [`            severity: ${threshold.severity}`]
      for (const gsKey of gsKeys) {
        labelLines.push(`            ${gsKey}: "{{ $.Values.${gsKey} }}"`)
      }
      for (const sel of selectors) {
        labelLines.push(`            ${sel}: "{{ .${sel} }}"`)
      }

      // Annotation summary reference — prefer per-row selector, fallback to global
      const summaryRef = selectors[0]
        ? `{{ .${selectors[0]} }}`
        : gsKeys[0] ? `{{ $.Values.${gsKeys[0]} }}` : ''

      rules.push(
        `        - alert: ${alertName}\n` +
        `          expr: ${expr}\n` +
        `          for: ${forDuration}\n` +
        `          labels:\n` +
        labelLines.join('\n') + '\n' +
        `          annotations:\n` +
        `            summary: "${alertName} triggered${summaryRef ? ` on ${summaryRef}` : ''}"`
      )
    }

    if (rules.length === 0) continue

    const groupYaml =
      `    - name: ${alertGroup.replace(/_/g, '-')}\n` +
      `      rules:\n` +
      `        {{- range .Values.${alertGroup} }}\n` +
      rules.join('\n') + '\n' +
      `        {{- end }}`

    groups.push(groupYaml)
  }

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
  const gsKeys = new Set((schema['x-global-selectors'] || []).filter(k => k && k.trim()))
  const values = {}
  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
    const props = alertDef?.items?.properties || {}
    const row = {}
    for (const [name, prop] of Object.entries(props)) {
      if (gsKeys.has(name)) continue // global selectors not in per-row values
      if (prop.default !== undefined) row[name] = prop.default
      else if (prop.type === 'number') row[name] = 0
      else row[name] = ''
    }
    values[alertGroup] = [row]
  }
  return values
}
