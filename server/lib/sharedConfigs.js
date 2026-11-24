/**
 * The repo's shared notification configs (#123), _shared/notification-configs.yaml:
 * configs written once and used by name from any folder deployment's
 * routing.yaml (`relay-webhook: { shared: true }`). Each deployment's
 * AlertmanagerConfig carries the shared config in full, so a change to one
 * is a change to every resource made from it: they are all made again and
 * written together, or none is.
 *
 *   readSharedConfigs   the file, parsed and checked; null when there is none
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
import { checkSharedConfigs, sharedNamesIn, SHARED_DIR, SHARED_FILE } from '../../src/utils/routingGenerator.js'
import { configNameProblem } from '../../src/utils/routingSchema.js'
import { readRouting, buildRouting, writeWhole, ROUTING_FILE, ROUTING_CR_FILE } from './routingFiles.js'
import { listFolderDeployments } from './commitChecks.js'
import { readSyncRegistry, getSourceForTarget } from './sync.js'
import { copyToTargets } from './deploymentWrite.js'

export { SHARED_DIR, SHARED_FILE }

const sharedPath = gitopsDir => path.join(gitopsDir, SHARED_FILE)

/** The file's configs from its text: `{ text, configs, errors }`. */
export function parseSharedConfigs(text) {
  let doc
  try {
    doc = yaml.load(text)
  } catch (err) {
    return { text, configs: {}, errors: [`${SHARED_FILE} is not valid YAML: ${err.reason || err.message}`] }
  }
  const errors = checkSharedConfigs(doc)
  return { text, configs: errors.length ? {} : doc.configs, errors }
}

