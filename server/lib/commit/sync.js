/** The commit check of sync.yaml, entry by entry (#179). */

import { getSourceForTarget } from '../sync.js'
import { sameRouting } from './routing.js'
import { loadSync, SYNC_FILE } from '../../repo/sync.js'
import { isDeployment } from '../../repo/walk.js'
import { decide } from '../../repo/policy.js'

export { SYNC_FILE }

/**
 * sync.yaml as Commit sees it (repo/sync.js): each fact about a row its
 * table refuses, as a finding naming the row; one that cannot be read is
 * one finding, and no sync relation is known (`readable: false`).
 * @returns { findings, readable, registry }
 */
export async function syncRegistryFindings(repo) {
  const loaded = await loadSync(repo)
  if (loaded.state === 'unreadable') {
    return { findings: [{ severity: 'commit', kind: 'sync-registry', description: `${SYNC_FILE} cannot be read (${loaded.why})` }], readable: false, registry: { syncs: [] } }
  }
  if (loaded.state === 'invalid') {
    return { findings: decide(loaded.findings, 'commit').refuse.map(f => ({ severity: 'commit', kind: 'sync-registry', description: f.message })), readable: false, registry: { syncs: [] } }
  }
  const { refuse } = decide(loaded.findings, 'commit')
  return { findings: refuse.map(f => ({ severity: 'commit', kind: 'sync-registry', description: f.message })), readable: true, registry: loaded.value }
}

/**
 * Every sync target, as a commit checks it (#179): held to its source's
 * files, not its own routing.yaml. One whose routing is not its source's
 * blocks; Regenerate copies it again (`fixes`) unless the source's own
 * routing.yaml has problems (`brokenSources`, from routingFindings).
 * `deployments` in the order the walk gave them; `registry` as read.
 * @returns { findings, fixes }
 */
export async function syncTargetFindings(repo, deployments, registry, brokenSources) {
  const gitopsDir = repo.root
  const out = { findings: [], fixes: [] }
  for (const dep of deployments) {
    const source = getSourceForTarget(registry, dep)
    if (!source || source === dep || !(await isDeployment(repo, source))) continue
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
