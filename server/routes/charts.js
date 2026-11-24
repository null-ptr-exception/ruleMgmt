import express from 'express'
import { z } from 'zod'
import fs from 'fs/promises'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { openRepo } from '../repo/openRepo.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { route, repoName, declaredRoutes } from '../http/route.js'
import { migrationMapping } from '../http/templateShapes.js'
import { planChange, applyChange } from '../repo/changes/index.js'

// A Template's name, as paths.js takes a name.
const CHART_NAME = (what = 'chart name') => repoName('name', { what })

export default function chartsRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // Every write goes through the writer (changes/chart.js), which takes the
  // commit lock only to write.

  router.get('/', route('charts.list', {}, async (input, { gitopsDir }) => {
    const chartsDir = getChartsDir(gitopsDir, process.env.CHARTS_DIR)
    await fs.mkdir(chartsDir, { recursive: true })
    return { status: 200, body: await findAlertTemplateCharts(chartsDir) }
  }))

  router.post('/', route('charts.create', {
    body: z.object({ name: CHART_NAME() }),
  }, async ({ body: { name } }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'chart-create', name }))
  )))

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
  }, async ({ params: { name }, body: { newName, migration } }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'chart-clone', name, newName, migration }))
  )))

  router.delete('/:name', route('charts.delete', {
    params: z.object({ name: CHART_NAME() }),
  }, async ({ params: { name } }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'chart-delete', name }))
  )))

  return declaredRoutes(router)
}
