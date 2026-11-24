/**
 * The one walk of the repo for deployments, and the one answer to "is this
 * folder a deployment": the tree, the lists, Commit, who uses a Template,
 * sync and check-deployment all ask here.
 *
 *   folderEntry(repo, rel)   → Entry: one folder, by the rules below
 *   isDeployment(repo, rel)  → whether folderEntry says 'deployment'
 *   walk(repo, { from, hidden }) → Entry[]: every deployment, `_common`
 *                              chart, folder that cannot be read (or is a
 *                              link out of the repo) and folder with
 *                              something to say (chartOnly, a link), under
 *                              `from` (the whole repo by default), sorted.
 *                              Once per snapshot.
 *   childEntries(repo, rel)  → Entry[] of the folder's own folders, for the
 *                              tree: what it shows, one level at a time
 *
 *   Entry: {
 *     rel,
 *     kind:      'deployment' | 'common' | 'folder' | 'unreadable'
 *                ('absent' from folderEntry only: nothing there, or a file)
 *     why?:      for 'unreadable', and for a link: in words
 *     cause?:    for 'unreadable': 'folder' (it cannot be listed), 'chart'
 *                (its Chart.yaml cannot be read or used), 'link' (out of
 *                the repo), 'circle' (a link round in a circle)
 *     chartOnly?: a Chart.yaml naming a dependency and no values.yaml (Helm
 *                deploys the Template's example rows)
 *     link?:     'inside' | 'outside' | 'git' | 'nowhere' | 'circle': the folder, or
 *                one above it, is a link; `real`: where the whole path
 *                leads in the repo (the folder to use instead). A link is never a deployment and
 *                never walked into: what it leads to is found where it is.
 *                One leading outside the repo is 'unreadable', and named.
 *     nestedIn:  the deployment it is inside, or null (walk, childEntries)
 *     inCommon:  whether it is inside a `_common` folder (walk, childEntries)
 *   }
 *
 * A deployment is a folder with a Chart.yaml naming a dependency and a
 * values.yaml (in any form: the checks say what is wrong with it). A folder
 * right inside a `_common/` with a Chart.yaml is that folder's `_common`
 * chart, never a deployment. A Chart.yaml that is there and cannot be read
 * or used (no permission, a folder, a link to nothing or out of the repo,
 * not YAML, not a map, empty, dependencies that are not a list) makes the
 * folder 'unreadable': named, never taken for no deployment; so does a
 * folder that is a link round in a circle (cause 'circle'). A Chart.yaml
 * naming no Template beside a values.yaml that writes values is a folder
 * with `valuesWithoutTemplate`: its rows deploy nothing, and that is said.
 */
import fs from 'fs/promises'
import path from 'path'
import { isCommonChartPath, COMMON_DIR } from '../../src/utils/reservedNames.js'
import { loadSharedDir, sharedDirProblemOf, SHARED_DIR } from './shared.js'
import { chartsDir } from './template.js'
import { repoRel } from './readRepoFile.js'
import { finding } from './finding.js'
import { createLimit } from '../lib/limit.js'
import { offeredPath } from './paths.js'

// How many folders one walk looks at at once: far below any open-files limit.
const WALK_AT_ONCE = 16

export { COMMON_DIR }

// Right inside a deployment or a `_common` chart: the chart's own folders —
// templates/ (the notification routing) and charts/ (what Helm fetches, or
// the `_common` chart's link to the Template). Further down they are
// folders like any other, as Helm reads only these two.
const CHART_OWN_DIRS = new Set(['templates', 'charts'])

const segmentsOf = rel => String(rel ?? '').split(/[\\/]/).filter(s => s && s !== '.')

function excludedName(name, { inChart = false, hidden = false } = {}) {
  if (name === '.git') return 'a hidden folder'
  if (name.startsWith('.') && !hidden) return 'a hidden folder'
  if (name === 'node_modules') return 'node_modules'
  if (inChart && CHART_OWN_DIRS.has(name)) return `a chart's own ${name}/ folder`
  return null
}

/**
 * Whether folder `name` is left out by its name alone. `inChart`: it is
 * right inside a deployment or a `_common` chart. `hidden`: hidden folders
 * are looked into too (all but .git), as "who uses this Template" does.
 */
