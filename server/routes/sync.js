import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import {
  readSyncRegistry,
  writeSyncRegistry,
  withSyncRegistryLock,
  getTargetsForSource,
  getSourceForTarget,
  isSafeSyncPath,
  normalizeSyncPath,
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
    const source = req.query.source ? normalizeSyncPath(req.query.source) : undefined
    const target = req.query.target ? normalizeSyncPath(req.query.target) : undefined
    let registry
    try {
      registry = await readSyncRegistry(req.gitopsDir)
    } catch (err) {
      // A malformed/unreadable sync.yaml is a real error, not "no syncs" —
      // reporting it as empty here would invite the next write to wipe it.
      console.error('Failed to read sync registry', err)
      return res.status(500).json({ error: 'Failed to read sync registry' })
    }

    if (source) {
      return res.json({ source, targets: getTargetsForSource(registry, source) })
    }
    if (target) {
      return res.json({ target, source: getSourceForTarget(registry, target) })
    }
    res.json(registry)
  })

  router.post('/', async (req, res) => {
    if (!req.body?.source || !req.body?.target) {
      return res.status(400).json({ error: 'source and target are required' })
    }
    // Normalize before any validation/comparison/storage — otherwise
    // 'cpu/prod' and 'cpu/./prod' would be treated as different deployments
    // by the strict string equality in applySync's role-exclusivity checks.
    const source = normalizeSyncPath(req.body.source)
    const target = normalizeSyncPath(req.body.target)

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

    try {
      const outcome = await withSyncRegistryLock(req.gitopsDir, async () => {
        const registry = await readSyncRegistry(req.gitopsDir)
        const result = applySync(registry, source, target)
        if (!result.ok) return { status: 400, body: { error: result.error } }

        // Read everything needed for the copy — and a restore snapshot of
        // the target — *before* mutating anything, so any failure past this
        // point can be rolled back instead of orphaning overwritten content.
        const sourceDir = path.join(req.gitopsDir, source)
        const content = await fs.readFile(path.join(sourceDir, 'values.yaml'), 'utf-8')
        const targetValuesFile = path.join(targetDir, 'values.yaml')
        const prevTargetValues = await fs.readFile(targetValuesFile, 'utf-8').catch(() => null)

        // Registry first: if this write fails, the target hasn't been
        // touched at all. (The reverse order could leave the target
        // overwritten with no sync link recorded.)
        await writeSyncRegistry(req.gitopsDir, registry)

        try {
          await fs.mkdir(targetDir, { recursive: true })
          await fs.writeFile(targetValuesFile, content, 'utf-8')

          // First-time target: carry over Chart.yaml too, so it renders like
          // a real deployment (mirrors what folders/init would have produced).
          try {
            await fs.access(path.join(targetDir, 'Chart.yaml'))
          } catch {
            const chartYaml = await fs.readFile(path.join(sourceDir, 'Chart.yaml'), 'utf-8')
            await fs.writeFile(path.join(targetDir, 'Chart.yaml'), chartYaml, 'utf-8')
          }
        } catch (copyErr) {
          // Best-effort rollback: restore the target's previous content and
          // take the link back out of the registry. If the rollback itself
          // fails, the link stays — eager sync on the next source save will
          // re-propagate, which is the safer residual state.
          if (prevTargetValues !== null) {
            await fs.writeFile(targetValuesFile, prevTargetValues, 'utf-8').catch(() => {})
          }
          applyUnlink(registry, target)
          await writeSyncRegistry(req.gitopsDir, registry).catch(() => {})
          throw copyErr
        }
        return { status: 200, body: { ok: true } }
      })
      res.status(outcome.status).json(outcome.body)
    } catch (err) {
      console.error('Failed to create sync', err)
      res.status(500).json({ error: 'Failed to create sync' })
    }
  })

  router.delete('/', async (req, res) => {
    if (!req.body?.target) {
      return res.status(400).json({ error: 'target is required' })
    }
    const target = normalizeSyncPath(req.body.target)
    if (!isSafeSyncPath(target, chartsDirName())) {
      return res.status(400).json({ error: `Invalid path: ${target}` })
    }

    try {
      const outcome = await withSyncRegistryLock(req.gitopsDir, async () => {
        const registry = await readSyncRegistry(req.gitopsDir)
        const result = applyUnlink(registry, target)
        if (!result.ok) return { status: 400, body: { error: result.error } }
        await writeSyncRegistry(req.gitopsDir, registry)
        return { status: 200, body: { ok: true } }
      })
      res.status(outcome.status).json(outcome.body)
    } catch (err) {
      console.error('Failed to unlink sync', err)
      res.status(500).json({ error: 'Failed to unlink sync' })
    }
  })

  return router
}
