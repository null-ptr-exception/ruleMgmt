import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { isCommonChartPath } from '../../src/utils/reservedNames.js'
import { isRepoPath } from './safePath.js'

const SYNC_FILE = 'sync.yaml'

// Serializes registry read-modify-write sequences. Concurrent POST/DELETE
// /api/v2/sync (or an eager-sync save racing either) would otherwise both
// read the same registry state and the second write would silently drop the
// first one's change. A per-directory promise chain is sufficient here: the
// app runs as a per-user JupyterHub singleuser server, so there is exactly
// one Node process per repo — no cross-process locking needed.
const registryLocks = new Map()
// Which workspaces' locks the running request already holds. The lock is not
// re-entrant: taking it again from inside would wait on itself for good, and
// every later commit and save behind it. That is refused at once instead.
const held = new AsyncLocalStorage()

export function withSyncRegistryLock(gitopsDir, fn) {
  if (held.getStore()?.includes(gitopsDir)) {
    return Promise.reject(new Error('the commit lock is already held by this request: it cannot be taken again inside it'))
  }
  const run = () => held.run([...(held.getStore() || []), gitopsDir], fn)
  const prev = registryLocks.get(gitopsDir) || Promise.resolve()
  const next = prev.then(run, run)
  registryLocks.set(gitopsDir, next.catch(() => {}))
  return next
}

// Longest a write may hold the lock: past it the lock is let go, so a
// handler that never answers cannot stop every commit and save behind it.
const HOLD_LIMIT_MS = 60000

/**
 * Express middleware: a request that writes files holds the same lock as a
 * commit until its response is sent, so a commit never adds or checks a
 * chart half-written (a save writes rules, then templates, then the schema).
 * Reads are not held, nor OPTIONS. It is let go when the handler answers,
 * whether or not the client is still there, or after HOLD_LIMIT_MS. The
 * lock is not re-entrant: a handler behind this that takes
 * withSyncRegistryLock itself gets an error at once, not a wait on itself.
 * The deployments and sync routers take it inside their handlers instead.
 */
export function holdSyncRegistryLock(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  withSyncRegistryLock(req.gitopsDir, () => new Promise(resolve => {
    let done = false
    const release = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(release, HOLD_LIMIT_MS)
    // Held until the handler answers (res.end), not until the socket says
    // so: a client that left fires 'close' too early — while the handler is
    // still writing — or, if it left while waiting here, never again, and
    // on a destroyed socket 'finish' never comes.
    const end = res.end
    res.end = function (...args) {
      res.end = end
      try { return end.apply(this, args) } finally { release() }
    }
    next()
  })).catch(next)
}

export async function readSyncRegistry(gitopsDir) {
  let raw
  try {
    raw = await fs.readFile(path.join(gitopsDir, SYNC_FILE), 'utf-8')
  } catch (err) {
    // Only a missing registry means "no syncs yet". Parse, permission, and
    // I/O errors must surface — treating a malformed sync.yaml as empty
    // would let the next write silently discard every existing sync link.
    if (err?.code === 'ENOENT') return { syncs: [] }
    throw err
  }
  const data = yaml.load(raw) || {}
  // An entry without a source or a targets list (a hand edit) is skipped
  // with a warning, or every deployment save fails on it (#180). The next
  // change to sync.yaml writes the registry without it.
  // Only the source and its string targets are kept: the rest of a hand
  // edit (a target that is not a path, an extra key, a YAML alias that
  // refers to itself) would otherwise break whatever logs, copies or
  // returns the entry. The entry itself is logged as is, never serialized.
  const syncs = []
  for (const s of Array.isArray(data.syncs) ? data.syncs : []) {
    if (!(s && typeof s.source === 'string' && Array.isArray(s.targets))) {
      console.warn(`${SYNC_FILE}: skipping an entry that is not { source, targets: [...] } (the next sync change drops it):`, s)
      continue
    }
    const targets = s.targets.filter(t => typeof t === 'string')
    if (targets.length < s.targets.length) {
      console.warn(`${SYNC_FILE}: ${s.source}: skipping ${s.targets.length - targets.length} target(s) that are not a path (the next sync change drops them)`)
    }
    // As every route spells a path, so `a/src/` and `./a/src` are `a/src`.
    syncs.push({ source: normalizeSyncPath(s.source), targets: targets.map(normalizeSyncPath) })
  }
  return { syncs }
}

export async function writeSyncRegistry(gitopsDir, registry) {
  // Temp file + rename so a crash mid-write can't leave sync.yaml
  // truncated — readSyncRegistry treats a corrupt registry as a hard
  // error (deliberately), which would take the whole sync API down.
  const file = path.join(gitopsDir, SYNC_FILE)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, yaml.dump(registry, { lineWidth: -1 }), 'utf-8')
  await fs.rename(tmp, file)
}

export function findSourceEntry(registry, source) {
  return registry.syncs.find(s => s.source === source) || null
}

export function findEntryForTarget(registry, target) {
  return registry.syncs.find(s => s.targets.includes(target)) || null
}

export function getTargetsForSource(registry, source) {
  return findSourceEntry(registry, source)?.targets || []
}

export function getSourceForTarget(registry, target) {
  return findEntryForTarget(registry, target)?.source || null
}

