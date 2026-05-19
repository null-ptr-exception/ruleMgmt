import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function chartsRouter() {
  const router = express.Router()

  // List all charts → [{ name, templateCount }]
  router.get('/', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    try {
      await fs.mkdir(chartsDir, { recursive: true })
      const entries = await fs.readdir(chartsDir, { withFileTypes: true })
      const charts = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const tmplDir = path.join(chartsDir, e.name, 'templates')
        let templateCount = 0
        try {
          const files = await fs.readdir(tmplDir)
          templateCount = files.filter(f => f.endsWith('.yaml')).length
        } catch { /* no templates dir */ }
        charts.push({ name: e.name, templateCount })
      }
      res.json(charts)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Create a new chart
  router.post('/', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const { name } = req.body
    if (!name || !NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid chart name. Must match ^[a-z0-9][a-z0-9_-]*$' })
    }
    const chartDir = path.join(chartsDir, name)
    try {
      await fs.mkdir(path.join(chartDir, 'templates'), { recursive: true })
      const chartYaml = yaml.dump({ apiVersion: 'v2', name, version: '0.1.0', type: 'application' })
      await fs.writeFile(path.join(chartDir, 'Chart.yaml'), chartYaml, 'utf-8')
      await fs.writeFile(
        path.join(chartDir, 'values.yaml'),
        yaml.dump({}),
        'utf-8'
      )
      const emptySchema = {
        $schema: 'https://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {}
      }
      await fs.writeFile(
        path.join(chartDir, 'values.schema.json'),
        JSON.stringify(emptySchema, null, 2),
        'utf-8'
      )
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete a chart
  router.delete('/:name', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
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
