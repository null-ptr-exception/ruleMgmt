/**
 * The repo's shared notification configs (#123), _shared/notification-configs.yaml:
 * configs written once and used by name from any folder deployment's
 * routing.yaml (`relay-webhook: { shared: true }`). Each deployment's
 * AlertmanagerConfig carries the shared config in full, so a change to one
 * is a change to every resource made from it: they are all made again and
 * written together, or none is.
 *
 * The file and each deployment's routing are read through server/repo
 * (shared.js, routing.js); this module writes them.
 *
 *   routingUsers        every deployment with a routing.yaml, and what it uses
 *   sharedUsage         who uses each shared config
 *   planShared          the file and every resource made from it, planned
 *   planRename          a shared config's name, in the file and every user, planned
 * (changes/shared.js writes what they plan, all or none.)
 */

import yaml from 'js-yaml'
import { sameConfig } from '../../src/utils/routingModel.js'
import { SHARED_DIR, SHARED_FILE } from '../../src/utils/routingGenerator.js'
import { configNameProblem } from '../../src/utils/routingSchema.js'
import { unreadableAnswer } from './routingFiles.js'
import { syncAnswer } from '../repo/sync.js'
import { listFolderDeployments } from './commitChecks.js'
import { getSourceForTarget } from './sync.js'
import { sharedCellOverlaps } from '../../src/utils/sharedOverlap.js'
import { openRepo } from '../repo/openRepo.js'
import { buildRouting, loadRouting, ROUTING_FILE, ROUTING_CR_FILE } from '../repo/routing.js'
import { loadShared, loadSharedDir, parseShared, sharedDirProblemOf } from '../repo/shared.js'
import { isLinkKind } from '../repo/loaded.js'
import { linkOutOfTree, linkOutRefusal } from '../repo/walk.js'
import { renameConfigInText, updateConfigsInText } from '../repo/sharedDoc.js'

export { SHARED_DIR, SHARED_FILE }


/**
 * Whether `relPath` (in the repo) is under _shared/ while that is the shared
 * configs' folder: nothing else is there, so nothing under it is a folder of
 * the tree, a deployment or a sync target, and nothing can be made there. A
 * repo's own _shared/ (sharedDirProblemOf) is a folder like any other, and
 * shared configs are refused instead. The one rule for every place that asks.
 */
export async function inSharedDir(gitopsDir, relPath) {
  const first = String(relPath ?? '').split(/[\\/]/).filter(s => s && s !== '.')[0]
  return first === SHARED_DIR && !sharedDirProblemOf(await loadSharedDir(openRepo(gitopsDir)))
}

/**
 * Every folder deployment with a routing.yaml, and the shared configs each
 * uses. A sync target is listed with the source it is copied from. One whose
 * routing.yaml cannot be read is listed with `unreadable` (why): whether it
 * uses a shared config cannot be told.
 * @returns [{ deployment, text, uses: [name], syncedFrom?, unreadable? }]
 */
export async function routingUsers(repo) {
  const { registry, refusal } = await syncAnswer(repo)
  if (refusal) return { refusal }
  const users = []
  for (const deployment of await listFolderDeployments(repo.root, repo)) {
    const source = getSourceForTarget(registry, deployment)
    const synced = source && source !== deployment ? { syncedFrom: source } : {}
    const loaded = await loadRouting(repo, deployment)
    if (loaded.state === 'unreadable') {
      users.push({ deployment, text: null, doc: null, uses: [], ...synced, unreadable: `${ROUTING_FILE} cannot be read (${loaded.why})` })
      continue
    }
    if (loaded.state === 'absent' || loaded.value.text === null) continue
    const r = loaded.value
    // Its resource cannot be read, so it cannot be made again either: it
    // stops only a change to a config it uses (refuseUnreadable).
    const cr = r.crUnreadable ? { crUnreadable: `${r.crUnreadable.file} cannot be read (${r.crUnreadable.why})` } : {}
    users.push({ deployment, text: r.text, doc: r.doc, uses: r.uses, ...synced, ...(r.usesUnknown ? { unreadable: r.usesUnknown } : {}), ...cr, routing: r })
  }
  return { users, registry }
}

/** The deployments whose routing.yaml or resource cannot be read: [{ deployment, error }]. */
export const unreadableOf = users => users.filter(u => u.unreadable || u.crUnreadable).map(u => ({ deployment: u.deployment, error: u.unreadable || u.crUnreadable }))

