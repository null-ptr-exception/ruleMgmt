import express from 'express'
import { holdSyncRegistryLock } from '../lib/sync.js'
import { diffSchema, describeChange, modelAlerts, groupTypeChanges, groupOnceChanges, groupSelectorChanges, groupSelectorLabelChanges } from '../../src/utils/schemaCompat.js'
import { findDeploymentsUsing, findChartUsage } from '../lib/chartUsage.js'
import { chartDrift, regenerateProducts, writeChanged, readChartArtifacts, readChartModel } from '../lib/chartFiles.js'
import { readTextIfThere, readDirIfThere, parseIfThere, UnreadableError } from '../lib/readIfThere.js'
import { planDeploymentMigration } from '../lib/migrate.js'
import { readSyncRegistry, isTarget, getSourceForTarget, withSyncRegistryLock } from '../lib/sync.js'
import { parseRulesDir, modelToSchema, genSchema, valueChecksKey } from '../../src/utils/rulesFile.js'
import { checkRules, saveBlockers } from '../../src/utils/ruleChecks.js'
import { generateProducts, staleTemplates, replacedByConversion } from '../../src/utils/drift.js'
import { isAlertGroup } from '../../src/utils/schemaUtils.js'
import { ensureChartYaml } from '../../src/utils/chartYaml.js'
import { objectMetaFromEnv } from '../../src/utils/objectMeta.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { writeWhole } from '../lib/routingFiles.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

// A templates/ file's text, for telling a 1.x rule file apart: null when it
// is not there or is a folder named *.yaml (not a rule object; Helm says so
// when it renders). Any other failure is an error naming it.
async function readTemplateText(file) {
  try {
    return await readTextIfThere(file)
  } catch (err) {
    if (err.cause?.code === 'EISDIR') return null
    throw err
  }
}
// A rules/ filename: a group file, or _common.yaml. Guards path traversal in
// the keys of the POST /:chart/rules body, and keeps a group key a name Helm
// can read (the same rule as GROUP_KEY_RE in rulesFile.js).
const RULES_FILE_RE = /^(_common|[a-z][a-z0-9_]*)\.yaml$/

/** Groups and per-group columns that are new in `after` vs `before` — mapping
 *  targets for a disappearing column or group in the breaking-change dialog. */
function addedInSchema(before, after) {
  const added = { groups: [], columns: {} }
  const beforeGroups = before?.properties || {}
  for (const [key, def] of Object.entries(after?.properties || {})) {
    if (!isAlertGroup(key)) continue
    if (!beforeGroups[key]) { added.groups.push(key); continue }
    const oldCols = Object.keys(beforeGroups[key].items?.properties || {})
    const fresh = Object.keys(def.items?.properties || {}).filter(c => !oldCols.includes(c))
    if (fresh.length) added.columns[key] = fresh
  }
  return added
}

async function withReadonly(gitopsDir, deployments) {
  const registry = await readSyncRegistry(gitopsDir)
  return deployments.map(d => ({ ...d, readonly: isTarget(registry, d.path) }))
}

// The Template's model as it is on disk, before a save: what a migrated
// deployment's values were valid against (#176). null when it has none.
// null when rules/ on disk does not parse: a partial model would make every
// problem a deployment already had look new.
async function modelBefore(chartDir) {
  const { rulesFiles } = await readChartArtifacts(chartDir)
  if (rulesFiles && Object.keys(rulesFiles).length && parseRulesDir(rulesFiles).errors.length) return null
  return (await readChartModel(chartDir)).model
}

// A refused deployment's new problems; a sync target names its source. A
// target its source's copy would fix has none of its own: one listed here
// is migrated on its own, and is changed by unlinking it.
async function withSources(gitopsDir, refused) {
  const registry = await readSyncRegistry(gitopsDir)
  return refused.map(d => ({
    path: d.path,
    readonly: d.readonly,
    ...(d.readonly ? { source: getSourceForTarget(registry, d.path) } : {}),
    problems: d.problems.filter(p => !p.before),
  }))
}

