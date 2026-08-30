import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'

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

  // Clone a chart.
  //
  // This is how a breaking change gets made without touching anyone: the copy
  // is edited, the original keeps working, and each rule owner moves over when
  // they are ready. The mapping their rows need is declared here, by the person
  // making the change — nobody else knows whether a column was renamed or
  // dropped — and is stored on the clone as x-migrated-from.
  router.post('/:name/clone', async (req, res) => {
    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const { newName, migration } = req.body
    if (!NAME_RE.test(req.params.name) || !NAME_RE.test(newName || '')) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }

    const source = path.join(chartsDir, req.params.name)
    const target = path.join(chartsDir, newName)
    try {
      try {
        await fs.access(target)
        return res.status(409).json({ error: `Chart ${newName} already exists` })
      } catch {
        // Not there yet, which is what we want.
      }

      await fs.cp(source, target, { recursive: true })

      const chartYamlFile = path.join(target, 'Chart.yaml')
      const chartYaml = yaml.load(await fs.readFile(chartYamlFile, 'utf-8')) || {}
      chartYaml.name = newName
      await fs.writeFile(chartYamlFile, yaml.dump(chartYaml), 'utf-8')

      const schemaFile = path.join(target, 'values.schema.json')
      const schema = JSON.parse(await fs.readFile(schemaFile, 'utf-8'))
      schema['x-migrated-from'] = { chart: req.params.name, ...(migration || {}) }
      await fs.writeFile(schemaFile, JSON.stringify(schema, null, 2), 'utf-8')

      res.json({ ok: true, chart: newName })
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
