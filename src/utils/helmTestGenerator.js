/**
 * Generate helm-unittest test YAML from a schema with x- extensions.
 *
 * For each alert group, generates test cases that:
 * 1. Verify the rendered output is a valid PrometheusRule
 * 2. For each threshold variable, verify an alert rule is rendered with:
 *    - Correct alert name (PascalCase group + threshold)
 *    - Correct severity label
 *    - Threshold value substituted in expr
 *    - Correct `for` duration
 */

function toPascalCase(str) {
  return str.split(/[_\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

function getThresholds(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] === 'threshold')
    .map(([name, p]) => ({
      name,
      severity: p['x-severity'] || 'warning',
      defaultValue: p.default
    }))
}

function getSelectors(alertDef) {
  const props = alertDef?.items?.properties || {}
  return Object.entries(props)
    .filter(([, p]) => p['x-var-type'] !== 'threshold')
    .map(([name, p]) => ({ name, default: p.default }))
}

function buildTestValues(alertGroup, alertDef) {
  const props = alertDef?.items?.properties || {}
  const row = {}
  for (const [name, prop] of Object.entries(props)) {
    if (prop.default !== undefined) {
      row[name] = prop.default
    } else if (prop.type === 'number' || prop.type === 'integer') {
      row[name] = 42
    } else {
      row[name] = `test-${name}`
    }
  }
  return { [alertGroup]: [row] }
}

export function generateHelmUnittestSuite(schema, templateFile = 'templates/prometheus-rule.yaml') {
  if (!schema?.properties) return ''

  const lines = []
  lines.push('suite: generated alert rule tests')
  lines.push('templates:')
  lines.push(`  - ${templateFile}`)
  lines.push('tests:')

  // Global structure test
  lines.push('  - it: renders a PrometheusRule')
  lines.push('    asserts:')
  lines.push('      - isKind:')
  lines.push('          of: PrometheusRule')
  lines.push('      - isAPIVersion:')
  lines.push('          of: monitoring.coreos.com/v1')

  for (const [alertGroup, alertDef] of Object.entries(schema.properties)) {
    if (alertGroup.startsWith('$')) continue
    if (alertDef['x-custom-template']) continue
    if (!alertDef['x-promql']) continue

    const thresholds = getThresholds(alertDef)
    const selectors = getSelectors(alertDef)
    const forDuration = alertDef['x-for'] || '5m'
    const testValues = buildTestValues(alertGroup, alertDef)

    if (thresholds.length === 0) continue

    // Test: group exists with correct name
    lines.push(`  - it: renders ${alertGroup} group`)
    lines.push('    set:')
    for (const [key, val] of Object.entries(testValues)) {
      lines.push(`      ${key}:`)
      for (const row of val) {
        lines.push(`        - ${Object.entries(row).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n          ')}`)
      }
    }
    lines.push('    asserts:')
    lines.push('      - contains:')
    lines.push('          path: spec.groups')
    lines.push('          content:')
    lines.push(`            name: ${alertGroup.replace(/_/g, '-')}`)
    lines.push('          any: true')

    // Test: each threshold generates a rule with correct severity
    for (const threshold of thresholds) {
      const alertName = `${toPascalCase(alertGroup)}_${toPascalCase(threshold.name)}`
      const thresholdValue = threshold.defaultValue !== undefined ? threshold.defaultValue : 42
      const groupIndex = Object.keys(schema.properties).filter(k => !k.startsWith('$') && !schema.properties[k]['x-custom-template'] && schema.properties[k]['x-promql']).indexOf(alertGroup)

      const thresholdIndex = thresholds.indexOf(threshold)

      lines.push(`  - it: renders ${alertName} with severity ${threshold.severity}`)
      lines.push('    set:')
      for (const [key, val] of Object.entries(testValues)) {
        lines.push(`      ${key}:`)
        for (const row of val) {
          lines.push(`        - ${Object.entries(row).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n          ')}`)
        }
      }
      lines.push('    asserts:')
      lines.push('      - equal:')
      lines.push(`          path: spec.groups[${groupIndex}].rules[${thresholdIndex}].alert`)
      lines.push(`          value: ${alertName}`)
      lines.push('      - equal:')
      lines.push(`          path: spec.groups[${groupIndex}].rules[${thresholdIndex}].for`)
      lines.push(`          value: ${forDuration}`)
      lines.push('      - equal:')
      lines.push(`          path: spec.groups[${groupIndex}].rules[${thresholdIndex}].labels.severity`)
      lines.push(`          value: ${threshold.severity}`)
      // For large numbers, Helm may render in scientific notation (e.g. 1.048576e+08)
      let patternValue = String(thresholdValue)
      if (typeof thresholdValue === 'number' && thresholdValue >= 1000000) {
        // Match either the literal number or scientific notation with optional leading zeros in exponent
        const sci = thresholdValue.toExponential().replace('+', '\\\\+').replace(/(e\\\\\+)(\d+)/, '$10*$2')
        patternValue = `(${thresholdValue}|${sci})`
      }
      lines.push('      - matchRegex:')
      lines.push(`          path: spec.groups[${groupIndex}].rules[${thresholdIndex}].expr`)
      lines.push(`          pattern: "${patternValue}"`)
    }
  }

  return lines.join('\n') + '\n'
}