export default function templatesRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // The migration preview writes nothing, but waits all the same: a save in
  // progress writes rules/, templates, the schema and every deployment's
  // values one after another, and a preview read between them would check
  // values of one version against rules of another.
  router.use(holdSyncRegistryLock)

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

  // null when values.schema.json is not there. One that cannot be read, or
  // is not JSON, is an error naming it: a save that took it for none would
  // drop the x-custom-template groups it holds. Opening the chart (`shown`)
  // takes a schema that is not JSON as none, so the editor still opens and
  // the drift says so.
  async function readSchema(schemaFile, { shown = false } = {}) {
    const raw = await readTextIfThere(schemaFile)
    if (raw === null) return null
    try {
      return JSON.parse(raw)
    } catch (err) {
      if (shown) return null
      throw new UnreadableError(schemaFile, { reason: `not valid JSON (${err.message}) — fix it by hand, or remove it to generate it again` })
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
      // Reading a chart that does not exist must not create it — a typo or a
      // stale saved selection would leave a directory under charts/.
      try { await fs.access(chartDir) } catch { return res.status(404).json({ error: 'Chart not found' }) }
      // A GET is not held by the commit's lock (holdSyncRegistryLock lets
      // reads through), but these two write: they take it themselves, so a
      // commit does not stage half the products.
      let drift = await chartDrift(chartDir)
      let chartYamlMissing = false
      try { await fs.access(chartYamlFile) } catch { chartYamlMissing = true }
      if (chartYamlMissing || drift.state === 'missing') {
        drift = await withSyncRegistryLock(req.gitopsDir, async () => {
          try {
            await fs.access(chartYamlFile)
          } catch {
            const { text } = ensureChartYaml(null, req.params.chart)
            await writeWhole(chartYamlFile, text)
          }
          let d = await chartDrift(chartDir)
          if (d.state === 'missing') {
            await regenerateProducts(chartDir)
            d = await chartDrift(chartDir)
          }
          return d
        })
      }

      const templateFiles = ((await readDirIfThere(tmplDir)) || [])
        .filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))

      const schema = await readSchema(schemaFile, { shown: true })

      // Not there: none. One that cannot be read or parsed is said, not
      // shown as empty for a Save to write over.
      const values = (await parseIfThere(valuesFile, yaml.load)) || {}
      const chartMeta = (await parseIfThere(chartYamlFile, yaml.load)) || {}

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

  // Save a chart's rules/*.yaml source, and regenerate every product from it
  // in one request.
  //
  // The client sends the whole set of rules files as text; the server parses
  // them, checks them, works out what breaks, generates values.schema.json and
  // every templates/*.yaml, and writes the lot all-or-nothing — everything is
  // computed in memory first, so a generation failure leaves the chart
  // untouched (an I/O failure mid-write is not rolled back; see writeChanged).
  // Only files whose content changed are written; the rules files
  // are written through verbatim so hand-added comments survive.
  router.post('/:chart/rules', async (req, res) => {
    const { chartDir, tmplDir, schemaFile, chartYamlFile } = chartPaths(req, req.params.chart)
    const { files, confirmBreaking, migration } = req.body || {}

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

      const findings = saveBlockers(checkRules(genSchema(model, before)))
      if (findings.length) return res.status(400).json({ error: 'Rule checks failed', findings })

      // Schema carries no rule data any more, so rule-removed detection reads
      // alert names from the model on both sides — the old rules/*.yaml on
      // disk (absent on a legacy chart's first migration, same as before).
      const { rulesFiles: oldRulesFiles } = await readChartArtifacts(chartDir)
      const beforeModel = oldRulesFiles ? parseRulesDir(oldRulesFiles).model : null
      const { breaking, isBreaking, notices } = diffSchema(before, newSchema, {
        before: modelAlerts(beforeModel),
        after: modelAlerts(model),
      })
      // A group changing output profile replaces its objects (#65): a notice,
      // shown with a breaking change or on its own after the save.
      notices.push(...groupTypeChanges(beforeModel, model, objectMetaFromEnv()), ...groupOnceChanges(beforeModel, model), ...groupSelectorChanges(beforeModel, model), ...groupSelectorLabelChanges(beforeModel, model))
      const withDesc = list => list.map(c => ({ ...c, description: describeChange(c) }))
      if (!confirmBreaking && isBreaking) {
        const { deployments, unreadable } = await findChartUsage(req.gitopsDir, req.params.chart, process.env.DEPLOYMENTS_DIR)
        // A folder that cannot be read may hold one: said, so the change is
        // confirmed knowing it.
        if (deployments.length > 0 || unreadable.length > 0) {
          return res.status(409).json({
            error: 'Breaking schema change',
            breaking: withDesc(breaking),
            notices: withDesc(notices),
            added: addedInSchema(before, newSchema),
            deployments: await withReadonly(req.gitopsDir, deployments),
            ...(unreadable.length ? { unreadable } : {}),
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

      // A confirmed breaking change carries a mapping — rewrite every affected
      // deployment's values.yaml in the same request.
      let migratedDeployments = []
      let migrationWrites = []
      let targetWrites = []
      if (confirmBreaking && migration && isBreaking) {
        try {
          const plan = await planDeploymentMigration(req.gitopsDir, req.params.chart, newSchema, migration, {
            deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: await modelBefore(chartDir),
          })
          migratedDeployments = plan.deployments
          migrationWrites = plan.writes.filter(w => !w[2]).map(([file, text]) => [file, text])
          targetWrites = plan.writes.filter(w => w[2])
        } catch (err) {
          return res.status(500).json({ error: `Deployment migration failed: ${err.message}` })
        }
        // What a values save would refuse is not written by a migration
        // either (#176). A problem a deployment had already is not this
        // change's doing: it is shown in the preview, not a reason to refuse.
        const refused = migratedDeployments.filter(d => d.problems.some(p => !p.before))
        if (refused.length) {
          return res.status(409).json({
            error: 'The migration would write values a save refuses',
            migrationProblems: await withSources(req.gitopsDir, refused),
          })
        }
      }

      // A change that is not breaking writes no deployment, but can still
      // leave one with values a save refuses — a column made a selector
      // that two rows fill the same (#176). Checked the same way, against
      // the values as they are; one that cannot be read is no reason to
      // stop this save.
      // Every deployment is read only when the change can give one a new
      // problem: with no model before, none counts as new; with the same
      // checks as before, each has the problems it had.
      const checkedBefore = !(confirmBreaking && migration && isBreaking) ? await modelBefore(chartDir) : null
      if (checkedBefore && valueChecksKey(checkedBefore) !== valueChecksKey(model)) {
        const plan = await planDeploymentMigration(req.gitopsDir, req.params.chart, newSchema, {}, {
          deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: checkedBefore, checkOnly: true,
        })
        const refused = plan.deployments.filter(d => d.problems.some(p => !p.before))
        if (refused.length) {
          return res.status(409).json({
            error: 'This change would leave deployments with values a save refuses',
            migrationProblems: await withSources(req.gitopsDir, refused),
          })
        }
      }

      const rulesDir = path.join(chartDir, 'rules')
      const entries = [
        ...Object.entries(files).map(([name, text]) => [path.join(rulesDir, name), text]),
        ...Object.entries(products.templates).map(([name, text]) => [path.join(tmplDir, name), text]),
        [schemaFile, products.schemaText],
        ...migrationWrites,
      ]
      // Made only when it is not there: one that cannot be read is not
      // written over.
      const chartYamlRaw = await readTextIfThere(chartYamlFile)
      const { text: chartYamlText, created } = ensureChartYaml(chartYamlRaw, req.params.chart)
      if (created) entries.push([chartYamlFile, chartYamlText])

      // Files on disk with no counterpart any more: a removed group, or a
      // _common.yaml for a chart that no longer has common columns. In
      // templates/ only a generated file is: one a hand-written file sits
      // next to is left alone (#114).
      const listYaml = async dir => ((await readDirIfThere(dir)) || []).filter(f => f.endsWith('.yaml'))
      // Converting a 1.x chart (no rules/ before): its old rule file, which
      // holds every group under a name no group has, goes too (#190).
      const templateNames = await listYaml(tmplDir)
      const replaced = oldRulesFiles && Object.keys(oldRulesFiles).length ? [] : replacedByConversion(
        Object.fromEntries(await Promise.all(templateNames.map(async f => [f, await readTemplateText(path.join(tmplDir, f))]))),
        products.templates)
      const removed = [
        ...(await listYaml(rulesDir)).filter(f => !(f in files)).map(f => path.join(rulesDir, f)),
        ...[...new Set([...staleTemplates(templateNames, products.templates, { schemas: [before], models: [beforeModel, model] }), ...replaced])]
          .map(f => path.join(tmplDir, f)),
      ]

      const wrote = await writeChanged(entries)
      for (const abs of removed) await fs.rm(abs, { force: true })
      // A sync target that cannot be written does not undo the Template or
      // its source: it is reported, as a values save reports it (#180).
      const syncFailed = []
      for (const [file, text, , target] of targetWrites) {
        try {
          wrote.push(...await writeChanged([[file, text]]))
        } catch (err) {
          console.error(`Migration: ${target} could not be written`, err)
          syncFailed.push({ target, error: err.code || err.message })
        }
      }

      res.json({
        ok: true,
        written: [
          ...wrote.map(p => path.relative(chartDir, p)),
          ...removed.map(p => `- ${path.relative(chartDir, p)}`),
        ],
        notices: withDesc(notices),
        migrated: migratedDeployments.map(d => ({ deployment: d.deployment, path: d.path, readonly: d.readonly, copiedFrom: d.copiedFrom, rowsChanged: d.rowsChanged })),
        ...(syncFailed.length ? { syncFailed } : {}),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // What a breaking change plus a mapping would do to every affected
  // deployment — feeds step 3 of the breaking-change dialog. Writes nothing.
  router.post('/:chart/migration-preview', async (req, res) => {
    const { schemaFile } = chartPaths(req, req.params.chart)
    const { files, migration } = req.body || {}
    if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files object required' })
    try {
      const { model, errors } = parseRulesDir(files)
      if (errors.length) return res.status(400).json({ error: 'Invalid rules', errors })
      const targetSchema = modelToSchema(model, await readSchema(schemaFile))
      const { deployments } = await planDeploymentMigration(
        req.gitopsDir, req.params.chart, targetSchema, migration || {},
        { deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: await modelBefore(chartPaths(req, req.params.chart).chartDir) })
      res.json({ deployments })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level default values
  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req, req.params.chart)
    const { values } = req.body
    try {
      const content = typeof values === 'string' ? values : dumpForHelm(values, { lineWidth: -1 })
      await writeWhole(valuesFile, content)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save Chart.yaml metadata (name, description, version)
  // The editor's Save writes the description, and only that: the rest
  // of Chart.yaml is read from disk, so a page loaded before a pull cannot
  // write back the version it loaded — every deployment asks for one.
  router.post('/:chart/chart-meta', async (req, res) => {
    const { chartYamlFile } = chartPaths(req, req.params.chart)
    const chartMeta = req.body?.chartMeta
    if (!chartMeta || typeof chartMeta !== 'object' || Array.isArray(chartMeta)) {
      return res.status(400).json({ error: 'chartMeta must be { description }' })
    }
    // Left out, the description stays as it is; null or '' removes it.
    const { description } = chartMeta
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return res.status(400).json({ error: 'description must be text' })
    }
    let onDisk
    try {
      onDisk = yaml.load(await fs.readFile(chartYamlFile, 'utf-8'))
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: `${req.params.chart} has no Chart.yaml` })
      return res.status(400).json({ error: `Chart.yaml is not valid YAML (${err.reason || err.message}) — fix it by hand; Save would lose what it holds` })
    }
    if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) {
      return res.status(400).json({ error: 'Chart.yaml is not a map — fix it by hand; Save would lose what it holds' })
    }
    const next = { ...onDisk }
    if (description) next.description = description
    else if (description !== undefined) delete next.description
    try {
      await writeWhole(chartYamlFile, dumpForHelm(next, { lineWidth: -1 }))
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
      const content = await readTextIfThere(tmplFile)
      if (content === null) return res.status(404).json({ error: 'Template not found' })
      res.json({ content })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save a template file's content
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await writeWhole(tmplFile, content)
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
