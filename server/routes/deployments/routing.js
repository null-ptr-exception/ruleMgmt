/** A deployment's notification routing (#92). */

import { copyToTargets, okWith } from '../../lib/deploymentWrite.js'
import { withSyncRegistryLock, isTarget, getSourceForTarget, getTargetsForSource } from '../../lib/sync.js'
import { buildRouting, writeRouting, removeRouting, unreadableAnswer, ROUTING_FILE, ROUTING_CR_FILE } from '../../lib/routingFiles.js'
import { syncAnswer } from '../../repo/sync.js'
import { isLinkKind } from '../../repo/loaded.js'
import { writeProblems, writeRefusal, targetWriteProblem } from '../../repo/writePath.js'
import { openRepo } from '../../repo/openRepo.js'
import { errorAnswer } from '../../lib/readIfThere.js'
import { loadRouting, routingFiles } from '../../repo/routing.js'
import { loadShared, sharedForBuild } from '../../repo/shared.js'
import { decide } from '../../repo/policy.js'
import { ROUTING_POLICIES } from '../../repo/routingPolicy.js'

// What stops a page, a save or a removal: an answer naming the file, or null.
function refusalOf(loaded, policy) {
  if (loaded.state === 'unreadable') return unreadableAnswer(loaded)
  if (loaded.state !== 'ok') return null
  const [first] = decide(loaded.findings, policy).refuse
  if (!first) return null
  if (first.code === 'routing.cr-unreadable') return { status: 409, body: { error: first.message, file: first.file, unreadable: true } }
  return { status: 409, body: { error: `${loaded.value.dep}: ${first.message}`, file: first.file } }
}

// The two files of `dep` and of each of its sync targets: a write that
// would land outside the repo is refused before anything is written.
const filesOf = dep => [`${dep}/${ROUTING_FILE}`, `${dep}/${ROUTING_CR_FILE}`]
async function outsideRefusal(repo, dep, targets) {
  const problem = await writeProblems(repo.root, filesOf(dep)) ?? await targetWriteProblem(repo.root, targets, filesOf)
  return problem ? writeRefusal(problem) : null
}

/**
 * What stops a save, by the routingSave table: a file it would replace
 * that cannot be read — no permission, a folder in its place. A link that
 * is the file itself (to nothing, or out of the repo) is replaced by the
 * file saved, as every save replaces one (its folder is the repo's: the
 * outside check runs first).
 */
async function saveRefusal(repo, dep) {
  const loaded = await loadRouting(repo, dep)
  if (loaded.state === 'unreadable') return isLinkKind(loaded.kind) ? null : unreadableAnswer(loaded)
  if (loaded.state !== 'ok') return null
  const cr = loaded.value.crUnreadable
  const { refuse } = decide(loaded.findings, ROUTING_POLICIES.routingSave)
  const first = refuse.find(f => f.code !== 'routing.cr-unreadable' || !isLinkKind(cr?.kind))
  if (!first) return null
  return first.code === 'routing.cr-unreadable' ? unreadableAnswer(cr) : { status: 409, body: { error: `${dep}: ${first.message}`, file: first.file } }
}

// A removal takes the files away whatever is in them; only a folder where
// one of them should be, or a file where templates/ should be, stops it —
// checked before the first file goes, so a refusal changes nothing.
const BLOCKS_REMOVAL = new Set(['folder', 'not-a-folder'])
async function removalRefusal(repo, dep) {
  for (const f of await Promise.all(filesOf(dep).map(rel => repo.file(rel)))) {
    if (f.state === 'unreadable' && BLOCKS_REMOVAL.has(f.kind)) return unreadableAnswer(f)
  }
  return null
}

import { z } from 'zod'
import { route } from '../../http/route.js'
import { DEPLOYMENT_REQUEST, deploymentAt, resolveValuesFile, commonRefused } from './resolve.js'

// The body's `routing` is routing.yaml's text, kept as written, or the
// parsed table.
const ROUTING_BODY = z.object({
  routing: z.union([z.string(), z.record(z.string(), z.unknown())], { error: iss => (iss.input === undefined ? 'routing is required: the text of routing.yaml, or its table' : 'routing must be the text of routing.yaml, or its table') }),
})

