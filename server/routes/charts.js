import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts, copyDirRecursive } from '../lib/chartDiscovery.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function chartsRouter() {
  const router = express.Router()

  router.get('/', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    try {
      await fs.mkdir(chartsDir, { recursive: true })
      const charts = await findAlertTemplateCharts(chartsDir)
      res.json(charts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const { name } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const chartDir = path.join(chartsDir, name)
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      const chartYaml = yaml.dump({ apiVersion: 'v2', name, version: '0.1.0', type: 'application', annotations: { app: 'alertforge' } })
      await fs.writeFile(path.join(chartDir, 'Chart.yaml'), chartYaml, 'utf-8')
      await fs.writeFile(path.join(chartDir, 'values.yaml'), yaml.dump({}), 'utf-8')
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {}
      }
      await fs.writeFile(path.join(chartDir, 'values.schema.json'), JSON.stringify(emptySchema, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:name/clone', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const { name } = req.params
    const { newName } = req.body
    if (!NAME_RE.test(name) || !NAME_RE.test(newName)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const srcDir = path.join(chartsDir, name)
    const destDir = path.join(chartsDir, newName)
    try {
      await fs.access(srcDir)
      try {
        await fs.access(destDir)
        return res.status(409).json({ error: `Chart "${newName}" already exists` })
      } catch { /* good — destination does not exist */ }
      await copyDirRecursive(srcDir, destDir)
      const chartYamlFile = path.join(destDir, 'Chart.yaml')
      try {
        const raw = await fs.readFile(chartYamlFile, 'utf-8')
        const meta = yaml.load(raw) || {}
        meta.name = newName
        await fs.writeFile(chartYamlFile, yaml.dump(meta, { lineWidth: -1 }), 'utf-8')
      } catch { /* skip if no Chart.yaml */ }
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:name', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    if (!NAME_RE.test(req.params.name)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    const chartDir = path.join(chartsDir, req.params.name)
    try {
      await fs.rm(chartDir, { recursive: true, force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