// A path is a "source" only once it has 1+ targets — an entry that's been
// unlinked down to zero targets is pruned, so it demotes back to independent.
export function isSource(registry, candidate) {
  const entry = findSourceEntry(registry, candidate)
  return !!entry && entry.targets.length > 0
}

export function isTarget(registry, candidate) {
  return !!findEntryForTarget(registry, candidate)
}

// Canonical form used for both validation and registry storage/comparison —
// callers must normalize a candidate with this *before* comparing it against
// existing registry entries (applySync/applyUnlink do strict string
// equality), otherwise 'cpu/prod' and 'cpu/./prod' would be treated as two
// different deployments and slip past role-exclusivity checks.
// Always POSIX semantics, regardless of host OS. On win32, path.normalize
// rewrites '/' to '\', which (a) stores non-portable '\'-separated paths in
// sync.yaml — a file that gets committed to the gitops repo and read on
// Linux — and (b) lets 'charts\evil' pass the charts-dir check below
// (split('/') can't see the '\' separator) while path.join still resolves
// it into the charts directory. Backslashes are folded into '/' first so
// both spellings canonicalize identically.
export function normalizeSyncPath(candidate) {
  if (typeof candidate !== 'string') return candidate
  return path.posix.normalize(candidate.replaceAll('\\', '/')).replace(/\/+$/, '')
}

// Reject traversal above the root, absolute paths, and anything rooted at
// the charts directory — sync must only ever point at deployment folders.
// See #33/#34 for the two prior path-traversal bugs this codebase has
// shipped. Candidates are normalized first so equivalent variants like
// 'cpu/./prod', 'cpu//prod', and 'cpu/prod/' can't slip past the checks
// below under a different spelling than what ends up on disk.
export function isSafeSyncPath(candidate, chartsDirName) {
  if (!candidate || typeof candidate !== 'string') return false
  // No `..`, no folder starting with a dot, no backslash or NUL (safePath.js).
  if (!isRepoPath(candidate)) return false
  if (path.isAbsolute(candidate)) return false
  const normalized = normalizeSyncPath(candidate)
  if (normalized === '.' || normalized === '' || normalized === '..' || normalized.startsWith('../')) return false
  const firstSegment = normalized.split('/')[0]
  if (firstSegment === chartsDirName) return false
  return true
}

// Core mutation: point `target` at `source`. Mutates `registry` in place.
// Enforces role exclusivity (see Issue #39 — flat tree, no chains) and
// switches `target` off whatever source it was previously following.
export function applySync(registry, source, target) {
  if (source === target) {
    return { ok: false, error: 'A deployment cannot sync to itself' }
  }
  if (isSource(registry, target)) {
    return { ok: false, error: `${target} is itself a sync source and cannot become a target` }
  }
  if (isTarget(registry, source)) {
    return { ok: false, error: `${source} is currently a target and cannot become a source` }
  }

  const existing = findEntryForTarget(registry, target)
  if (existing && existing.source !== source) {
    existing.targets = existing.targets.filter(t => t !== target)
    if (existing.targets.length === 0) {
      registry.syncs = registry.syncs.filter(s => s !== existing)
    }
  }

  let entry = findSourceEntry(registry, source)
  if (!entry) {
    entry = { source, targets: [] }
    registry.syncs.push(entry)
  }
  if (!entry.targets.includes(target)) {
    entry.targets.push(target)
  }
  return { ok: true }
}

// Remove `target` from whichever source it's under. If that source is left
// with zero targets, drop the entry entirely — this is what lets a former
// source be folded into a different tree later (see "Merging two trees").
export function applyUnlink(registry, target) {
  if (!findEntryForTarget(registry, target)) {
    return { ok: false, error: `${target} is not currently synced` }
  }
  // Every entry that lists it: a hand edit can list a target twice, and the
  // second one would point at a deployment that is gone.
  for (const entry of registry.syncs) entry.targets = entry.targets.filter(t => t !== target)
  registry.syncs = registry.syncs.filter(s => s.targets.length > 0)
  return { ok: true }
}

/**
 * A folder right inside a `_common/` with a Chart.yaml: what the deployments
 * beside the `_common/` inherit from (#75). It is a chart, not a deployment.
 */
export async function isCommonChartDir(absDir) {
  if (!isCommonChartPath(absDir)) return false
  return fs.access(path.join(absDir, 'Chart.yaml')).then(() => true, () => false)
}

// Same recognition rule used by the folder tree (Chart.yaml with a
// dependency + values.yaml) — a sync source/target must resolve to an
// actual deployment, not an arbitrary directory. A `_common` chart is not
// one, whatever it holds: it is not synced, listed or checked as one.
export async function isDeploymentDir(absDir) {
  if (isCommonChartPath(absDir)) return false
  let chartData
  try {
    const raw = await fs.readFile(path.join(absDir, 'Chart.yaml'), 'utf-8')
    chartData = yaml.load(raw) || {}
  } catch {
    return false
  }
  const hasDeps = Array.isArray(chartData.dependencies) && chartData.dependencies.length > 0
  if (!hasDeps) return false
  try {
    await fs.access(path.join(absDir, 'values.yaml'))
    return true
  } catch {
    return false
  }
}
