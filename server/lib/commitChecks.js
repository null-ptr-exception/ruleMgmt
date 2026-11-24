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
import { writeRouting, routingToCopy, copyRouting, ROUTING_FILE, ROUTING_CR_FILE } from './routingFiles.js'
import { writeProblems } from '../repo/writePath.js'
import { isSafeSyncPath, withSyncRegistryLock, getSourceForTarget, getTargetsForSource } from './sync.js'
import { syncAnswer } from '../repo/sync.js'
import { walk, walkFindings, isDeployment } from '../repo/walk.js'
import { decide } from '../repo/policy.js'
import { openRepo } from '../repo/openRepo.js'
import { loadRouting } from '../repo/routing.js'
import { loadShared, sharedForBuild, SHARED_FILE } from '../repo/shared.js'
import { resolveStack } from './stack.js'
import { insideReal } from './safePath.js'
import { templateFindings } from './commit/template.js'
import { valuesFindings } from './commit/values.js'
import { syncRegistryFindings, syncTargetFindings, SYNC_FILE } from './commit/sync.js'
import { routingFindings, sharedFileFindings, sameRoutingAs } from './commit/routing.js'
import { factsOf } from './commit/facts.js'
import { finding } from '../repo/finding.js'

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * Every folder deployment, relative to the gitops repo, sorted — one inside
 * another's folder too, as the tree shows it (the one walk, repo/walk.js).
 */
export async function listFolderDeployments(gitopsDir, repo = openRepo(gitopsDir)) {
  return (await walk(repo)).filter(d => d.kind === 'deployment').map(d => d.rel)
}

/** What a commit has to clear outside charts/: Commit's answer (collectDeploymentChecks). */
export async function deploymentCommitBlockers(gitopsDir) {
  const { facts: _facts, deployments: _deployments, ...answer } = await collectDeploymentChecks(gitopsDir)
  return answer
}

/**
 * Every deployment's checks, by one table: Commit's (deploymentCommitBlockers)
 * or check-repo's. Besides Commit's answer, `facts` is every fact found
 * with what the table does with it (commit/facts.js), and `deployments`
 * every deployment the walk found.
 */
export async function collectDeploymentChecks(gitopsDir, { policy = 'commit', repo = openRepo(gitopsDir) } = {}) {
  // `repo` is one snapshot for every deployment: a Template is read once.
  const sync = await syncRegistryFindings(repo, { policy })
  const findings = [...sync.findings]
  const facts = [...sync.facts]
  const routingProblems = []
  // Never blocking: what a routing's configs will do that is worth saying.
  const routingWarnings = []
  // Never blocking either: rows the row identity label cannot tell apart.
  const valueWarnings = []
  const registry = sync.registry
  const walked = await walk(repo)
  const deployments = walked.filter(d => d.kind === 'deployment').map(d => d.rel)
  // A folder that cannot be read: its deployments are not checked. Listed,
  // as a routing.yaml's own problems are, not a reason to refuse a commit
  // of everything else.
  const walkSaid = decide(walkFindings(walked), policy)
  const unreadable = walkSaid.list.map(f => ({ path: f.file, error: f.detail.why }))
  for (const f of walkSaid.refuse) findings.push({ severity: 'commit', kind: 'file-unreadable', regenerable: false, description: f.message })
  facts.push(...factsOf(walkSaid, null))
  // A routing.yaml using a shared config is made with it (#123): a change to
  // the shared file leaves every resource made from it behind.
  const sharedLoaded = await loadShared(repo)
  const shared = sharedForBuild(sharedLoaded)
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
    const stack = await resolveStack(gitopsDir, path.join(gitopsDir, dep), { repo })
    const template = await templateFindings(gitopsDir, dep, stack)
    findings.push(...template.findings)
    facts.push(...template.facts)
    const values = await valuesFindings(gitopsDir, dep, stack, { repo, policy })
    findings.push(...values.findings)
    facts.push(...values.facts)
    if (values.warnings.length) valueWarnings.push({ deployment: dep, warnings: values.warnings })
    // A target is held to its source below. One listed as its own target is
    // no target (sync.yaml is refused for it too): its routing is checked.
    const followed = getSourceForTarget(registry, dep)
    if (followed && followed !== dep) continue

    const routing = await routingFindings(repo, dep, { registry, layers: stack.layers, policy })
    findings.push(...routing.findings)
    facts.push(...routing.facts)
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
  facts.push(...sharedFacts(sharedLoaded, unresolved, policy))

  const targets = await syncTargetFindings(repo, deployments, registry, brokenSources)
  findings.push(...targets.findings)
  facts.push(...targets.facts)
  for (const f of targets.fixes) fixes.add(f)
  return { findings, routingProblems, routingWarnings, valueWarnings, unreadable, regenerable: fixes.size, readable: sync.readable, facts, deployments }
}

// The shared configs file's facts, by the table; while a deployment uses
// it, its problems are refused by every table (routing-shared-broken).
function sharedFacts(loaded, unresolved, policy) {
  if (loaded.state === 'absent') return []
  const facts = loaded.state === 'ok' ? loaded.findings
    : [finding({ code: 'shared.unreadable', file: SHARED_FILE, helm: 'n/a', message: `${loaded.file} cannot be read (${loaded.why})` })]
  const d = decide(facts, policy)
  if (unresolved.length) {
    const used = f => f.code === 'shared.problem' || f.code === 'shared.unreadable'
    d.refuse.push(...d.list.filter(used))
    d.list = d.list.filter(f => !used(f))
  }
  return factsOf(d, SHARED_FILE)
}

// A deployment's routing files would land outside the repo (a templates/
// that is a link leading out): named, nothing written.
async function refuseOutside(gitopsDir, dep) {
  const problem = await writeProblems(gitopsDir, [`${dep}/${ROUTING_FILE}`, `${dep}/${ROUTING_CR_FILE}`])
  if (problem) throw new Error(`${problem.file} cannot be written: ${problem.why}`)
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
    // Who is whose target cannot be told without sync.yaml: named first.
    const repo = openRepo(gitopsDir)
    const read = await syncAnswer(repo)
    if (read.refusal) return { regenerated, failed: [{ deployment: SYNC_FILE, error: read.refusal.body.error }] }
    const { registry } = read
    const { findings } = await deploymentCommitBlockers(gitopsDir)

    // One that cannot be read is named, not made again.
    for (const f of findings.filter(f => f.kind === 'file-unreadable' && f.deployment)) failed.push({ deployment: f.deployment, error: f.description })
    for (const f of findings.filter(f => f.kind === 'routing-stale')) {
      try {
        const loaded = await loadRouting(repo, f.deployment)
        if (loaded.state !== 'ok' || !loaded.value.made) throw new Error(loaded.state === 'ok' ? loaded.value.errors.join('; ') : `${loaded.file} cannot be read`)
        await refuseOutside(gitopsDir, f.deployment)
        await writeRouting(path.join(gitopsDir, f.deployment), { text: loaded.value.text, cr: loaded.value.made })
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
        if (!(await isDeployment(repo, target))) throw new Error('not a deployment on disk')
        await refuseOutside(gitopsDir, target)
        // Read before anything is written: the source as it is made now.
        const routing = await routingToCopy(openRepo(gitopsDir), source)
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
