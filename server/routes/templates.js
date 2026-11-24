import express from 'express'
import { holdSyncRegistryLock } from '../lib/sync.js'
import { diffSchema, describeChange, modelAlerts, groupTypeChanges, groupNameChanges, groupOnceChanges, groupSelectorChanges, groupSelectorLabelChanges } from '../../src/utils/schemaCompat.js'
import { findChartUsage } from '../lib/chartUsage.js'
import { regenerateProducts, writeChanged, readTemplate } from '../lib/chartFiles.js'
import { UnreadableError, errorAnswer } from '../lib/readIfThere.js'
import { planDeploymentMigration } from '../lib/migrate.js'
import { isTarget, getSourceForTarget, withSyncRegistryLock } from '../lib/sync.js'
import { readRegistry } from '../repo/sync.js'
import { NotLoadedError } from '../repo/loaded.js'
import { parseRulesDir, modelToSchema, genSchema, valueChecksKey } from '../../src/utils/rulesFile.js'
import { checkRules, saveBlockers } from '../../src/utils/ruleChecks.js'
import { generateProducts, staleTemplates, replacedByConversion } from '../../src/utils/drift.js'
import { isAlertGroup } from '../../src/utils/schemaUtils.js'
import { ensureChartYaml } from '../../src/utils/chartYaml.js'
import { objectMetaFromEnv } from '../../src/utils/objectMeta.js'
import fs from 'fs/promises'
import path from 'path'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { writeWhole } from '../lib/routingFiles.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { answerRejections } from '../lib/answerRejections.js'
import { pathProblem, parsePath } from '../repo/paths.js'
import { openRepo } from '../repo/openRepo.js'
import { decide } from '../repo/policy.js'
import { TEMPLATE_POLICIES } from '../repo/findings/template.js'
import { writeProblems, writeRefusal } from '../repo/writePath.js'

// What a save refuses: what it writes. What another file of the Template
// keeps Helm from rendering is said with the save, not a reason to lose it.
function splitBySave({ refuse, warn = [] }, writes) {
  return { refuse: refuse.filter(writes), elsewhere: [...refuse.filter(f => !writes(f)), ...warn] }
}

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)

// A rules/ filename: a group file, or _common.yaml. Guards path traversal in
// the keys of the POST /:chart/rules body, and keeps a group key a name Helm
// can read (the same rule as GROUP_KEY_RE in rulesFile.js): paths.js.

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
  const registry = await readRegistry(openRepo(gitopsDir))
  return deployments.map(d => ({ ...d, readonly: isTarget(registry, d.path) }))
}

// The Template's model as it is on disk, before a save: what a migrated
// deployment's values were valid against (#176). null when it has none.
// null when rules/ on disk does not parse: a partial model would make every
// problem a deployment already had look new.
const modelBefore = t => (t?.ruleErrors.length ? null : t?.model ?? null)

