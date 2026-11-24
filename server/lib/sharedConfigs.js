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
 *   writeShared         the file and every resource made from it, all or none
 *   renameShared        a shared config's name, in the file and every user
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { parseDocument, Document, isMap, isScalar, isSeq } from 'yaml'
import { readsAsNonString } from '../../src/utils/yamlScalar.js'
import { sameConfig } from '../../src/utils/routingModel.js'
import { SHARED_DIR, SHARED_FILE } from '../../src/utils/routingGenerator.js'
import { configNameProblem } from '../../src/utils/routingSchema.js'
import { buildRouting, writeWhole, unreadableAnswer, ROUTING_FILE, ROUTING_CR_FILE } from './routingFiles.js'
import { syncAnswer } from '../repo/sync.js'
import { listFolderDeployments } from './commitChecks.js'
import { getSourceForTarget, getTargetsForSource } from './sync.js'
import { copyToTargets } from './deploymentWrite.js'
import { sharedCellOverlaps } from '../../src/utils/sharedOverlap.js'
import { openRepo } from '../repo/openRepo.js'
import { loadRouting } from '../repo/routing.js'
import { loadShared, loadSharedDir, parseShared, sharedDirProblemOf } from '../repo/shared.js'
import { isLinkKind } from '../repo/loaded.js'
import { writeProblems, writeRefusal, targetWriteProblem } from '../repo/writePath.js'

export { SHARED_DIR, SHARED_FILE }

const sharedPath = gitopsDir => path.join(gitopsDir, SHARED_FILE)

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

// The files a write would put, and every sync target's copy after it: one
// that would land outside the repo refuses the whole write.
async function outsideProblem(gitopsDir, registry, rels, sources) {
  const targets = sources.flatMap(s => getTargetsForSource(registry, s).filter(t => t !== s))
  return await writeProblems(gitopsDir, rels) ?? targetWriteProblem(gitopsDir, targets, t => [`${t}/${ROUTING_FILE}`, `${t}/${ROUTING_CR_FILE}`])
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
 * Write every file at once: each is put back as it was when any write fails.
 * `files` is [{ abs, content }] (content null: remove it).
 */
async function writeAll(files) {
  const before = []
  let at
  try {
    for (const f of files) {
      at = f
      before.push({ abs: f.abs, content: await fs.readFile(f.abs, 'utf-8').catch(err => { if (err.code === 'ENOENT') return null; throw err }) })
      await fs.mkdir(path.dirname(f.abs), { recursive: true })
      if (f.content === null) await fs.rm(f.abs, { force: true })
      else await writeWhole(f.abs, f.content)
    }
  } catch (err) {
    for (const b of before.reverse()) {
      await (b.content === null ? fs.rm(b.abs, { force: true }) : writeWhole(b.abs, b.content)).catch(() => {})
    }
    // Named by its path in the repo, never the server's.
    return { status: 500, body: { error: `${at.rel} could not be written (${err.code || 'error'}): nothing was changed`, file: at.rel } }
  }
  return null
}

/**
 * Make, in memory, each user's files with the shared configs `shared`;
 * `rewrite(user)` gives a user's routing.yaml text (default: as it is).
 * A sync target is not made: it is copied from its source after.
 * @returns { files, sources, failed: [{ deployment, errors }] }
 */
function planUsers(gitopsDir, users, shared, rewrite = u => u.text) {
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
    const dir = path.join(gitopsDir, user.deployment)
    if (text !== user.text) files.push({ abs: path.join(dir, ROUTING_FILE), content: text, rel: `${user.deployment}/${ROUTING_FILE}` })
    files.push({ abs: path.join(dir, ROUTING_CR_FILE), content: built.cr, rel: `${user.deployment}/${ROUTING_CR_FILE}` })
    sources.push(user.deployment)
  }
  return { files, sources, failed }
}

// Each source's targets get its routing again: a target's files are its
// source's. One that cannot be written is reported, as a save reports it.
async function copyToSyncTargets(gitopsDir, registry, sources) {
  const failed = []
  for (const source of sources) failed.push(...await copyToTargets(gitopsDir, registry, source, { values: false, routing: true }))
  return failed
}

/**
 * Write the shared configs and make again the resource of every deployment
 * that uses one, all or nothing (the caller holds the commit lock). A
 * deployment's resource that cannot be made — its routing.yaml has a
 * problem, or uses a config the new file does not have — refuses the whole
 * write, naming it. A shared config still used cannot be removed.
 * @returns { status, body }
 */
