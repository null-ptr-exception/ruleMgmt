import express from 'express'
import { z } from 'zod'
import { holdSyncRegistryLock } from '../lib/sync.js'
import fs from 'fs/promises'
import path from 'path'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { findChartUsage } from '../lib/chartUsage.js'
import { UnreadableError } from '../lib/readIfThere.js'
import { openRepo } from '../repo/openRepo.js'
import { chartsDir as chartsDirRel } from '../repo/template.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { writeWhole } from '../lib/routingFiles.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { route, repoName, declaredRoutes } from '../http/route.js'
import { migrationMapping } from '../http/templateShapes.js'


// "2 deployments and 1 _common chart": a _common is not a deployment.
function usedBy(found) {
  const commons = found.filter(d => d.kind === 'common').length
  const others = found.length - commons
  const part = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`
  return [others ? part(others, 'deployment') : null, commons ? part(commons, '_common chart') : null].filter(Boolean).join(' and ')
}

// A Template's name, as paths.js takes a name.
const CHART_NAME = (what = 'chart name') => repoName('name', { what })

export default function chartsRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  router.use(holdSyncRegistryLock)

  router.get('/', route('charts.list', {}, async (input, { gitopsDir }) => {
    const chartsDir = getChartsDir(gitopsDir, process.env.CHARTS_DIR)
    await fs.mkdir(chartsDir, { recursive: true })
    return { status: 200, body: await findAlertTemplateCharts(chartsDir) }
  }))

  router.post('/', route('charts.create', {
    body: z.object({ name: CHART_NAME() }),
  }, async ({ body: { name } }, { gitopsDir, res }) => {
    const chartsDir = getChartsDir(gitopsDir, process.env.CHARTS_DIR)
    const chartDir = path.join(chartsDir, name)
    // Creating over an existing chart reset its Chart.yaml, values.yaml and
    // schema — and New → From rules… then replaced its rules/ outright.
    try {
      await fs.access(path.join(chartDir, 'Chart.yaml'))
      return res.status(409).json({ error: `A chart named "${name}" already exists` })
    } catch { /* free */ }
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      const chartYaml = dumpForHelm({ apiVersion: 'v2', name, version: '0.1.0', type: 'application', annotations: { app: 'alertforge' } })
      await writeWhole(path.join(chartDir, 'Chart.yaml'), chartYaml)
      await writeWhole(path.join(chartDir, 'values.yaml'), dumpForHelm({}))
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {}
      }
      await writeWhole(path.join(chartDir, 'values.schema.json'), JSON.stringify(emptySchema, null, 2))
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  }))

  // Clone a chart.
  //
  // This is how a breaking change gets made without touching anyone: the copy
  // is edited, the original keeps working, and each rule owner moves over when
  // they are ready. The mapping their rows need is declared here, by the person
  // making the change — nobody else knows whether a column was renamed or
  // dropped — and is stored on the clone as x-migrated-from.
  router.post('/:name/clone', route('charts.clone', {
    params: z.object({ name: CHART_NAME() }),
    body: z.object({ newName: CHART_NAME('chart name (newName)'), migration: migrationMapping.optional() }),
  }, async ({ params: { name }, body: { newName, migration } }, { gitopsDir, res }) => {
    const chartsDir = getChartsDir(gitopsDir, process.env.CHARTS_DIR)
    const source = path.join(chartsDir, name)
    const target = path.join(chartsDir, newName)
    try {
      await fs.access(target)
      return res.status(409).json({ error: `Chart ${newName} already exists` })
    } catch {
      // Not there yet, which is what we want.
    }

    // The source, read as everything else reads it: a file of it that
    // cannot be read, a Chart.yaml or a schema that cannot be used is
    // named, and nothing is copied.
    // A file of rules/ or templates/ that cannot be read is copied as it
    // is (Commit names it in either): only the folder itself has to be.
    const loaded = await openRepo(gitopsDir).templateFiles(`${chartsDirRel()}/${name}`)
    if (loaded.state === 'absent') return res.status(404).json({ error: `Chart ${name} not found` })
    if (loaded.state === 'unreadable') throw new UnreadableError(path.join(gitopsDir, loaded.file), { reason: loaded.why })
    const src = { ...loaded.value, findings: loaded.findings }
    // What the copy's Chart.yaml and schema are written from; the rest is
    // copied as it is.
    const stop = src.findings.find(f => /^template\.(chart-(absent|unreadable|not-yaml|cannot-tell|not-map)|schema-(unreadable|not-json|not-object))$/.test(f.code))
    if (stop) return res.status(409).json({ error: `${name} cannot be cloned: ${stop.message}`, ...(/-unreadable$/.test(stop.code) ? { unreadable: true } : {}) })
    // No schema on disk: the one its rules/ generates (what opening it writes).
    const schema = src.schema ?? (src.products ? JSON.parse(src.products.schemaText) : null)
    if (!schema) return res.status(409).json({ error: `${name} cannot be cloned: it has no values.schema.json — open it in the editor (which writes it) and clone it then` })

    // The recorded source is always the chart cloned from; a mapping in
    // the body cannot replace it.
    const mapping = migration ?? {}
    try {
      await fs.cp(source, target, { recursive: true })
    } catch (err) {
      // A file it cannot read: named, and nothing half-copied is left.
      await fs.rm(target, { recursive: true, force: true })
      if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err
      throw new UnreadableError(err.path || source, err)
    }
    try {
      await writeWhole(path.join(target, 'Chart.yaml'), dumpForHelm({ ...src.chart, name: newName }))
      await writeWhole(path.join(target, 'values.schema.json'), JSON.stringify({ ...schema, 'x-migrated-from': { ...mapping, chart: name } }, null, 2))
    } catch (err) {
      // A half-made copy would block a retry with "already exists".
      await fs.rm(target, { recursive: true, force: true })
      return res.status(500).json({ error: err.message })
    }

    res.json({ ok: true, chart: newName })
  }))

  router.delete('/:name', route('charts.delete', {
    params: z.object({ name: CHART_NAME() }),
  }, async ({ params: { name } }, { gitopsDir, res }) => {
    const chartsDir = getChartsDir(gitopsDir, process.env.CHARTS_DIR)
    const chartDir = path.join(chartsDir, name)
    // A deployment still bound to the chart would fail to render the moment
    // it is gone (#177), so the delete is refused and names them.
    // What Helm or ArgoCD would render from it blocks: a deployment, a
    // _common chart, a folder with a Chart.yaml and no values.yaml, one in
    // a hidden folder. A folder that cannot be read does not: who is in it
    // is not known, and it is said.
    const { deployments, unreadable } = await findChartUsage(gitopsDir, name, process.env.DEPLOYMENTS_DIR)
    if (deployments.length) {
      return res.status(409).json({
        error: `${name} is still used by ${usedBy(deployments)}`,
        deployments: deployments.map(d => ({ deployment: d.deployment, path: d.path, ...(d.kind ? { kind: d.kind } : {}) })),
      })
    }
    try {
      await fs.rm(chartDir, { recursive: true, force: true })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(unreadable.length ? { ok: true, unreadable } : { ok: true })
  }))

  return declaredRoutes(router)
}
