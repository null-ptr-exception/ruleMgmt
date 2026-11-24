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
import { readRouting, buildRouting, writeRouting, checkedRouting, copyRouting, ROUTING_CR_FILE } from './routingFiles.js'
import { isDeploymentDir, isSafeSyncPath, readSyncRegistry, withSyncRegistryLock, getSourceForTarget, getTargetsForSource } from './sync.js'
import { readSharedConfigs, SHARED_FILE } from './sharedConfigs.js'
import { sharedRefProblems } from '../../src/utils/routingGenerator.js'
import { listDeploymentPaths, walkDeployments } from './deploymentWalk.js'
import { resolveStack } from './stack.js'
import { valuesWarnings } from './deploymentWrite.js'
import { parseIfThere, UnreadableError } from './readIfThere.js'
import { insideReal } from './safePath.js'
import { loadValues } from '../../src/utils/valuesText.js'
import { templateProblem } from './commit/template.js'
import { stackNulls } from './commit/values.js'
import { syncRegistryFindings, SYNC_FILE } from './commit/sync.js'
import { parsedOrNull, sameRouting, sameRoutingAs } from './commit/routing.js'

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
    const template = await templateProblem(gitopsDir, dep, stack)
    if (template) findings.push({ severity: 'commit', deployment: dep, ...template })
    const nulls = stackNulls(stack)
    if (nulls.length) findings.push({ severity: 'commit', kind: 'values-null', deployment: dep, regenerable: false, description: `${dep}: ${nulls.join('; ')}` })
    // A values.yaml that cannot be read, or is not YAML, renders nothing:
    // said as a stack says it for a deployment on one, not passed over.
    let valuesText
    try {
      valuesText = await parseIfThere(path.join(gitopsDir, dep, 'values.yaml'), text => { loadValues(text); return text })
    } catch (err) {
      if (!stack.problems.some(p => p.kind === 'values-unreadable')) {
        findings.push({ severity: 'commit', kind: 'values-unreadable', deployment: dep, regenerable: false,
          description: `${dep}: values.yaml cannot be read (${err.why || err.message}), so Helm cannot render it` })
      }
      valuesText = null
    }
    // A Template that cannot be read is the chart check's finding
    // (chart-unreadable): this deployment's warnings wait for it.
    const repeats = valuesText === null ? [] : await valuesWarnings(gitopsDir, path.join(gitopsDir, dep), valuesText, { stack })
      .catch(err => { if (err instanceof UnreadableError) return []; throw err })
    if (repeats.length) valueWarnings.push({ deployment: dep, warnings: repeats })
    // A target is held to its source below. One listed as its own target is
    // no target (sync.yaml is refused for it too): its routing is checked.
    const followed = getSourceForTarget(registry, dep)
    if (followed && followed !== dep) continue

    const { text, cr } = await readRouting(path.join(gitopsDir, dep))
    if (text === null) {
      if (cr !== null) {
        findings.push({ severity: 'commit', kind: 'routing-orphaned', deployment: dep,
          description: `${dep}: ${ROUTING_CR_FILE} is there without a routing.yaml — remove it, or put routing.yaml back` })
      }
      continue
    }
    const refs = sharedRefProblems(parsedOrNull(text), shared)
    if (refs.length) {
      unresolved.push(dep)
      findings.push({ severity: 'commit', kind: 'routing-shared-unresolved', deployment: dep, regenerable: false,
        description: `${dep}: ${refs.join('; ')}` })
      continue
    }
    const built = buildRouting(text, shared)
    if (built.errors) {
      routingProblems.push({ deployment: dep, errors: built.errors })
      brokenSources.add(dep)
      continue
    }
    // A synced target is its source's copy: it says the same.
    if (built.warnings.length) {
      for (const d of [dep, ...getTargetsForSource(registry, dep).filter(t => t !== dep)]) routingWarnings.push({ deployment: d, warnings: built.warnings })
    }
    if (built.cr !== cr) {
      findings.push({ severity: 'commit', kind: 'routing-stale', deployment: dep, regenerable: true,
        description: `${dep}: its AlertmanagerConfig is behind its routing.yaml, the shared notification configs it uses or the site's object labels — use Regenerate` })
      fixes.add(dep)
      for (const t of getTargetsForSource(registry, dep)) fixes.add(t)
    }
  }

  // The shared file itself: blocks while it is used, else only listed.
  if (shared?.warnings?.length) routingWarnings.push({ deployment: SHARED_FILE, warnings: shared.warnings })
  if (shared?.errors.length) {
    if (unresolved.length) {
      findings.push({ severity: 'commit', kind: 'routing-shared-broken', deployment: SHARED_FILE, regenerable: false,
        description: `${SHARED_FILE} has problems and is used by ${unresolved.join(', ')}: ${shared.errors.join('; ')}` })
    } else {
      routingProblems.push({ deployment: SHARED_FILE, errors: shared.errors })
    }
  }

  // A sync target is held to its source's files, not its own routing.yaml.
  for (const dep of deployments) {
    const source = getSourceForTarget(registry, dep)
    if (!source || source === dep || !(await isDeploymentDir(path.join(gitopsDir, source)))) continue
    if (await sameRouting(gitopsDir, source, dep)) continue
    if (brokenSources.has(source)) {
      findings.push({ severity: 'commit', kind: 'routing-target-differs', deployment: dep, regenerable: false,
        description: `${dep}: its routing is not its source's (${source}), whose routing.yaml has problems — fix the source first` })
    } else {
      findings.push({ severity: 'commit', kind: 'routing-target-differs', deployment: dep, regenerable: true,
        description: `${dep}: its routing is not its source's (${source}) — use Regenerate to copy it again` })
      fixes.add(dep)
    }
  }
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