export function skippedDir(name, opts) {
  return excludedName(name, opts) !== null
}

/** Whether `rel` is the Templates folder (CHARTS_DIR, however it is spelled). */
export function isTemplatesDir(rel) {
  return segmentsOf(rel).join('/') === segmentsOf(chartsDir() ?? 'charts').join('/')
}

const inShared = async (repo, rel) => segmentsOf(rel)[0] === SHARED_DIR && !sharedDirProblemOf(await loadSharedDir(repo))

/**
 * Why the walk leaves the folder `rel` out, or null: the one list. Its name
 * (hidden, node_modules, a chart's own folders), the Templates folder, the
 * shared notification configs' folder.
 */
export async function excludedFolder(repo, rel, { inChart = false, hidden = false } = {}) {
  const byName = excludedName(path.posix.basename(rel), { inChart, hidden })
  if (byName) return byName
  if (isTemplatesDir(rel)) return 'the Templates folder'
  if (segmentsOf(rel).length === 1 && await inShared(repo, rel)) return `the shared notification configs' folder (${SHARED_DIR}/)`
  return null
}

const LINK_WHY = {
  inside: real => `a link to ${real}`,
  outside: () => 'a link that leads outside the repo',
  git: () => "a link into git's own folder",
  nowhere: () => 'a link to a folder that is not there',
  circle: () => 'a link that leads round in a circle',
}

// The first folder on the way to `rel` (or `rel` itself) that is a link:
// { at, link, real } or null (`real`: where an 'inside' one leads).
export async function linkOnTheWay(repo, rel) {
  const segments = segmentsOf(rel)
  for (let i = 0; i < segments.length; i++) {
    const parent = segments.slice(0, i).join('/')
    const dir = await repo.dir(parent)
    if (dir.state !== 'ok') return null
    const link = dir.value.links.get(segments[i])
    if (!link) continue
    const at = segments.slice(0, i + 1).join('/')
    // Where the link leads, and where the whole path does: in the repo.
    let to = null
    let real = null
    if (link === 'inside') {
      const base = await fs.realpath(repo.root).catch(() => repo.root)
      const inRepo = abs => (abs ? path.relative(base, abs).split(path.sep).join('/') || '.' : null)
      to = inRepo(await fs.realpath(path.join(repo.root, at)).catch(() => null))
      const whole = inRepo(await fs.realpath(path.join(repo.root, rel)).catch(() => null))
      real = whole && !whole.startsWith('..') ? whole : null
    }
    return { at, link, to, real }
  }
  return null
}

const chartWhy = c => (c.state === 'unreadable'
  ? `its Chart.yaml cannot be read (${c.why})`
  : `its Chart.yaml cannot be used (${c.findings.map(f => f.message).join('; ')})`)

// A values.yaml that writes something: a map with a key in it.
async function holdsValues(repo, rel) {
  const v = await repo.helmYaml(rel)
  return v.state === 'ok' && !!v.value && typeof v.value === 'object' && !Array.isArray(v.value) && Object.keys(v.value).length > 0
}

