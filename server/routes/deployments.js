import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function deploymentsRouter(gitopsDir) {
  const router = express.Router()
  const deploymentsDir = path.join(gitopsDir, 'deployments')

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  // List deployments for a chart
  router.get('/:chart', async (req, res) => {
    const dir = path.join(deploymentsDir, req.params.chart)
    try {
      await fs.mkdir(dir, { recursive: true })
      const files = await fs.readdir(dir)
      const deployments = []
      for (const f of files) {
        if (!f.endsWith('-values.yaml')) continue
        const name = f.replace(/-values\.yaml$/, '')
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8')
          const parsed = yaml.load(raw) || {}
          for (const [key, value] of Object.entries(parsed)) {
            if (key === '_meta') continue
            if (Array.isArray(value)) alertCount += value.length
          }
        } catch { /* skip unreadable */ }
        deployments.push({ name, file: f, alertCount })
      }
      res.json(deployments)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Get deployment values
  router.get('/:chart/:deployment', async (req, res) => {
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(deploymentsDir, req.params.chart, `${req.params.deployment}-values.yaml`)
    try {
      const content = await fs.readFile(file, 'utf-8')
      res.json({ content, parsed: yaml.load(content) })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  // Save deployment values
  router.post('/:chart/:deployment', async (req, res) => {
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const dir = path.join(deploymentsDir, req.params.chart)
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      await fs.mkdir(dir, { recursive: true })
      const content = typeof req.body.values === 'string' ? req.body.values : yaml.dump(req.body.values, { lineWidth: -1 })
      await fs.writeFile(file, content, 'utf-8')
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Clone a deployment
  router.post('/:chart/:deployment/clone', async (req, res) => {
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (!req.body.newName || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const dir = path.join(deploymentsDir, req.params.chart)
    const srcFile = path.join(dir, `${req.params.deployment}-values.yaml`)
    const dstFile = path.join(dir, `${req.body.newName}-values.yaml`)
    try {
      await fs.copyFile(srcFile, dstFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Delete deployment
  router.delete('/:chart/:deployment', async (req, res) => {
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(deploymentsDir, req.params.chart, `${req.params.deployment}-values.yaml`)
    try {
      await fs.rm(file, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
