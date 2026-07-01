import express from 'express'
import fs from 'fs/promises'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import chartsRouter from './server/routes/charts.js'
import templatesV2Router from './server/routes/templates.js'
import deploymentsRouter from './server/routes/deployments.js'
import renderRouter from './server/routes/render.js'
import gitRouter from './server/routes/git.js'
import git from './server/lib/git.js'
import foldersRouter from './server/routes/folders.js'
import syncRouter from './server/routes/sync.js'
import { getChartsDir, getDeploymentsDir, scaffoldSamplesIfNeeded } from './server/lib/chartDiscovery.js'
import { logger, httpLogger } from './server/lib/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())
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
  try {
    await fs.access(path.join(GITOPS_DIR_V2, '.git'))
  } catch {
    await fs.mkdir(GITOPS_DIR_V2, { recursive: true })
    await git(GITOPS_DIR_V2, 'init')
    await git(GITOPS_DIR_V2, 'add', '-A')
    await git(GITOPS_DIR_V2, 'commit', '--allow-empty', '-m', 'initial')
    logger.info(`Git initialized in ${GITOPS_DIR_V2}`)
  }
}

// Scaffold sample chart templates if none exist
{
  const chartsDir = getChartsDir(GITOPS_DIR_V2, process.env.CHARTS_DIR)
  const deploymentsDir = getDeploymentsDir(GITOPS_DIR_V2, process.env.DEPLOYMENTS_DIR)
  const sampleDir = path.join(__dirname, 'sample')
  const scaffolded = await scaffoldSamplesIfNeeded(chartsDir, sampleDir, deploymentsDir)
  if (scaffolded) logger.info(`Scaffolded sample data into ${chartsDir}`)
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

baseRouter.get('/api/v2/user', (req, res) => {
  const user = process.env.JUPYTERHUB_USER || null
  const logoutUrl = process.env.JUPYTERHUB_BASE_URL ? `${process.env.JUPYTERHUB_BASE_URL}hub/logout` : null
  res.json({ user, logoutUrl })
})

// Static assets + SPA fallback with base path injection
const indexHtml = readFileSync(path.join(__dirname, 'dist', 'index.html'), 'utf-8')

baseRouter.use(express.static(path.join(__dirname, 'dist'), { index: false }))
baseRouter.get('*', (req, res) => {
  const html = indexHtml
    .replace('<head>', `<head><base href="${BASE_PATH}"><script>window.__BASE_PATH__="${BASE_PATH}"</script>`)
  res.send(html)
})

app.use(BASE_PATH, baseRouter)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => logger.info(`API server listening on port ${PORT}`))
