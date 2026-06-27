import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { wrapValues, countAlerts } from '../lib/subchart.js'

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.cache'])

function isExcluded(name) {
  return EXCLUDED_DIRS.has(name) || name.startsWith('.')
}

async function listChildren(baseDir, parentPath) {
  const dir = parentPath ? path.join(baseDir, parentPath) : baseDir
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || isExcluded(e.name)) continue
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
    if (chartData && hasDeps && hasValues) {
      node.isDeployment = true
      node.chart = chartData.dependencies[0].name
      try {
        const valuesYaml = await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')
        node.alertCount = countAlerts(yaml.load(valuesYaml) || {}, node.chart)
      } catch { node.alertCount = 0 }
    }

    // Check if has subdirectories
    try {
      const subEntries = await fs.readdir(absPath, { withFileTypes: true })
      node.isLeaf = !subEntries.some(s => s.isDirectory() && !isExcluded(s.name))
    } catch {
      node.isLeaf = true
    }

    folders.push(node)
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

export default function foldersRouter() {
  const router = express.Router()

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
    if (!folderPath || folderPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    try {
      await fs.mkdir(path.join(req.gitopsDir, folderPath), { recursive: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/init', async (req, res) => {
    const { folder, chart } = req.body
    if (!folder || typeof folder !== 'string' || folder.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    if (!chart || typeof chart !== 'string' || chart.includes('..') || path.isAbsolute(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)

    try {
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
      const chartMeta = yaml.load(await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8'))
      const relPath = path.relative(deployDir, chartDir)

      const deployChart = {
        apiVersion: 'v2',
        name: path.basename(folder),
        version: '0.1.0',
        dependencies: [{
          name: chart,
          version: chartMeta.version || '0.1.0',
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
