import fs from 'fs/promises'
import path from 'path'
import { getDeploymentsDir } from './chartDiscovery.js'
import { getDepName } from './subchart.js'

/**
 * Which deployments are using a chart — see issue #57.
 *
 * This is what makes a breaking schema change a decision rather than a silent
 * rewrite, and it is what tells anyone whether an old chart is finally free to
 * retire. Nothing new is stored: the default layout puts the chart name in the
 * path, and a deployment in a folder names it in Chart.yaml's first dependency.
 */

const SKIP = new Set(['.git', 'node_modules', 'charts'])
const MAX_DEPTH = 4

async function readDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
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

/** A deployment anywhere in the tree, bound through Chart.yaml's dependency. */
async function fromFolders(gitopsDir, chart, dir = gitopsDir, depth = 0) {
  if (depth > MAX_DEPTH) return []
  const found = []
  for (const entry of await readDir(dir)) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue
    const child = path.join(dir, entry.name)
    if (await getDepName(child) === chart) {
      found.push({
        chart,
        deployment: entry.name,
        path: path.relative(gitopsDir, child).replace(/\\/g, '/')
      })
      continue
    }
    found.push(...await fromFolders(gitopsDir, chart, child, depth + 1))
  }
  return found
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
