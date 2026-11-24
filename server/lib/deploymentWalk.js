/**
 * The one way the repo is walked for deployments. Migration, the commit
 * checks, the shared configs' users, "which deployments use this chart" and
 * the Sync to candidates all list what this finds, and the tree shows a
 * folder by the same rules, so a deployment the tree shows is one every
 * other list has — at any depth, and inside another deployment too.
 *
 *   walkDeployments        every deployment and `_common` chart, sorted
 *   excludedFolder         the one list of folders the walk (and the tree) never enter
 *   skippedDir             the same, by name alone
 *   placementOf            why an existing deployment is somewhere it should not be
 *   newDeploymentProblem   why a deployment cannot be made at a path, or null
 *
 * A deployment is a folder with a Chart.yaml naming a dependency and a
 * values.yaml (isDeploymentDir). A folder right inside a `_common/` is that
 * folder's `_common` chart, never a deployment.
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { isDeploymentDir, isCommonChartDir } from './sync.js'
import { inSharedDir, SHARED_DIR } from './sharedConfigs.js'
import { COMMON_DIR } from '../../src/utils/reservedNames.js'
import { isAbsent } from './readIfThere.js'

export { COMMON_DIR }

const chartsDirName = () => process.env.CHARTS_DIR || 'charts'

// Right inside a deployment or a `_common` chart: the chart's own folders —
// templates/ (the notification routing, #92) and charts/ (what Helm fetches,
// or the `_common` chart's link to the Template). Further down they are
// folders like any other, as Helm reads only these two.
const CHART_OWN_DIRS = new Set(['templates', 'charts'])

/**
 * Whether folder `name` is left out by its name alone. `inChart`: it is
 * right inside a deployment or a `_common` chart. `hidden`: hidden folders
 * are looked into too (all but .git), as "which deployments use this chart"
 * does.
 */
export function skippedDir(name, { inChart = false, hidden = false } = {}) {
  return excludedName(name, { inChart, hidden }) !== null
}

function excludedName(name, { inChart = false, hidden = false } = {}) {
  if (name === '.git') return 'a hidden folder'
  if (name.startsWith('.') && !hidden) return 'a hidden folder'
  if (name === 'node_modules') return 'node_modules'
  if (inChart && CHART_OWN_DIRS.has(name)) return `a chart's own ${name}/ folder`
  return null
}

/** Whether `rel` is the Templates folder (CHARTS_DIR, however it is spelled). */
export function isTemplatesDir(gitopsDir, rel) {
  return path.resolve(gitopsDir, rel) === path.resolve(gitopsDir, chartsDirName())
}

/**
 * Why the walk leaves the folder `rel` out, or null: the one list. `inChart`
 * as for skippedDir. Its name (hidden, node_modules, a chart's own
 * folders), the Templates folder, the shared notification configs' folder.
 */
export async function excludedFolder(gitopsDir, rel, { inChart = false, hidden = false } = {}) {
  const byName = excludedName(path.posix.basename(rel), { inChart, hidden })
  if (byName) return byName
  if (isTemplatesDir(gitopsDir, rel)) return 'the Templates folder'
  // The shared configs' folder holds no deployment (#123).
  if (!rel.includes('/') && await inSharedDir(gitopsDir, rel)) return `the shared notification configs' folder (${SHARED_DIR}/)`
  return null
}

const segmentsOf = rel => String(rel ?? '').split(/[\\/]/).filter(s => s && s !== '.')

// A folder's entries; null when it cannot be read (it is reported, not
// thrown: one folder must not stop every list).
async function readDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return []
    return { error: err?.code || 'error' }
  }
}

// Why a folder's Chart.yaml cannot be read, or null (not there, or read).
async function unreadableChart(abs) {
  const file = path.join(abs, 'Chart.yaml')
  try {
    await fs.readFile(file, 'utf-8')
    return null
  } catch (err) {
    if (await isAbsent(file, err)) return null
    return err.code === 'ENOENT' ? 'a link to a file that is not there' : err.code || 'error'
  }
}

// A folder with a Chart.yaml naming a dependency, and no values.yaml: Helm
// deploys it with the Template's own values — its example rows.
async function isChartOnlyDir(abs) {
  let chart
  try {
    chart = yaml.load(await fs.readFile(path.join(abs, 'Chart.yaml'), 'utf-8'))
  } catch {
    return false
  }
  if (!Array.isArray(chart?.dependencies) || !chart.dependencies.length) return false
  return fs.access(path.join(abs, 'values.yaml')).then(() => false, () => true)
}

/**
 * Every deployment, and every `_common` chart, under `from` (the whole repo
 * by default), relative to the repo, sorted by path:
 *   { path, kind, nestedIn, inCommon }
 * `kind` is 'deployment', 'common', 'chart-only' (a Chart.yaml naming a
 * dependency, no values.yaml: Helm deploys the Template's example rows; with
 * `chartOnly`), or 'unreadable' (a folder that cannot be read, with
 * `error`: nothing under it is known). `nestedIn` is the deployment it is
 * inside (or null), `inCommon` whether it is inside a `_common` folder —
 * both only for a deployment, as placementOf. The walk goes into a
 * deployment's other folders too: one put inside another is still found.
 * `hidden` also looks into hidden folders (all but .git).
 */
