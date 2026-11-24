import { z } from 'zod'
import { route, repoName, declaredRoutes } from '../http/route.js'
import { rulesFiles, migrationMapping } from '../http/templateShapes.js'
import express from 'express'
import { holdSyncRegistryLock } from '../lib/sync.js'
import { readTemplate } from '../lib/chartFiles.js'
import { UnreadableError } from '../lib/readIfThere.js'
import { planMigration } from '../lib/migrate.js'
import { parseRulesDir, modelToSchema } from '../../src/utils/rulesFile.js'
import path from 'path'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { openRepo } from '../repo/openRepo.js'
import { planChange, applyChange } from '../repo/changes/index.js'
import { schemaBefore, modelBefore } from '../repo/changes/rules.js'

// Every route is about one Template: its name, as paths.js takes a name.
const CHART = z.object({ chart: repoName('name', { what: 'chart name' }) })

export default function templatesRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // The migration preview writes nothing, but waits all the same: a save in
  // progress writes rules/, templates, the schema and every deployment's
  // values one after another, and a preview read between them would check
  // values of one version against rules of another. A write through the
  // writer (changes/) takes the lock only to write, itself.
  const held = holdSyncRegistryLock

  // Get chart-level info: schema + values + Chart.yaml metadata + template file
  // list + product drift.
  //
  // Opening a chart is the moment a missing Chart.yaml is filled in and missing
  // products are generated (nothing is overwritten either way) — deliberately
  // not the list route, where a write would be a side effect of scrolling past.
  router.get('/:chart', route('templates.get', { params: CHART }, async ({ params: { chart } }, { gitopsDir, res }) => {
    // Reading a chart that does not exist must not create it — a typo or a
    // stale saved selection would leave a directory under charts/.
    let t = await readTemplate(gitopsDir, chart)
    if (!t) return res.status(404).json({ error: 'Chart not found' })
    // A GET is not held by the commit's lock, but this one may write: the
    // writer takes the lock to write, so a commit does not stage half the
    // products. A file it cannot write is named (409).
    if (t.findings.some(f => f.code === 'template.chart-absent') || t.drift.state === 'missing') {
      const filled = await applyChange(await planChange(openRepo(gitopsDir), { kind: 'template-open', chart }))
      if (filled.status !== 200) return res.status(filled.status).json(filled.body)
      t = await readTemplate(gitopsDir, chart)
      if (!t) return res.status(404).json({ error: 'Chart not found' })
    }

    const templateFiles = t.templateNames.map(f => f.replace(/\.yaml$/, ''))

    // The values and Chart.yaml as Helm reads them (`010` is 8). One that
    // cannot be read or parsed is said, not shown as empty for a Save to
    // write over.
    const stop = t.findings.find(f => /^template\.(values|chart)-(unreadable|not-yaml|cannot-tell|not-map)$/.test(f.code))
    if (stop) throw new UnreadableError(path.join(gitopsDir, stop.file), { reason: stop.detail?.why ?? stop.message })

    // The editor loads from `rulesFiles`; null when the chart has not been
    // migrated to the rules/ format yet (it falls back to reading `schema`).
    // A schema that is not JSON is shown as none on a chart with rules/: it
    // is a product, the drift says it is missing and Save writes it again.
    res.json({ templateFiles, schema: t.schema, values: t.values, chartMeta: t.chart || {}, drift: t.drift, rulesFiles: t.rulesFiles })
  }))

  // --- Chart-level endpoints ---

  // Save a chart's rules/*.yaml source, and everything made from it — the
  // schema, every template, and on a confirmed breaking change every
  // affected deployment's values — as one change, all or none
  // (changes/rules.js). The rules files are written as sent, so hand-added
  // comments survive; only files whose content changes are written.
  router.post('/:chart/rules', route('templates.rules', {
    params: CHART,
    body: z.object({ files: rulesFiles, confirmBreaking: z.boolean().optional(), migration: migrationMapping.optional() }),
  }, async ({ params: { chart }, body: { files, confirmBreaking, migration } }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'rules', chart, files, confirmBreaking, migration }))
  )))

  // What a breaking change plus a mapping would do to every affected
  // deployment — feeds step 3 of the breaking-change dialog. Writes nothing.
  router.post('/:chart/migration-preview', held, route('templates.migration-preview', {
    params: CHART,
    body: z.object({ files: rulesFiles, migration: migrationMapping.optional() }),
  }, async ({ params: { chart }, body: { files, migration } }, { gitopsDir }) => {
    const { model, errors } = parseRulesDir(files)
    if (errors.length) return { status: 400, body: { error: 'Invalid rules', errors } }
    const onDisk = await readTemplate(gitopsDir, chart)
    const targetSchema = modelToSchema(model, schemaBefore(gitopsDir, onDisk))
    // Planned as the save plans it, on a snapshot; only its facts are shown.
    const { deployments } = await planMigration(openRepo(gitopsDir), {
      chart, targetSchema, migration: migration || {},
      deploymentsDirEnv: process.env.DEPLOYMENTS_DIR, model, beforeModel: modelBefore(onDisk) })
    return { status: 200, body: { deployments } }
  }))

  // Save Chart.yaml metadata (name, description, version)
  // The editor's Save writes the description, and only that: the rest
  // of Chart.yaml is read from disk, so a page loaded before a pull cannot
  // write back the version it loaded — every deployment asks for one.
  // Left out, the description stays as it is; null or '' removes it.
  router.post('/:chart/chart-meta', route('templates.chart-meta', {
    params: CHART,
    body: z.object({ chartMeta: z.object({ description: z.string().nullable().optional() }) }),
  }, async ({ params: { chart }, body: { chartMeta: { description } } }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'chart-meta', chart, description }))
  )))

  return declaredRoutes(router)
}
