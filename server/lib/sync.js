import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const SYNC_FILE = 'sync.yaml'

// Serializes registry read-modify-write sequences. Concurrent POST/DELETE
// /api/v2/sync (or an eager-sync save racing either) would otherwise both
// read the same registry state and the second write would silently drop the
// first one's change. A per-directory promise chain is sufficient here: the
// app runs as a per-user JupyterHub singleuser server, so there is exactly
// one Node process per repo — no cross-process locking needed.
const registryLocks = new Map()

export function withSyncRegistryLock(gitopsDir, fn) {
  const prev = registryLocks.get(gitopsDir) || Promise.resolve()
  const next = prev.then(fn, fn)
  registryLocks.set(gitopsDir, next.catch(() => {}))
  return next
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
  return { syncs: Array.isArray(data.syncs) ? data.syncs : [] }
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
export function normalizeSyncPath(candidate) {
  if (typeof candidate !== 'string') return candidate
  return path.normalize(candidate).replace(/\/+$/, '')
}

// Reject traversal above the root, absolute paths, and anything rooted at
// the charts directory — sync must only ever point at deployment folders.
// See #33/#34 for the two prior path-traversal bugs this codebase has
// shipped. Candidates are normalized first so equivalent variants like
// 'cpu/./prod', 'cpu//prod', and 'cpu/prod/' can't slip past the checks
// below under a different spelling than what ends up on disk.
export function isSafeSyncPath(candidate, chartsDirName) {
  if (!candidate || typeof candidate !== 'string') return false
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
  const entry = findEntryForTarget(registry, target)
  if (!entry) {
    return { ok: false, error: `${target} is not currently synced` }
  }
  entry.targets = entry.targets.filter(t => t !== target)
  if (entry.targets.length === 0) {
    registry.syncs = registry.syncs.filter(s => s !== entry)
  }
  return { ok: true }
}

// Same recognition rule used by the folder tree (Chart.yaml with a
// dependency + values.yaml) — a sync source/target must resolve to an
// actual deployment, not an arbitrary directory.
export async function isDeploymentDir(absDir) {
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
