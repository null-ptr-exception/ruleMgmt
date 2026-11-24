/** Delete a deployment. */

import { withoutPath } from '../../lib/answerPaths.js'
import fs from 'fs/promises'
import path from 'path'
import { writeSyncRegistry, withSyncRegistryLock, isTarget, applyUnlink } from '../../lib/sync.js'
import { syncAnswer } from '../../repo/sync.js'
import { folderEntry, isDeployment } from '../../repo/walk.js'
import { openRepo } from '../../repo/openRepo.js'

import { route } from '../../http/route.js'
import { DEPLOYMENT_REQUEST, deploymentAt, resolveValuesFile, commonRefused } from './resolve.js'
export function lifecycleRoutes(router) {
  router.delete('/:chart/:deployment', route('deployments.delete', DEPLOYMENT_REQUEST, async (input, { gitopsDir, res }) => {
    const common = commonRefused(input.query.folder?.rel, 'deleted as one')
    if (common) return common
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return { status: 400, body: { error: at.error } }
    const { dir, folder, deployment } = at
    // A removal that fails is answered with its reason: the user is shown it.
    try {
      const resolved = await resolveValuesFile(dir, deployment)
      const { legacyFile } = resolved
      // A folder with a Chart.yaml and no values.yaml is removed whole too:
      // it renders the Template, and keeps the Template from being deleted.
      const direct = resolved.direct || (!!folder && deployment === path.basename(dir) && !!(await folderEntry(openRepo(gitopsDir), folder)).chartOnly)
      // Deleting a legacy sibling leaves the folder's deployment, and so its
      // sync link, in place. A deleted target leaves its source; a deleted
      // source lets go of its targets, which keep what they have and become
      // editable again, instead of staying read-only with no source (#180).
      let unlinked = []
      if (folder && direct) {
        // Folder-mode deployment: the directory itself is the deployment
        // (Chart.yaml + values.yaml live directly inside it), so removing
        // just one file would leave an orphaned, half-deleted deployment.
        // Removed first, inside the lock: a removal that fails leaves the
        // sync links as they were, and no sync can be made to it meanwhile.
        const refused = await withSyncRegistryLock(gitopsDir, async () => {
          const repo = openRepo(gitopsDir)
          const { registry, refusal } = await syncAnswer(repo)
          if (refusal) return refusal
          await fs.rm(dir, { recursive: true, force: true })
          let changed = false
          if (isTarget(registry, folder)) {
            applyUnlink(registry, folder)
            changed = true
          }
          // Every entry, as a hand edit can list the same source twice.
          const entries = registry.syncs.filter(s => s.source === folder)
          if (entries.length) {
            registry.syncs = registry.syncs.filter(s => !entries.includes(s))
            changed = true
            // Listed as let go: on disk, and not still under another source.
            // Asked of the repo as it is after the delete: one inside the source went with it.
            const after = openRepo(gitopsDir)
            for (const t of new Set(entries.flatMap(e => e.targets))) {
              if (t !== folder && !isTarget(registry, t) && await isDeployment(after, t)) unlinked.push(t)
            }
          }
          if (changed) await writeSyncRegistry(gitopsDir, registry)
          return null
        })
        if (refused) return res.status(refused.status).json(refused.body)
      } else if (direct) {
        await fs.rm(dir, { recursive: true, force: true })
      } else {
        await fs.rm(legacyFile, { force: true })
      }
      res.json(unlinked.length ? { ok: true, unlinked } : { ok: true })
    } catch (err) {
      // Shown to the user as the reason: without where the repo is.
      console.error('Delete failed', err)
      res.status(500).json({ error: await withoutPath(err.message, gitopsDir) })
    }
  }))
}