// The folder itself, links on the way already looked at.
async function classify(repo, rel) {
  const dir = await repo.dir(rel)
  if (dir.state === 'absent' || (dir.state === 'unreadable' && dir.kind === 'not-a-folder')) return { rel, kind: 'absent' }
  if (dir.state === 'unreadable') return { rel, kind: 'unreadable', why: dir.why, cause: 'folder' }
  const entries = dir.value.entries
  const chart = entries.has('Chart.yaml') ? await repo.helmYaml(`${rel}/Chart.yaml`) : null
  const there = chart && chart.state !== 'absent' && !(chart.state === 'unreadable' && chart.kind === 'dangling-link' && isCommonChartPath(rel))
  if (isCommonChartPath(rel) && there) return { rel, kind: 'common' }
  if (!there) return { rel, kind: 'folder' }
  if (chart.state !== 'ok') return { rel, kind: 'unreadable', why: chartWhy(chart), cause: 'chart' }
  // Read, and of no use as a chart's: Helm stops on it as on one that
  // cannot be read.
  const unusable = !chart.value || (typeof chart.value === 'object' && !Object.keys(chart.value).length) ? 'it is empty'
    : chart.value.dependencies !== undefined && chart.value.dependencies !== null && !Array.isArray(chart.value.dependencies) ? 'its dependencies are not a list' : null
  if (unusable) return { rel, kind: 'unreadable', why: `its Chart.yaml cannot be used (${unusable})`, cause: 'chart' }
  const deps = chart.value.dependencies
  if (!Array.isArray(deps) || !deps.length) {
    // No Template, and values with rows: what they promise deploys nothing.
    return entries.has('values.yaml') && await holdsValues(repo, `${rel}/values.yaml`) ? { rel, kind: 'folder', valuesWithoutTemplate: true } : { rel, kind: 'folder' }
  }
  if (!entries.has('values.yaml')) return { rel, kind: 'folder', chartOnly: true }
  return { rel, kind: 'deployment' }
}

/** One folder, by the walk's rules (no nestedIn / inCommon: see walk). */
export function folderEntry(repo, rel) {
  const key = segmentsOf(rel).join('/')
  return repo.memo('folderEntry', key, async () => {
    if (!key) return { rel: key, kind: 'folder' }
    // Not a path in the repo (`..`, absolute): nothing of the repo's there.
    try { repoRel(key) } catch { return { rel: key, kind: 'absent' } }
    const link = await linkOnTheWay(repo, key)
    if (link) {
      const why = `${link.at === key ? 'it' : link.at} is ${LINK_WHY[link.link](link.to)}`
      // One leading out of the repo, or into git's own folder, is not
      // followed, one round in a circle cannot be (Helm stops on it):
      // named, as unreadable.
      const cause = link.link === 'outside' || link.link === 'git' ? 'link' : link.link === 'circle' && link.at === key ? 'circle' : null
      return { rel: key, kind: cause ? 'unreadable' : 'folder', link: link.link, why, ...(cause ? { cause } : {}), ...(link.real ? { real: link.real } : {}) }
    }
    return classify(repo, key)
  })
}

const CODES = {
  folder: ['walk.folder-unreadable', 'unknown', 'nothing in it is known: its deployments are not checked'],
  chart: ['walk.chart-unreadable', 'fails', 'Helm cannot render it'],
  link: ['walk.link-outside', 'unknown', 'what Helm renders through it is not in the repo'],
  circle: ['walk.link-circle', 'fails', 'Helm cannot read it'],
}
const NO_TEMPLATE_WHY = 'its Chart.yaml names no Template'

/**
 * The walk's facts (policy.js `walk.*`): each entry it could not read,
 * and each values.yaml with rows in a folder whose Chart.yaml names no
 * Template (walk.values-no-template: the rows deploy nothing).
 */
export function walkFindings(entries) {
  return entries.filter(e => e.kind === 'unreadable' || e.valuesWithoutTemplate).map(e => {
    if (e.valuesWithoutTemplate) {
      const file = `${e.rel}/values.yaml`
      return finding({ code: 'walk.values-no-template', file, helm: 'renders-differently', message: `${file}: ${NO_TEMPLATE_WHY}, so none of the rows it writes is deployed — add the Template to its dependencies, or remove the values`, detail: { why: NO_TEMPLATE_WHY } })
    }
    const [code, helm, then] = CODES[e.cause] ?? CODES.folder
    return finding({ code, file: e.rel || '.', helm, message: `${e.rel || '.'}: ${e.why}: ${then}`, detail: { why: e.why } })
  })
}

export async function isDeployment(repo, rel) {
  return (await folderEntry(repo, rel)).kind === 'deployment'
}

const isChart = e => e.kind === 'deployment' || e.kind === 'common'

// Where a folder is: the deployment above it, whether its parent is a chart.
async function contextOf(repo, rel) {
  const segments = segmentsOf(rel)
  let nestedIn = null
  let inChart = false
  for (let i = 1; i <= segments.length; i++) {
    const e = await folderEntry(repo, segments.slice(0, i).join('/'))
    if (e.kind === 'deployment' && i < segments.length) nestedIn ??= e.rel
    inChart = isChart(e) && i === segments.length
  }
  return { nestedIn, inChart, self: segments.length ? await folderEntry(repo, segments.join('/')) : null }
}