// A change to the shared configs is refused while a routing.yaml cannot be
// read (it may use the config being changed, and would be left behind),
// or while a deployment using a config being changed has a resource that
// cannot be read (it could not be made again). One whose resource cannot be
// read and uses none of them is left as it is. `touches(user)`: it uses a
// config being changed.
function refuseUnreadable(users, what, touches) {
  const unknown = users.filter(u => u.unreadable)
  if (unknown.length) {
    return { status: 409, body: {
      error: `${what}: the routing.yaml of ${unknown.map(u => u.deployment).join(', ')} cannot be read, so whether it uses a shared config cannot be told — fix it first`,
      unreadable: unreadableOf(unknown),
    } }
  }
  const stuck = users.filter(u => u.crUnreadable && touches(u))
  if (!stuck.length) return null
  return { status: 409, body: {
    error: `${what}: ${stuck.map(u => u.crUnreadable).join('; ')}, and it uses a shared config being changed — fix it first`,
    unreadable: unreadableOf(stuck),
  } }
}

/** Shared config name → [{ deployment, syncedFrom? }] using it. */
export function usageOf(users) {
  const usage = {}
  for (const { deployment, uses, syncedFrom } of users) {
    // Own keys only: a config may be named constructor or toString.
    for (const name of uses) (Object.hasOwn(usage, name) ? usage[name] : (usage[name] = [])).push({ deployment, ...(syncedFrom ? { syncedFrom } : {}) })
  }
  return usage
}

/**
 * Cells of different deployments that send one alert to the same shared
 * config (sharedOverlap.js): `{ overlaps, unchecked, synced }`. A
 * routing.yaml that cannot be read is left out — the page names those on
 * their own; one the save would refuse is listed as unchecked.
 */
export function overlapsOf(users, shared) {
  return sharedCellOverlaps(users
    .filter(u => !u.unreadable && u.uses.length)
    .map(u => ({ deployment: u.deployment, routing: u.doc, ...(u.syncedFrom ? { syncedFrom: u.syncedFrom } : {}) })), shared)
}

/**
 * The deployments using a shared config whose AlertmanagerConfig is not what
 * their routing.yaml and the shared configs make now (a target: not its
 * source's). Regenerate makes them again.
 */
export function staleUsers(users) {
  const stale = new Set()
  const byName = new Map(users.map(u => [u.deployment, u]))
  // Sources first: a target whose source is behind is behind with it.
  const ordered = [...users.filter(u => !u.syncedFrom), ...users.filter(u => u.syncedFrom)]
  for (const user of ordered) {
    if (!user.uses.length) continue
    const mine = user.routing
    if (user.syncedFrom) {
      const source = byName.get(user.syncedFrom)?.routing
      if (stale.has(user.syncedFrom) || !source || source.text !== mine.text || source.cr !== mine.cr) stale.add(user.deployment)
      continue
    }
    if (mine.errors.length || mine.made !== mine.cr) stale.add(user.deployment)
  }
  return users.map(u => u.deployment).filter(d => stale.has(d))
}

/**
 * Make, in memory, each user's files with the shared configs `shared`;
 * `rewrite(user)` gives a user's routing.yaml text (default: as it is).
 * A sync target is not made: it is copied from its source after.
 * @returns { files: [{ rel, text }], sources: [{ deployment, routing: { text, cr } }], failed: [{ deployment, errors }] }
 */
function planUsers(users, shared, rewrite = u => u.text) {
  const files = []
  const sources = []
  const failed = []
  for (const user of users) {
    // A target is copied from its source; one whose resource cannot be read
    // uses no config being changed (refuseUnreadable): its own is the same.
    if (user.syncedFrom || user.crUnreadable) continue
    const text = rewrite(user)
    const built = buildRouting(text, shared)
    if (built.errors) {
      failed.push({ deployment: user.deployment, errors: built.errors })
      continue
    }
    if (text !== user.text) files.push({ rel: `${user.deployment}/${ROUTING_FILE}`, text })
    files.push({ rel: `${user.deployment}/${ROUTING_CR_FILE}`, text: built.cr })
    sources.push({ deployment: user.deployment, routing: { text, cr: built.cr } })
  }
  return { files, sources, failed }
}

/**
 * The shared configs written and the resource of every deployment that
 * uses one made again, planned on `repo`. A deployment's resource that
 * cannot be made — its routing.yaml has a problem, or uses a config the
 * new file does not have — refuses the whole write, naming it. A shared
 * config still used cannot be removed.
 * @returns { refusal } | { files, sources, registry, body }: `files` the
 *   shared file first, then each user's; `sources` the users whose sync
 *   targets get their routing; `body` the 200's
 */
