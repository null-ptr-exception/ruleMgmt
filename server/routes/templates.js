import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function templatesRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  function chartPaths(req, chart) {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const chartDir = path.join(chartsDir, chart)
    return {
      chartDir,
      tmplDir: path.join(chartDir, 'templates'),
      valuesFile: path.join(chartDir, 'values.yaml'),
      schemaFile: path.join(chartDir, 'values.schema.json'),
      chartYamlFile: path.join(chartDir, 'Chart.yaml'),
    }
  }

  async function readSchema(schemaFile) {
    try {
      const raw = await fs.readFile(schemaFile, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  // Get chart-level info: schema + values + Chart.yaml metadata + template file list
  router.get('/:chart', async (req, res) => {
    const { tmplDir, valuesFile, schemaFile, chartYamlFile } = chartPaths(req, req.params.chart)
    try {
      let templateFiles = []
      try {
        const files = await fs.readdir(tmplDir)
        templateFiles = files.filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))
      } catch { /* no templates dir */ }

      const schema = await readSchema(schemaFile)

      let values = {}
      try {
        const raw = await fs.readFile(valuesFile, 'utf-8')
        values = yaml.load(raw) || {}
      } catch { /* use default */ }

      let chartMeta = {}
      try {
        const raw = await fs.readFile(chartYamlFile, 'utf-8')
        chartMeta = yaml.load(raw) || {}
      } catch { /* use default */ }

      res.json({ templateFiles, schema, values, chartMeta })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // --- Chart-level endpoints (must be before /:chart/:template) ---

  // Save chart-level schema
  router.post('/:chart/schema', async (req, res) => {
    const { schemaFile } = chartPaths(req, req.params.chart)
    const { schema } = req.body
    try {
      await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save chart-level default values
  router.post('/:chart/values', async (req, res) => {
    const { valuesFile } = chartPaths(req, req.params.chart)
    const { values } = req.body
    try {
      const content = typeof values === 'string' ? values : yaml.dump(values, { lineWidth: -1 })
      await fs.writeFile(valuesFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Save Chart.yaml metadata (name, description, version)
  router.post('/:chart/chart-meta', async (req, res) => {
    const { chartYamlFile } = chartPaths(req, req.params.chart)
    const { chartMeta } = req.body
    try {
      await fs.writeFile(chartYamlFile, yaml.dump(chartMeta, { lineWidth: -1 }), 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Rename a template file
  router.post('/:chart/:template/rename', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const { newName } = req.body
    if (!newName || !NAME_RE.test(newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const oldFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const newFile = path.join(tmplDir, `${newName}.yaml`)
    try {
      await fs.rename(oldFile, newFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // --- Template file endpoints ---

  // Get a single template file's content
  router.get('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      const content = await fs.readFile(tmplFile, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'Template not found' })
    }
  })

  // Save a template file's content
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(tmplFile, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete a template file
  router.delete('/:chart/:template', async (req, res) => {
    const { tmplDir } = chartPaths(req, req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      await fs.rm(tmplFile, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