const placed = (e, nestedIn) => ({ ...e, nestedIn: e.kind === 'deployment' || e.kind === 'unreadable' || e.chartOnly ? nestedIn : null, inCommon: (e.kind === 'deployment' || e.kind === 'unreadable' || !!e.chartOnly) && segmentsOf(e.rel).includes(COMMON_DIR) })

// The folders right inside `rel` the walk looks at: a link to a folder
// counts (as what it is), a file or a link to one does not.
async function subfolders(repo, rel, { inChart, hidden }) {
  const dir = await repo.dir(rel)
  if (dir.state !== 'ok') return []
  const out = []
  for (const [name, kind] of dir.value.entries) {
    const link = dir.value.links.get(name)
    // A link round in a circle is neither a folder nor a file: looked at, to be named.
    if (kind !== 'dir' && link !== 'circle') continue
    const child = rel ? `${rel}/${name}` : name
    if (await excludedFolder(repo, child, { inChart, hidden })) continue
    out.push({ name, child, link })
  }
  return out
}

export function walk(repo, { from = '', hidden = false } = {}) {
  const start = segmentsOf(from).join('/')
  return repo.memo('walk', `${start}\0${hidden}`, async () => {
    const found = []
    const { nestedIn: above, inChart: startInChart } = await contextOf(repo, start)
    // Folders looked at side by side, a few at a time (each reads a file or
    // two): the answer is sorted below.
    const limit = createLimit(WALK_AT_ONCE)
    async function into(rel, { inChart, nestedIn }) {
      await Promise.all((await subfolders(repo, rel, { inChart, hidden })).map(async ({ child, link }) => {
        const e = await limit(() => folderEntry(repo, child))
        if (link) {
          // Never walked into; one leading out of the repo is named.
          if (e.kind === 'unreadable' || link === 'inside') found.push(placed(e, nestedIn))
          return
        }
        if (e.kind !== 'folder' || e.chartOnly || e.valuesWithoutTemplate) found.push(placed(e, nestedIn))
        await into(child, { inChart: isChart(e), nestedIn: e.kind === 'deployment' ? (nestedIn ?? child) : nestedIn })
      }))
    }
    const root = start ? await folderEntry(repo, start) : null
    if (root?.kind === 'unreadable' && !root.link) found.push(placed(root, above))
    else if (!root?.link) await into(start, { inChart: startInChart, nestedIn: above })
    return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  })
}

/**
 * The folders right inside `rel`, as the tree shows them: by name only (the
 * Templates folder is shown), the shared configs' folder left out at the
 * top, a link only when it leads out of the repo (named as unreadable).
 * Each with `hasFolders`: whether the tree can open it.
 */
export async function childEntries(repo, rel) {
  const key = segmentsOf(rel).join('/')
  const { nestedIn: above, self } = await contextOf(repo, key)
  const inChart = !!self && isChart(self)
  const nestedIn = self?.kind === 'deployment' ? (above ?? key) : above
  const dir = await repo.dir(key)
  if (dir.state !== 'ok') return []
  const hideShared = !key && await inShared(repo, SHARED_DIR)
  const names = [...dir.value.entries].filter(([name, kind]) => {
    const link = dir.value.links.get(name)
    if (kind !== 'dir' || (link && link !== 'outside' && link !== 'git')) return false
    return !skippedDir(name, { inChart }) && !(hideShared && name === SHARED_DIR)
  }).map(([name]) => name)
  // Side by side, a few at a time, in the folder's order.
  const limit = createLimit(WALK_AT_ONCE)
  return Promise.all(names.map(name => limit(async () => {
    const e = placed(await folderEntry(repo, key ? `${key}/${name}` : name), nestedIn)
    let hasFolders = false
    if (!dir.value.links.get(name)) {
      const sub = await repo.dir(e.rel)
      // What the tree shows in it: a folder, or a link leading out of the repo (named).
      if (sub.state === 'ok') hasFolders = [...sub.value.entries].some(([n, k]) => k === 'dir' && (!sub.value.links.has(n) || ['outside', 'git'].includes(sub.value.links.get(n))) && !skippedDir(n, { inChart: isChart(e) }))
    }
    return { ...e, name, hasFolders }
  })))
}

