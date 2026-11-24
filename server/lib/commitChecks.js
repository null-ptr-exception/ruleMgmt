/**
 * What a commit has to clear outside charts/ (#179): every folder
 * deployment's notification routing, the sync registry, and the Template
 * each deployment renders (there, and at the version it asks for).
 *
 *   deploymentCommitBlockers  { findings, routingProblems } for a commit
 *   regenerateRouting         make every resource that is behind again
 *
 * A finding blocks the commit and names the deployment or sync.yaml entry.
 * `regenerable` on it says Regenerate fixes it. A routing.yaml with errors
 * does not block: it is listed in `routingProblems`, to fix on its Routing
 * page. Only AlertForge's commit runs this; a commit made with git directly
 * is left to CI.
 */

import path from 'path'
import { readRouting, buildRouting, writeRouting, checkedRouting, copyRouting } from './routingFiles.js'
import { isDeploymentDir, isSafeSyncPath, readSyncRegistry, withSyncRegistryLock, getSourceForTarget, getTargetsForSource } from './sync.js'
import { readSharedConfigs } from './sharedConfigs.js'
import { listDeploymentPaths, walkDeployments } from './deploymentWalk.js'
import { resolveStack } from './stack.js'
import { insideReal } from './safePath.js'
import { templateFindings } from './commit/template.js'
import { valuesFindings } from './commit/values.js'
import { syncRegistryFindings, syncTargetFindings, SYNC_FILE } from './commit/sync.js'
import { routingFindings, sharedFileFindings, sameRoutingAs } from './commit/routing.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * Every folder deployment, relative to the gitops repo, sorted — one inside
 * another's folder too, as the tree shows it (the one walk, deploymentWalk).
 */
export async function listFolderDeployments(gitopsDir) {
  return listDeploymentPaths(gitopsDir)
}

export async function deploymentCommitBlockers(gitopsDir) {
  const sync = await syncRegistryFindings(gitopsDir)
  const findings = [...sync.findings]
  const routingProblems = []
  // Never blocking: what a routing's configs will do that is worth saying.
  const routingWarnings = []
  // Never blocking either: rows the row identity label cannot tell apart.
  const valueWarnings = []
  const registry = sync.readable ? await readSyncRegistry(gitopsDir) : { syncs: [] }
  const walked = await walkDeployments(gitopsDir)
  const deployments = walked.filter(d => d.kind === 'deployment').map(d => d.path)
  // A folder that cannot be read: its deployments are not checked. Listed,
  // as a routing.yaml's own problems are, not a reason to refuse a commit
  // of everything else.
  const unreadable = walked.filter(d => d.kind === 'unreadable').map(d => ({ path: d.path || '.', error: d.error }))
  // A routing.yaml using a shared config is made with it (#123): a change to
  // the shared file leaves every resource made from it behind.
  const shared = await readSharedConfigs(gitopsDir)
  // Who uses a shared config the shared file does not give: a resource made
  // now would have no one to send to. Blocks, unlike a routing.yaml's own
  // problems: the file was changed — removed, broken, a config taken out —
  // under deployments that were fine.
  const unresolved = []
  // What Regenerate would make: a source behind makes its targets again too.
  const fixes = new Set()
  const brokenSources = new Set()
  for (const dep of deployments) {
    // Read once for both.
    const stack = await resolveStack(gitopsDir, path.join(gitopsDir, dep))
    findings.push(...await templateFindings(gitopsDir, dep, stack))
    const values = await valuesFindings(gitopsDir, dep, stack)
    findings.push(...values.findings)
    if (values.warnings.length) valueWarnings.push({ deployment: dep, warnings: values.warnings })
    // A target is held to its source below. One listed as its own target is
    // no target (sync.yaml is refused for it too): its routing is checked.
    const followed = getSourceForTarget(registry, dep)
    if (followed && followed !== dep) continue

    const routing = await routingFindings(gitopsDir, dep, { shared, registry })
    findings.push(...routing.findings)
    routingProblems.push(...routing.problems)
    routingWarnings.push(...routing.warnings)
    if (routing.unresolved) unresolved.push(dep)
    if (routing.broken) brokenSources.add(dep)
    for (const f of routing.fixes) fixes.add(f)
  }

  const sharedFile = sharedFileFindings(shared, unresolved)
  routingWarnings.push(...sharedFile.warnings)
  findings.push(...sharedFile.findings)
  routingProblems.push(...sharedFile.problems)

  const targets = await syncTargetFindings(gitopsDir, deployments, registry, brokenSources)
  findings.push(...targets.findings)
  for (const f of targets.fixes) fixes.add(f)
  return { findings, routingProblems, routingWarnings, valueWarnings, unreadable, regenerable: fixes.size, readable: sync.readable }
}

/**
 * Every resource that is behind its routing.yaml is made again from it (the
 * text is left as it is, comments and all); then every target whose routing
 * is not its source's gets its source's. Each one on its own: one that
 * fails is listed, the rest go ahead. Writes files only, commits nothing.
 * @returns { regenerated: [path], failed: [{ deployment, error }] }
 */
export async function regenerateRouting(gitopsDir) {
  return withSyncRegistryLock(gitopsDir, async () => {
    const regenerated = []
    const failed = []
    const { findings, readable } = await deploymentCommitBlockers(gitopsDir)
    if (!readable) return { regenerated, failed: [{ deployment: SYNC_FILE, error: 'not valid YAML: fix it first' }] }
    const registry = await readSyncRegistry(gitopsDir)
    const shared = await readSharedConfigs(gitopsDir)

    for (const f of findings.filter(f => f.kind === 'routing-stale')) {
      try {
        const dir = path.join(gitopsDir, f.deployment)
        const { text } = await readRouting(dir)
        const built = buildRouting(text, shared)
        if (built.errors) throw new Error(built.errors.join('; '))
        await writeRouting(dir, { text, cr: built.cr })
        regenerated.push(f.deployment)
      } catch (err) {
        failed.push({ deployment: f.deployment, error: err.code || err.message })
      }
    }

    // A target is copied from its source, after the source is made again.
    const targets = new Set(findings.filter(f => f.kind === 'routing-target-differs' && f.regenerable).map(f => f.deployment))
    for (const source of regenerated) for (const t of getTargetsForSource(registry, source)) targets.add(t)
    for (const target of [...targets].sort()) {
      const source = getSourceForTarget(registry, target)
      try {
        if (!source) throw new Error('no source')
        // sync.yaml may be hand-edited or pulled: a target is written only
        // where sync itself would write it — a safe path inside the
        // workspace, holding a deployment (as copyToTargets checks).
        if (!isSafeSyncPath(target, chartsDirName())) throw new Error('not a path sync may write to')
        if (!(await insideReal(gitopsDir, target))) throw new Error('not a path sync may write to: it leads outside the repo')
        if (!(await isDeploymentDir(path.join(gitopsDir, target)))) throw new Error('not a deployment on disk')
        const routing = await checkedRouting(path.join(gitopsDir, source), shared)
        if (routing.errors) throw new Error(`its source ${source} has routing problems`)
        if (await sameRoutingAs(gitopsDir, target, routing)) continue
        await copyRouting(path.join(gitopsDir, source), path.join(gitopsDir, target), routing)
        regenerated.push(target)
      } catch (err) {
        failed.push({ deployment: target, error: err.code || err.message })
      }
    }
    return { regenerated, failed }
  })
}
