import express from 'express'
import { getTargetsForSource, getSourceForTarget, normalizeSyncPath } from '../lib/sync.js'
import { openRepo } from '../repo/openRepo.js'
import { syncAnswer } from '../repo/sync.js'
import { planChange, applyChange } from '../repo/changes/index.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { z } from 'zod'
import { route, declaredRoutes } from '../http/route.js'

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

  // A link made: sync.yaml and the target a copy of the source, all or
  // none (repo/changes/sync.js). Paths as the registry spells them, so
  // 'cpu/prod' and 'cpu/./prod' are one deployment.
  router.post('/', route('sync.create', { body: CREATE_BODY }, async ({ body }, { gitopsDir }) => {
    const plan = await planChange(openRepo(gitopsDir), { kind: 'sync-link', source: normalizeSyncPath(body.source), target: normalizeSyncPath(body.target) })
    return applyChange(plan)
  }))

  router.delete('/', route('sync.delete', { body: UNLINK_BODY }, async ({ body }, { gitopsDir }) => {
    const plan = await planChange(openRepo(gitopsDir), { kind: 'sync-unlink', target: normalizeSyncPath(body.target) })
    return applyChange(plan)
  }))

  return declaredRoutes(router)
}