/**
 * Why an existing deployment at `rel` is where no new one can be made, for
 * the tree to flag: `{ nestedIn }` or `{ inCommon: true }`, or null.
 */
export async function placementOf(repo, rel) {
  const { nestedIn } = await contextOf(repo, rel)
  if (nestedIn) return { nestedIn }
  if (segmentsOf(rel).includes(COMMON_DIR)) return { inCommon: true }
  return null
}

/**
 * Why no new deployment can be made at `rel`, or null. An existing
 * deployment there is no problem: the caller finds it there. Refused:
 * anywhere the walk does not look (excludedFolder, a link on the way),
 * inside a `_common` folder, inside another deployment or `_common` chart,
 * around one (a folder that already has a deployment in it), and on a
 * folder that holds a `_common` (its deployments go in folders under it).
 */
export async function newDeploymentProblem(repo, rel) {
  const segments = segmentsOf(rel)
  const where = segments.join('/')
  const here = await folderEntry(repo, where)
  if (here.kind === 'deployment') return null
  // Made through a link, it would be somewhere else, or outside the repo.
  if (here.link) {
    const { at, to } = await linkOnTheWay(repo, where)
    const there = to ? `${to}${where.slice(at.length)}` : null
    const instead = there && await offeredPath(repo.root, there) ? `: make it in ${there}` : ''
    return `${where}: ${here.why} — a deployment is made in a folder of the repo, not through a link${instead}`
  }
  let inChart = false
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/')
    const excluded = await excludedFolder(repo, prefix, { inChart })
    if (excluded) return `${where}: a deployment there would not be seen — ${prefix} is ${excluded}, which AlertForge does not look into`
    inChart = isChart(await folderEntry(repo, prefix))
  }
  if (segments.includes(COMMON_DIR)) return `${where}: a deployment cannot be made inside a ${COMMON_DIR} folder — ${COMMON_DIR} holds what the deployments beside it inherit`
  for (let i = 1; i < segments.length; i++) {
    const above = segments.slice(0, i).join('/')
    const e = await folderEntry(repo, above)
    if (e.kind === 'common') return `${where}: a deployment cannot be made inside a ${COMMON_DIR} chart (${above})`
    if (e.kind === 'deployment') return `${where}: a deployment cannot be made inside another deployment (${above}) — make it in a folder beside it`
  }
  const dir = await repo.dir(where)
  if (dir.state === 'ok' && dir.value.entries.get(COMMON_DIR) === 'dir') return `${where}: this folder holds a ${COMMON_DIR} — its deployments go in folders under it (${where}/<name>), not on the folder itself`
  const below = (await walk(repo, { from: where })).find(d => d.kind === 'deployment')
  if (below) return `${where}: this folder already holds the deployment ${below.rel} — a deployment cannot hold another; make it in a folder of its own`
  return null
}

export async function isCommonChart(repo, rel) {
  return (await folderEntry(repo, rel)).kind === 'common'
}

/**
 * The first folder of the tree that is a link leading out of the repo (or
 * into git's own folder), as the walk names it, or null: a deployment
 * behind it cannot be read, so a change that has to reach every
 * deployment (a migration, the shared configs) is refused naming it
 * rather than leaving it behind.
 *   → { rel, why } | null
 */
export async function linkOutOfTree(repo) {
  const e = (await walk(repo, { hidden: true })).find(x => x.kind === 'unreadable' && x.cause === 'link')
  return e ? { rel: e.rel, why: e.why } : null
}

/** The refusal of a change that would leave a deployment behind a link out of the repo (linkOutOfTree). */
export const linkOutRefusal = ({ rel, why }, what) => ({ status: 409, body: {
  error: `${rel}: ${why} — a deployment behind it would be left ${what}: links made by hand are not followed; remove it in git, or make it a folder of the repo`,
  file: rel } })