export async function writeShared(gitopsDir, input) {
  const repo = openRepo(gitopsDir)
  const dirProblem = sharedDirProblemOf(await loadSharedDir(repo))
  if (dirProblem) return { status: 409, body: { error: dirProblem } }
  // The file is replaced as a whole, and put back if a write fails: one
  // that cannot be read (no permission, a folder) could be neither. A link
  // that is the file itself is replaced by the file; its folder must be the
  // repo's (writeProblem, below).
  const before = await loadShared(repo)
  if (before.state === 'unreadable' && !isLinkKind(before.kind)) return unreadableAnswer(before)
  const current = before.state === 'ok' ? before.value : null
  const text = typeof input === 'string' ? input : textFromPage(input, current)
  const shared = parseShared(text)
  if (shared.errors.length) return { status: 400, body: { error: `${SHARED_FILE} has problems`, problems: shared.errors } }

  const { users: all, registry, refusal } = await routingUsers(repo)
  if (refusal) return refusal
  const was = current && !current.errors.length ? current.configs : null
  const changed = name => !was || !Object.hasOwn(was, name) || !Object.hasOwn(shared.configs, name) || !sameConfig(was[name], shared.configs[name])
  const unreadable = refuseUnreadable(all, 'Not written', u => u.uses.some(changed))
  if (unreadable) return unreadable
  const users = all.filter(u => u.uses.length)
  const removed = {}
  for (const user of users) {
    for (const name of user.uses) {
      if (!Object.hasOwn(shared.configs, name)) (Object.hasOwn(removed, name) ? removed[name] : (removed[name] = [])).push(user.deployment)
    }
  }
  if (Object.keys(removed).length) {
    return { status: 409, body: {
      error: `Still used: ${Object.entries(removed).map(([n, deps]) => `${n} by ${deps.join(', ')}`).join('; ')}`,
      usedBy: removed,
    } }
  }

  const { files, sources, failed } = planUsers(gitopsDir, users, shared)
  if (failed.length) {
    return { status: 400, body: { error: `Not written: the routing of ${failed.map(f => f.deployment).join(', ')} cannot be made with these shared configs`, failed } }
  }
  const outside = await outsideProblem(gitopsDir, registry, [SHARED_FILE, ...files.map(f => f.rel)], sources)
  if (outside) return writeRefusal(outside)
  const notWritten = await writeAll([{ abs: sharedPath(gitopsDir), content: text, rel: SHARED_FILE }, ...files])
  if (notWritten) return notWritten
  const syncFailed = await copyToSyncTargets(gitopsDir, registry, sources)
  return { status: 200, body: { ok: true, written: [SHARED_FILE, ...files.map(f => f.rel)], ...(shared.warnings.length ? { warnings: shared.warnings } : {}), ...(syncFailed.length ? { syncFailed } : {}) } }
}

// The page sends { configs }: written into the file as it is, its comments
// and layout kept (updateConfigsInText); anew when there is no such file.
function textFromPage(input, current) {
  const configs = input.configs && typeof input.configs === 'object' && !Array.isArray(input.configs) ? input.configs : null
  return (configs && current?.text && !current.errors.length && updateConfigsInText(current.text, configs)) || yaml.dump(input, { lineWidth: -1 })
}

/**
 * A routing.yaml's or the shared file's text with the config `from` named
 * `to` — in configs, and in every cell that notifies it. Only those names
 * are replaced, where they are written: every other byte, comments and
 * layout, stays.
 */
export function renameConfigInText(text, from, to) {
  const doc = parseDocument(text)
  const at = []
  const configs = doc.get('configs', true)
  if (isMap(configs)) for (const pair of configs.items) if (isScalar(pair.key) && pair.key.value === from) at.push(pair.key)
  const cells = doc.get('cells', true)
  if (isSeq(cells)) {
    for (const cell of cells.items) {
      const list = isMap(cell) ? cell.get('configs', true) : null
      if (isSeq(list)) for (const item of list.items) if (isScalar(item) && item.value === from) at.push(item)
    }
  }
  // A name is letters, digits and "-": written as the old one was, in
  // either quotes, or plain — quoted when YAML would read it bare as
  // something else (`123`, `true`, `0x10`).
  const written = node => (node.type === 'QUOTE_DOUBLE' ? JSON.stringify(to)
    : node.type === 'QUOTE_SINGLE' || readsAsNonString(to) ? `'${to}'` : to)
  let out = text
  for (const node of at.sort((a, b) => b.range[0] - a.range[0])) {
    out = out.slice(0, node.range[0]) + written(node) + out.slice(node.range[1])
  }
  return out
}

// A config name as a key: quoted when YAML would read it bare as something else.
const keyText = name => (readsAsNonString(name) ? `'${name}'` : name)

const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text, at) => {
  const end = text.indexOf('\n', at)
  return end < 0 ? text.length : end + 1
}

// One config as a pair of the shared file, flow (`name: { … }`, one line)
// or block, at `indent`.
function pairText(name, config, flow, indent) {
  if (flow) {
    const doc = new Document(config)
    doc.contents.flow = true
    return `${indent}${keyText(name)}: ${doc.toString({ lineWidth: 0 }).trim()}\n`
  }
  const body = new Document(config).toString({ lineWidth: 0 }).trimEnd().split('\n')
  return `${indent}${keyText(name)}:\n${body.map(l => `${indent}  ${l}`).join('\n')}\n`
}

