/** Clone and delete a deployment. */

import { withoutPath } from '../../lib/answerPaths.js'
import fs from 'fs/promises'
import path from 'path'
import { writeSyncRegistry, withSyncRegistryLock, isTarget, applyUnlink } from '../../lib/sync.js'
import { syncAnswer } from '../../repo/sync.js'
import { folderEntry, isDeployment } from '../../repo/walk.js'
import { openRepo } from '../../repo/openRepo.js'
import { NAME_RE } from '../../lib/safePath.js'
import { errorAnswer } from '../../lib/readIfThere.js'

import { isValidDeploymentParam, syncFolder, resolveDeploymentDir, resolveValuesFile, commonRefused } from './resolve.js'
export function lifecycleRoutes(router) {
  router.post('/:chart/:deployment/clone', async (req, res) => {
    if (commonRefused(req, res, 'cloned')) return
    const dir = await resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (typeof req.body?.newName !== 'string' || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const dstFile = path.join(dir, `${req.body.newName}-values.yaml`)
    try {
      const { file: srcFile } = await resolveValuesFile(dir, req.params.deployment)
      await fs.copyFile(srcFile, dstFile)
      res.json({ ok: true })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  router.delete('/:chart/:deployment', async (req, res) => {
    if (commonRefused(req, res, 'deleted as one')) return
    const dir = await resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    try {
      const resolved = await resolveValuesFile(dir, req.params.deployment)
      const { legacyFile } = resolved
      const folder = syncFolder(req)
      // A folder with a Chart.yaml and no values.yaml is removed whole too:
      // it renders the Template, and keeps the Template from being deleted.
      const direct = resolved.direct || (!!folder && req.params.deployment === path.basename(dir) && !!(await folderEntry(openRepo(req.gitopsDir), folder)).chartOnly)
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
        const refused = await withSyncRegistryLock(req.gitopsDir, async () => {
          const repo = openRepo(req.gitopsDir)
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
            for (const t of new Set(entries.flatMap(e => e.targets))) {
              if (t !== folder && !isTarget(registry, t) && await isDeployment(repo, t)) unlinked.push(t)
            }
          }
          if (changed) await writeSyncRegistry(req.gitopsDir, registry)
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
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })
}