// A refused deployment's new problems; a sync target names its source. A
// target its source's copy would fix has none of its own: one listed here
// is migrated on its own, and is changed by unlinking it.
async function withSources(gitopsDir, refused) {
  const registry = await readRegistry(openRepo(gitopsDir))
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
    const chart = pathProblem(req.params.chart, 'name')
    if (chart) return res.status(400).json({ error: `Invalid chart name: ${chart.why}` })
    next()
  })
  // A template file is named like a file, never a path (paths.js).
  router.use('/:chart/:template', (req, res, next) => {
    const template = pathProblem(req.params.template, 'file', { suffix: '.yaml' })
    if (template) return res.status(400).json({ error: `Invalid template name: ${template.why}` })
    next()
  })
  // Where the file really is, through a link: in the repo.
  const templateFile = async req => {
    const p = await parsePath(req.params.template, 'file', { under: chartPaths(req, req.params.chart).tmplDir, suffix: '.yaml' })
    return p.ok ? p.abs : null
  }
  // A template file as the repo names it: charts/<chart>/templates/<name>.yaml.
  const templateRel = (req, name) => path.relative(req.gitopsDir, path.join(chartPaths(req, req.params.chart).tmplDir, `${name}.yaml`)).replace(/\\/g, '/')
  // A write to a template file never lands outside the repo: a chart folder
  // or a templates/ folder that is a link leading out is refused (409, the
  // file named), as the Template's other routes refuse it.
  const outsideRefusal = async (req, names) => {
    const problem = await writeProblems(req.gitopsDir, names.map(n => templateRel(req, n)))
    return problem ? writeRefusal(problem) : null
  }

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

  // The schema a save carries x-custom-template groups over from: null when
  // it is not there. One that cannot be read (readTemplate) or is not JSON
  // is an error naming it: a save that took it for none would drop the
  // groups it holds.
  function schemaBefore(req, t) {
    if (!t) return null
    if (t.schemaNotJson !== null) {
      throw new UnreadableError(path.join(req.gitopsDir, t.dir, 'values.schema.json'), { reason: `not valid JSON (${t.schemaNotJson}) — fix it by hand, or remove it to generate it again` })
    }
    return t.schema
  }

  // Get chart-level info: schema + values + Chart.yaml metadata + template file
  // list + product drift.
  //
  // Opening a chart is the moment a missing Chart.yaml is filled in and missing
  // products are generated (nothing is overwritten either way) — deliberately
  // not the list route, where a write would be a side effect of scrolling past.
  router.get('/:chart', async (req, res) => {
    const { chartYamlFile } = chartPaths(req, req.params.chart)
    const chart = req.params.chart
    try {
      // Reading a chart that does not exist must not create it — a typo or a
      // stale saved selection would leave a directory under charts/.
      let t = await readTemplate(req.gitopsDir, chart)
      if (!t) return res.status(404).json({ error: 'Chart not found' })
      // A GET is not held by the commit's lock (holdSyncRegistryLock lets
      // reads through), but these two write: they take it themselves, so a
      // commit does not stage half the products.
      const chartYamlMissing = t.findings.some(f => f.code === 'template.chart-absent')
      if (chartYamlMissing || t.drift.state === 'missing') {
        t = await withSyncRegistryLock(req.gitopsDir, async () => {
          let now = await readTemplate(req.gitopsDir, chart)
          // Deleted meanwhile: not there to open.
          if (!now) return null
          if (now.findings.some(f => f.code === 'template.chart-absent')) {
            const { text } = ensureChartYaml(null, chart)
            await writeWhole(chartYamlFile, text)
          }
          if (now.drift.state === 'missing') await regenerateProducts(req.gitopsDir, chart)
          now = await readTemplate(req.gitopsDir, chart)
          return now
        })
        if (!t) return res.status(404).json({ error: 'Chart not found' })
      }

      const templateFiles = t.templateNames.map(f => f.replace(/\.yaml$/, ''))

      // The values and Chart.yaml as Helm reads them (`010` is 8). One that
      // cannot be read or parsed is said, not shown as empty for a Save to
      // write over.
      const stop = t.findings.find(f => /^template\.(values|chart)-(unreadable|not-yaml|cannot-tell|not-map)$/.test(f.code))
      if (stop) throw new UnreadableError(path.join(req.gitopsDir, stop.file), { reason: stop.detail?.why ?? stop.message })

      // The editor loads from `rulesFiles`; null when the chart has not been
      // migrated to the rules/ format yet (it falls back to reading `schema`).
      // A schema that is not JSON is shown as none on a chart with rules/: it
      // is a product, the drift says it is missing and Save writes it again.
      res.json({ templateFiles, schema: t.schema, values: t.values, chartMeta: t.chart || {}, drift: t.drift, rulesFiles: t.rulesFiles })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // --- Chart-level endpoints (must be before /:chart/:template) ---

  // Which deployments are using this chart. Needed before a breaking change,
  // and to know when an old chart is free to retire.
  router.get('/:chart/deployments', async (req, res) => {
    try {
      res.json(await findChartUsage(req.gitopsDir, req.params.chart, process.env.DEPLOYMENTS_DIR))
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
      if (pathProblem(name, 'rules-file') || typeof files[name] !== 'string') {
        return res.status(400).json({ error: `Invalid rules file name: ${name}` })
      }
    }

    try {
      const { model, errors } = parseRulesDir(files)
      if (errors.length) return res.status(400).json({ error: 'Invalid rules', errors })

      const onDisk = await readTemplate(req.gitopsDir, req.params.chart)
      const before = schemaBefore(req, onDisk)
      // rules/ gone (or empty) beside a schema the generator wrote: what the
      // editor sends is that schema converted, every group with no rules.
      // Written, the Template deploys no alert.
      const gone = onDisk?.findings.find(f => f.code === 'template.rules-gone')
      if (gone && Object.values(model.groups).every(g => !g.rules?.length)) {
        return res.status(409).json({ error: gone.message })
      }

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
      const oldRulesFiles = onDisk?.rulesFiles ?? null
      const beforeModel = oldRulesFiles ? parseRulesDir(oldRulesFiles).model : null
      const { breaking, isBreaking, notices } = diffSchema(before, newSchema, {
        before: modelAlerts(beforeModel),
        after: modelAlerts(model),
      })
      // A group changing output profile replaces its objects (#65): a notice,
      // shown with a breaking change or on its own after the save.
      notices.push(...groupTypeChanges(beforeModel, model, objectMetaFromEnv()), ...groupNameChanges(beforeModel, model), ...groupOnceChanges(beforeModel, model), ...groupSelectorChanges(beforeModel, model), ...groupSelectorLabelChanges(beforeModel, model))
      const withDesc = list => list.map(c => ({ ...c, description: c.description ?? describeChange(c) }))
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
            deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: modelBefore(onDisk),
          })
          migratedDeployments = plan.deployments
          migrationWrites = plan.writes.filter(w => !w[2]).map(([file, text]) => [file, text])
          targetWrites = plan.writes.filter(w => w[2])
        } catch (err) {
          // A file it could not read is named (errorAnswer, below).
          if (err instanceof NotLoadedError) throw err
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
      const checkedBefore = !(confirmBreaking && migration && isBreaking) ? modelBefore(onDisk) : null
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
      // written over (the check below refuses it).
      if (!onDisk || onDisk.findings.some(f => f.code === 'template.chart-absent')) entries.push([chartYamlFile, ensureChartYaml(null, req.params.chart).text])

      // Files on disk with no counterpart any more: a removed group, or a
      // _common.yaml for a chart that no longer has common columns. In
      // templates/ only a generated file is: one a hand-written file sits
      // next to is left alone (#114).
      // Converting a 1.x chart (no rules/ before): its old rule file, which
      // holds every group under a name no group has, goes too (#190). A
      // folder named *.yaml is no rule object (Helm says so when it renders).
      const templateNames = onDisk?.templateNames ?? []
      const replaced = oldRulesFiles && Object.keys(oldRulesFiles).length ? [] : replacedByConversion(
        Object.fromEntries(templateNames.map(f => [f, onDisk.templateFiles[f] ?? null])),
        products.templates)
      const removed = [
        ...Object.keys(oldRulesFiles ?? {}).filter(f => !(f in files)).map(f => path.join(rulesDir, f)),
        ...[...new Set([...staleTemplates(templateNames, products.templates, { schemas: [before], models: [beforeModel, model] }), ...replaced])]
          .map(f => path.join(tmplDir, f)),
      ]

      // The Template as this save leaves it. What Helm fails on, or renders
      // other than written, in what this save writes is refused; in a file
      // it does not write (Chart.yaml, the Template's values.yaml, a
      // hand-written template) the save goes through and says it, naming the
      // file — Commit still refuses it.
      const overlay = new Map([
        ...entries.map(([abs, text]) => [path.relative(req.gitopsDir, abs).replace(/\\/g, '/'), text]),
        ...removed.map(abs => [path.relative(req.gitopsDir, abs).replace(/\\/g, '/'), null]),
      ])
      const after = await openRepo(req.gitopsDir).with(overlay).templateFiles(path.relative(req.gitopsDir, chartDir).replace(/\\/g, '/'))
      const decided = after.state === 'ok' ? decide(after.findings, TEMPLATE_POLICIES.saveRules) : { refuse: [], warn: [] }
      const split = splitBySave(decided, f => overlay.has(f.file) || f.file.endsWith('/rules') || f.file.includes('/rules/'))
      // A migration also refuses what its own table names (migrationApply).
      const hard = confirmBreaking && migration && isBreaking && after.state === 'ok' ? decide(after.findings, TEMPLATE_POLICIES.migrationApply).refuse : []
      const refuse = [...hard, ...split.refuse.filter(f => !hard.includes(f))]
      const elsewhere = split.elsewhere.filter(f => !hard.includes(f))
      // A file that cannot be read is answered as one (409, unreadable).
      const unread = refuse.find(f => /-unreadable$/.test(f.code))
      if (unread) throw new UnreadableError(path.join(req.gitopsDir, unread.file), { reason: unread.detail.why })
      if (refuse.length) return res.status(409).json({ error: `The Template would not render as written: ${refuse.map(f => f.message).join('; ')}`, findings: refuse.map(f => ({ code: f.code, file: f.file, description: f.message })) })
      const warnings = elsewhere.map(f => ({ kind: 'template-file', code: f.code, file: f.file, description: `${f.message} — Commit refuses it until it is fixed` }))
      notices.push(...warnings)

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
        ...(warnings.length ? { warnings } : {}),
        migrated: migratedDeployments.map(d => ({ deployment: d.deployment, path: d.path, readonly: d.readonly, copiedFrom: d.copiedFrom, rowsChanged: d.rowsChanged })),
        ...(syncFailed.length ? { syncFailed } : {}),
      })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // What a breaking change plus a mapping would do to every affected
  // deployment — feeds step 3 of the breaking-change dialog. Writes nothing.
  router.post('/:chart/migration-preview', async (req, res) => {
    const { files, migration } = req.body || {}
    if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files object required' })
    try {
      const { model, errors } = parseRulesDir(files)
      if (errors.length) return res.status(400).json({ error: 'Invalid rules', errors })
      const onDisk = await readTemplate(req.gitopsDir, req.params.chart)
      const targetSchema = modelToSchema(model, schemaBefore(req, onDisk))
      const { deployments } = await planDeploymentMigration(
        req.gitopsDir, req.params.chart, targetSchema, migration || {},
        { deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: modelBefore(onDisk) })
      res.json({ deployments })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // Save chart-level default values
  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req, req.params.chart)
    const { values } = req.body || {}
    // The text of values.yaml, or its values as a map: anything else
    // (left out, null, a number, a list) would be written as an empty or
    // meaningless file.
    if (typeof values !== 'string' && !isMap(values)) {
      return res.status(400).json({ error: 'values is required: the text of values.yaml, or its values as a map' })
    }
    try {
      const content = typeof values === 'string' ? values : dumpForHelm(values, { lineWidth: -1 })
      // The Template as this save leaves it, read as Helm reads it: a text
      // that is not YAML, one AlertForge cannot tell Helm's reading of (the
      // line is named), and what else of the Template keeps every deployment
      // from rendering are refused before it is written. Saving does not run
      // Helm.
      const dir = path.relative(req.gitopsDir, path.dirname(valuesFile)).replace(/\\/g, '/')
      const after = await openRepo(req.gitopsDir).with(new Map([[`${dir}/values.yaml`, content]])).templateFiles(dir)
      if (after.state === 'unreadable') throw new UnreadableError(path.join(req.gitopsDir, after.file), { reason: after.why })
      const decided = after.state === 'ok' ? decide(after.findings, TEMPLATE_POLICIES.saveValues) : { refuse: [], warn: [] }
      // The text sent is refused; a file this save does not write goes
      // through, said (Commit refuses it).
      const { refuse, elsewhere } = splitBySave(decided, f => f.file === `${dir}/values.yaml`)
      const unread = refuse.find(f => /-unreadable$/.test(f.code))
      if (unread) throw new UnreadableError(path.join(req.gitopsDir, unread.file), { reason: unread.detail.why })
      if (refuse.length) return res.status(400).json({ error: refuse.map(f => f.message).join('; '), findings: refuse.map(f => ({ code: f.code, file: f.file, description: f.message, ...(f.at ? { at: f.at } : {}) })) })
      await writeWhole(valuesFile, content)
      res.json({ ok: true, ...(elsewhere.length ? { warnings: elsewhere.map(f => ({ code: f.code, file: f.file, description: `${f.message} — Commit refuses it until it is fixed` })) } : {}) })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
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
    // Read as Helm reads it, through the repo loader.
    const read = await openRepo(req.gitopsDir).helmYaml(path.relative(req.gitopsDir, chartYamlFile).replace(/\\/g, '/'))
    if (read.state === 'absent') return res.status(404).json({ error: `${req.params.chart} has no Chart.yaml` })
    if (read.state === 'unreadable') {
      const { status, body } = errorAnswer(new UnreadableError(chartYamlFile, { reason: read.why }))
      return res.status(status).json(body)
    }
    if (read.state === 'invalid') return res.status(400).json({ error: `Chart.yaml is not valid YAML (${read.findings[0].message}) — fix it by hand; Save would lose what it holds` })
    const onDisk = read.value
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
    const { newName } = req.body || {}
    const badNew = pathProblem(newName, 'name')
    if (badNew) {
      return res.status(400).json({ error: `Invalid newName: ${badNew.why}` })
    }
    try {
      const refused = await outsideRefusal(req, [req.params.template, newName])
      if (refused) return res.status(refused.status).json(refused.body)
      const oldFile = await templateFile(req)
      if (!oldFile) return res.status(400).json({ error: 'Invalid template name: it leads outside the repo' })
      // A file already at the new name is not written over, as a chart's
      // clone and a shared config's rename are not.
      const newRel = templateRel(req, newName)
      const listed = await openRepo(req.gitopsDir).dir(path.posix.dirname(newRel))
      if (listed.state === 'ok' && listed.value.entries.has(`${newName}.yaml`)) return res.status(409).json({ error: `${newRel} already exists`, file: newRel })
      await fs.rename(oldFile, path.join(tmplDir, `${newName}.yaml`))
      res.json({ ok: true })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // --- Template file endpoints ---

  // Get a single template file's content
  router.get('/:chart/:template', async (req, res) => {
    try {
      const tmplFile = await templateFile(req)
      if (!tmplFile) return res.status(400).json({ error: 'Invalid template name: it leads outside the repo' })
      const { tmplDir } = chartPaths(req, req.params.chart)
      const read = await openRepo(req.gitopsDir).file(path.relative(req.gitopsDir, path.join(tmplDir, `${req.params.template}.yaml`)).replace(/\\/g, '/'))
      if (read.state === 'absent') return res.status(404).json({ error: 'Template not found' })
      if (read.state === 'unreadable') throw new UnreadableError(path.join(tmplDir, `${req.params.template}.yaml`), { reason: read.why })
      res.json({ content: read.value.text })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // Save a template file's content
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const { content } = req.body || {}
    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required: the template file\'s text' })
    try {
      const refused = await outsideRefusal(req, [req.params.template])
      if (refused) return res.status(refused.status).json(refused.body)
      const tmplFile = await templateFile(req)
      if (!tmplFile) return res.status(400).json({ error: 'Invalid template name: it leads outside the repo' })
      await fs.mkdir(tmplDir, { recursive: true })
      await writeWhole(tmplFile, content)
      res.json({ ok: true })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // Delete a template file
  router.delete('/:chart/:template', async (req, res) => {
    try {
      const refused = await outsideRefusal(req, [req.params.template])
      if (refused) return res.status(refused.status).json(refused.body)
      const tmplFile = await templateFile(req)
      if (!tmplFile) return res.status(400).json({ error: 'Invalid template name: it leads outside the repo' })
      await fs.rm(tmplFile, { force: true })
      res.json({ ok: true })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  return answerRejections(router)
}
