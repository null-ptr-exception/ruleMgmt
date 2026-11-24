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
 * whole: every file under its folder — links as links, never followed —
 * then each folder, deepest first; and sync.yaml without it: a deleted
 * target leaves its source, a deleted source lets go of its targets, which
 * keep what they have and become editable again (#180). A legacy
 * `<name>-values.yaml` goes alone, and sync.yaml is not touched. All or
 * none: a file that cannot be removed puts back every one removed before
 * it. A file or folder under it that cannot be read is named, and nothing
 * is removed (it could not be put back).
 */
import path from 'path'
import { defineChange } from '../write.js'
import { syncAnswer, SYNC_FILE } from '../sync.js'
import { folderEntry, isDeployment } from '../walk.js'
import { LEGACY_VALUES_SUFFIX } from '../paths.js'
import { isTarget, applyUnlink, registryText } from '../../lib/sync.js'
import { everythingUnder } from './everythingUnder.js'

const cannotRead = (file, why) => ({ refusal: { status: 409, body: { error: `${file} cannot be read: ${why}`, file, unreadable: true } } })

defineChange('delete-deployment', {
  policy: 'save',

  async plan(repo, { dir, folder, deployment }) {
    // Which file holds its values (resolve.js): the folder's own deployment,
    // named after the folder, is values.yaml when there is one; any other
    // name a legacy `<name>-values.yaml` beside it.
    let direct = false
    if (deployment === path.posix.basename(dir)) {
      const values = await repo.file(`${dir}/values.yaml`)
      // A link to nothing, or one that cannot be read, must not quietly
      // pick the other file.
      // A folder in its place is removed with the rest, as before.
      if (values.state === 'unreadable' && values.kind !== 'not-a-folder' && values.kind !== 'folder') return cannotRead(`${dir}/values.yaml`, values.why)
      direct = values.state === 'ok' || values.kind === 'folder'
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
    const unread = await everythingUnder(repo, dir, files)
    if (unread) return cannotRead(unread.file, unread.why)
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
      // Listed as let go: on disk, and not still under another source.
      // Asked of the repo as it is after the delete: one inside the source goes with it.
      const after = repo.with(files.filter(f => !f.removeFolder).map(f => [f.rel, null]))
      for (const t of new Set(entries.flatMap(e => e.targets))) {
        if (t !== folder && !t.startsWith(`${folder}/`) && !isTarget(registry, t) && await isDeployment(after, t)) facts.unlinked.push(t)
      }
    }
    if (changed) files.push({ rel: SYNC_FILE, text: registryText(registry) })
    return { files, facts }
  },

  // Nothing is someone else's edit to keep: a file added or changed while
  // it waits is planned again (and removed with the rest).
  strict: () => new Set(),
  table: () => 'save',
  refused: () => ({ status: 400, body: { error: 'refused' } }),
  changed: () => ({ status: 409, body: { error: 'The deployment changed while it was being deleted: look at it again', changed: true } }),
  answer: plan => (plan.facts.unlinked.length ? { ok: true, unlinked: plan.facts.unlinked } : { ok: true }),
})
