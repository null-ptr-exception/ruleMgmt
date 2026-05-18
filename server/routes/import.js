import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { generatePrometheusRule } from '../../src/utils/templateGenerator.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function importRouter(gitopsDir) {
  const router = express.Router()
  const presetsFile = path.join(gitopsDir, 'charts', '_presets', 'presets.json')
  const chartsDir = path.join(gitopsDir, 'charts')

  async function loadPresets() {
    const raw = await fs.readFile(presetsFile, 'utf-8')
    return JSON.parse(raw)
  }

  async function readSchema(schemaFile) {
    try {
      const raw = await fs.readFile(schemaFile, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    }
  }

  /**
   * Build a schema property for one leaf from a preset + metricExpr.
   *
   * Supports two threshold modes:
   *  - xVarType "threshold": one schema var per tier (existing behaviour)
   *  - xVarType "threshold-base": single table column; expands to one var per
   *    tier defined in preset.tiers[], ratios stored as x-ratio for row transform
   *
   * For fixedAlert presets (absence-check), sets x-custom-template: true.
   */
  function buildLeafSchemaProp(preset, leaf) {
    const promql = preset.promqlTemplate.replace('METRIC_EXPR', leaf.metricExpr)
    const itemProps = {}
    const activeTiers = leaf.overrideTiers || null

    for (const v of preset.vars) {
      if (v.xVarType === 'threshold-base') {
        // Expand to one schema property per tier
        for (const tier of (preset.tiers || [])) {
          if (activeTiers && !activeTiers.includes(tier.severity)) continue
          itemProps[tier.name] = {
            type: 'number',
            'x-var-type': 'threshold',
            'x-severity': tier.severity,
            'x-ratio': tier.ratio,
            description: `${tier.severity} threshold (${tier.ratio * 100}% of base threshold)`,
          }
        }
      } else {
        const prop = { type: v.type }
        if (v.description) prop.description = v.description
        if (v.default !== undefined) prop.default = v.default
        if (v.xVarType) prop['x-var-type'] = v.xVarType
        if (v.xSeverity) {
          if (activeTiers && !activeTiers.includes(v.xSeverity)) continue
          prop['x-severity'] = v.xSeverity
        }
        itemProps[v.name] = prop
      }
    }

    const required = preset.vars
      .filter(v => v.xVarType === 'selector')
      .map(v => v.name)

    const schemaProp = {
      type: 'array',
      'x-promql': promql,
      'x-for': preset.forDuration,
      items: {
        type: 'object',
        properties: itemProps,
        ...(required.length > 0 ? { required } : {}),
      },
    }

    if (preset.fixedAlert) {
      schemaProp['x-custom-template'] = true
      schemaProp['x-fixed-alert'] = true
      schemaProp['x-fixed-severity'] = preset.fixedSeverity || 'critical'
    }

    return schemaProp
  }

  /**
   * If the preset uses threshold-base, expand each row's single `threshold`
   * column into per-tier values using the ratios defined in preset.tiers.
   * Returns rows unchanged for presets without threshold-base vars.
   */
  function expandThresholdBaseRows(preset, rows) {
    const baseVar = (preset.vars || []).find(v => v.xVarType === 'threshold-base')
    if (!baseVar || !preset.tiers) return rows

    return rows.map(row => {
      const base = Number(row[baseVar.name])
      if (isNaN(base)) return row
      const expanded = { ...row }
      delete expanded[baseVar.name]
      for (const tier of preset.tiers) {
        expanded[tier.name] = Math.round(base * tier.ratio * 10000) / 10000
      }
      return expanded
    })
  }

  /**
   * Generate a fixed Helm template snippet for absence-check-style presets.
   * One alert per selector combination (cluster/app), no threshold tiers.
   */
  function generateFixedAlertSnippet(alertGroup, schemaProp) {
    const forDuration = schemaProp['x-for'] || '3m'
    const severity = schemaProp['x-fixed-severity'] || 'critical'
    const promql = schemaProp['x-promql'] || ''
    const props = schemaProp.items?.properties || {}
    const selectors = Object.entries(props)
      .filter(([, p]) => p['x-var-type'] === 'selector')
      .map(([name]) => name)

    const alertName = alertGroup.replace(/_/g, '-').replace(/(?:^|-)([a-z])/g, (_, c) => c.toUpperCase())
    const labelLines = [`            severity: ${severity}`]
    for (const sel of selectors) {
      labelLines.push(`            ${sel}: "{{ .${sel} }}"`)
    }

    const rule =
      `        - alert: ${alertName}\n` +
      `          expr: ${promql}\n` +
      `          for: ${forDuration}\n` +
      `          labels:\n` +
      labelLines.join('\n') + '\n' +
      `          annotations:\n` +
      `            summary: "${alertName} triggered on {{ .${selectors[0] || 'cluster'} }}"`

    return (
      `    - name: ${alertGroup.replace(/_/g, '-')}\n` +
      `      rules:\n` +
      `        {{- range .Values.${alertGroup} }}\n` +
      rule + '\n' +
      `        {{- end }}`
    )
  }

  /**
   * Build full PrometheusRule YAML from merged schema.
   * Handles x-custom-template groups with their own snippet generator.
   */
  function buildFullTemplate(mergedSchema, releaseName) {
    const groups = []

    for (const [alertGroup, alertDef] of Object.entries(mergedSchema.properties || {})) {
      if (alertGroup.startsWith('$')) continue

      if (alertDef['x-custom-template']) {
        if (alertDef['x-fixed-alert']) {
          groups.push(generateFixedAlertSnippet(alertGroup, alertDef))
        }
        continue
      }
    }

    const standardYaml = generatePrometheusRule(mergedSchema, releaseName)

    if (groups.length === 0) return standardYaml

    // Merge: insert fixed-alert groups into the standard yaml's groups section
    const fixedGroupsBlock = groups.join('\n\n')
    if (!standardYaml.includes('  groups:')) {
      // No standard groups; build minimal wrapper
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
        fixedGroupsBlock + '\n'
      )
    }

    return standardYaml.replace(/(\n  groups:\n)/, `$1${fixedGroupsBlock}\n\n`)
  }

  function groupRowsByName(rows) {
    const map = {}
    for (const row of rows) {
      const n = row.name
      if (!n) continue
      if (!map[n]) map[n] = []
      const { name: _name, ...rest } = row
      map[n].push(rest)
    }
    return map
  }

  async function handleImport(req, res, dryRun) {
    const { chart, deployment, presetId, leaves, rows } = req.body

    if (!chart || !NAME_RE.test(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    if (!presetId) return res.status(400).json({ error: 'presetId required' })
    if (!Array.isArray(leaves) || leaves.length === 0) {
      return res.status(400).json({ error: 'leaves[] required' })
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows[] required' })
    }

    try {
      const presets = await loadPresets()
      const preset = presets[presetId]
      if (!preset) return res.status(400).json({ error: `Preset '${presetId}' not found` })

      const chartDir = path.join(chartsDir, chart)
      const schemaFile = path.join(chartDir, 'values.schema.json')
      const tmplDir = path.join(chartDir, 'templates')

      const existingSchema = await readSchema(schemaFile)

      // Build new leaf schema properties
      const newProps = {}
      for (const leaf of leaves) {
        if (!leaf.name || !leaf.metricExpr) {
          return res.status(400).json({ error: `Leaf '${leaf.name}' missing metricExpr` })
        }
        newProps[leaf.name] = buildLeafSchemaProp(preset, leaf)
      }

      // Merge: new leaves override existing same-named properties
      const mergedSchema = {
        ...existingSchema,
        properties: {
          ...existingSchema.properties,
          ...newProps,
        },
      }

      const templateYaml = buildFullTemplate(mergedSchema, '{{ .Release.Name }}')

      const expandedRows = expandThresholdBaseRows(preset, rows)
      const rowsByName = groupRowsByName(expandedRows)
      const stats = {
        leaves: leaves.length,
        rules: Object.values(newProps).reduce((acc, prop) => {
          if (prop['x-fixed-alert']) return acc + 1
          const thresholds = Object.values(prop.items?.properties || {}).filter(p => p['x-var-type'] === 'threshold')
          return acc + thresholds.length
        }, 0),
      }

      if (dryRun) {
        return res.json({
          schemaPreview: mergedSchema,
          templatePreview: templateYaml,
          valuesPreview: rowsByName,
          stats,
        })
      }

      // Save: write schema, template, and deployment values
      const depName = deployment && NAME_RE.test(deployment) ? deployment : 'default'

      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(schemaFile, JSON.stringify(mergedSchema, null, 2), 'utf-8')
      await fs.writeFile(path.join(tmplDir, 'prometheus-rule.yaml'), templateYaml, 'utf-8')

      const depValuesFile = path.join(chartDir, `${depName}-values.yaml`)
      let existingDepValues = {}
      try {
        const raw = await fs.readFile(depValuesFile, 'utf-8')
        existingDepValues = yaml.load(raw) || {}
      } catch { /* new file */ }

      const mergedDepValues = { ...existingDepValues, ...rowsByName }
      await fs.writeFile(depValuesFile, yaml.dump(mergedDepValues, { lineWidth: -1 }), 'utf-8')

      res.json({ ok: true, stats })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }

  router.post('/preview', (req, res) => handleImport(req, res, true))
  router.post('/', (req, res) => handleImport(req, res, false))

  return router
}
