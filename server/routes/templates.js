import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

export default function templatesRouter(gitopsDir) {
  const router = express.Router()
  const chartsDir = path.join(gitopsDir, 'charts')

  function chartPaths(chart) {
    const chartDir = path.join(chartsDir, chart)
    return {
      chartDir,
      tmplDir: path.join(chartDir, 'templates'),
      valuesFile: path.join(chartDir, 'values.yaml'),
    }
  }

  async function readMeta(valuesFile) {
    try {
      const raw = await fs.readFile(valuesFile, 'utf-8')
      const parsed = yaml.load(raw) || {}
      return parsed._meta || {}
    } catch {
      return {}
    }
  }

  async function writeMeta(valuesFile, meta) {
    let parsed = {}
    try {
      const raw = await fs.readFile(valuesFile, 'utf-8')
      parsed = yaml.load(raw) || {}
    } catch { /* file may not exist */ }
    parsed._meta = meta
    await fs.writeFile(valuesFile, yaml.dump(parsed, { lineWidth: -1 }), 'utf-8')
  }

  // List templates in a chart → [{ name, description, vars }]
  router.get('/:chart', async (req, res) => {
    const { tmplDir, valuesFile } = chartPaths(req.params.chart)
    try {
      const files = await fs.readdir(tmplDir)
      const meta = await readMeta(valuesFile)
      const templates = files
        .filter(f => f.endsWith('.yaml'))
        .map(f => {
          const name = f.replace(/\.yaml$/, '')
          const tmplMeta = meta[name] || {}
          return {
            name,
            description: tmplMeta.description || '',
            vars: tmplMeta.vars || [],
          }
        })
      res.json(templates)
    } catch {
      res.json([])
    }
  })

  // Get template content + metadata
  router.get('/:chart/:template', async (req, res) => {
    const { tmplDir, valuesFile } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      const content = await fs.readFile(tmplFile, 'utf-8')
      const meta = await readMeta(valuesFile)
      res.json({ content, meta: meta[req.params.template] || {} })
    } catch {
      res.status(404).json({ error: 'Template not found' })
    }
  })

  // Save template content + metadata
  router.post('/:chart/:template', async (req, res) => {
    const { tmplDir, valuesFile } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const { content, meta: tmplMeta } = req.body
    try {
      await fs.mkdir(tmplDir, { recursive: true })
      await fs.writeFile(tmplFile, content, 'utf-8')
      if (tmplMeta !== undefined) {
        const meta = await readMeta(valuesFile)
        meta[req.params.template] = tmplMeta
        await writeMeta(valuesFile, meta)
      }
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete template
  router.delete('/:chart/:template', async (req, res) => {
    const { tmplDir, valuesFile } = chartPaths(req.params.chart)
    const tmplFile = path.join(tmplDir, `${req.params.template}.yaml`)
    try {
      await fs.rm(tmplFile, { force: true })
      const meta = await readMeta(valuesFile)
      delete meta[req.params.template]
      await writeMeta(valuesFile, meta)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Rename template
  router.post('/:chart/:template/rename', async (req, res) => {
    const { tmplDir, valuesFile } = chartPaths(req.params.chart)
    const { newName } = req.body
    if (!newName) {
      return res.status(400).json({ error: 'newName is required' })
    }
    const oldFile = path.join(tmplDir, `${req.params.template}.yaml`)
    const newFile = path.join(tmplDir, `${newName}.yaml`)
    try {
      await fs.rename(oldFile, newFile)
      const meta = await readMeta(valuesFile)
      if (meta[req.params.template]) {
        meta[newName] = meta[req.params.template]
        delete meta[req.params.template]
        await writeMeta(valuesFile, meta)
      }
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