export async function planShared(repo, input) {
  const dirProblem = sharedDirProblemOf(await loadSharedDir(repo))
  if (dirProblem) return { refusal: { status: 409, body: { error: dirProblem } } }
  // The file is replaced as a whole, and put back if a write fails: one
  // that cannot be read (no permission, a folder) could be neither. A link
  // that is the file itself is replaced by the file; its folder must be the
  // repo's (writeProblem, below).
  const before = await loadShared(repo)
  if (before.state === 'unreadable' && !isLinkKind(before.kind)) return { refusal: unreadableAnswer(before) }
  const current = before.state === 'ok' ? before.value : null
  const text = typeof input === 'string' ? input : textFromPage(input, current)
  const shared = parseShared(text)
  if (shared.errors.length) return { refusal: { status: 400, body: { error: `${SHARED_FILE} has problems`, problems: shared.errors } } }

  const { users: all, registry, refusal } = await routingUsers(repo)
  if (refusal) return { refusal }
  const was = current && !current.errors.length ? current.configs : null
  const changed = name => !was || !Object.hasOwn(was, name) || !Object.hasOwn(shared.configs, name) || !sameConfig(was[name], shared.configs[name])
  const unreadable = refuseUnreadable(all, 'Not written', u => u.uses.some(changed))
  if (unreadable) return { refusal: unreadable }
  const out = await linkOutOfTree(repo)
  if (out) return { refusal: linkOutRefusal(out, 'with its shared configs as they were') }
  const users = all.filter(u => u.uses.length)
  const removed = {}
  for (const user of users) {
    for (const name of user.uses) {
      if (!Object.hasOwn(shared.configs, name)) (Object.hasOwn(removed, name) ? removed[name] : (removed[name] = [])).push(user.deployment)
    }
  }
  if (Object.keys(removed).length) {
    return { refusal: { status: 409, body: {
      error: `Still used: ${Object.entries(removed).map(([n, deps]) => `${n} by ${deps.join(', ')}`).join('; ')}`,
      usedBy: removed,
    } } }
  }

  const { files, sources, failed } = planUsers(users, shared)
  if (failed.length) {
    return { refusal: { status: 400, body: { error: `Not written: the routing of ${failed.map(f => f.deployment).join(', ')} cannot be made with these shared configs`, failed } } }
  }
  const writes = [{ rel: SHARED_FILE, text }, ...files]
  return { files: writes, sources, registry, body: { ok: true, written: writes.map(f => f.rel), ...(shared.warnings.length ? { warnings: shared.warnings } : {}) } }
}

// The page sends { configs }: written into the file as it is, its comments
// and layout kept (updateConfigsInText); anew when there is no such file.
function textFromPage(input, current) {
  const configs = input.configs && typeof input.configs === 'object' && !Array.isArray(input.configs) ? input.configs : null
  return (configs && current?.text && !current.errors.length && updateConfigsInText(current.text, configs)) || yaml.dump(input, { lineWidth: -1 })
}

/**
 * A shared config renamed in the file and in every routing.yaml that uses
 * it, and their resources made again, planned on `repo` as planShared.
 * Refused when a user already has a config of its own named `to`.
 * @returns { refusal } | { files, sources, registry, body }
 */
export async function planRename(repo, from, to) {
  const loaded = await loadShared(repo)
  if (loaded.state === 'unreadable') return { refusal: unreadableAnswer(loaded) }
  const current = loaded.state === 'ok' ? loaded.value : null
  if (!current) return { refusal: { status: 404, body: { error: 'There are no shared notification configs' } } }
  if (current.errors.length) return { refusal: { status: 400, body: { error: `${SHARED_FILE} has problems: fix it first`, problems: current.errors } } }
  if (!Object.hasOwn(current.configs, from)) return { refusal: { status: 404, body: { error: `There is no shared config named ${from}` } } }
  const why = typeof to === 'string' ? configNameProblem(to) : 'the new name must be text'
  if (why) return { refusal: { status: 400, body: { error: `${to}: ${why}` } } }
  if (to === from) return { refusal: { status: 400, body: { error: 'The new name is the same' } } }
  if (Object.hasOwn(current.configs, to)) return { refusal: { status: 409, body: { error: `${to} is already a shared config` } } }

  const { users: all, registry, refusal } = await routingUsers(repo)
  if (refusal) return { refusal }
  const unreadable = refuseUnreadable(all, 'Not renamed', u => u.uses.includes(from))
  if (unreadable) return { refusal: unreadable }
  const out = await linkOutOfTree(repo)
  if (out) return { refusal: linkOutRefusal(out, 'with the old name') }
  const users = all.filter(u => u.uses.includes(from))
  const clash = users.filter(u => !u.syncedFrom && Object.hasOwn(u.doc?.configs || {}, to)).map(u => u.deployment)
  if (clash.length) return { refusal: { status: 409, body: { error: `${clash.join(', ')} already ${clash.length > 1 ? 'have' : 'has'} a config named ${to}`, clash } } }

  const text = renameConfigInText(current.text, from, to)
  const shared = parseShared(text)
  const { files, sources, failed } = planUsers(users, shared, u => renameConfigInText(u.text, from, to))
  if (failed.length) {
    return { refusal: { status: 400, body: { error: `Not renamed: the routing of ${failed.map(f => f.deployment).join(', ')} cannot be made`, failed } } }
  }
  const writes = [{ rel: SHARED_FILE, text }, ...files]
  return { files: writes, sources, registry, body: { ok: true, written: writes.map(f => f.rel) } }
}