/** The shared configs as they are on disk, or null when the repo has none. */
export async function readSharedConfigs(gitopsDir) {
  let text
  try {
    text = await fs.readFile(sharedPath(gitopsDir), 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    // A file there that cannot be read is the shared configs' problem, as a
    // syntax error is: a deployment using none of them goes on as before.
    return { text: null, configs: {}, errors: [`${SHARED_FILE} cannot be read (${err.code || 'error'})`] }
  }
  return parseSharedConfigs(text)
}

/**
 * Why _shared/ cannot hold the shared configs, or null: it is a folder of
 * the repo's own, with something besides them in it.
 */
export async function sharedDirProblem(gitopsDir) {
  let entries
  try {
    entries = await fs.readdir(path.join(gitopsDir, SHARED_DIR))
  } catch {
    return null
  }
  const own = path.basename(SHARED_FILE)
  // writeWhole's temp files start with `_`, next to the file.
  const others = entries.filter(e => e !== own && !e.startsWith(`_${own}.`))
  return others.length
    ? `${SHARED_DIR}/ is a folder of this repo's (it holds ${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}): rename it to use shared notification configs, which are kept there`
    : null
}

/**
 * Whether `relPath` (in the repo) is under _shared/ while that is the shared
 * configs' folder: nothing else is there, so nothing under it is a folder of
 * the tree, a deployment or a sync target, and nothing can be made there. A
 * repo's own _shared/ (sharedDirProblem) is a folder like any other, and
 * shared configs are refused instead. The one rule for every place that asks.
 */
export async function inSharedDir(gitopsDir, relPath) {
  const first = String(relPath ?? '').split(/[\\/]/).filter(s => s && s !== '.')[0]
  return first === SHARED_DIR && !(await sharedDirProblem(gitopsDir))
}

const parsedRouting = text => {
  try {
    return yaml.load(text)
  } catch {
    return null
  }
}

// Why a routing.yaml's text cannot be read for the shared configs it uses,
// or null. Such a file may use any of them: nothing can tell.
function unreadableReason(text) {
  let doc
  try {
    doc = yaml.load(text)
  } catch (err) {
    return `${ROUTING_FILE} is not valid YAML: ${err.reason || err.message}`
  }
  const isMapDoc = doc !== null && typeof doc === 'object' && !Array.isArray(doc)
  if (!isMapDoc) return `${ROUTING_FILE} is not a map`
  if (doc.configs !== undefined && (doc.configs === null || typeof doc.configs !== 'object' || Array.isArray(doc.configs))) {
    return `${ROUTING_FILE}'s configs is not a map`
  }
  return null
}

/**
 * Every folder deployment with a routing.yaml, and the shared configs each
 * uses. A sync target is listed with the source it is copied from. One whose
 * routing.yaml cannot be read is listed with `unreadable` (why): whether it
 * uses a shared config cannot be told.
 * @returns [{ deployment, text, uses: [name], syncedFrom?, unreadable? }]
 */
export async function routingUsers(gitopsDir) {
  const registry = await readSyncRegistry(gitopsDir).catch(() => ({ syncs: [] }))
  const out = []
  for (const deployment of await listFolderDeployments(gitopsDir)) {
    const source = getSourceForTarget(registry, deployment)
    const synced = source && source !== deployment ? { syncedFrom: source } : {}
    let text
    try {
      ;({ text } = await readRouting(path.join(gitopsDir, deployment)))
    } catch (err) {
      out.push({ deployment, text: null, uses: [], ...synced, unreadable: `${ROUTING_FILE} cannot be read (${err.code || 'error'})` })
      continue
    }
    if (text === null) continue
    const why = unreadableReason(text)
    out.push({ deployment, text, uses: why ? [] : sharedNamesIn(parsedRouting(text)), ...synced, ...(why ? { unreadable: why } : {}) })
  }
  return out
}

/** The deployments whose routing.yaml cannot be read: [{ deployment, error }]. */
export const unreadableOf = users => users.filter(u => u.unreadable).map(u => ({ deployment: u.deployment, error: u.unreadable }))

// A change to the shared configs is refused while any routing.yaml cannot
// be read: it may use the config being changed, and would be left behind.
function refuseUnreadable(users, what) {
  const unreadable = unreadableOf(users)
  if (!unreadable.length) return null
  return { status: 409, body: {
    error: `${what}: the routing.yaml of ${unreadable.map(u => u.deployment).join(', ')} cannot be read, so whether it uses a shared config cannot be told — fix it first`,
    unreadable,
  } }
}

/** Shared config name → [{ deployment, syncedFrom? }] using it. */
export function usageOf(users) {
  const usage = {}
  for (const { deployment, uses, syncedFrom } of users) {
    for (const name of uses) (usage[name] ||= []).push({ deployment, ...(syncedFrom ? { syncedFrom } : {}) })
  }
  return usage
}

export async function sharedUsage(gitopsDir) {
  return usageOf(await routingUsers(gitopsDir))
}

/**
 * The deployments using a shared config whose AlertmanagerConfig is not what
 * their routing.yaml and the shared configs make now (a target: not its
 * source's). Regenerate makes them again.
 */
export async function staleUsers(gitopsDir, users, shared) {
  const stale = new Set()
  // Sources first: a target whose source is behind is behind with it.
  const ordered = [...users.filter(u => !u.syncedFrom), ...users.filter(u => u.syncedFrom)]
  for (const user of ordered) {
    if (!user.uses.length) continue
    const { cr } = await readRouting(path.join(gitopsDir, user.deployment))
    if (user.syncedFrom) {
      const source = await readRouting(path.join(gitopsDir, user.syncedFrom))
      if (stale.has(user.syncedFrom) || source.text !== user.text || source.cr !== cr) stale.add(user.deployment)
      continue
    }
    const built = buildRouting(user.text, shared)
    if (built.errors || built.cr !== cr) stale.add(user.deployment)
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
    if (user.syncedFrom) continue
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
async function copyToSyncTargets(gitopsDir, sources) {
  const registry = await readSyncRegistry(gitopsDir).catch(() => ({ syncs: [] }))
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
export async function writeShared(gitopsDir, text) {
  const dirProblem = await sharedDirProblem(gitopsDir)
  if (dirProblem) return { status: 409, body: { error: dirProblem } }
  const shared = parseSharedConfigs(text)
  if (shared.errors.length) return { status: 400, body: { error: `${SHARED_FILE} has problems`, problems: shared.errors } }

  const all = await routingUsers(gitopsDir)
  const unreadable = refuseUnreadable(all, 'Not written')
  if (unreadable) return unreadable
  const users = all.filter(u => u.uses.length)
  const removed = {}
  for (const user of users) {
    for (const name of user.uses) {
      if (!Object.hasOwn(shared.configs, name)) (removed[name] ||= []).push(user.deployment)
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
  const notWritten = await writeAll([{ abs: sharedPath(gitopsDir), content: text, rel: SHARED_FILE }, ...files])
  if (notWritten) return notWritten
  const syncFailed = await copyToSyncTargets(gitopsDir, sources)
  return { status: 200, body: { ok: true, written: [SHARED_FILE, ...files.map(f => f.rel)], ...(syncFailed.length ? { syncFailed } : {}) } }
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
 * replaces, or of the last one. Null when the text has no configs map with
 * a config in it to follow: the caller writes the file anew.
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
  const current = await readSharedConfigs(gitopsDir)
  if (!current) return { status: 404, body: { error: 'There are no shared notification configs' } }
  if (current.errors.length) return { status: 400, body: { error: `${SHARED_FILE} has problems: fix it first`, problems: current.errors } }
  if (!Object.hasOwn(current.configs, from)) return { status: 404, body: { error: `There is no shared config named ${from}` } }
  const why = typeof to === 'string' ? configNameProblem(to) : 'the new name must be text'
  if (why) return { status: 400, body: { error: `${to}: ${why}` } }
  if (to === from) return { status: 400, body: { error: 'The new name is the same' } }
  if (Object.hasOwn(current.configs, to)) return { status: 409, body: { error: `${to} is already a shared config` } }

  const all = await routingUsers(gitopsDir)
  const unreadable = refuseUnreadable(all, 'Not renamed')
  if (unreadable) return unreadable
  const users = all.filter(u => u.uses.includes(from))
  const clash = users.filter(u => !u.syncedFrom && Object.hasOwn(parsedRouting(u.text)?.configs || {}, to)).map(u => u.deployment)
  if (clash.length) return { status: 409, body: { error: `${clash.join(', ')} already ${clash.length > 1 ? 'have' : 'has'} a config named ${to}`, clash } }

  const text = renameConfigInText(current.text, from, to)
  const shared = parseSharedConfigs(text)
  const { files, sources, failed } = planUsers(gitopsDir, users, shared, u => renameConfigInText(u.text, from, to))
  if (failed.length) {
    return { status: 400, body: { error: `Not renamed: the routing of ${failed.map(f => f.deployment).join(', ')} cannot be made`, failed } }
  }
  const notWritten = await writeAll([{ abs: sharedPath(gitopsDir), content: text, rel: SHARED_FILE }, ...files])
  if (notWritten) return notWritten
  const syncFailed = await copyToSyncTargets(gitopsDir, sources)
  return { status: 200, body: { ok: true, written: [SHARED_FILE, ...files.map(f => f.rel)], ...(syncFailed.length ? { syncFailed } : {}) } }
}
