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

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { readRouting, buildRouting, writeRouting, checkedRouting, copyRouting, ROUTING_CR_FILE } from './routingFiles.js'
import { isDeploymentDir, isSafeSyncPath, normalizeSyncPath, readSyncRegistry, withSyncRegistryLock, getSourceForTarget, getTargetsForSource } from './sync.js'
import { readSharedConfigs, SHARED_FILE } from './sharedConfigs.js'
import { sharedRefProblems } from '../../src/utils/routingGenerator.js'
import { listDeploymentPaths, walkDeployments } from './deploymentWalk.js'
import { resolveStack } from './stack.js'
import { COMMON_DIR, isCommonChartPath } from '../../src/utils/reservedNames.js'

const SYNC_FILE = 'sync.yaml'
const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * Every folder deployment, relative to the gitops repo, sorted — one inside
 * another's folder too, as the tree shows it (the one walk, deploymentWalk).
 */
export async function listFolderDeployments(gitopsDir) {
  return listDeploymentPaths(gitopsDir)
}

// A version as Helm's semver library reads one: a leading v, a part left
// out read as 0 (`2.0` is 2.0.0), build metadata ignored when it compares.
const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const parseVersion = v => {
  const m = VERSION.exec(String(v).trim())
  return m ? { at: [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number).join('.') + (m[4] ? `-${m[4]}` : '') } : null
}
// A constraint that is one version and nothing else — `2.1.0`, `=2.1.0`,
// `v2.1.0` — all three parts written: `2.1` and every range are not judged.
const exactWanted = v => {
  const text = String(v).trim().replace(/^=\s*/, '')
  return /^v?\d+\.\d+\.\d+(?:[-+]\S*)?$/.test(text) ? parseVersion(text) : null
}

/**
 * What stops the Template a deployment renders from being found, so Helm
 * renders none of the deployment: not in the repo (deleted with git), a
 * Chart.yaml with no version Helm reads, or (changed by hand, or pulled)
 * at another version than the one exact version the deployment asks for.
 * A range (`>=0.0.0-0`, which AlertForge writes) is not judged.
 */
async function templateProblem(gitopsDir, dep, stack) {
  const dir = path.join(gitopsDir, dep)
  const own = await fileDependencyProblem(gitopsDir, dir, dep)
  // Gone since the walk: not there to commit.
  if (own === undefined) return null
  if (own) return own
  // Its `_common` stack (#100): what Helm renders nothing from, or stops
  // on. Below the deployment Helm fetches nothing, so a version or a
  // repository a `_common` asks for is not checked: Helm does not read it.
  if (stack.problems.length) return { ...stack.problems[0], description: `${dep}: ${stack.problems[0].description}` }
  return null
}

// The first problem with a chart folder's file:// dependencies, null when
// there is none, undefined when its Chart.yaml is gone (deleted since the
// walk, #187: not there to commit).
async function fileDependencyProblem(gitopsDir, dir, dep) {
  let chart
  try {
    chart = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8')) || {}
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw err
  }
  for (const d of chart.dependencies || []) {
    const repo = typeof d?.repository === 'string' ? d.repository : ''
    const at = repo.startsWith('file://') ? path.resolve(dir, repo.slice('file://'.length)) : null
    if (!at) continue
    // A `_common` chart is named as one, not as a Template.
    const common = isCommonChartPath(at)
    const what = common ? `${COMMON_DIR} chart` : 'Template'
    const noun = `${what} ${common ? path.relative(gitopsDir, at).replace(/\\/g, '/') : d.name || repo}`
    const problem = description => ({ kind: 'template-version', description: `${dep}: ${description}, so Helm cannot render it` })
    let template
    try {
      template = yaml.load(await fs.readFile(path.join(at, 'Chart.yaml'), 'utf-8'))
    } catch (err) {
      if (err.code === 'ENOENT') return { kind: 'template-missing', description: `${dep}: its ${noun} is not in the repo` }
      return problem(`its ${noun}'s Chart.yaml is not valid YAML (${err.reason || err.message})`)
    }
    const has = template && typeof template === 'object' ? parseVersion(template.version ?? '') : null
    if (!has) return problem(`its ${noun}'s Chart.yaml has no version Helm reads (${JSON.stringify(template?.version ?? null)})`)
    const wants = d.version
    if (wants === undefined || wants === null || wants === false || String(wants).trim() === '') {
      return problem(`its Chart.yaml gives no version for the ${noun} — write version: ">=0.0.0-0" (any version)`)
    }
    const exact = exactWanted(wants)
    if (exact && exact.at !== has.at) {
      return problem(`its Chart.yaml asks for the ${noun} at version ${wants}, but the ${what} is ${template.version} — write version: ">=0.0.0-0" (any version), or ${template.version}`)
    }
  }
  return null
}

// A hand-written null in a stacked deployment's values or a layer's (#100):
// Helm versions read it differently, so what is deployed cannot be told.
const stackNulls = stack => (stack.layers.length ? stack.valueIssues : [])

/**
 * sync.yaml as written, entry by entry: what readSyncRegistry would skip,
 * and what it reads but cannot be right — a chain, a target with two
 * sources, a path that is not a deployment.
 */
async function syncRegistryFindings(gitopsDir) {
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

const parsedOrNull = text => {
  try {
    return yaml.load(text)
  } catch {
    return null
  }
}

async function sameRouting(gitopsDir, a, b) {
  const [x, y] = await Promise.all([readRouting(path.join(gitopsDir, a)), readRouting(path.join(gitopsDir, b))])
  return x.text === y.text && x.cr === y.cr
}

export async function deploymentCommitBlockers(gitopsDir) {
  const sync = await syncRegistryFindings(gitopsDir)
  const findings = [...sync.findings]
  const routingProblems = []
  // Never blocking: what a routing's configs will do that is worth saying.
  const routingWarnings = []
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
  return { findings, routingProblems, routingWarnings, unreadable, regenerable: fixes.size, readable: sync.readable }
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

async function sameRoutingAs(gitopsDir, dep, { text, cr }) {
  const now = await readRouting(path.join(gitopsDir, dep))
  return now.text === text && now.cr === cr
}
