import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.cache'])

async function readFolderTree(dir, depth = 0) {
  if (depth > 5) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || EXCLUDED_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const children = await readFolderTree(path.join(dir, e.name), depth + 1)
    folders.push({ name: e.name, children })
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

export default function foldersRouter() {
  const router = express.Router()

  router.get('/', async (req, res) => {
    try {
      const tree = await readFolderTree(req.gitopsDir)
      res.json(tree)
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
    if (!folder || folder.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    if (!chart) {
      return res.status(400).json({ error: 'chart name required' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)

    try {
      await fs.mkdir(deployDir, { recursive: true })

      // Check if folder already has a Chart.yaml with an alert-template dependency
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

      // Read chart template info
      const chartDir = path.join(chartsDir, chart)
      const chartMeta = yaml.load(await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8'))

      // Compute relative path from deploy folder to chart folder
      const relPath = path.relative(deployDir, chartDir)

      // Scaffold Chart.yaml
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

      // Scaffold values.yaml from chart defaults
      let defaultValues = ''
      try {
        defaultValues = await fs.readFile(path.join(chartDir, 'values.yaml'), 'utf-8')
      } catch { /* no default values */ }
      await fs.writeFile(path.join(deployDir, 'values.yaml'), defaultValues, 'utf-8')

      res.json({ status: 'created', chart, folder })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
