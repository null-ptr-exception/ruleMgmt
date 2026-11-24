import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import {
  writeSyncRegistry,
  withSyncRegistryLock,
  getTargetsForSource,
  getSourceForTarget,
  isSafeSyncPath,
  normalizeSyncPath,
  applySync,
  applyUnlink,
} from '../lib/sync.js'
import { newReservedSegment, reservedError } from '../lib/reservedNames.js'
import { readRouting, restoreRouting, routingToCopy, unreadableAnswer } from '../lib/routingFiles.js'
import { inSharedDir, SHARED_DIR } from '../lib/sharedConfigs.js'
import { openRepo } from '../repo/openRepo.js'
import { writeProblems, writeRefusal } from '../repo/writePath.js'
import { valuesWrite, copyToTarget } from '../lib/deploymentWrite.js'
import { newDeploymentProblem, isDeployment } from '../repo/walk.js'
import { syncAnswer } from '../repo/sync.js'
import { writeWhole } from '../lib/routingFiles.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { z } from 'zod'
import { route, declaredRoutes } from '../http/route.js'
import { parsePath, deploymentLinkProblem } from '../repo/paths.js'
import { resolveStack, linkedStackRefusal } from '../lib/stack.js'

function chartsDirName() {
  return process.env.CHARTS_DIR || 'charts'
}

async function validateSyncPath(gitopsDir, candidate) {
  if (!isSafeSyncPath(candidate, chartsDirName())) {
    return `Invalid path: ${candidate}`
  }
  if (await inSharedDir(gitopsDir, candidate)) return `${candidate}: ${SHARED_DIR}/ holds the shared notification configs, and no deployment`
  const link = await deploymentLinkProblem(gitopsDir, candidate)
  if (link) return link
  if (!(await isDeployment(openRepo(gitopsDir), candidate))) {
    return `${candidate} is not a valid deployment`
  }
  return null
}

// `?source=` (its targets) or `?target=` (its source); neither: all of sync.yaml.
const ASK_QUERY = z.object({ source: z.string().optional(), target: z.string().optional() })
// The deployments, as the tree names them: made into the registry's own
// spelling and checked below.
const folder = which => z.string({ error: iss => (iss.input === undefined ? `${which} is required` : `${which} must be text: a deployment's folder`) })
  .min(1, `${which} is required`)
const CREATE_BODY = z.object({ source: folder('source'), target: folder('target') })
const UNLINK_BODY = z.object({ target: folder('target') })

