import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

function resolveDeploymentDir(req) {
  const folder = req.query.folder
  if (folder) {
    if (folder.includes('..')) return null
    return path.join(req.gitopsDir, folder)
  }
  const deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments')
  return path.join(deploymentsDir, req.params.chart)
}

export default function deploymentsRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  router.get('/:chart', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
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
          for (const val of Object.values(parsed)) {
            if (Array.isArray(val)) alertCount += val.length
          }
        } catch { /* skip unreadable */ }
        deployments.push({ name, file: f, alertCount })
      }
      res.json(deployments)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      const content = await fs.readFile(file, 'utf-8')
      res.json({ content, parsed: yaml.load(content) })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
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

  router.post('/:chart/:deployment/clone', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (!req.body.newName || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const srcFile = path.join(dir, `${req.params.deployment}-values.yaml`)
    const dstFile = path.join(dir, `${req.body.newName}-values.yaml`)
    try {
      await fs.copyFile(srcFile, dstFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!NAME_RE.test(req.params.deployment)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      await fs.rm(file, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
