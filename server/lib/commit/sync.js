/** The commit check of sync.yaml, entry by entry (#179). */

import { getSourceForTarget } from '../sync.js'
import { sameRouting } from './routing.js'
import { loadSync, SYNC_FILE } from '../../repo/sync.js'
import { isDeployment } from '../../repo/walk.js'
import { decide } from '../../repo/policy.js'
import { fact, factsOf } from './facts.js'

export { SYNC_FILE }

/**
 * sync.yaml as Commit sees it (repo/sync.js): each fact about a row its
 * table refuses, as a finding naming the row; one that cannot be read is
 * one finding, and no sync relation is known (`readable: false`).
 * `policy`: the table (Commit's, or check-repo's); `facts` is every fact
 * with what the table does with it (commitChecks.js).
 * @returns { findings, readable, registry, facts }
 */
export async function syncRegistryFindings(repo, { policy = 'commit' } = {}) {
  const loaded = await loadSync(repo)
  if (loaded.state === 'unreadable') {
    const description = `${SYNC_FILE} cannot be read (${loaded.why})`
    return { findings: [{ severity: 'commit', kind: 'sync-registry', description }], readable: false, registry: { syncs: [] },
      // No finding of its own: what is behind it was not checked.
      facts: [fact('refuse', { code: 'sync.unreadable', file: SYNC_FILE, message: description }, SYNC_FILE, { notChecked: true })] }
  }
  if (loaded.state === 'invalid') {
    const d = decide(loaded.findings, policy)
    return { findings: decide(loaded.findings, 'commit').refuse.map(f => ({ severity: 'commit', kind: 'sync-registry', description: f.message })), readable: false, registry: { syncs: [] },
      facts: factsOf(d, SYNC_FILE) }
  }
  const d = decide(loaded.findings, policy)
  return { findings: d.refuse.map(f => ({ severity: 'commit', kind: 'sync-registry', description: f.message })), readable: true, registry: loaded.value,
    facts: factsOf(d, SYNC_FILE) }
}

/**
 * Every sync target, as a commit checks it (#179): held to its source's
 * files, not its own routing.yaml. One whose routing is not its source's
 * blocks; Regenerate copies it again (`fixes`) unless the source's own
 * routing.yaml has problems (`brokenSources`, from routingFindings).
 * `deployments` in the order the walk gave them; `registry` as read.
 * Refused by every table: a target is a copy of its source.
 * @returns { findings, fixes, facts }
 */
export async function syncTargetFindings(repo, deployments, registry, brokenSources) {
  const gitopsDir = repo.root
  const out = { findings: [], fixes: [], facts: [] }
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
    out.facts.push(fact('refuse', { code: 'routing.target-differs', file: `${dep}/routing.yaml`, message: `its routing is not its source's (${source})${brokenSources.has(source) ? ', whose routing.yaml has problems — fix the source first' : ' — save the source again in AlertForge, or use Regenerate'}` }, dep))
  }
  return out
}
