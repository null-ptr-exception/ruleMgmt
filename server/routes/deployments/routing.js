/** A deployment's notification routing (#92). */

import { isTarget, getSourceForTarget } from '../../lib/sync.js'
import { unreadableAnswer } from '../../lib/routingFiles.js'
import { syncAnswer } from '../../repo/sync.js'
import { openRepo } from '../../repo/openRepo.js'
import { loadRouting, routingFiles } from '../../repo/routing.js'
import { decide } from '../../repo/policy.js'
import { ROUTING_POLICIES } from '../../repo/routingPolicy.js'
import { z } from 'zod'
import { planChange, applyChange } from '../../repo/changes/index.js'
import { route, map } from '../../http/route.js'
import { DEPLOYMENT_REQUEST, deploymentAt, commonRefused } from './resolve.js'
import { resolveValuesFile } from '../../repo/locate.js'

// What stops a page, a save or a removal: an answer naming the file, or null.
function refusalOf(loaded, policy) {
  if (loaded.state === 'unreadable') return unreadableAnswer(loaded)
  if (loaded.state !== 'ok') return null
  const [first] = decide(loaded.findings, policy).refuse
  if (!first) return null
  if (first.code === 'routing.cr-unreadable') return { status: 409, body: { error: first.message, file: first.file, unreadable: true } }
  return { status: 409, body: { error: `${loaded.value.dep}: ${first.message}`, file: first.file } }
}

// The body's `routing` is routing.yaml's text, kept as written, or the
// parsed table.
const ROUTING_BODY = z.object({
  routing: z.union([z.string(), map()], { error: iss => (iss.input === undefined ? 'routing is required: the text of routing.yaml, or its table' : 'routing must be the text of routing.yaml, or its table') }),
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
  // Save or remove routing for the folder's own deployment, and give each
  // sync target the same files: one change, all or none (changes/routing.js).
  router.put('/:chart/:deployment/routing', route('deployments.routing-put', { ...DEPLOYMENT_REQUEST, body: ROUTING_BODY }, async (input, { gitopsDir }) => {
    const { at, refused: no } = await routingTarget(input, gitopsDir)
    if (no) return no
    return applyChange(await planChange(openRepo(gitopsDir), { kind: 'routing', dep: at.folder, routing: input.body.routing }))
  }))

  router.delete('/:chart/:deployment/routing', route('deployments.routing-delete', DEPLOYMENT_REQUEST, async (input, { gitopsDir }) => {
    const { at, refused: no } = await routingTarget(input, gitopsDir)
    if (no) return no
    return applyChange(await planChange(openRepo(gitopsDir), { kind: 'routing', dep: at.folder, remove: true }))
  }))
}
