import express from 'express'
import { holdSyncRegistryLock } from '../lib/sync.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { wrapValues, countAlerts } from '../lib/subchart.js'
import { isDeploymentDir, isCommonChartDir, isSafeSyncPath } from '../lib/sync.js'
import { walkDeployments, skippedDir, placementOf, newDeploymentProblem } from '../lib/deploymentWalk.js'
import { newReservedSegment, reservedError } from '../lib/reservedNames.js'
import { inSharedDir, SHARED_DIR } from '../lib/sharedConfigs.js'

// What a new deployment asks of its Template's version: any.
export const ANY_TEMPLATE_VERSION = '>=0.0.0-0'

function chartsDirName() {
  return process.env.CHARTS_DIR || 'charts'
}

// isSafeSyncPath's first-segment string check can be bypassed by an
// equivalent CHARTS_DIR spelling (e.g. './charts', 'charts/'), so also
// verify the resolved target isn't the charts dir or a descendant of it.
function isSafeFolderPath(candidate, gitopsDir) {
  if (!isSafeSyncPath(candidate, chartsDirName())) return false

  const targetDir = path.resolve(gitopsDir, candidate)
  const chartsDir = path.resolve(getChartsDir(gitopsDir, process.env.CHARTS_DIR))
  const relative = path.relative(chartsDir, targetDir)
  const isSameOrChild = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  return !isSameOrChild
}

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
    if (isCommon) node.isCommon = true
    if (chartData && hasDeps && hasValues && !isCommon) {
      node.isDeployment = true
      node.chart = chartData.dependencies[0].name
      try {
        const valuesYaml = await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')
        node.alertCount = countAlerts(yaml.load(valuesYaml) || {}, node.chart)
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
    } catch {
      node.isLeaf = true
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
async function collectDeployments(baseDir) {
  const results = []
  for (const d of await walkDeployments(baseDir)) {
    if (d.kind !== 'deployment') continue
    const absPath = path.join(baseDir, d.path)
    let chart = null
    // null when values.yaml cannot be read: unknown, not none.
    let alertCount = null
    try {
      const chartYaml = yaml.load(await fs.readFile(path.join(absPath, 'Chart.yaml'), 'utf-8')) || {}
      chart = chartYaml.dependencies?.[0]?.name || null
      const valuesYaml = yaml.load(await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')) || {}
      alertCount = countAlerts(valuesYaml, chart)
    } catch { /* leave defaults */ }
    results.push({ name: path.basename(d.path), path: d.path, chart, alertCount })
  }
  return results
}

export default function foldersRouter() {
  const router = express.Router()
  router.use(holdSyncRegistryLock)

  router.get('/tree', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath.includes('..')) {
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
      res.json(await collectDeployments(req.gitopsDir))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const { path: folderPath } = req.body
    if (!isSafeFolderPath(folderPath, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    try {
      const reserved = await newReservedSegment(req.gitopsDir, folderPath)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      await fs.mkdir(path.join(req.gitopsDir, folderPath), { recursive: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/init', async (req, res) => {
    const { folder, chart } = req.body
    if (!isSafeFolderPath(folder, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    if (!chart || typeof chart !== 'string' || chart.includes('..') || path.isAbsolute(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)

    try {
      const reserved = await newReservedSegment(req.gitopsDir, folder)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      const misplaced = await newDeploymentProblem(req.gitopsDir, folder)
      if (misplaced) return res.status(400).json({ error: misplaced })
      // A deployment already there is never written over, whatever it
      // depends on: its Chart.yaml and values.yaml are someone's.
      if (await isDeploymentDir(deployDir)) {
        const existing = yaml.load(await fs.readFile(path.join(deployDir, 'Chart.yaml'), 'utf-8')) || {}
        return res.json({ status: 'existing', chart: existing.dependencies?.[0]?.name ?? null })
      }
      await fs.mkdir(deployDir, { recursive: true })

      try {
        const existingChartYaml = await fs.readFile(path.join(deployDir, 'Chart.yaml'), 'utf-8')
        const existing = yaml.load(existingChartYaml) || {}
        if (existing.dependencies) {
          const alertCharts = await findAlertTemplateCharts(chartsDir)
          const alertChartNames = new Set(alertCharts.map(c => c.name))
          for (const dep of existing.dependencies) {
            if (alertChartNames.has(dep.name)) {
              return res.json({ status: 'existing', chart: dep.name })
            }
          }
        }
      } catch { /* no existing Chart.yaml */ }

      const chartDir = path.join(chartsDir, chart)
      // The Template has to be there, and readable; its version is not
      // copied (below).
      yaml.load(await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8'))
      // Helm reads this as a URL, and the file is committed and rendered on
      // Linux even when it was written on Windows, so the separator has to be
      // a forward slash regardless of the platform that produced it.
      const relPath = path.relative(deployDir, chartDir).replace(/\\/g, '/')

      const deployChart = {
        apiVersion: 'v2',
        name: path.basename(folder),
        version: '0.1.0',
        // Any version of the Template, pre-releases too: there is one
        // copy of it, so an exact version only breaks every deployment the
        // day the Template's changes, by hand or by a pull. Read the same by
        // Helm 3.12 and 3.15 (one semver library).
        dependencies: [{
          name: chart,
          version: ANY_TEMPLATE_VERSION,
          repository: `file://${relPath}`,
        }]
      }
      await fs.writeFile(path.join(deployDir, 'Chart.yaml'), yaml.dump(deployChart, { lineWidth: -1 }), 'utf-8')

      let emptyValues = {}
      try {
        const defaults = yaml.load(await fs.readFile(path.join(chartDir, 'values.yaml'), 'utf-8')) || {}
        for (const [key, val] of Object.entries(defaults)) {
          if (Array.isArray(val)) emptyValues[key] = []
        }
      } catch { /* no default values */ }
      const wrapped = wrapValues(emptyValues, chart)
      await fs.writeFile(path.join(deployDir, 'values.yaml'), yaml.dump(wrapped, { lineWidth: -1 }), 'utf-8')

      res.json({ status: 'created', chart, folder })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
