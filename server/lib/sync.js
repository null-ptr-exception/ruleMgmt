import path from 'path'
import yaml from 'js-yaml'
import { pathProblem } from '../repo/paths.js'
import { normalizeSyncPath } from '../repo/sync.js'

/** sync.yaml's text for `registry` ({ syncs }), as the writer writes it. */
export const registryText = registry => yaml.dump(registry, { lineWidth: -1 })

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
// equality): sync.yaml's reader (repo/sync.js) stores every path in it.
export { normalizeSyncPath } from '../repo/sync.js'

// Reject traversal above the root, absolute paths, and anything rooted at
// the charts directory — sync must only ever point at deployment folders.
// See #33/#34 for the two prior path-traversal bugs this codebase has
// shipped. Candidates are normalized first so equivalent variants like
// 'cpu/./prod', 'cpu//prod', and 'cpu/prod/' can't slip past the checks
// below under a different spelling than what ends up on disk.
export function isSafeSyncPath(candidate, chartsDirName) {
  if (!candidate || typeof candidate !== 'string') return false
  if (path.isAbsolute(candidate)) return false
  // As sync.yaml may spell it (`apps\\prod`, `a/./b`), then checked: no
  // `..`, no folder starting with a dot, no NUL (paths.js).
  const normalized = normalizeSyncPath(candidate)
  if (pathProblem(normalized, 'create')) return false
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
// source become a target of another source later.
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
