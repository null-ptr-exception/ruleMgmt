/** The commit check of sync.yaml, entry by entry (#179). */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { isDeploymentDir, normalizeSyncPath, getSourceForTarget } from '../sync.js'
import { sameRouting } from './routing.js'

export const SYNC_FILE = 'sync.yaml'

/**
 * sync.yaml as written, entry by entry: what readSyncRegistry would skip,
 * and what it reads but cannot be right — a chain, a target with two
 * sources, a path that is not a deployment.
 */
export async function syncRegistryFindings(gitopsDir) {
  let raw
  try {
    raw = await fs.readFile(path.join(gitopsDir, SYNC_FILE), 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return { findings: [], readable: true }
    throw err
  }
  const finding = (where, why) => ({ severity: 'commit', kind: 'sync-registry', description: `${SYNC_FILE} ${where}: ${why}` })
  let data
  try {
    data = yaml.load(raw) || {}
  } catch (err) {
    // Nothing else can be read from it: the sync links are not known.
    return { findings: [finding('', `is not valid YAML (${err.reason || err.message})`)], readable: false }
  }
  if (data.syncs === undefined || data.syncs === null) return { findings: [], readable: true }
  if (!Array.isArray(data.syncs)) return { findings: [finding('syncs', 'is not a list')], readable: true }

  const findings = []
  const sourcesOf = new Map() // target → the entries that list it
  const entryOf = new Map()   // source → its first entry's index
  for (const [i, s] of data.syncs.entries()) {
    const where = `syncs[${i}]`
    if (!s || typeof s.source !== 'string' || !Array.isArray(s.targets)) {
      findings.push(finding(where, 'is not { source, targets: [...] }'))
      continue
    }
    const source = normalizeSyncPath(s.source)
    if (entryOf.has(source)) findings.push(finding(where, `${source} is listed as a source again (first in syncs[${entryOf.get(source)}])`))
    else entryOf.set(source, i)
    if (!(await isDeploymentDir(path.join(gitopsDir, source)))) findings.push(finding(where, `source ${source} is not a deployment`))
    for (const t of s.targets) {
      if (typeof t !== 'string') {
        findings.push(finding(where, `a target is not a path (${JSON.stringify(t)})`))
        continue
      }
      const target = normalizeSyncPath(t)
      if (target === source) findings.push(finding(where, `${source} is listed as its own target`))
      else if (!(await isDeploymentDir(path.join(gitopsDir, target)))) findings.push(finding(where, `target ${target} is not a deployment`))
      if (!sourcesOf.has(target)) sourcesOf.set(target, [])
      sourcesOf.get(target).push(source)
    }
  }
  const hasTargets = new Set(data.syncs
    .filter(s => s && typeof s.source === 'string' && Array.isArray(s.targets) && s.targets.length)
    .map(s => normalizeSyncPath(s.source)))
  for (const [target, from] of sourcesOf) {
    const distinct = [...new Set(from)].filter(s => s !== target)
    if (distinct.length > 1) findings.push(finding('', `${target} follows two sources: ${distinct.join(' and ')}`))
    if (distinct.length && hasTargets.has(target)) findings.push(finding('', `${target} follows ${distinct[0]} and is a source itself: sync does not chain`))
  }
  return { findings, readable: true }
}

/**
 * Every sync target, as a commit checks it (#179): held to its source's
 * files, not its own routing.yaml. One whose routing is not its source's
 * blocks; Regenerate copies it again (`fixes`) unless the source's own
 * routing.yaml has problems (`brokenSources`, from routingFindings).
 * `deployments` in the order the walk gave them; `registry` as read.
 * @returns { findings, fixes }
 */
export async function syncTargetFindings(gitopsDir, deployments, registry, brokenSources) {
  const out = { findings: [], fixes: [] }
  for (const dep of deployments) {
    const source = getSourceForTarget(registry, dep)
    if (!source || source === dep || !(await isDeploymentDir(path.join(gitopsDir, source)))) continue
    if (await sameRouting(gitopsDir, source, dep)) continue
    if (brokenSources.has(source)) {
      out.findings.push({ severity: 'commit', kind: 'routing-target-differs', deployment: dep, regenerable: false,
        description: `${dep}: its routing is not its source's (${source}), whose routing.yaml has problems — fix the source first` })
    } else {
      out.findings.push({ severity: 'commit', kind: 'routing-target-differs', deployment: dep, regenerable: true,
        description: `${dep}: its routing is not its source's (${source}) — use Regenerate to copy it again` })
      out.fixes.push(dep)
    }
  }
  return out
}
