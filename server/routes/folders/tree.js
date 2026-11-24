/** The folder tree and the flat list of deployments (sync's dialogs). */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { countAlerts } from '../../lib/subchart.js'
import { isDeploymentDir, isCommonChartDir } from '../../lib/sync.js'
import { walkDeployments, skippedDir, placementOf } from '../../lib/deploymentWalk.js'
import { resolveStack } from '../../lib/stack.js'
import { inSharedDir, SHARED_DIR } from '../../lib/sharedConfigs.js'
import { folderCommonOf, folderCommons, inheritsFromOf } from '../../lib/commonEdit.js'
import { isRepoPath } from '../../lib/safePath.js'
import { loadValues } from '../../../src/utils/valuesText.js'

async function listChildren(baseDir, parentPath) {
  const dir = parentPath ? path.join(baseDir, parentPath) : baseDir
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Inside a deployment or a `_common` chart, its own templates/ and
  // charts/ are no folders of the tree — the walk's rules (deploymentWalk).
  const inChart = parentPath ? (await isDeploymentDir(dir) || await isCommonChartDir(dir)) : false
  // The shared notification configs' folder (#123) is no folder of the tree
  // — unless it is one of the repo's own, with other things in it.
  const hideShared = !parentPath && await inSharedDir(baseDir, SHARED_DIR)

  // Every deployment in it has the same folders above it: each asked once.
  const folderCommonHere = folderCommons(baseDir, parentPath || '.')
  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || skippedDir(e.name, { inChart })) continue
    if (hideShared && e.name === SHARED_DIR) continue
    const nodePath = parentPath ? `${parentPath}/${e.name}` : e.name
    const absPath = path.join(baseDir, nodePath)

    const node = { name: e.name, path: nodePath }

    // Check if deployment (Chart.yaml + dependencies + values.yaml)
    let chartData = null
    try {
      const chartYaml = await fs.readFile(path.join(absPath, 'Chart.yaml'), 'utf-8')
      chartData = yaml.load(chartYaml) || {}
    } catch { /* no Chart.yaml */ }

    let hasValues = false
    try {
      await fs.access(path.join(absPath, 'values.yaml'))
      hasValues = true
    } catch { /* no values.yaml */ }

    const hasDeps = chartData && Array.isArray(chartData.dependencies) && chartData.dependencies.length > 0
    const isCommon = await isCommonChartDir(absPath)
    if (isCommon) {
      node.isCommon = true
      // The Template it is for, which its page opens (#101).
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || stack.claims || e.name
      if (stack.problems.length) node.problems = stack.problems.map(p => p.description)
    }
    // Helm deploys it with the Template's example rows: flagged, and
    // counted as using its Template (a breaking change, a chart's delete).
    if (chartData && hasDeps && !hasValues && !isCommon) {
      node.noValues = true
      node.chart = (await resolveStack(baseDir, absPath)).chart || chartData.dependencies[0]?.name
    }
    if (chartData && hasDeps && hasValues && !isCommon) {
      node.isDeployment = true
      // The Template at the bottom of its `_common` stack (#100), which
      // Preview and the editor open: not the `_common` chart it names.
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || chartData.dependencies[0].name
      // The _common it renders on, and the one its folder has (#103): a sync
      // target follows its source's, which may be another.
      node.inheritsFrom = inheritsFromOf(stack)
      node.folderCommon = await folderCommonHere(stack.chart || stack.claims)
      try {
        const valuesYaml = await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')
        node.alertCount = countAlerts(loadValues(valuesYaml) || {}, stack.keys.length ? stack.keys : node.chart)
      } catch { node.alertCount = 0 }
      // Where no new deployment can be made (inside another, inside a
      // _common folder): still shown and used, and flagged.
      const placement = await placementOf(baseDir, nodePath)
      if (placement) Object.assign(node, placement)
    }

    // Check if has subdirectories
    try {
      const subEntries = await fs.readdir(absPath, { withFileTypes: true })
      node.isLeaf = !subEntries.some(s => s.isDirectory() && !skippedDir(s.name, { inChart: node.isDeployment || isCommon }))
    } catch (err) {
      node.isLeaf = true
      // Nothing in it is listed, checked or migrated: said in the tree.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') node.unreadable = err?.code || 'error'
    }

    folders.push(node)
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

// Every deployment in the repo, flat — the Sync to/from modals' candidate
// lists. The one walk (deploymentWalk), so one inside another, or deeper
// than a few folders, is a candidate like any other. Deliberately not
// cached: this only runs when a sync modal opens, so a fresh scan each time
// is simplest and cannot drift from the filesystem.
// `chart`: the folders' _common is looked up for it — the Sync to dialog's
// source's Template, which a target renders (#103) — else each one's own.
async function collectDeployments(baseDir, chartFor = null) {
  const results = []
  for (const d of await walkDeployments(baseDir)) {
    if (d.kind !== 'deployment') continue
    const absPath = path.join(baseDir, d.path)
    let chart = null
    // null when values.yaml cannot be read: unknown, not none.
    let alertCount = null
    let inheritsFrom = null
    let folderCommon = null
    try {
      const stack = await resolveStack(baseDir, absPath)
      chart = stack.chart
      inheritsFrom = inheritsFromOf(stack)
      folderCommon = await folderCommonOf(baseDir, d.path, chartFor || chart || stack.claims)
      const valuesYaml = loadValues(await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')) || {}
      alertCount = countAlerts(valuesYaml, stack.keys)
    } catch { /* leave defaults */ }
    results.push({ name: path.basename(d.path), path: d.path, chart, alertCount, inheritsFrom, folderCommon })
  }
  return results
}

export function treeRoutes(router) {
  router.get('/tree', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath && !isRepoPath(parentPath, { hidden: true })) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/deployments', async (req, res) => {
    try {
      const chart = typeof req.query.chart === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(req.query.chart) ? req.query.chart : null
      res.json(await collectDeployments(req.gitopsDir, chart))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath && !isRepoPath(parentPath, { hidden: true })) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}
