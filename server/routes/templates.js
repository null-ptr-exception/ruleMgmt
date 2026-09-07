import express from 'express'
import { diffSchema, describeChange } from '../../src/utils/schemaCompat.js'
import { findDeploymentsUsing } from '../lib/chartUsage.js'
import { chartDrift, regenerateProducts, writeChanged, readChartArtifacts } from '../lib/chartFiles.js'
import { parseRulesDir, modelToSchema } from '../../src/utils/rulesFile.js'
import { checkRules, saveBlockers } from '../../src/utils/ruleChecks.js'
import { generateProducts } from '../../src/utils/drift.js'
import { isAlertGroup } from '../../src/utils/schemaUtils.js'
import { ensureChartYaml } from '../../src/utils/chartYaml.js'
import { objectMetaFromEnv } from '../../src/utils/objectMeta.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
// A rules/ filename: a group file, or _common.yaml. Guards path traversal in
// the keys of the POST /:chart/rules body.
const RULES_FILE_RE = /^(_common|[a-z0-9][a-z0-9_-]*)\.yaml$/

export default function templatesRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  function chartPaths(req, chart) {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const chartDir = path.join(chartsDir, chart)
    return {
      chartDir,
      tmplDir: path.join(chartDir, 'templates'),
      valuesFile: path.join(chartDir, 'values.yaml'),
      schemaFile: path.join(chartDir, 'values.schema.json'),
      chartYamlFile: path.join(chartDir, 'Chart.yaml'),
    }
  }

  async function readSchema(schemaFile) {
    try {
      const raw = await fs.readFile(schemaFile, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  // Get chart-level info: schema + values + Chart.yaml metadata + template file
  // list + product drift.
  //
  // Opening a chart is the moment a missing Chart.yaml is filled in and missing
  // products are generated (nothing is overwritten either way) — deliberately
  // not the list route, where a write would be a side effect of scrolling past.
  router.get('/:chart', async (req, res) => {
    const { chartDir, tmplDir, valuesFile, schemaFile, chartYamlFile } = chartPaths(req, req.params.chart)
    try {
      try {
        await fs.access(chartYamlFile)
      } catch {
        const { text } = ensureChartYaml(null, req.params.chart)
        await fs.mkdir(chartDir, { recursive: true })
        await fs.writeFile(chartYamlFile, text, 'utf-8')
      }

      let drift = await chartDrift(chartDir)
      if (drift.state === 'missing') {
        await regenerateProducts(chartDir)
        drift = await chartDrift(chartDir)
      }

      let templateFiles = []
      try {
        const files = await fs.readdir(tmplDir)
        templateFiles = files.filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))
      } catch { /* no templates dir */ }

      const schema = await readSchema(schemaFile)

      let values = {}
      try {
        const raw = await fs.readFile(valuesFile, 'utf-8')
        values = yaml.load(raw) || {}
      } catch { /* use default */ }

      let chartMeta = {}
      try {
        const raw = await fs.readFile(chartYamlFile, 'utf-8')
        chartMeta = yaml.load(raw) || {}
      } catch { /* use default */ }

      // The editor loads from these; null when the chart has not been migrated
      // to the rules/ format yet (it falls back to reading `schema`).
      const { rulesFiles } = await readChartArtifacts(chartDir)

      res.json({ templateFiles, schema, values, chartMeta, drift, rulesFiles })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // --- Chart-level endpoints (must be before /:chart/:template) ---

  // Which deployments are using this chart. Needed before a breaking change,
  // and to know when an old chart is free to retire.
  router.get('/:chart/deployments', async (req, res) => {
    try {
      res.json({ deployments: await findDeploymentsUsing(req.gitopsDir, req.params.chart, process.env.DEPLOYMENTS_DIR) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level schema.
  //
  // A change that would orphan data a rule owner already entered is refused
  // rather than written silently — the caller gets what breaks and who is
  // affected, and decides: clone the chart, or confirm and overwrite.
  router.post('/:chart/schema', async (req, res) => {
    const { schemaFile } = chartPaths(req, req.params.chart)
    const { schema, confirmBreaking } = req.body
    try {
      const before = await readSchema(schemaFile)
      const { breaking, isBreaking, notices } = diffSchema(before, schema)
      const withDesc = list => list.map(c => ({ ...c, description: describeChange(c) }))
      if (!confirmBreaking && isBreaking) {
        const deployments = await findDeploymentsUsing(req.gitopsDir, req.params.chart, process.env.DEPLOYMENTS_DIR)
        if (deployments.length > 0) {
          return res.status(409).json({
            error: 'Breaking schema change',
            breaking: withDesc(breaking),
            notices: withDesc(notices),
            deployments
          })
        }
      }
      await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2), 'utf-8')
      res.json({ ok: true, notices: withDesc(notices) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save a chart's rules/*.yaml source, and regenerate every product from it
  // in one request.
  //
  // The client sends the whole set of rules files as text; the server parses
  // them, checks them, works out what breaks, generates values.schema.json and
  // every templates/*.yaml, and writes the lot all-or-nothing — everything is
  // computed in memory first, so a generation failure leaves the chart
  // untouched. Only files whose content changed are written; the rules files
  // are written through verbatim so hand-added comments survive.
  router.post('/:chart/rules', async (req, res) => {
    const { chartDir, tmplDir, schemaFile, chartYamlFile } = chartPaths(req, req.params.chart)
    const { files, confirmBreaking } = req.body || {}

    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      return res.status(400).json({ error: 'files object required' })
    }
    for (const name of Object.keys(files)) {
      if (!RULES_FILE_RE.test(name) || typeof files[name] !== 'string') {
        return res.status(400).json({ error: `Invalid rules file name: ${name}` })
      }
    }

    try {
      const { model, errors } = parseRulesDir(files)
      if (errors.length) return res.status(400).json({ error: 'Invalid rules', errors })

      const before = await readSchema(schemaFile)

      // An x-custom-template group has no rules file — carry it over from the
      // schema so its hand-written template is neither regenerated nor deleted.
      for (const [key, def] of Object.entries(before?.properties || {})) {
        if (isAlertGroup(key) && def['x-custom-template'] && !model.groups[key]) {
          model.groups[key] = { group: key, custom: true }
        }
      }

      const newSchema = modelToSchema(model, before)

      const findings = saveBlockers(checkRules(newSchema))
      if (findings.length) return res.status(400).json({ error: 'Rule checks failed', findings })

      const { breaking, isBreaking, notices } = diffSchema(before, newSchema)
      const withDesc = list => list.map(c => ({ ...c, description: describeChange(c) }))
      if (!confirmBreaking && isBreaking) {
        const deployments = await findDeploymentsUsing(req.gitopsDir, req.params.chart, process.env.DEPLOYMENTS_DIR)
        if (deployments.length > 0) {
          return res.status(409).json({
            error: 'Breaking schema change',
            breaking: withDesc(breaking),
            notices: withDesc(notices),
            deployments
          })
        }
      }

      // Compute every output before writing anything.
      let products
      try {
        products = generateProducts(model, before, objectMetaFromEnv())
      } catch (err) {
        return res.status(500).json({ error: `Generation failed: ${err.message}` })
      }

      const rulesDir = path.join(chartDir, 'rules')
      const entries = [
        ...Object.entries(files).map(([name, text]) => [path.join(rulesDir, name), text]),
        ...Object.entries(products.templates).map(([name, text]) => [path.join(tmplDir, name), text]),
        [schemaFile, products.schemaText],
      ]
      let chartYamlRaw = null
      try { chartYamlRaw = await fs.readFile(chartYamlFile, 'utf-8') } catch { /* absent */ }
      const { text: chartYamlText, created } = ensureChartYaml(chartYamlRaw, req.params.chart)
      if (created) entries.push([chartYamlFile, chartYamlText])

      // Files on disk with no counterpart any more: a removed group, or a
      // _common.yaml for a chart that no longer has common columns. A
      // hand-written x-custom-template's file is left alone.
      const customTemplates = new Set(
        Object.entries(newSchema.properties || {})
          .filter(([k, d]) => isAlertGroup(k) && d['x-custom-template'])
          .map(([k]) => `${k.replace(/_/g, '-')}.yaml`)
      )
      const keep = { rules: new Set(Object.keys(files)), templates: new Set(Object.keys(products.templates)) }
      const removed = []
      for (const [dir, kind] of [[rulesDir, 'rules'], [tmplDir, 'templates']]) {
        let onDisk = []
        try { onDisk = (await fs.readdir(dir)).filter(f => f.endsWith('.yaml')) } catch { /* absent */ }
        for (const f of onDisk) {
          if (keep[kind].has(f)) continue
          if (kind === 'templates' && customTemplates.has(f)) continue
          removed.push(path.join(dir, f))
        }
      }

      const wrote = await writeChanged(entries)
      for (const abs of removed) await fs.rm(abs, { force: true })

      res.json({
        ok: true,
        written: [
          ...wrote.map(p => path.relative(chartDir, p)),
          ...removed.map(p => `- ${path.relative(chartDir, p)}`),
        ],
        notices: withDesc(notices),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level default values
  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req, req.params.chart)
    const { values } = req.body
    try {
      const content = typeof values === 'string' ? values : yaml.dump(values, { lineWidth: -1 })
      await fs.writeFile(valuesFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save Chart.yaml metadata (name, description, version)
  router.post('/:chart/chart-meta', async (req, res) => {
    const { chartYamlFile } = chartPaths(req, req.params.chart)
    const { chartMeta } = req.body
    try {
      await fs.writeFile(chartYamlFile, yaml.dump(chartMeta, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Rename a template file
  router.post('/:chart/:template/rename', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const { newName } = req.body
    if (!newName || !NAME_RE.test(newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const oldFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const newFile = path.join(tmplDir, `${newName}.yaml`)
    try {
      await fs.rename(oldFile, newFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // --- Template file endpoints ---

  // Get a single template file's content
  router.get('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      const content = await fs.readFile(tmplFile, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'Template not found' })
    }
  })

  // Save a template file's content
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(tmplFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete a template file
  router.delete('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      await fs.rm(tmplFile, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
