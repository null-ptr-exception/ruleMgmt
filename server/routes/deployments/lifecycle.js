/** Delete a deployment. */

import path from 'path'
import { openRepo } from '../../repo/openRepo.js'
import { planChange, applyChange } from '../../repo/changes/index.js'
import { route } from '../../http/route.js'
import { DEPLOYMENT_REQUEST, deploymentAt, commonRefused } from './resolve.js'

export function lifecycleRoutes(router) {
  // A folder deployment goes whole, with its sync links: a deleted target
  // leaves its source, a deleted source lets go of its targets, which keep
  // what they have and become editable again (#180); a legacy sibling goes
  // alone. All or none (repo/changes/delete-deployment.js).
  router.delete('/:chart/:deployment', route('deployments.delete', DEPLOYMENT_REQUEST, async (input, { gitopsDir }) => {
    const common = commonRefused(input.query.folder?.rel, 'deleted as one')
    if (common) return common
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return { status: 400, body: { error: at.error } }
    const { folder, chart, deployment } = at
    // In the repo: the folder, or a legacy deployment's deployments/<chart>.
    const dir = folder ?? path.posix.join(process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    const plan = await planChange(openRepo(gitopsDir), { kind: 'delete-deployment', dir, folder, deployment })
    return applyChange(plan)
  }))
}
