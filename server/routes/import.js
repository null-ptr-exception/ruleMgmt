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
  const deploymentsDir = path.join(gitopsDir, 'deployments')

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
   * Recursively resolve tree YAML into a flat leaf map.
   * Inheritance: child inherits parent's preset / threshold / exprTemplate unless it overrides.
   *
   * Input tree node shape:
   *   {
   *     preset?,        // inherited
   *     threshold?,     // inherited
   *     thresholds?,    // inherited
   *     exprTemplate?,  // inherited — e.g. "1 - ({{metric}})"
   *     children?: { ... }
   *     // --- leaf-only ---
   *     metric?,        // substituted into nearest exprTemplate → metricExpr
   *     metricExpr?,    // full override; takes priority over metric + exprTemplate
   *   }
   *
   * Output: { [leafName]: { preset, threshold, thresholds, metricExpr } }
   */
  function resolveTree(nodes, inherited = {}) {
    const leaves = {}
    for (const [key, def] of Object.entries(nodes || {})) {
      if (!def || typeof def !== 'object') continue

      const ctx = {
        preset:       def.preset       ?? inherited.preset,
        threshold:    def.threshold    !== undefined ? def.threshold  : inherited.threshold,
        thresholds:   def.thresholds   ?? inherited.thresholds,
        exprTemplate: def.exprTemplate ?? inherited.exprTemplate,
      }

      if (def.children && Object.keys(def.children).length > 0) {
        const childLeaves = resolveTree(def.children, ctx)
        for (const [childKey, childLeaf] of Object.entries(childLeaves)) {
          leaves[`${key}_${childKey}`] = childLeaf
        }
      } else if (def.metricExpr || def.metric) {
        // metricExpr (full expr) beats metric + exprTemplate
        let metricExpr = def.metricExpr
        if (!metricExpr && def.metric) {
          const tmpl = ctx.exprTemplate || '{{metric}}'
          metricExpr = tmpl.replace(/\{\{metric\}\}/g, def.metric)
        }
        leaves[key] = {
          preset:     ctx.preset,
          threshold:  ctx.threshold,
          thresholds: ctx.thresholds,
          metricExpr,
        }
      }
    }
    return leaves
  }

  /**
   * Build a JSON Schema property for one leaf.
   * Supports: threshold-base (tiers[]), multi-var threshold, fixedAlert.
   */
  function buildLeafSchemaProp(preset, metricExpr) {
    const promql = preset.promqlTemplate.replace('METRIC_EXPR', metricExpr)
    const itemProps = {}

    for (const v of (preset.vars || [])) {
      if (v.xVarType === 'threshold-base') {
        for (const tier of (preset.tiers || [])) {
          itemProps[tier.name] = {
            type: 'number',
            'x-var-type': 'threshold',
            'x-severity': tier.severity,
            'x-ratio': tier.ratio,
            description: `${tier.severity} threshold (${tier.ratio * 100}% of base)`,
          }
        }
      } else {
        const prop = { type: v.type }
        if (v.description) prop.description = v.description
        if (v.default !== undefined) prop.default = v.default
        if (v.xVarType) prop['x-var-type'] = v.xVarType
        if (v.xSeverity) prop['x-severity'] = v.xSeverity
        itemProps[v.name] = prop
      }
    }

    const required = (preset.vars || [])
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
   * Expand a single data row using the leaf's resolved threshold defaults.
   * - threshold-base preset: expand single value into tier values via ratios
   * - multi-var preset: map threshold / thresholds to named vars
   * - fixedAlert: selectors only, no threshold vars
   */
  function resolveRow(row, leafDef, preset) {
    const { name: _name, threshold: rowThreshold, ...selectors } = row

    // Resolve base threshold: row override > leaf template default
    const hasOverride = rowThreshold !== undefined && rowThreshold !== ''
    const baseThreshold = hasOverride ? Number(rowThreshold) : leafDef.threshold

    const expanded = { ...selectors }

    if (preset.fixedAlert) {
      return expanded
    }

    if (preset.tiers) {
      // single-threshold-3tier pattern: derive each tier from base × ratio
      for (const tier of preset.tiers) {
        expanded[tier.name] = Math.round(baseThreshold * tier.ratio * 10000) / 10000
      }
    } else {
      // multi-var threshold: map to named vars
      // leafDef.thresholds = { info: 0.4, warn: 0.6, crit: 0.8 } (severity-keyed)
      const thresholdVars = (preset.vars || []).filter(v => v.xVarType === 'threshold')
      for (const v of thresholdVars) {
        const severityVal = leafDef.thresholds?.[v.xSeverity]
        expanded[v.name] = severityVal ?? baseThreshold ?? v.default ?? 0
      }
    }

    return expanded
  }

  function groupRowsByName(rows) {
    const map = {}
    for (const { name, ...rest } of rows) {
      if (!name) continue
      if (!map[name]) map[name] = []
      map[name].push(rest)
    }
    return map
  }

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
    for (const sel of selectors) labelLines.push(`            ${sel}: "{{ .${sel} }}"`)

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

  function buildFullTemplate(mergedSchema, releaseName) {
    const fixedGroups = []
    for (const [alertGroup, alertDef] of Object.entries(mergedSchema.properties || {})) {
      if (alertGroup.startsWith('$')) continue
      if (alertDef['x-custom-template'] && alertDef['x-fixed-alert']) {
        fixedGroups.push(generateFixedAlertSnippet(alertGroup, alertDef))
      }
    }

    const standardYaml = generatePrometheusRule(mergedSchema, releaseName)

    if (fixedGroups.length === 0) return standardYaml

    const fixedBlock = fixedGroups.join('\n\n')
    if (!standardYaml.includes('  groups:')) {
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
        fixedBlock + '\n'
      )
    }
    return standardYaml.replace(/(\n  groups:\n)/, `$1${fixedBlock}\n\n`)
  }

  // ── POST /api/v2/import/parse-template ────────────────────────────────────
  // Validate and parse template YAML, return leaf summary for UI preview.

  router.post('/parse-template', async (req, res) => {
    const { templateYaml } = req.body
    if (!templateYaml) return res.status(400).json({ error: 'templateYaml required' })
    try {
      const doc = yaml.load(templateYaml)
      const presets = await loadPresets()
      const globalCtx = {
        preset:    doc.preset,
        threshold: doc.threshold,
      }
      const leafDefs = resolveTree(doc.tree || {}, globalCtx)

      const errors = []
      for (const [name, def] of Object.entries(leafDefs)) {
        if (!def.preset || !presets[def.preset]) errors.push(`Leaf "${name}": unknown preset "${def.preset}"`)
        if (!def.metricExpr) errors.push(`Leaf "${name}": missing metricExpr (or metric + exprTemplate)`)
        if (!presets[def.preset]?.fixedAlert && def.threshold == null && !def.thresholds) {
          errors.push(`Leaf "${name}": no threshold defined (set at leaf, parent, or global level)`)
        }
      }

      res.json({ leafDefs, errors })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // ── POST /api/v2/import/preview and POST /api/v2/import ──────────────────

  async function handleImport(req, res, dryRun) {
    const { chart, deployment, templateYaml, dataRows } = req.body

    if (!chart || !NAME_RE.test(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    if (!templateYaml) return res.status(400).json({ error: 'templateYaml required' })

    try {
      const presets = await loadPresets()

      const doc = yaml.load(templateYaml)
      const globalCtx = { preset: doc.preset, threshold: doc.threshold }
      const leafDefs = resolveTree(doc.tree || {}, globalCtx)

      if (Object.keys(leafDefs).length === 0) {
        return res.status(400).json({ error: 'No valid leaf nodes found in template YAML' })
      }

      // Build schema properties for each leaf
      const newProps = {}
      for (const [leafName, leafDef] of Object.entries(leafDefs)) {
        const preset = presets[leafDef.preset]
        if (!preset) return res.status(400).json({ error: `Unknown preset "${leafDef.preset}" for leaf "${leafName}"` })
        newProps[leafName] = buildLeafSchemaProp(preset, leafDef.metricExpr)
      }

      const chartDir = path.join(chartsDir, chart)
      const schemaFile = path.join(chartDir, 'values.schema.json')
      const tmplDir = path.join(chartDir, 'templates')

      const existingSchema = await readSchema(schemaFile)
      const mergedSchema = {
        ...existingSchema,
        properties: { ...existingSchema.properties, ...newProps },
      }

      const templateYamlOutput = buildFullTemplate(mergedSchema, '{{ .Release.Name }}')

      // Resolve data rows: threshold inheritance + tier expansion
      const rows = Array.isArray(dataRows) ? dataRows : []
      const expandedRows = rows.map(row => {
        const leafDef = leafDefs[row.name]
        if (!leafDef) return null
        const preset = presets[leafDef.preset]
        return { name: row.name, ...resolveRow(row, leafDef, preset) }
      }).filter(Boolean)

      const rowsByName = groupRowsByName(expandedRows)

      const stats = {
        leaves: Object.keys(leafDefs).length,
        rules: Object.values(newProps).reduce((acc, prop) => {
          if (prop['x-fixed-alert']) return acc + 1
          return acc + Object.values(prop.items?.properties || {}).filter(p => p['x-var-type'] === 'threshold').length
        }, 0),
        instances: expandedRows.length,
      }

      if (dryRun) {
        return res.json({
          leafDefs,
          schemaPreview: mergedSchema,
          templatePreview: templateYamlOutput,
          valuesPreview: rowsByName,
          stats,
        })
      }

      const depName = deployment && NAME_RE.test(deployment) ? deployment : 'default'
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(schemaFile, JSON.stringify(mergedSchema, null, 2), 'utf-8')
      await fs.writeFile(path.join(tmplDir, 'prometheus-rule.yaml'), templateYamlOutput, 'utf-8')

      const depDir = path.join(deploymentsDir, chart)
      const depValuesFile = path.join(depDir, `${depName}-values.yaml`)
      await fs.mkdir(depDir, { recursive: true })
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