export default function syncRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  router.get('/', route('sync.get', { query: ASK_QUERY }, async ({ query }, { repo }) => {
    const source = query.source ? normalizeSyncPath(query.source) : undefined
    const target = query.target ? normalizeSyncPath(query.target) : undefined
    // A sync.yaml that cannot be read is named, not taken for "no syncs":
    // reporting it as empty would invite the next write to wipe it.
    const { registry, refusal } = await syncAnswer(repo)
    if (refusal) return refusal

    if (source) return { status: 200, body: { source, targets: getTargetsForSource(registry, source) } }
    if (target) return { status: 200, body: { target, source: getSourceForTarget(registry, target) } }
    return { status: 200, body: registry }
  }))

  router.post('/', route('sync.create', { body: CREATE_BODY }, async ({ body }, { gitopsDir }) => {
    // Normalize before any validation/comparison/storage — otherwise
    // 'cpu/prod' and 'cpu/./prod' would be treated as different deployments
    // by the strict string equality in applySync's role-exclusivity checks.
    const source = normalizeSyncPath(body.source)
    const target = normalizeSyncPath(body.target)

    const sourceError = await validateSyncPath(gitopsDir, source)
    if (sourceError) return { status: 400, body: { error: sourceError } }

    // Through a link, still in the repo: a copy is written there.
    // Why, from the one path check; one under the Templates' folder is no
    // sync target either.
    const where = await parsePath(target, 'create', { root: gitopsDir, what: 'path' })
    if (!where.ok) return { status: 400, body: { error: where.error } }
    if (!isSafeSyncPath(target, chartsDirName())) return { status: 400, body: { error: `Invalid path: ${target}` } }
    // Unlike source, target is allowed not to exist yet (it gets created as
    // a copy of source) — but if something is already there, it must be a
    // real deployment, not an arbitrary folder we'd otherwise overwrite.
    // A new target is a new deployment, so a reserved name is refused (#99).
    const reserved = await newReservedSegment(gitopsDir, target)
    if (reserved) return { status: 400, body: { error: reservedError(reserved) } }
    // A target reached through a link is no deployment: said as one (paths.js).
    const linked = await deploymentLinkProblem(gitopsDir, target)
    if (linked) return { status: 400, body: { error: linked } }
    // Either one on a _common reached through a link made by hand: nothing is written.
    for (const rel of [source, target]) {
      const onLink = linkedStackRefusal(await resolveStack(gitopsDir, path.join(gitopsDir, rel)), rel)
      if (onLink) return onLink
    }
    const targetDir = path.join(gitopsDir, target)

    return withSyncRegistryLock(gitopsDir, async () => {
      // Whether the target is there is read under the lock: another sync
      // to the same new target may have made it while this one waited, and
      // a rollback that took it for new would delete that one's deployment.
      const here = openRepo(gitopsDir)
      const targetExists = await fs.access(targetDir).then(() => true).catch(() => false)
      if (targetExists && !(await isDeployment(here, target))) {
        return { status: 400, body: { error: `${target} exists but is not a valid deployment` } }
      }
      // A new target is made where any new deployment may be: not inside
      // another deployment (the source too), around one, or in a _common folder.
      if (!targetExists) {
        const misplaced = await newDeploymentProblem(here, target)
        if (misplaced) return { status: 400, body: { error: misplaced } }
      }
      const read = await syncAnswer(here)
      if (read.refusal) return read.refusal
      const { registry } = read
      const result = applySync(registry, source, target)
      if (!result.ok) return { status: 400, body: { error: result.error } }

      // Read everything needed for the copy — and a restore snapshot of
      // the target — *before* mutating anything, so any failure past this
      // point can be rolled back instead of orphaning overwritten content.
      const sourceDir = path.join(gitopsDir, source)
      // What a values save would refuse is not copied either: the target
      // is read-only and could not fix it (#180).
      // Read as a save reads it: one that cannot be read is named (409).
      const repo = openRepo(gitopsDir)
      const sourceFile = await repo.file(`${source}/values.yaml`)
      if (sourceFile.state === 'unreadable') return { status: 409, body: { error: `${source}/values.yaml cannot be read: ${sourceFile.why}`, unreadable: true } }
      const content = sourceFile.state === 'ok' ? sourceFile.value.text : ''
      const answer = await valuesWrite(gitopsDir, source, content, { policy: 'sync', repo })
      if (answer.refusal?.status === 409) return answer.refusal
      const refusal = answer.refusal?.body ?? null
      // Nor routing the save checks would refuse: the whole sync is
      // refused, not half of it, with both files' problems at once. A
      // resource behind its routing.yaml is made again rather than copied
      // (#166).
      const routing = await routingToCopy(openRepo(gitopsDir), source)
      if (routing.unreadable) return unreadableAnswer(routing.unreadable)
      // The target's routing files would land outside the repo: nothing is written.
      const outside = await writeProblems(gitopsDir, [`${target}/routing.yaml`, `${target}/templates/alertmanagerconfig.yaml`])
      if (outside) return writeRefusal(outside)
      // A values.yaml the copy replaces that is a folder is named, not a
      // 500. (A Chart.yaml that is one makes the target no deployment: refused above.)
      const there = await here.file(`${target}/values.yaml`)
      if (there.state === 'unreadable' && there.kind === 'folder') return writeRefusal({ file: there.file, why: there.why })
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
      await writeSyncRegistry(gitopsDir, registry)

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
            await writeWhole(targetValuesFile, prevTargetValues).catch(() => {})
          }
          await restoreRouting(targetDir, prevTargetRouting).catch(() => {})
          // A Chart.yaml the copy made is taken out again.
          if (prevTargetChart !== null) await writeWhole(targetChartFile, prevTargetChart).catch(() => {})
          else await fs.rm(targetChartFile, { force: true }).catch(() => {})
        }
        applyUnlink(registry, target)
        await writeSyncRegistry(gitopsDir, registry).catch(() => {})
        throw copyErr
      }
      return { status: 200, body: { ok: true } }
    })
  }))

  router.delete('/', route('sync.delete', { body: UNLINK_BODY }, async ({ body }, { gitopsDir }) => {
    const target = normalizeSyncPath(body.target)
    if (!isSafeSyncPath(target, chartsDirName())) {
      return { status: 400, body: { error: `Invalid path: ${target}` } }
    }
    return withSyncRegistryLock(gitopsDir, async () => {
      const { registry, refusal } = await syncAnswer(openRepo(gitopsDir))
      if (refusal) return refusal
      const result = applyUnlink(registry, target)
      if (!result.ok) return { status: 400, body: { error: result.error } }
      await writeSyncRegistry(gitopsDir, registry)
      return { status: 200, body: { ok: true } }
    })
  }))

  return declaredRoutes(router)
}
