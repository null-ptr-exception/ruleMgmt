import fs from 'fs/promises'
import path from 'path'
import { getDeploymentsDir } from './chartDiscovery.js'
import yaml from 'js-yaml'
import { walkDeployments } from './deploymentWalk.js'

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
 * deployment too), or a `_common` chart, bound through any of its Chart.yaml
 * dependencies. `depName` is the dependency the values are wrapped under.
 */
async function fromFolders(gitopsDir, chart) {
  const found = []
  for (const d of await walkDeployments(gitopsDir)) {
    const dir = path.join(gitopsDir, d.path)
    const dependencies = await dependencyNames(dir)
    if (!dependencies.includes(chart)) continue
    found.push({ chart, deployment: path.basename(d.path), path: d.path, depName: chart, ...(d.kind === 'common' ? { kind: 'common' } : {}) })
  }
  return found
}

// Every dependency's name in a folder's Chart.yaml; none when it has none or
// cannot be read (the walk read it a moment ago).
async function dependencyNames(dir) {
  try {
    const chartYaml = yaml.load(await fs.readFile(path.join(dir, 'Chart.yaml'), 'utf-8'))
    const deps = Array.isArray(chartYaml?.dependencies) ? chartYaml.dependencies : []
    return deps.map(d => d?.name).filter(n => typeof n === 'string')
  } catch {
    return []
  }
}

export async function findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv) {
  const [byPath, byDependency] = await Promise.all([
    fromDefaultLayout(gitopsDir, chart, deploymentsDirEnv),
    fromFolders(gitopsDir, chart)
  ])
  const seen = new Set()
  return [...byPath, ...byDependency].filter(d => {
    if (seen.has(d.path)) return false
    seen.add(d.path)
    return true
  })
}
