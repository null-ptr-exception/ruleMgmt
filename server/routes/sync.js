import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import {
  readSyncRegistry,
  writeSyncRegistry,
  getTargetsForSource,
  getSourceForTarget,
  isSafeSyncPath,
  isDeploymentDir,
  applySync,
  applyUnlink,
} from '../lib/sync.js'

function chartsDirName() {
  return process.env.CHARTS_DIR || 'charts'
}

async function validateSyncPath(gitopsDir, candidate) {
  if (!isSafeSyncPath(candidate, chartsDirName())) {
    return `Invalid path: ${candidate}`
  }
  const absDir = path.join(gitopsDir, candidate)
  if (!(await isDeploymentDir(absDir))) {
    return `${candidate} is not a valid deployment`
  }
  return null
}

export default function syncRouter() {
  const router = express.Router()

  router.get('/', async (req, res) => {
    const { source, target } = req.query
    const registry = await readSyncRegistry(req.gitopsDir)

    if (source) {
      return res.json({ source, targets: getTargetsForSource(registry, source) })
    }
    if (target) {
      return res.json({ target, source: getSourceForTarget(registry, target) })
    }
    res.json(registry)
  })

  router.post('/', async (req, res) => {
    const { source, target } = req.body || {}
    if (!source || !target) {
      return res.status(400).json({ error: 'source and target are required' })
    }

    const sourceError = await validateSyncPath(req.gitopsDir, source)
    if (sourceError) return res.status(400).json({ error: sourceError })

    if (!isSafeSyncPath(target, chartsDirName())) {
      return res.status(400).json({ error: `Invalid path: ${target}` })
    }
    // Unlike source, target is allowed not to exist yet (it gets created as
    // a copy of source) — but if something is already there, it must be a
    // real deployment, not an arbitrary folder we'd otherwise overwrite.
    const targetDir = path.join(req.gitopsDir, target)
    const targetExists = await fs.access(targetDir).then(() => true).catch(() => false)
    if (targetExists && !(await isDeploymentDir(targetDir))) {
      return res.status(400).json({ error: `${target} exists but is not a valid deployment` })
    }

    const registry = await readSyncRegistry(req.gitopsDir)
    const result = applySync(registry, source, target)
    if (!result.ok) {
      return res.status(400).json({ error: result.error })
    }

    try {
      const sourceDir = path.join(req.gitopsDir, source)
      const content = await fs.readFile(path.join(sourceDir, 'values.yaml'), 'utf-8')
      await fs.mkdir(targetDir, { recursive: true })
      await fs.writeFile(path.join(targetDir, 'values.yaml'), content, 'utf-8')

      // First-time target: carry over Chart.yaml too, so it renders like a
      // real deployment (mirrors what folders/init would have produced).
      try {
        await fs.access(path.join(targetDir, 'Chart.yaml'))
      } catch {
        const chartYaml = await fs.readFile(path.join(sourceDir, 'Chart.yaml'), 'utf-8')
        await fs.writeFile(path.join(targetDir, 'Chart.yaml'), chartYaml, 'utf-8')
      }

      await writeSyncRegistry(req.gitopsDir, registry)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/', async (req, res) => {
    const { target } = req.body || {}
    if (!target) {
      return res.status(400).json({ error: 'target is required' })
    }
    if (!isSafeSyncPath(target, chartsDirName())) {
      return res.status(400).json({ error: `Invalid path: ${target}` })
    }

    const registry = await readSyncRegistry(req.gitopsDir)
    const result = applyUnlink(registry, target)
    if (!result.ok) {
      return res.status(400).json({ error: result.error })
    }

    try {
      await writeSyncRegistry(req.gitopsDir, registry)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
