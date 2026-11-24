/**
 * What a commit has to clear outside charts/ (#179): every folder
 * deployment's notification routing, the sync registry, and the Template
 * each deployment renders.
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

const SYNC_FILE = 'sync.yaml'
const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

/**
 * Every folder deployment, relative to the gitops repo, sorted — one inside
 * another's folder too, as the tree shows it. A deployment's own templates/
 * and charts/ are not walked into.
 */
export async function listFolderDeployments(gitopsDir) {
  const chartsDir = path.resolve(gitopsDir, chartsDirName())
  const found = []
  async function walk(rel, inDeployment) {
    let entries
    try {
      entries = await fs.readdir(path.join(gitopsDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      if (inDeployment && (e.name === 'templates' || e.name === 'charts')) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (path.resolve(gitopsDir, child) === chartsDir) continue
      const isDeployment = await isDeploymentDir(path.join(gitopsDir, child))
      if (isDeployment) found.push(child)
      await walk(child, isDeployment)
    }
  }
  await walk('', false)
  return found.sort()
}

/** The Template a deployment renders is not in the repo (deleted with git). */
async function missingTemplate(gitopsDir, dep) {
  const dir = path.join(gitopsDir, dep)
  let chart
  try {
    chart = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8')) || {}
  } catch (err) {
    // Deleted since the walk (#187): not there to commit.
    if (err.code === 'ENOENT') return null
    throw err
  }
  for (const d of chart.dependencies || []) {
    const repo = typeof d?.repository === 'string' ? d.repository : ''
    const at = repo.startsWith('file://') ? path.resolve(dir, repo.slice('file://'.length)) : null
    if (!at) continue
    try {
      await fs.access(path.join(at, 'Chart.yaml'))
    } catch {
      return d.name || repo
    }
  }
  return null
}

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

async function sameRouting(gitopsDir, a, b) {
  const [x, y] = await Promise.all([readRouting(path.join(gitopsDir, a)), readRouting(path.join(gitopsDir, b))])
  return x.text === y.text && x.cr === y.cr
}

export async function deploymentCommitBlockers(gitopsDir) {
  const sync = await syncRegistryFindings(gitopsDir)
  const findings = [...sync.findings]
  const routingProblems = []
  const registry = sync.readable ? await readSyncRegistry(gitopsDir) : { syncs: [] }
  const deployments = await listFolderDeployments(gitopsDir)
  // What Regenerate would make: a source behind makes its targets again too.
  const fixes = new Set()
  const brokenSources = new Set()
  for (const dep of deployments) {
    const missing = await missingTemplate(gitopsDir, dep)
    if (missing) {
      findings.push({ severity: 'commit', kind: 'template-missing', deployment: dep, description: `${dep}: its Template ${missing} is not in the repo` })
    }
    if (getSourceForTarget(registry, dep)) continue

    const { text, cr } = await readRouting(path.join(gitopsDir, dep))
    if (text === null) {
      if (cr !== null) {
        findings.push({ severity: 'commit', kind: 'routing-orphaned', deployment: dep,
          description: `${dep}: ${ROUTING_CR_FILE} is there without a routing.yaml — remove it, or put routing.yaml back` })
      }
      continue
    }
    const built = buildRouting(text)
    if (built.errors) {
      routingProblems.push({ deployment: dep, errors: built.errors })
      brokenSources.add(dep)
      continue
    }
    if (built.cr !== cr) {
      findings.push({ severity: 'commit', kind: 'routing-stale', deployment: dep, regenerable: true,
        description: `${dep}: its AlertmanagerConfig is behind its routing.yaml or the site's object labels — use Regenerate` })
      fixes.add(dep)
      for (const t of getTargetsForSource(registry, dep)) fixes.add(t)
    }
  }

  // A sync target is held to its source's files, not its own routing.yaml.
  for (const dep of deployments) {
    const source = getSourceForTarget(registry, dep)
    if (!source || !(await isDeploymentDir(path.join(gitopsDir, source)))) continue
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
  return { findings, routingProblems, regenerable: fixes.size, readable: sync.readable }
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

    for (const f of findings.filter(f => f.kind === 'routing-stale')) {
      try {
        const dir = path.join(gitopsDir, f.deployment)
        const { text } = await readRouting(dir)
        const built = buildRouting(text)
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
        const routing = await checkedRouting(path.join(gitopsDir, source))
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
