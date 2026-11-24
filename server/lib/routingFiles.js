/**
 * A deployment's notification routing on disk (#92): the routing.yaml it is
 * written in, and the AlertmanagerConfig generated from it into the
 * deployment chart's templates/. Shared by the routing, shared-config and sync changes, so the two files are always planned together.
 *
 * Only a folder deployment has routing: it is a chart directory of its own,
 * so a file in its templates/ is deployed with it. A legacy flat deployment
 * is a values file beside others and has nowhere to put one.
 */

import path from 'path'
import { ROUTING_FILE, ROUTING_CR_FILE, loadRouting, routingFiles } from '../repo/routing.js'
import { decide } from '../repo/policy.js'
import { ROUTING_POLICIES } from '../repo/routingPolicy.js'

/**
 * An answer naming a file that cannot be read: 409, `unreadable: true`,
 * never a 500. `loaded` is a Loaded that is not ok, or { file, why }.
 */
export const unreadableAnswer = ({ file, why }) => ({ status: 409, body: { error: `${file} cannot be read (${why})`, file, unreadable: true } })

/**
 * A source's routing as a sync copies it to its targets (#166): both files,
 * the resource made again from routing.yaml so a stale or missing one is
 * not copied; `{ errors }` when the copy is refused (syncCopy policy: a
 * routing.yaml the save would refuse, a resource left without one), and
 * `{ unreadable }` (a Loaded) when routing.yaml cannot be read. Neither
 * file: nothing to copy, `{ text: null, cr: null }`.
 */
export async function routingToCopy(repo, source) {
  const loaded = await loadRouting(repo, source)
  if (loaded.state === 'unreadable') return { unreadable: loaded, errors: [`${loaded.file} cannot be read (${loaded.why})`] }
  if (loaded.state === 'absent') return routingFiles(loaded)
  const { refuse } = decide(loaded.findings, ROUTING_POLICIES.syncCopy)
  // A resource with nothing to make it from: neither Routing page shows it,
  // and a read-only target could not remove it.
  const said = f => (f.code === 'routing.problem' ? loaded.value.errors
    : f.code === 'routing.orphaned' ? [`${ROUTING_CR_FILE} is there without a routing.yaml to make it from: remove it, or put routing.yaml back`] : [f.message])
  if (refuse.length) return { errors: refuse.flatMap(said) }
  return { text: loaded.value.text, cr: loaded.value.made }
}

/**
 * The files (a writer's entries) that make `dep`'s routing `{ text, cr }`
 * (null: none), planned on the snapshot `repo`: routing.yaml and its
 * AlertmanagerConfig, written or removed, and templates/ removed when the
 * resource was all it held. Only what changes. The one place a
 * deployment's routing files are planned: its own save, removal and
 * Regenerate, and a sync target's copy (deploymentWrite.js targetCopy).
 */
export async function routingEntries(repo, dep, { text, cr }) {
  const out = []
  for (const [rel, want] of [[`${dep}/${ROUTING_FILE}`, text], [`${dep}/${ROUTING_CR_FILE}`, cr]]) {
    const now = await repo.file(rel)
    if (want === null ? now.state === 'absent' : now.state === 'ok' && now.value.text === want) continue
    out.push({ rel, text: want })
  }
  if (cr === null) {
    // templates/ was made for the resource; one holding anything else stays.
    const tdir = `${dep}/${path.posix.dirname(ROUTING_CR_FILE)}`
    const d = await repo.dir(tdir)
    if (d.state === 'ok' && [...d.value.entries.keys()].every(n => n === path.posix.basename(ROUTING_CR_FILE))) out.push({ rel: tdir, removeFolder: true })
  }
  return out
}
