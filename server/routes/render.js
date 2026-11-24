import express from 'express'
import path from 'path'
import { chartDrift, readChartModel } from '../lib/chartFiles.js'
import { getDepName, unwrapValues } from '../lib/subchart.js'
import { resolveStack, readStackValues, mergeValues } from '../lib/stack.js'
import { getCommonSchema, isAlertGroup } from '../../src/utils/schemaUtils.js'
import { selfCheckRendered, tallyRendered, summarizeGroups } from '../../src/utils/renderSummary.js'
import { derivedTable } from '../../src/utils/rulesFile.js'
import { logger } from '../lib/logger.js'
import { checkRules, renderChart } from '../lib/ruleCheck.js'
import yaml from 'js-yaml'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { readTextIfThere, parseIfThere } from '../lib/readIfThere.js'
import { NAME_RE, isRepoPath, insideReal } from '../lib/safePath.js'

// One segment of a file name: not a path, not hidden.
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.)[^/\\\0]+$/

// The Preview summary the rule owner sees instead of raw YAML: per group, how
// many alerts it actually produced (by name and severity, never merged), which
// of the template's alerts produced nothing, and whether a group is empty
// (no rows) versus filled-but-silent (rows, zero alerts). Plus any value keys
// the schema no longer has — orphans left by a migration that didn't finish.
async function buildSummary(renderedYaml, { model, schema }, readValues, readDefaults = async () => ({})) {
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
      // A rule without its own severity takes its group's labels' (#182).
      .map(r => ({ alert: r.alert, severity: r.labels?.severity ?? g.labels?.severity ?? '' }))
  }

  const schemaGroups = new Set(schema ? Object.keys(schema.properties || {}).filter(isAlertGroup) : [])
  const commonSchemaProps = new Set(Object.keys(getCommonSchema(schema)?.properties || {}))

  const groupRows = {}
  const orphanFields = new Set()
  const values = await readValues()
  if (values) {
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
  }

  const types = Object.fromEntries(Object.entries(model?.groups || {}).map(([k, g]) => [k, g.type]))
  const onceGroups = Object.entries(model?.groups || {}).filter(([, g]) => g.once).map(([k]) => k)
  // Each row's derived values (#118), computed as the save check computes
  // them, from what Helm reads: the Template's values.yaml under the
  // deployment's (its Common Values too), on a stack what the layers add.
  const derived = model && values ? derivedTable(mergeValues(await readDefaults(), values), model) : {}
  const { groups, unmatchedGroups } = summarizeGroups({ rendered, possible, groupRows, schema, types, onceGroups, derived })
  return { total: rendered.total, groups, unmatchedGroups, orphanFields: [...orphanFields] }
}

export default function renderRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

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
      deploymentsDir = isRepoPath(folder) ? await insideReal(req.gitopsDir, folder) : null
      if (!deploymentsDir) return res.status(400).json({ error: 'Invalid folder path' })
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    // A folder deployment renders the Template at the bottom of its stack
    // (#100): through a `_common`, the dependency it names is not it.
    let template = chart
    try {
      const stack = folder ? await resolveStack(req.gitopsDir, deploymentsDir) : null
      template = stack?.chart || chart
      const chartDir = path.join(chartsDir, template)
      const releaseName = `${template}-${deployment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      // A link gone, a `_common` chart missing: Helm renders nothing and
      // says nothing, which would read as passed.
      if (stack?.problems.length) {
        return res.json({ ok: false, error: stack.problems.map(p => `${folder}: ${p.description}`).join('\n') })
      }
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
        logger.error({ err, chart: template, deployment }, 'readChartModel failed, rendering without a model')
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
      // parses wins. On a `_common` stack, what the layers and the deployment
      // add up to — and the Template's own values under a group none of them
      // gives, which Helm renders too.
      let valueWarnings = []
      const readValues = async () => {
        if (stack?.layers.length) {
          const stacked = await readStackValues(req.gitopsDir, deploymentsDir, stack)
          valueWarnings = stacked.nulls
          const defaults = (await parseIfThere(path.join(chartDir, 'values.yaml'), yaml.load)) || {}
          return mergeValues(defaults, stacked.merged)
        }
        const candidates = folder
          ? [path.join(deploymentsDir, 'values.yaml'), path.join(deploymentsDir, `${deployment}-values.yaml`)]
          : [path.join(deploymentsDir, `${deployment}-values.yaml`)]
        // Not there: the next one. One that cannot be read or parsed fails
        // the summary (logged), rather than showing another file's rows.
        for (const candidate of candidates) {
          const text = await readTextIfThere(candidate)
          if (text === null) continue
          return unwrapValues(yaml.load(text) || {}, stack?.keys[0] ?? await getDepName(path.dirname(candidate)))
        }
        return null
      }
      const readDefaults = async () => (await parseIfThere(path.join(chartDir, 'values.yaml'), yaml.load)) || {}
      const summary = await buildSummary(output, chartModel, readValues, readDefaults).catch(err => {
        logger.error({ err, chart: template, deployment }, 'buildSummary failed, falling back to raw YAML')
        return null
      })
      // The rule owner is looking at products; if they are older than the
      // chart's rules/ source, what they see here may not be current.
      const drift = await chartDrift(chartDir).catch(() => ({ state: 'ok' }))
      res.json({ ok: true, output, check, selfCheck, summary, drift, ...(valueWarnings.length ? { valueWarnings } : {}) })
    } catch (err) {
      res.json({ ok: false, error: err.stderr || err.stdout || err.message })
    }
  })

  return router
}
