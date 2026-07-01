import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const SYNC_FILE = 'sync.yaml'

export async function readSyncRegistry(gitopsDir) {
  try {
    const raw = await fs.readFile(path.join(gitopsDir, SYNC_FILE), 'utf-8')
    const data = yaml.load(raw) || {}
    return { syncs: Array.isArray(data.syncs) ? data.syncs : [] }
  } catch {
    return { syncs: [] }
  }
}

export async function writeSyncRegistry(gitopsDir, registry) {
  await fs.writeFile(path.join(gitopsDir, SYNC_FILE), yaml.dump(registry, { lineWidth: -1 }), 'utf-8')
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

// Reject '..', absolute paths, and anything rooted at the charts directory —
// sync must only ever point at deployment folders. See #33/#34 for the two
// prior path-traversal bugs this codebase has shipped.
export function isSafeSyncPath(candidate, chartsDirName) {
  if (!candidate || typeof candidate !== 'string') return false
  if (candidate.includes('..')) return false
  if (path.isAbsolute(candidate)) return false
  const firstSegment = candidate.split('/')[0]
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