export async function walkDeployments(gitopsDir, { from = '', chartOnly = false, hidden = false } = {}) {
  const found = []
  async function walk(rel, { inChart, nestedIn }) {
    const entries = await readDir(path.join(gitopsDir, rel))
    if (!Array.isArray(entries)) {
      found.push({ path: rel, kind: 'unreadable', error: entries.error, nestedIn: null, inCommon: false })
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const child = rel ? `${rel}/${e.name}` : e.name
      if (await excludedFolder(gitopsDir, child, { inChart, hidden })) continue
      const abs = path.join(gitopsDir, child)
      if (await isCommonChartDir(abs)) {
        found.push({ path: child, kind: 'common', nestedIn: null, inCommon: false })
        await walk(child, { inChart: true, nestedIn })
        continue
      }
      // A Chart.yaml that is there and cannot be read: listed as a folder
      // that cannot be read, as one whose entries cannot be — named, not
      // taken for no deployment.
      const chartError = await unreadableChart(abs)
      // A folder that cannot be listed is named once, by the walk into it.
      // Where it is, as for a deployment there: inside another, or a _common folder.
      if (chartError && Array.isArray(await readDir(abs))) found.push({ path: child, kind: 'unreadable', error: chartError, nestedIn, inCommon: segmentsOf(child).includes(COMMON_DIR) })
      const isDeployment = !chartError && await isDeploymentDir(abs)
      if (isDeployment) {
        found.push({ path: child, kind: 'deployment', nestedIn, inCommon: segmentsOf(child).includes(COMMON_DIR) })
      } else if (chartOnly && await isChartOnlyDir(abs)) {
        found.push({ path: child, kind: 'chart-only', nestedIn, inCommon: segmentsOf(child).includes(COMMON_DIR) })
      }
      await walk(child, { inChart: isDeployment, nestedIn: isDeployment ? (nestedIn ?? child) : nestedIn })
    }
  }
  const start = segmentsOf(from).join('/')
  // A walk from a folder knows the deployments above it, as one from the top.
  let nestedIn = null
  let inChart = false
  const segments = segmentsOf(start)
  for (let i = 1; i <= segments.length; i++) {
    const abs = path.join(gitopsDir, ...segments.slice(0, i))
    const here = await isCommonChartDir(abs) || await isDeploymentDir(abs)
    if (here && !(await isCommonChartDir(abs))) nestedIn ??= segments.slice(0, i).join('/')
    inChart = here && i === segments.length
  }
  await walk(start, { inChart, nestedIn })
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Every deployment's path, sorted. */
export async function listDeploymentPaths(gitopsDir) {
  return (await walkDeployments(gitopsDir)).filter(d => d.kind === 'deployment').map(d => d.path)
}

/** The folders the walk could not read, relative to the repo. */
export async function unreadableFolders(gitopsDir) {
  return (await walkDeployments(gitopsDir)).filter(d => d.kind === 'unreadable').map(d => ({ path: d.path || '.', error: d.error }))
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
 * anywhere the walk does not look (excludedFolder), inside a `_common`
 * folder (it holds what the deployments beside it inherit), inside another
 * deployment, around one (a folder that already has a deployment in it),
 * and on a folder that holds a `_common` (its deployments go in folders
 * under it).
 */
export async function newDeploymentProblem(gitopsDir, rel) {
  const segments = segmentsOf(rel)
  const where = segments.join('/')
  if (await isDeploymentDir(path.join(gitopsDir, where))) return null
  let inChart = false
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/')
    const excluded = await excludedFolder(gitopsDir, prefix, { inChart })
    if (excluded) return `${where}: a deployment there would not be seen — ${prefix} is ${excluded}, which AlertForge does not look into`
    const abs = path.join(gitopsDir, prefix)
    inChart = await isDeploymentDir(abs) || await isCommonChartDir(abs)
  }
  if (segments.includes(COMMON_DIR)) return `${where}: a deployment cannot be made inside a ${COMMON_DIR} folder — ${COMMON_DIR} holds what the deployments beside it inherit`
  for (let i = 1; i < segments.length; i++) {
    const above = segments.slice(0, i).join('/')
    if (await isCommonChartDir(path.join(gitopsDir, above))) return `${where}: a deployment cannot be made inside a ${COMMON_DIR} chart (${above})`
    if (await isDeploymentDir(path.join(gitopsDir, above))) return `${where}: a deployment cannot be made inside another deployment (${above}) — make it in a folder beside it`
  }
  const holdsCommon = await fs.stat(path.join(gitopsDir, where, COMMON_DIR)).then(s => s.isDirectory(), () => false)
  if (holdsCommon) return `${where}: this folder holds a ${COMMON_DIR} — its deployments go in folders under it (${where}/<name>), not on the folder itself`
  const below = (await walkDeployments(gitopsDir, { from: where })).find(d => d.kind === 'deployment')
  if (below) return `${where}: this folder already holds the deployment ${below.path} — a deployment cannot hold another; make it in a folder of its own`
  return null
}