export function routingRoutes(router) {
  // A deployment's notification routing (#92): routing.yaml and the
  // AlertmanagerConfig generated from it, always written together. Only the
  // folder's own deployment has one — see routingFiles.js. `{ at }`, or
  // `{ refused }`: the answer that says why not.
  async function routingTarget(input, gitopsDir, { write = true } = {}) {
    const common = commonRefused(input.query.folder?.rel, 'given notification routing')
    if (common) return { refused: common }
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return { refused: { status: 400, body: { error: at.error } } }
    const { dir, folder } = at
    const { direct } = folder ? await resolveValuesFile(dir, at.deployment) : { direct: false }
    if (!direct) return { refused: { status: 400, body: { error: 'Only a folder deployment has notification routing' } } }
    // A synced target is read-only: refused before its routing is checked,
    // and checked again under the lock when it is written.
    const { registry, refusal } = await syncAnswer(openRepo(gitopsDir))
    if (refusal) return { refused: refusal }
    if (write && isTarget(registry, folder)) {
      return { refused: { status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } } }
    }
    return { at: { dir, folder, registry } }
  }

  // Save or delete routing for the folder's own deployment, then give each
  // sync target the source's files and report the ones that could not be
  // written — under the registry lock, like the values save. A synced target
  // is read-only.
  function writeRoutingAndSync(gitopsDir, { dir, folder }, write) {
    return withSyncRegistryLock(gitopsDir, async () => {
      const { registry, refusal } = await syncAnswer(openRepo(gitopsDir))
      if (refusal) return refusal
      if (isTarget(registry, folder)) {
        return { status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } }
      }
      const repo = openRepo(gitopsDir)
      const outside = await outsideRefusal(repo, folder, getTargetsForSource(registry, folder).filter(t => t !== folder))
      if (outside) return outside
      // A write may refuse what it was given: { status, body }.
      const refused = await write(dir, repo)
      if (refused) return refused
      const syncFailed = await copyToTargets(gitopsDir, registry, folder, { values: false, routing: true })
      return { status: 200, body: okWith(syncFailed) }
    })
  }

  // routing.yaml's text, its problems, and whether the AlertmanagerConfig is
  // out of date (`stale`) — saving the text again regenerates it. A synced
  // target can be read like any other.
  router.get('/:chart/:deployment/routing', route('deployments.routing-get', DEPLOYMENT_REQUEST, async (input, { gitopsDir, repo }) => {
    const { at, refused: no } = await routingTarget(input, gitopsDir, { write: false })
    if (no) return no
    const loaded = await loadRouting(repo, at.folder)
    const refused = refusalOf(loaded, ROUTING_POLICIES.routingPage)
    if (refused) return refused
    if (loaded.state === 'absent') return { status: 404, body: { error: 'This deployment has no routing.yaml' } }
    const r = loaded.value
    const said = decide(loaded.findings, ROUTING_POLICIES.routingPage)
    const state = { text: r.text, errors: r.errors, warnings: said.warn.map(f => f.message), stale: r.stale }
    // A sync target is held to its source's files (#179): one that is not
    // its source's is behind as well, though its own two files agree.
    const source = getSourceForTarget(at.registry, at.folder)
    if (source) {
      const theirs = await loadRouting(repo, source)
      const mine = routingFiles(loaded)
      // Its source's that cannot be read: it cannot be told to be the same.
      const same = theirs.state !== 'unreadable' && (({ text, cr }) => text === mine.text && cr === mine.cr)(routingFiles(theirs))
      if (!same) return { status: 200, body: { ...state, stale: true, differsFromSource: true } }
    }
    return { status: 200, body: state }
  }))

  // A routing.yaml that does not pass the checks is refused and neither
  // file is written.
  router.put('/:chart/:deployment/routing', route('deployments.routing-put', { ...DEPLOYMENT_REQUEST, body: ROUTING_BODY }, async (input, { gitopsDir }) => {
    const { at, refused: no } = await routingTarget(input, gitopsDir)
    if (no) return no
    // A config used from the shared configs (#123) is written in full:
    // read and built under the lock, so a change to them made meanwhile is
    // never written over with the old one.
    let warnings = []
    // A write that fails says why, naming the file (answersWithoutPaths).
    try {
      const { status, body } = await writeRoutingAndSync(gitopsDir, at, async (dir, repo) => {
        const refused = await saveRefusal(repo, at.folder)
        if (refused) return refused
        const built = buildRouting(input.body.routing, sharedForBuild(await loadShared(repo)))
        if (built.errors) return { status: 400, body: { error: 'routing.yaml has problems', problems: built.errors } }
        await writeRouting(dir, built)
        // Saved all the same: what the configs will do that is worth saying.
        warnings = built.warnings
        return null
      })
      return { status, body: status < 300 && warnings.length && body && typeof body === 'object' ? { ...body, warnings } : body }
    } catch (err) {
      return errorAnswer(err)
    }
  }))

  router.delete('/:chart/:deployment/routing', route('deployments.routing-delete', DEPLOYMENT_REQUEST, async (input, { gitopsDir }) => {
    const { at, refused: no } = await routingTarget(input, gitopsDir)
    if (no) return no
    try {
      return await writeRoutingAndSync(gitopsDir, at, async (dir, repo) => {
        const refused = await removalRefusal(repo, at.folder)
        if (refused) return refused
        await removeRouting(dir)
        return null
      })
    } catch (err) {
      return errorAnswer(err)
    }
  }))
}
