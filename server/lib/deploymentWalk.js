/**
 * The one way the repo is walked for deployments. Migration, the commit
 * checks, the shared configs' users, "which deployments use this chart" and
 * the Sync to candidates all list what this finds, and the tree shows a
 * folder by the same rules, so a deployment the tree shows is one every
 * other list has — at any depth, and inside another deployment too.
 *
 *   walkDeployments        every deployment and `_common` chart, sorted
 *   skippedDir             which folders the walk (and the tree) never enter
 *   placementOf            why an existing deployment is somewhere it should not be
 *   newDeploymentProblem   why a deployment cannot be made at a path, or null
 *
 * A deployment is a folder with a Chart.yaml naming a dependency and a
 * values.yaml (isDeploymentDir). A folder right inside a `_common/` is that
 * folder's `_common` chart, never a deployment.
 */

import fs from 'fs/promises'
import path from 'path'
import { isDeploymentDir, isCommonChartDir } from './sync.js'
import { inSharedDir } from './sharedConfigs.js'
import { COMMON_DIR } from '../../src/utils/reservedNames.js'

export { COMMON_DIR }

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

// Inside a deployment or a `_common` chart: the chart's own folders —
// templates/ (the notification routing, #92) and charts/ (what Helm fetches,
// or the `_common` chart's link to the Template).
const CHART_OWN_DIRS = new Set(['templates', 'charts'])

/**
 * Whether the walk leaves folder `name` out. `inChart`: it is inside a
 * deployment or a `_common` chart. Hidden folders and node_modules are never
 * entered. The Templates folder is isTemplatesDir's.
 */
export function skippedDir(name, { inChart = false } = {}) {
  if (name.startsWith('.') || name === 'node_modules') return true
  if (inChart && CHART_OWN_DIRS.has(name)) return true
  return false
}

/** Whether `rel` is the Templates folder (CHARTS_DIR, however it is spelled). */
export function isTemplatesDir(gitopsDir, rel) {
  return path.resolve(gitopsDir, rel) === path.resolve(gitopsDir, chartsDirName())
}

const segmentsOf = rel => String(rel ?? '').split(/[\\/]/).filter(s => s && s !== '.')

async function readDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    // Only a folder that is not there is empty: anything else would make a
    // deployment silently missing from every list.
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return []
    throw err
  }
}

/**
 * Every deployment, and every `_common` chart, under `from` (the whole repo
 * by default), relative to the repo, sorted by path:
 *   { path, kind: 'deployment' | 'common', nestedIn, inCommon }
 * `nestedIn` is the deployment it is inside (or null), `inCommon` whether it
 * is inside a `_common` folder — both only for a deployment, as placementOf.
 * The walk goes into a deployment's other folders too: one put inside
 * another is still found.
 */
export async function walkDeployments(gitopsDir, { from = '' } = {}) {
  const found = []
  async function walk(rel, { inChart, nestedIn }) {
    for (const e of await readDir(path.join(gitopsDir, rel))) {
      if (!e.isDirectory()) continue
      if (skippedDir(e.name, { inChart })) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      // Only the Templates folder itself: a folder of the same name further
      // down is a folder like any other.
      if (isTemplatesDir(gitopsDir, child)) continue
      // The shared configs' folder holds no deployment (#123).
      if (!rel && await inSharedDir(gitopsDir, child)) continue
      const abs = path.join(gitopsDir, child)
      if (await isCommonChartDir(abs)) {
        found.push({ path: child, kind: 'common', nestedIn: null, inCommon: false })
        await walk(child, { inChart: true, nestedIn })
        continue
      }
      const isDeployment = await isDeploymentDir(abs)
      if (isDeployment) {
        found.push({ path: child, kind: 'deployment', nestedIn, inCommon: segmentsOf(child).includes(COMMON_DIR) })
      }
      await walk(child, { inChart: isDeployment || inChart, nestedIn: isDeployment ? (nestedIn ?? child) : nestedIn })
    }
  }
  const start = segmentsOf(from).join('/')
  // A walk from a folder knows the deployments above it, as one from the top.
  let nestedIn = null
  let inChart = false
  const segments = segmentsOf(start)
  for (let i = 1; i <= segments.length; i++) {
    const abs = path.join(gitopsDir, ...segments.slice(0, i))
    if (await isCommonChartDir(abs)) inChart = true
    else if (await isDeploymentDir(abs)) { inChart = true; nestedIn ??= segments.slice(0, i).join('/') }
  }
  await walk(start, { inChart, nestedIn })
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Every deployment's path, sorted. */
export async function listDeploymentPaths(gitopsDir) {
  return (await walkDeployments(gitopsDir)).filter(d => d.kind === 'deployment').map(d => d.path)
}

/**
 * Why an existing deployment at `rel` is where no new one can be made, for
 * the tree to flag: `{ nestedIn }` (the deployment it is inside) or
 * `{ inCommon: true }`, or null. It still works as any other.
 */
export async function placementOf(gitopsDir, rel) {
  const segments = segmentsOf(rel)
  for (let i = 1; i < segments.length; i++) {
    const above = segments.slice(0, i).join('/')
    if (await isDeploymentDir(path.join(gitopsDir, above))) return { nestedIn: above }
  }
  if (segments.includes(COMMON_DIR)) return { inCommon: true }
  return null
}

/**
 * Why no new deployment can be made at `rel`, or null. An existing
 * deployment there is no problem: the caller finds it there. Refused:
 * inside a `_common` folder (it holds what the deployments beside it
 * inherit), inside another deployment, around one (a folder that already
 * has a deployment in it), and where the walk never looks.
 */
export async function newDeploymentProblem(gitopsDir, rel) {
  const segments = segmentsOf(rel)
  const where = segments.join('/')
  if (await isDeploymentDir(path.join(gitopsDir, where))) return null
  const hidden = segments.find(s => skippedDir(s))
  if (hidden) return `${where}: a deployment under ${hidden}/ would not be seen — pick a folder that does not start with "." and is not node_modules`
  if (segments.includes(COMMON_DIR)) return `${where}: a deployment cannot be made inside a ${COMMON_DIR} folder — ${COMMON_DIR} holds what the deployments beside it inherit`
  for (let i = 1; i < segments.length; i++) {
    const above = segments.slice(0, i).join('/')
    if (await isCommonChartDir(path.join(gitopsDir, above))) return `${where}: a deployment cannot be made inside a ${COMMON_DIR} chart (${above})`
    if (await isDeploymentDir(path.join(gitopsDir, above))) return `${where}: a deployment cannot be made inside another deployment (${above}) — make it in a folder beside it`
  }
  const below = (await walkDeployments(gitopsDir, { from: where })).find(d => d.kind === 'deployment')
  if (below) return `${where}: this folder already holds the deployment ${below.path} — a deployment cannot hold another; make it in a folder of its own`
  return null
}
