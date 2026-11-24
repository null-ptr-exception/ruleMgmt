import express from 'express'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import chartsRouter from './server/routes/charts.js'
import { valuesLimitNote } from './server/repo/limits.js'
import templatesV2Router from './server/routes/templates.js'
import deploymentsRouter from './server/routes/deployments.js'
import renderRouter from './server/routes/render.js'
import gitRouter from './server/routes/git.js'
import foldersRouter from './server/routes/folders.js'
import syncRouter from './server/routes/sync.js'
import routingSharedRouter from './server/routes/routingShared.js'
import { getChartsDir, getDeploymentsDir } from './server/lib/chartDiscovery.js'
import { initGitIfNone, scaffoldSamplesIfNeeded } from './server/repo/setup.js'
import { logger, httpLogger } from './server/lib/logger.js'
import { jsonBody } from './server/http/body.js'
import { answerUncaught } from './server/http/route.js'
import { userRoute, unknownApiRoute } from './server/routes/own.js'
import { sweepTempFiles, parkedItems } from './server/repo/write.js'
import { parkedSaid } from './server/lib/parkedSaid.js'
import { chartsDir as templatesDirRel } from './server/repo/template.js'
import { sweepTempCopies } from './server/repo/copyRepo.js'
import { objectMetaFromEnv } from './src/utils/objectMeta.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The site's object labels and annotations (RULE_OBJECT_*) are read on every
// generation; check them once here, so a mistake stops the server instead of
// leaving rules no evaluator loads (#86).
{
  const { warnings, errors } = objectMetaFromEnv()
  for (const warning of warnings) logger.warn(warning)
  if (errors.length) {
    for (const error of errors) logger.error(error)
    process.exit(1)
  }
}
const app = express()
// A body that is not JSON, or too big, is answered as JSON (server/http/body.js).
app.use(jsonBody())
app.use(httpLogger)
app.use((req, res, next) => {
  const origJson = res.json.bind(res)
  res.json = (body) => {
    if (res.statusCode >= 400 && body?.error) {
      res._errorBody = body.error
    }
    return origJson(body)
  }
  next()
})

const BASE_PATH = process.env.JUPYTERHUB_SERVICE_PREFIX || '/'
const GITOPS_DIR_V2 = process.env.GITOPS_DIR || path.join(__dirname, 'gitops')

// Auto-init git in local dev mode (no JupyterHub)
if (!process.env.JUPYTERHUB_SERVICE_PREFIX) {
  if (await initGitIfNone(GITOPS_DIR_V2)) logger.info(`Git initialized in ${GITOPS_DIR_V2}`)
}

// A MAX_VALUES_BYTES that is not used as written is said once.
{
  const note = valuesLimitNote()
  if (note) logger.warn(note)
}

// Scaffold sample chart templates if none exist
{
  const chartsDir = getChartsDir(GITOPS_DIR_V2, process.env.CHARTS_DIR)
  const deploymentsDir = getDeploymentsDir(GITOPS_DIR_V2, process.env.DEPLOYMENTS_DIR)
  const sampleDir = path.join(__dirname, 'sample')
  const scaffolded = await scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir)
  if (scaffolded) logger.info(`Scaffolded sample data into ${chartsDir}`)
}

// A write killed between its temp file and its rename leaves the temp file:
// old ones are removed (Commit never adds them either).
{
  const swept = await sweepTempFiles(GITOPS_DIR_V2)
  if (swept.length) logger.info(`Removed ${swept.length} temp file(s) a write left: ${swept.join(', ')}`)
  // Content a write moved aside and did not put back or remove is never
  // removed: said, and Commit refuses while it is there.
  for (const said of parkedSaid(await parkedItems(GITOPS_DIR_V2), templatesDirRel())) logger.warn(said)
  // And the copies of the repo a plan checks in, left by a server killed meanwhile.
  const copies = await sweepTempCopies()
  if (copies.length) logger.info(`Removed ${copies.length} temp cop${copies.length > 1 ? 'ies' : 'y'} of the repo left by a stopped server`)
}

// ─── V2 API (base path router) ──────────────────────────────────────────────
const baseRouter = express.Router()

function setGitopsDir(req, res, next) {
  req.gitopsDir = GITOPS_DIR_V2
  next()
}

baseRouter.use('/api/v2/charts', setGitopsDir, chartsRouter())
baseRouter.use('/api/v2/templates', setGitopsDir, templatesV2Router())
baseRouter.use('/api/v2/deployments', setGitopsDir, deploymentsRouter())
baseRouter.use('/api/v2/render', setGitopsDir, renderRouter())
baseRouter.use('/api/v2/git', setGitopsDir, gitRouter())
baseRouter.use('/api/v2/folders', setGitopsDir, foldersRouter())
baseRouter.use('/api/v2/sync', setGitopsDir, syncRouter())
baseRouter.use('/api/v2/routing/shared', setGitopsDir, routingSharedRouter())

baseRouter.get('/api/v2/user', userRoute)
// Any other /api path is no page: a JSON 404.
baseRouter.use('/api', unknownApiRoute)

// Static assets + SPA fallback with base path injection
const indexHtml = readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf-8')

baseRouter.use(express.static(path.join(__dirname, 'dist'), { index: false }))
baseRouter.get('*', (req, res) => {
  const html = indexHtml
    .replace('<head>', `<head><base href="${BASE_PATH}"><script>window.__BASE_PATH__="${BASE_PATH}"</script>`)
  res.send(html)
})

app.use(BASE_PATH, baseRouter)
// An error no route answered: JSON, no stack trace, no path of the machine.
app.use(answerUncaught)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => logger.info(`API server listening on port ${PORT}`))
