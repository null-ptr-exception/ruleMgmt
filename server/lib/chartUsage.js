import fs from 'fs/promises'
import path from 'path'
import { getDeploymentsDir } from './chartDiscovery.js'
import { walkDeployments } from './deploymentWalk.js'
import { resolveStack } from './stack.js'

/**
 * Which deployments are using a chart — see issue #57.
 *
 * This is what makes a breaking schema change a decision rather than a silent
 * rewrite, and it is what tells anyone whether an old chart is finally free to
 * retire. Nothing new is stored: the default layout puts the chart name in the
 * path, and a deployment in a folder names it in a Chart.yaml dependency.
 */

// Only an absent directory is empty. Any other error has to surface: an
// empty result here reads as "no deployment uses this chart", which lets a
// breaking change through without the dialog.
async function readDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

/** deployments/<chart>/<name>-values.yaml */
async function fromDefaultLayout(gitopsDir, chart, deploymentsDirEnv) {
  const dir = path.join(getDeploymentsDir(gitopsDir, deploymentsDirEnv), chart)
  const entries = await readDir(dir)
  return entries
    .filter(e => e.isFile() && e.name.endsWith('-values.yaml'))
    .map(e => ({
      chart,
      deployment: e.name.replace(/-values\.yaml$/, ''),
      path: path.relative(gitopsDir, path.join(dir, e.name)).replace(/\\/g, '/')
    }))
}

/**
 * A deployment anywhere in the tree (the one walk: any depth, inside another
 * deployment too), a `_common` chart, or a folder with a Chart.yaml and no
 * values.yaml (`kind: 'chart-only'`: Helm deploys it with the Template's
 * example rows), that renders the chart: at the bottom of its `_common`
 * stack (#100), or as any of its Chart.yaml dependencies. Hidden folders
 * are looked into too (`hidden: true`): ArgoCD deploys whatever folder it
 * is pointed at. `keys` are the keys its values are wrapped under. Folders
 * that cannot be read are returned apart.
 */
async function fromFolders(gitopsDir, chart) {
  const found = []
  const unreadable = []
  for (const d of await walkDeployments(gitopsDir, { chartOnly: true, hidden: true })) {
    if (d.kind === 'unreadable') { unreadable.push({ path: d.path || '.', error: d.error }); continue }
    const dir = path.join(gitopsDir, d.path)
    const stack = await resolveStack(gitopsDir, dir)
    // A stack that does not reach its Template (a _common missing, a link
    // gone) still uses the one it is for: counted, and named as broken.
    const uses = stack.chart ?? stack.claims
    const keys = uses === chart ? stack.keys : stack.dependencyNames.includes(chart) ? [chart] : null
    if (!keys) continue
    const hidden = d.path.split('/').some(s => s.startsWith('.'))
    found.push({ chart, deployment: path.basename(d.path), path: d.path, keys,
      ...(d.kind === 'deployment' ? {} : { kind: d.kind }), ...(hidden ? { hidden: true } : {}),
      ...(!stack.chart && stack.problems.length ? { broken: stack.problems[0].description } : {}) })
  }
  return { found, unreadable }
}

/**
 * Who uses `chart`: `{ deployments, unreadable }`, `unreadable` the folders
 * that could not be read (who is in them is not known).
 */
export async function findChartUsage(gitopsDir, chart, deploymentsDirEnv) {
  const [byPath, byDependency] = await Promise.all([
    fromDefaultLayout(gitopsDir, chart, deploymentsDirEnv),
    fromFolders(gitopsDir, chart)
  ])
  const seen = new Set()
  const deployments = [...byPath, ...byDependency.found].filter(d => {
    if (seen.has(d.path)) return false
    seen.add(d.path)
    return true
  })
  return { deployments, unreadable: byDependency.unreadable }
}

export async function findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv) {
  return (await findChartUsage(gitopsDir, chart, deploymentsDirEnv)).deployments
}
