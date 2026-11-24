import { UnreadableError } from './readIfThere.js'
import path from 'path'
import { getDeploymentsDir } from './chartDiscovery.js'
import { walk } from '../repo/walk.js'
import { openRepo } from '../repo/openRepo.js'
import { resolveStack, linkedStackRefusal } from './stack.js'

/**
 * Which deployments are using a chart — see issue #57.
 *
 * This is what makes a breaking schema change a decision rather than a silent
 * rewrite, and it is what tells anyone whether an old chart is finally free to
 * retire. Nothing new is stored: the default layout puts the chart name in the
 * path, and a deployment in a folder names it in a Chart.yaml dependency.
 */

/**
 * deployments/<chart>/<name>-values.yaml, listed through the snapshot (so a
 * writer sees one made or removed before it writes). Only an absent folder
 * is empty; one that cannot be read throws, naming it: an empty result
 * reads as "no deployment uses this chart", which lets a breaking change
 * through without the dialog.
 */
async function fromDefaultLayout(gitopsDir, chart, deploymentsDirEnv, repo) {
  const dir = path.join(getDeploymentsDir(gitopsDir, deploymentsDirEnv), chart)
  const rel = path.relative(gitopsDir, dir).split(path.sep).join('/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return []
  const listed = await repo.dir(rel)
  if (listed.state === 'absent') return []
  if (listed.state !== 'ok') throw new UnreadableError(dir, { reason: listed.why })
  return [...listed.value.entries]
    .filter(([name, kind]) => kind === 'file' && name.endsWith('-values.yaml'))
    .map(([name]) => ({ chart, deployment: name.replace(/-values\.yaml$/, ''), path: `${rel}/${name}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * A deployment anywhere in the tree (the one walk: any depth, inside another
 * deployment too), a `_common` chart, or a folder with a Chart.yaml and no
 * values.yaml (`kind: 'chart-only'`: Helm deploys it with the Template's
 * example rows), that renders the chart: at the bottom of its `_common`
 * stack (#100), or as any of its Chart.yaml dependencies. Hidden folders
 * are looked into too (`hidden: true`): ArgoCD deploys whatever folder it
 * is pointed at. `keys` are the keys its values are wrapped under. Folders
 * that cannot be read, and deployments whose Chart.yaml cannot be (which
 * Template they use is not known), are returned apart.
 */
async function fromFolders(gitopsDir, chart, repo) {
  const found = []
  const unreadable = []
  for (const e of await walk(repo, { hidden: true })) {
    // A link out of the repo holds none of its deployments: not followed.
    if (e.kind === 'unreadable' && e.cause !== 'link') { unreadable.push({ path: e.rel || '.', error: e.why }); continue }
    if (e.kind !== 'deployment' && e.kind !== 'common' && !e.chartOnly) continue
    const d = { path: e.rel, kind: e.chartOnly ? 'chart-only' : e.kind }
    const dir = path.join(gitopsDir, d.path)
    const stack = await resolveStack(gitopsDir, dir, { repo })
    // A stack that does not reach its Template (a _common missing, a link
    // gone) still uses the one it is for: counted, and named as broken.
    const uses = stack.chart ?? stack.claims
    const keys = uses === chart ? stack.keys : stack.dependencyNames.includes(chart) ? [chart] : null
    if (!keys) continue
    const hidden = d.path.split('/').some(s => s.startsWith('.'))
    found.push({ chart, deployment: path.basename(d.path), path: d.path, keys,
      ...(d.kind === 'deployment' ? {} : { kind: d.kind }), ...(hidden ? { hidden: true } : {}),
      ...(!stack.chart && stack.problems.length ? { broken: stack.problems[0].description } : {}),
      // On a _common reached through a link made by hand: what a write that touches it answers.
      ...(linkedStackRefusal(stack, d.path) ? { linked: linkedStackRefusal(stack, d.path) } : {}) })
  }
  return { found, unreadable }
}

/**
 * Who uses `chart`: `{ deployments, unreadable }`, `unreadable` the folders
 * that could not be read (who is in them is not known). `repo` the snapshot
 * a writer's plan reads the folders through.
 */
export async function findChartUsage(gitopsDir, chart, deploymentsDirEnv, { repo = openRepo(gitopsDir) } = {}) {
  const [byPath, byDependency] = await Promise.all([
    fromDefaultLayout(gitopsDir, chart, deploymentsDirEnv, repo),
    fromFolders(gitopsDir, chart, repo)
  ])
  const seen = new Set()
  const deployments = [...byPath, ...byDependency.found].filter(d => {
    if (seen.has(d.path)) return false
    seen.add(d.path)
    return true
  })
  return { deployments, unreadable: byDependency.unreadable }
}

export async function findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv, opts) {
  return (await findChartUsage(gitopsDir, chart, deploymentsDirEnv, opts)).deployments
}
