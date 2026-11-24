/** A deployment's notification routing (#92). */

import path from 'path'
import { copyToTargets, okWith } from '../../lib/deploymentWrite.js'
import { readSyncRegistry, withSyncRegistryLock, isTarget, getSourceForTarget } from '../../lib/sync.js'
import { buildRouting, writeRouting, removeRouting, routingState, readRouting } from '../../lib/routingFiles.js'
import { readSharedConfigs } from '../../lib/sharedConfigs.js'
import { errorAnswer } from '../../lib/readIfThere.js'

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
    if (write && isTarget(await readSyncRegistry(req.gitopsDir), folder)) {
      res.status(409).json({ error: `${folder} is synced from another deployment and is read-only` })
      return null
    }
    return { dir, folder }
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
      // A write may refuse what it was given: { status, body }.
      const refused = await write(dir)
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
      const state = await routingState(at.dir, await readSharedConfigs(req.gitopsDir))
      if (!state) return res.status(404).json({ error: 'This deployment has no routing.yaml' })
      // A sync target is held to its source's files (#179): one that is not
      // its source's is behind as well, though its own two files agree.
      const source = getSourceForTarget(await readSyncRegistry(req.gitopsDir), syncFolder(req))
      if (source) {
        const [mine, theirs] = await Promise.all([readRouting(at.dir), readRouting(path.join(req.gitopsDir, source))])
        if (mine.text !== theirs.text || mine.cr !== theirs.cr) return res.json({ ...state, stale: true, differsFromSource: true })
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
      const { status, body } = await writeRoutingAndSync(req, at, async dir => {
        const built = buildRouting(input, await readSharedConfigs(req.gitopsDir))
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
      const { status, body } = await writeRoutingAndSync(req, at, async dir => { await removeRouting(dir); return null })
      res.status(status).json(body)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })
}
