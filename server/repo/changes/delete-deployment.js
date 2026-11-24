/**
 * delete-deployment: a deployment removed.
 *
 *   { kind: 'delete-deployment', dir, folder, deployment }
 *     dir         its folder in the repo (a folder deployment's own, or a
 *                 legacy deployment's deployments/<chart>)
 *     folder      the folder the route was asked for (undefined: legacy)
 *     deployment  the name in the URL
 *
 * A folder deployment (its values.yaml, or a Chart.yaml with none) goes
 * whole: its folder moved aside in one rename (write.js removeWhole) —
 * nothing in it read, so one with a file that cannot be read, or a link,
 * is removed too — then sync.yaml written without it: a deleted target
 * leaves its source, a deleted source lets go of its targets, which keep
 * what they have and become editable again (#180); then the folder moved
 * aside is removed. All or none: when sync.yaml cannot be written the
 * folder is renamed back. A deployment folder that is itself a link is
 * refused (the route's path check, and the writer's). A legacy
 * `<name>-values.yaml` goes alone, and sync.yaml is not touched.
 */
import path from 'path'
import { defineChange } from '../write.js'
import { syncAnswer, SYNC_FILE } from '../sync.js'
import { folderEntry, isDeployment } from '../walk.js'
import { LEGACY_VALUES_SUFFIX, deploymentLinkProblem } from '../paths.js'
import { isTarget, applyUnlink, registryText } from '../../lib/sync.js'

defineChange('delete-deployment', {
  policy: 'save',

  async plan(repo, { dir, folder, deployment }) {
    // A deployment folder reached through a link is refused here too: the
    // plan made again under the lock is not checked by the route.
    const link = await deploymentLinkProblem(repo.root, dir)
    if (link) return { refusal: { status: 400, body: { error: link } } }
    // Which file holds its values (resolve.js): the folder's own deployment,
    // named after the folder, is values.yaml when there is one; any other
    // name a legacy `<name>-values.yaml` beside it.
    // Anything at values.yaml — a file, one that cannot be read, a link,
    // a link to nothing, a folder — is the folder's own deployment: never
    // quietly the other file.
    let direct = false
    if (deployment === path.posix.basename(dir)) {
      const values = await repo.file(`${dir}/values.yaml`)
      direct = values.state !== 'absent' && values.kind !== 'not-a-folder'
    }
    // A folder with a Chart.yaml and no values.yaml is removed whole too:
    // it renders the Template, and keeps the Template from being deleted.
    if (!direct && folder && deployment === path.posix.basename(dir)) direct = !!(await folderEntry(repo, folder)).chartOnly
    const files = []
    const facts = { unlinked: [] }
    if (!direct) {
      const file = `${dir}/${deployment}${LEGACY_VALUES_SUFFIX}`
      const there = await repo.file(file)
      if (there.state === 'unreadable' && there.kind === 'folder') return { refusal: { status: 409, body: { error: `${file} cannot be removed: a folder is in its place`, file } } }
      if (there.state !== 'absent') files.push({ rel: file, text: null })
      return { files, facts }
    }
    files.push({ rel: dir, removeWhole: true })
    // Deleting a legacy deployment's folder leaves sync.yaml as it is.
    if (!folder) return { files, facts }
    const read = await syncAnswer(repo)
    if (read.refusal) return { refusal: read.refusal }
    const { registry } = read
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
      // Listed as let go: on disk, and not still under another source; one
      // inside the source goes with it.
      for (const t of new Set(entries.flatMap(e => e.targets))) {
        if (t !== folder && !t.startsWith(`${folder}/`) && !isTarget(registry, t) && await isDeployment(repo, t)) facts.unlinked.push(t)
      }
    }
    if (changed) files.push({ rel: SYNC_FILE, text: registryText(registry) })
    return { files, facts }
  },

  // Nothing is someone else's edit to keep: a file added or changed while
  // it waits is planned again (and goes with the rest).
  strict: () => new Set(),
  table: () => 'save',
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The deployment changed while it was being deleted: look at it again', changed: true } }),
  answer: plan => (plan.facts.unlinked.length ? { ok: true, unlinked: plan.facts.unlinked } : { ok: true }),
})
