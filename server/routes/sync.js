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
import { newReservedSegment, reservedError } from '../lib/reservedNames.js'
import { readRouting, restoreRouting, checkedRouting } from '../lib/routingFiles.js'
import { readSharedConfigs, inSharedDir, SHARED_DIR } from '../lib/sharedConfigs.js'
import { valuesRefusal, copyToTarget } from '../lib/deploymentWrite.js'
import { getDepName } from '../lib/subchart.js'
import { newDeploymentProblem } from '../lib/deploymentWalk.js'

function chartsDirName() {
  return process.env.CHARTS_DIR || 'charts'
}

async function validateSyncPath(gitopsDir, candidate) {
  if (!isSafeSyncPath(candidate, chartsDirName())) {
    return `Invalid path: ${candidate}`
  }
  if (await inSharedDir(gitopsDir, candidate)) return `${candidate}: ${SHARED_DIR}/ holds the shared notification configs, and no deployment`
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
    // A new target is a new deployment, so a reserved name is refused (#99).
    const reserved = await newReservedSegment(req.gitopsDir, target)
    if (reserved) return res.status(400).json({ error: reservedError(reserved) })
    const targetDir = path.join(req.gitopsDir, target)
    const targetExists = await fs.access(targetDir).then(() => true).catch(() => false)
    if (targetExists && !(await isDeploymentDir(targetDir))) {
      return res.status(400).json({ error: `${target} exists but is not a valid deployment` })
    }
    // A new target is made where any new deployment may be: not inside
    // another deployment (the source too), around one, or in a _common folder.
    if (!targetExists) {
      const misplaced = await newDeploymentProblem(req.gitopsDir, target)
      if (misplaced) return res.status(400).json({ error: misplaced })
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
        // What a values save would refuse is not copied either: the target
        // is read-only and could not fix it (#180).
        const content = await fs.readFile(path.join(sourceDir, 'values.yaml'), 'utf-8')
        const depName = await getDepName(sourceDir)
        const refusal = await valuesRefusal(req.gitopsDir, depName, depName, content)
        // Nor routing the save checks would refuse: the whole sync is
        // refused, not half of it, with both files' problems at once. A
        // resource behind its routing.yaml is made again rather than copied
        // (#166).
        const routing = await checkedRouting(sourceDir, await readSharedConfigs(req.gitopsDir))
        if (refusal || routing.errors) {
          const reasons = [refusal?.error, routing.errors && 'its routing.yaml has problems'].filter(Boolean)
          return { status: 400, body: {
            ...refusal,
            error: `${source} cannot be synced: ${reasons.join('; ')}`,
            problems: [...(refusal?.problems || []), ...(routing.errors || []).map(message => ({ message }))],
          } }
        }
        const targetValuesFile = path.join(targetDir, 'values.yaml')
        const prevTargetValues = await fs.readFile(targetValuesFile, 'utf-8').catch(() => null)
        const prevTargetRouting = await readRouting(targetDir)
        const targetChartFile = path.join(targetDir, 'Chart.yaml')
        const prevTargetChart = await fs.readFile(targetChartFile, 'utf-8').catch(() => null)

        // Registry first: if this write fails, the target hasn't been
        // touched at all. (The reverse order could leave the target
        // overwritten with no sync link recorded.)
        await writeSyncRegistry(req.gitopsDir, registry)

        try {
          // The bytes checked above, not a second read a `git pull` could
          // change. Chart.yaml comes too: a target on another Template, or a
          // new one at another depth, renders what the source does (#180).
          await copyToTarget(sourceDir, targetDir, { valuesContent: content, routingContent: routing })
        } catch (copyErr) {
          // Best-effort rollback: restore the target's previous content and
          // take the link back out of the registry. If the rollback itself
          // fails, the link stays — eager sync on the next source save will
          // re-propagate, which is the safer residual state.
          if (!targetExists) {
            // A new target half made would be a deployment of its own, unlinked.
            await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {})
          } else {
            if (prevTargetValues !== null) {
              await fs.writeFile(targetValuesFile, prevTargetValues, 'utf-8').catch(() => {})
            }
            await restoreRouting(targetDir, prevTargetRouting).catch(() => {})
            if (prevTargetChart !== null) await fs.writeFile(targetChartFile, prevTargetChart, 'utf-8').catch(() => {})
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