/**
 * The shared file's text with its configs made `configs` — the ones taken
 * out removed, the changed ones written again, new ones added after the
 * last — and every other byte as it was: comments, layout, the configs not
 * changed. A changed or added config is written in the style of the one it
 * replaces, or of the last one; with none left, `configs: {}`. Null when
 * the text has no configs map with a config in it to follow: the caller
 * writes the file anew.
 */
export function updateConfigsInText(text, configs) {
  const doc = parseDocument(text)
  const map = doc.get('configs', true)
  if (doc.errors.length || !isMap(map) || map.flow || !map.items.length) return null
  const pairs = map.items.filter(p => isScalar(p.key))
  if (pairs.length !== map.items.length) return null
  const current = doc.toJS().configs || {}
  // Edits from the end, so each range is still where it was.
  const edits = []
  const last = pairs[pairs.length - 1]
  const indentOf = pair => text.slice(lineStart(text, pair.key.range[0]), pair.key.range[0])
  const flowOf = pair => isMap(pair.value) && !!pair.value.flow
  const spanOf = pair => [lineStart(text, pair.key.range[0]), lineEnd(text, pair.value.range[1] - 1)]
  for (const pair of pairs) {
    const name = String(pair.key.value)
    const [from, to] = spanOf(pair)
    if (!Object.hasOwn(configs, name)) edits.push({ from, to, insert: '' })
    else if (!sameConfig(current[name], configs[name])) edits.push({ from, to, insert: pairText(name, configs[name], flowOf(pair), indentOf(pair)) })
  }
  const added = Object.keys(configs).filter(n => !Object.hasOwn(current, n))
  if (added.length) {
    const at = spanOf(last)[1]
    const insert = added.map(n => pairText(n, configs[n], flowOf(last), indentOf(last))).join('')
    edits.push({ from: at, to: at, insert: (text.slice(0, at).endsWith('\n') ? '' : '\n') + insert })
  }
  // Every config taken out: the map is written empty, `configs: {}`. Left
  // as a bare `configs:` it would read as null, which the file may not hold.
  if (!Object.keys(configs).length) {
    const key = doc.contents.items.find(p => isScalar(p.key) && p.key.value === 'configs').key
    const colon = text.indexOf(':', key.range[1])
    edits.push({ from: colon + 1, to: colon + 1, insert: ' {}' })
  }
  let out = text
  for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  return out
}

/**
 * Rename a shared config in the file and in every routing.yaml that uses it,
 * and make their resources again — all or nothing, as writeShared. Refused
 * when a user already has a config of its own named `to`.
 * @returns { status, body }
 */
export async function renameShared(gitopsDir, from, to) {
  const repo = openRepo(gitopsDir)
  const loaded = await loadShared(repo)
  if (loaded.state === 'unreadable') return unreadableAnswer(loaded)
  const current = loaded.state === 'ok' ? loaded.value : null
  if (!current) return { status: 404, body: { error: 'There are no shared notification configs' } }
  if (current.errors.length) return { status: 400, body: { error: `${SHARED_FILE} has problems: fix it first`, problems: current.errors } }
  if (!Object.hasOwn(current.configs, from)) return { status: 404, body: { error: `There is no shared config named ${from}` } }
  const why = typeof to === 'string' ? configNameProblem(to) : 'the new name must be text'
  if (why) return { status: 400, body: { error: `${to}: ${why}` } }
  if (to === from) return { status: 400, body: { error: 'The new name is the same' } }
  if (Object.hasOwn(current.configs, to)) return { status: 409, body: { error: `${to} is already a shared config` } }

  const { users: all, registry, refusal } = await routingUsers(repo)
  if (refusal) return refusal
  const unreadable = refuseUnreadable(all, 'Not renamed', u => u.uses.includes(from))
  if (unreadable) return unreadable
  const users = all.filter(u => u.uses.includes(from))
  const clash = users.filter(u => !u.syncedFrom && Object.hasOwn(u.doc?.configs || {}, to)).map(u => u.deployment)
  if (clash.length) return { status: 409, body: { error: `${clash.join(', ')} already ${clash.length > 1 ? 'have' : 'has'} a config named ${to}`, clash } }

  const text = renameConfigInText(current.text, from, to)
  const shared = parseShared(text)
  const { files, sources, failed } = planUsers(gitopsDir, users, shared, u => renameConfigInText(u.text, from, to))
  if (failed.length) {
    return { status: 400, body: { error: `Not renamed: the routing of ${failed.map(f => f.deployment).join(', ')} cannot be made`, failed } }
  }
  const outside = await outsideProblem(gitopsDir, registry, [SHARED_FILE, ...files.map(f => f.rel)], sources)
  if (outside) return writeRefusal(outside)
  const notWritten = await writeAll([{ abs: sharedPath(gitopsDir), content: text, rel: SHARED_FILE }, ...files])
  if (notWritten) return notWritten
  const syncFailed = await copyToSyncTargets(gitopsDir, registry, sources)
  return { status: 200, body: { ok: true, written: [SHARED_FILE, ...files.map(f => f.rel)], ...(syncFailed.length ? { syncFailed } : {}) } }
}
