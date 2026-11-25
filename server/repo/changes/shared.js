/**
 * shared: the repo's shared notification configs saved, or one of them
 * renamed, with every AlertmanagerConfig made from them and every sync
 * target's copy of a user's routing — one change, all or none.
 *
 *   { kind: 'shared', shared }            the file's text, or { configs } from the page
 *   { kind: 'shared', rename: { from, to } }
 *
 * Files written: _shared/notification-configs.yaml; each user's resource
 * (and, for a rename, its routing.yaml); then each user's sync targets'
 * routing.yaml and resource (before, a target that could not be written
 * was listed and the rest kept). A target sync.yaml lists that is no
 * deployment of the repo is listed (`syncFailed`), not written. What
 * refuses it is planShared's / planRename's (sharedConfigs.js), and a file
 * that would land outside the repo or behind a folder that is a link.
 *
 * strict: the shared file — changed between the read and the write, it is
 * a 409, never written over. A user's routing changed meanwhile is planned
 * again under the lock.
 */
import { defineChange } from '../write.js'
import { SHARED_FILE } from '../shared.js'
import { planShared, planRename } from '../../lib/sharedConfigs.js'
import { syncTargets } from '../../lib/deploymentWrite.js'
import { copyRoutingToTargets, placeRefusal, linkedStack } from './routing.js'

defineChange('shared', {
  policy: 'save',

  async plan(repo, { shared, rename }) {
    const planned = rename ? await planRename(repo, rename.from, rename.to) : await planShared(repo, shared)
    if (planned.refusal) return { refusal: planned.refusal }
    const files = [...planned.files]
    const syncFailed = []
    for (const { deployment, routing } of planned.sources) {
      // A deployment whose resource this writes, on a _common reached
      // through a link made by hand: nothing of it is written, so none of it.
      const onLink = await linkedStack(repo, deployment)
      if (onLink) return { refusal: onLink }
      const { targets, failed, refusal } = await syncTargets(repo, planned.registry, deployment)
      if (refusal) return { refusal }
      syncFailed.push(...failed)
      const noCopy = await copyRoutingToTargets(repo, deployment, targets, routing, files)
      if (noCopy) return { refusal: noCopy }
    }
    const outside = await placeRefusal(repo, files)
    if (outside) return { refusal: outside }
    return { files, facts: { body: planned.body, syncFailed } }
  },

  strict: () => new Set([SHARED_FILE]),
  table: policy => policy,
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: `${SHARED_FILE} changed while it was being saved: reload it to see what is there now`, changed: true } }),
  answer: plan => ({ ...plan.facts.body, ...(plan.facts.syncFailed.length ? { syncFailed: plan.facts.syncFailed } : {}) }),
})
