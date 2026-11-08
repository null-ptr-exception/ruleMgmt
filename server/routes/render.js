import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import { chartDrift, readChartModel } from '../lib/chartFiles.js'
import { getDepName, unwrapValues } from '../lib/subchart.js'
import { getCommonSchema, isAlertGroup } from '../../src/utils/schemaUtils.js'
import { selfCheckRendered, tallyRendered, summarizeGroups } from '../../src/utils/renderSummary.js'
import { logger } from '../lib/logger.js'
import { checkRules, renderChart } from '../lib/ruleCheck.js'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

// The Preview summary the rule owner sees instead of raw YAML: per group, how
// many alerts it actually produced (by name and severity, never merged), which
// of the template's alerts produced nothing, and whether a group is empty
// (no rows) versus filled-but-silent (rows, zero alerts). Plus any value keys
// the schema no longer has — orphans left by a migration that didn't finish.
async function buildSummary(renderedYaml, { model, schema }, valuesFilePaths) {
  let rendered
  try {
    rendered = tallyRendered(renderedYaml)
  } catch {
    return null
  }

  // Possible (alert, severity) pairs per group key, from the chart's rules/
  // (or a legacy schema through the upgrade adapter). With no schema yet there
  // is no possible-alert list and no orphan check.
  const possible = {}
  for (const [key, g] of Object.entries(model?.groups || {})) {
    possible[key] = (g.rules || [])
      .filter(r => r.alert)
      .map(r => ({ alert: r.alert, severity: r.labels?.severity ?? '' }))
  }

  const schemaGroups = new Set(schema ? Object.keys(schema.properties || {}).filter(isAlertGroup) : [])
  const commonSchemaProps = new Set(Object.keys(getCommonSchema(schema)?.properties || {}))

  const groupRows = {}
  const orphanFields = new Set()
  for (const candidate of valuesFilePaths) {
    let parsed
    try {
      parsed = yaml.load(await fs.readFile(candidate, 'utf-8'))
    } catch {
      continue
    }
    const values = unwrapValues(parsed || {}, await getDepName(path.dirname(candidate)))
    for (const [k, v] of Object.entries(values || {})) {
      if (k === '_common') {
        if (schema) for (const f of Object.keys(v || {})) if (!commonSchemaProps.has(f)) orphanFields.add(f)
        continue
      }
      if (!Array.isArray(v)) continue
      groupRows[k] = v.length
      if (schema && !schemaGroups.has(k)) { orphanFields.add(k); continue }
      const groupFields = new Set(Object.keys(schema?.properties?.[k]?.items?.properties || {}))
      if (schema) for (const row of v) for (const f of Object.keys(row || {})) if (!groupFields.has(f)) orphanFields.add(f)
    }
    break
  }

  const types = Object.fromEntries(Object.entries(model?.groups || {}).map(([k, g]) => [k, g.type]))
  const onceGroups = Object.entries(model?.groups || {}).filter(([, g]) => g.once).map(([k]) => k)
  const { groups, unmatchedGroups } = summarizeGroups({ rendered, possible, groupRows, schema, types, onceGroups })
  return { total: rendered.total, groups, unmatchedGroups, orphanFields: [...orphanFields] }
}

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const { chart, deployment } = req.params
    const folder = req.query.folder
    const deploymentValid = folder
      ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
      : NAME_RE.test(deployment)
    if (!NAME_RE.test(chart) || !deploymentValid) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }

    let deploymentsDir
    if (folder) {
      if (folder.includes('..')) return res.status(400).json({ error: 'Invalid folder path' })
      deploymentsDir = path.join(req.gitopsDir, folder)
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    const chartDir = path.join(chartsDir, chart)
    const releaseName = `${chart}-${deployment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')

    try {
      const templateDir = folder ? deploymentsDir : chartDir

      let templateArgs
      if (folder) {
        templateArgs = ['template', releaseName, templateDir]
      } else {
        const valuesFile = path.join(deploymentsDir, `${deployment}-values.yaml`)
        templateArgs = ['template', releaseName, chartDir, '-f', valuesFile]
      }

      const output = await renderChart(templateDir, templateArgs)
      const check = await checkRules(output)
      // Like the summary and drift below: optional, so a failure here cannot
      // turn a good render into { ok: false }.
      const chartModel = await readChartModel(chartDir).catch(err => {
        logger.error({ err, chart, deployment }, 'readChartModel failed, rendering without a model')
        return { model: null, fromRules: false, schema: null }
      })
      let selfCheck = null
      try {
        selfCheck = selfCheckRendered(output, chartModel.fromRules ? chartModel.model : null)
      } catch (err) {
        logger.error({ err, chart, deployment }, 'selfCheckRendered failed, skipping the self-check')
      }
      // Same file the frontend saves: `values.yaml` in folder mode, the legacy
      // `<deployment>-values.yaml` otherwise. Both are tried; the first that
      // parses wins.
      const valuesFilePaths = folder
        ? [path.join(deploymentsDir, 'values.yaml'), path.join(deploymentsDir, `${deployment}-values.yaml`)]
        : [path.join(deploymentsDir, `${deployment}-values.yaml`)]
      const summary = await buildSummary(output, chartModel, valuesFilePaths).catch(err => {
        logger.error({ err, chart, deployment }, 'buildSummary failed, falling back to raw YAML')
        return null
      })
      // The rule owner is looking at products; if they are older than the
      // chart's rules/ source, what they see here may not be current.
      const drift = await chartDrift(chartDir).catch(() => ({ state: 'ok' }))
      res.json({ ok: true, output, check, selfCheck, summary, drift })
    } catch (err) {
      res.json({ ok: false, error: err.stderr || err.stdout || err.message })
    }
  })

  return router
}
