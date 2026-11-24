/**
 * sync-link and sync-unlink: a sync link made or taken out of sync.yaml.
 *
 *   { kind: 'sync-link', source, target }     (as sync.yaml spells them)
 *   { kind: 'sync-unlink', target }
 *
 * sync-link writes, in this order and all or none: the target's Chart.yaml
 * (when its Template is not the source's), its values.yaml (the source's
 * bytes), its routing.yaml and the AlertmanagerConfig made from it (the
 * source's, or removed when the source has none, with the templates/
 * folder they leave empty), then sync.yaml. A new target is made as a
 * copy; one refused leaves nothing behind. A target file that cannot be
 * read fails the link, naming it: what the copy replaces could not be put
 * back. sync-unlink writes sync.yaml alone.
 *
 * Neither has a version: a change to any file it read while it waits for
 * the lock is planned again under the lock, from the repo as it is then
 * (a link made meanwhile, the source saved), and that plan is decided.
 */
import path from 'path'
import { defineChange } from '../write.js'
import { syncAnswer, SYNC_FILE } from '../sync.js'
import { ROUTING_FILE, ROUTING_CR_FILE } from '../routing.js'
import { isDeployment, newDeploymentProblem } from '../walk.js'
import { parsePath, deploymentLinkProblem } from '../paths.js'
import { writeProblems, writeRefusal } from '../writePath.js'
import { applySync, applyUnlink, isSafeSyncPath, registryText } from '../../lib/sync.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { inSharedDir, SHARED_DIR } from '../../lib/sharedConfigs.js'
import { routingToCopy, unreadableAnswer } from '../../lib/routingFiles.js'
import { valuesWrite, targetCopy } from '../../lib/deploymentWrite.js'
import { resolveStack, linkedStackRefusal } from '../../lib/stack.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'
const bad = error => ({ refusal: { status: 400, body: { error } } })
const unreadableFile = (file, why) => ({ refusal: { status: 409, body: { error: `${file} cannot be read: ${why}`, file, unreadable: true } } })

// Why `source` cannot be synced from, or null.
async function sourceProblem(repo, source) {
  if (!isSafeSyncPath(source, chartsDirName())) return `Invalid path: ${source}`
  if (await inSharedDir(repo.root, source)) return `${source}: ${SHARED_DIR}/ holds the shared notification configs, and no deployment`
  const link = await deploymentLinkProblem(repo.root, source)
  if (link) return link
  if (!(await isDeployment(repo, source))) return `${source} is not a valid deployment`
  return null
}

async function planLink(repo, { source, target }) {
  const root = repo.root
  const sourceError = await sourceProblem(repo, source)
  if (sourceError) return bad(sourceError)
  // Why, from the one path check; one under the Templates' folder is no
  // sync target either.
  const where = await parsePath(target, 'create', { root, what: 'path' })
  if (!where.ok) return bad(where.error)
  if (!isSafeSyncPath(target, chartsDirName())) return bad(`Invalid path: ${target}`)
  // A new target is a new deployment, so a reserved name is refused (#99).
  const reserved = await newReservedSegment(root, target)
  if (reserved) return bad(reservedError(reserved))
  // A target reached through a link is no deployment: said as one (paths.js).
  const linked = await deploymentLinkProblem(root, target)
  if (linked) return bad(linked)
  // Either one on a _common reached through a link made by hand: nothing is written.
  for (const rel of [source, target]) {
    const onLink = linkedStackRefusal(await resolveStack(root, path.join(root, rel), { repo }), rel)
    if (onLink) return { refusal: onLink }
  }
  // A target need not be there yet (it is made a copy of the source), but
  // what is there must be a deployment, not a folder it would write over.
  const targetExists = (await repo.dir(target)).state !== 'absent'
  if (targetExists && !(await isDeployment(repo, target))) return bad(`${target} exists but is not a valid deployment`)
  // A new target is made where any new deployment may be: not inside
  // another deployment (the source too), around one, or in a _common folder.
  if (!targetExists) {
    const misplaced = await newDeploymentProblem(repo, target)
    if (misplaced) return bad(misplaced)
  }
  const read = await syncAnswer(repo)
  if (read.refusal) return { refusal: read.refusal }
  const { registry } = read
  const linkedUp = applySync(registry, source, target)
  if (!linkedUp.ok) return bad(linkedUp.error)

  // What a values save would refuse is not copied either: the target is
  // read-only and could not fix it (#180). Read as a save reads it: one
  // that cannot be read is named (409).
  const sourceFile = await repo.file(`${source}/values.yaml`)
  if (sourceFile.state === 'unreadable') return unreadableFile(`${source}/values.yaml`, sourceFile.why)
  const content = sourceFile.state === 'ok' ? sourceFile.value.text : ''
  const answer = await valuesWrite(root, source, content, { policy: 'sync', repo })
  if (answer.refusal?.status === 409) return { refusal: answer.refusal }
  const refusal = answer.refusal?.body ?? null
  // Nor routing the save checks would refuse: the whole sync is refused,
  // not half of it, with both files' problems at once. A resource behind
  // its routing.yaml is made again rather than copied (#166).
  const routing = await routingToCopy(repo, source)
  if (routing.unreadable) return { refusal: unreadableAnswer(routing.unreadable) }
  // The target's routing files would land outside the repo: nothing is written.
  const outside = await writeProblems(root, [`${target}/${ROUTING_FILE}`, `${target}/${ROUTING_CR_FILE}`])
  if (outside) return { refusal: writeRefusal(outside) }
  if (refusal || routing.errors) {
    const reasons = [refusal?.error, routing.errors && 'its routing.yaml has problems'].filter(Boolean)
    return { refusal: { status: 400, body: {
      ...refusal,
      error: `${source} cannot be synced: ${reasons.join('; ')}`,
      problems: [...(refusal?.problems || []), ...(routing.errors || []).map(message => ({ message }))],
    } } }
  }
  // The bytes checked above, and the routing checked above.
  const copy = await targetCopy(repo, source, target, { valuesContent: content, routingContent: routing })
  if (copy.refusal) return { refusal: copy.refusal }
  const files = copy.files
  files.push({ rel: SYNC_FILE, text: registryText(registry) })
  return { files, facts: {} }
}

async function planUnlink(repo, { target }) {
  if (!isSafeSyncPath(target, chartsDirName())) return bad(`Invalid path: ${target}`)
  const read = await syncAnswer(repo)
  if (read.refusal) return { refusal: read.refusal }
  const result = applyUnlink(read.registry, target)
  if (!result.ok) return bad(result.error)
  return { files: [{ rel: SYNC_FILE, text: registryText(read.registry) }], facts: {} }
}

const common = {
  policy: 'sync',
  // Nothing is someone else's edit to keep: any change is planned again.
  strict: () => new Set(),
  table: () => 'sync',
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The repo changed while the sync was being written: look at it again', changed: true } }),
  answer: () => ({ ok: true }),
}

defineChange('sync-link', { ...common, plan: planLink })
defineChange('sync-unlink', { ...common, plan: planUnlink })
