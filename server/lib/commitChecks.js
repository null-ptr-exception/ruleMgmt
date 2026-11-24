/**
 * What a commit has to clear outside charts/ (#179): every folder
 * deployment's notification routing, the sync registry, and the Template
 * each deployment renders (there, and at the version it asks for).
 *
 *   deploymentCommitBlockers  { findings, routingProblems } for a commit
 *
 * A finding blocks the commit and names the deployment or sync.yaml entry.
 * `regenerable` on it says Regenerate fixes it. A routing.yaml with errors
 * does not block: it is listed in `routingProblems`, to fix on its Routing
 * page. Only AlertForge's commit runs this; a commit made with git directly
 * is left to CI.
 */

import path from 'path'
import { getSourceForTarget } from './sync.js'
import { walk, walkFindings } from '../repo/walk.js'
import { decide } from '../repo/policy.js'
import { openRepo } from '../repo/openRepo.js'
import { loadShared, sharedForBuild, SHARED_FILE } from '../repo/shared.js'
import { resolveStack } from './stack.js'
import { templateFindings } from './commit/template.js'
import { valuesFindings } from './commit/values.js'
import { syncRegistryFindings, syncTargetFindings } from './commit/sync.js'
import { routingFindings, sharedFileFindings } from './commit/routing.js'
import { factsOf } from './commit/facts.js'
import { finding } from '../repo/finding.js'

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
  // `repo` is one snapshot for every deployment: a Template is read once
  // (templateFindings and sameRouting open a snapshot of their own).
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

  const targets = await syncTargetFindings(repo, deployments, registry, brokenSources, { policy })
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
