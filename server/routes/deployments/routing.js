/** A deployment's notification routing (#92). */

import { copyToTargets, okWith } from '../../lib/deploymentWrite.js'
import { readSyncRegistry, withSyncRegistryLock, isTarget, getSourceForTarget, getTargetsForSource } from '../../lib/sync.js'
import { buildRouting, writeRouting, removeRouting, registryOrRefusal, unreadableAnswer, ROUTING_FILE, ROUTING_CR_FILE } from '../../lib/routingFiles.js'
import { isLinkKind } from '../../repo/loaded.js'
import { writeProblems, writeRefusal, targetWriteProblem } from '../../repo/writePath.js'
import { errorAnswer } from '../../lib/readIfThere.js'
import { openRepo } from '../../repo/openRepo.js'
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

import { isValidDeploymentParam, syncFolder, resolveDeploymentDir, resolveValuesFile, commonRefused } from './resolve.js'
export function routingRoutes(router) {
  // A deployment's notification routing (#92): routing.yaml and the
  // AlertmanagerConfig generated from it, always written together. Only the
  // folder's own deployment has one — see routingFiles.js.
  async function routingTarget(req, res, { write = true } = {}) {
    if (commonRefused(req, res, 'given notification routing')) return null
    const dir = await resolveDeploymentDir(req)
    if (!dir) { res.status(400).json({ error: 'Invalid folder path' }); return null }
    if (!isValidDeploymentParam(req)) { res.status(400).json({ error: 'Invalid deployment name' }); return null }
    const folder = syncFolder(req)
    const { direct } = folder ? await resolveValuesFile(dir, req.params.deployment) : { direct: false }
    if (!direct) {
      res.status(400).json({ error: 'Only a folder deployment has notification routing' })
      return null
    }
    // A synced target is read-only: refused before its routing is checked,
    // and checked again under the lock when it is written.
    const { registry, refusal } = await registryOrRefusal(req.gitopsDir)
    if (refusal) { res.status(refusal.status).json(refusal.body); return null }
    if (write && isTarget(registry, folder)) {
      res.status(409).json({ error: `${folder} is synced from another deployment and is read-only` })
      return null
    }
    return { dir, folder, registry }
  }

  // Save or delete routing for the folder's own deployment, then give each
  // sync target the source's files and report the ones that could not be
  // written — under the registry lock, like the values save. A synced target
  // is read-only.
  function writeRoutingAndSync(req, { dir, folder }, write) {
    return withSyncRegistryLock(req.gitopsDir, async () => {
      const registry = await readSyncRegistry(req.gitopsDir)
      if (isTarget(registry, folder)) {
        return { status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } }
      }
      const repo = openRepo(req.gitopsDir)
      const outside = await outsideRefusal(repo, folder, getTargetsForSource(registry, folder).filter(t => t !== folder))
      if (outside) return outside
      // A write may refuse what it was given: { status, body }.
      const refused = await write(dir, repo)
      if (refused) return refused
      const syncFailed = await copyToTargets(req.gitopsDir, registry, folder, { values: false, routing: true })
      return { status: 200, body: okWith(syncFailed) }
    })
  }

  // routing.yaml's text, its problems, and whether the AlertmanagerConfig is
  // out of date (`stale`) — saving the text again regenerates it. A synced
  // target can be read like any other.
  router.get('/:chart/:deployment/routing', async (req, res) => {
    try {
      const at = await routingTarget(req, res, { write: false })
      if (!at) return
      const repo = openRepo(req.gitopsDir)
      const loaded = await loadRouting(repo, at.folder)
      const refused = refusalOf(loaded, ROUTING_POLICIES.routingPage)
      if (refused) return res.status(refused.status).json(refused.body)
      if (loaded.state === 'absent') return res.status(404).json({ error: 'This deployment has no routing.yaml' })
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
        if (!same) return res.json({ ...state, stale: true, differsFromSource: true })
      }
      res.json(state)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  // The body's `routing` is routing.yaml's text, kept as written, or the
  // parsed table. A routing.yaml that does not pass the checks is refused
  // and neither file is written.
  router.put('/:chart/:deployment/routing', async (req, res) => {
    const input = req.body?.routing
    if (typeof input !== 'string' && (input === null || typeof input !== 'object')) {
      return res.status(400).json({ error: 'routing is required: the text of routing.yaml, or its table' })
    }
    try {
      const at = await routingTarget(req, res)
      if (!at) return
      // A config used from the shared configs (#123) is written in full:
      // read and built under the lock, so a change to them made meanwhile is
      // never written over with the old one.
      let warnings = []
      const { status, body } = await writeRoutingAndSync(req, at, async (dir, repo) => {
        const refused = await saveRefusal(repo, at.folder)
        if (refused) return refused
        const built = buildRouting(input, sharedForBuild(await loadShared(repo)))
        if (built.errors) return { status: 400, body: { error: 'routing.yaml has problems', problems: built.errors } }
        await writeRouting(dir, built)
        // Saved all the same: what the configs will do that is worth saying.
        warnings = built.warnings
        return null
      })
      res.status(status).json(status < 300 && warnings.length && body && typeof body === 'object' ? { ...body, warnings } : body)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  router.delete('/:chart/:deployment/routing', async (req, res) => {
    try {
      const at = await routingTarget(req, res)
      if (!at) return
      const { status, body } = await writeRoutingAndSync(req, at, async (dir, repo) => {
        const refused = await removalRefusal(repo, at.folder)
        if (refused) return refused
        await removeRouting(dir)
        return null
      })
      res.status(status).json(body)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })
}
