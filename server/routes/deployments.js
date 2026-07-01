import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getDepName, wrapValues, unwrapValues, countAlerts } from '../lib/subchart.js'
import { readSyncRegistry, writeSyncRegistry, getTargetsForSource, isTarget, applyUnlink } from '../lib/sync.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

function isValidDeploymentParam(req) {
  const deployment = req.params.deployment
  return req.query.folder
    ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
    : NAME_RE.test(deployment)
}

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
      const depName = await getDepName(dir)

      if (files.includes('values.yaml')) {
        const folderName = path.basename(dir)
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, 'values.yaml'), 'utf-8')
          alertCount = countAlerts(yaml.load(raw) || {}, depName)
        } catch { /* skip unreadable */ }
        deployments.push({ name: folderName, file: 'values.yaml', alertCount })
      }

      for (const f of files) {
        if (!f.endsWith('-values.yaml')) continue
        const name = f.replace(/-values\.yaml$/, '')
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8')
          alertCount = countAlerts(yaml.load(raw) || {}, depName)
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
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const legacyFile = path.join(dir, `${req.params.deployment}-values.yaml`)
    const directFile = path.join(dir, 'values.yaml')
    try {
      let file = legacyFile
      try { await fs.access(legacyFile) } catch { file = directFile }
      const content = await fs.readFile(file, 'utf-8')
      const parsed = unwrapValues(yaml.load(content) || {}, await getDepName(dir))
      res.json({ content, parsed })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const folder = req.query.folder
    const legacyFile = path.join(dir, `${req.params.deployment}-values.yaml`)
    const directFile = path.join(dir, 'values.yaml')
    try {
      await fs.mkdir(dir, { recursive: true })
      let file = legacyFile
      try { await fs.access(directFile); file = directFile } catch { /* use legacy */ }
      let values = req.body.values
      if (typeof values !== 'string') {
        const depName = await getDepName(dir)
        values = yaml.dump(wrapValues(values, depName), { lineWidth: -1 })
      }
      await fs.writeFile(file, values, 'utf-8')

      // Eager sync: only folder-mode deployments participate (sync.yaml
      // paths are folder-relative, matching the `folder` query param).
      if (folder) {
        const registry = await readSyncRegistry(req.gitopsDir)
        const targets = getTargetsForSource(registry, folder)
        for (const target of targets) {
          try {
            const targetDir = path.join(req.gitopsDir, target)
            await fs.mkdir(targetDir, { recursive: true })
            await fs.writeFile(path.join(targetDir, 'values.yaml'), values, 'utf-8')
          } catch { /* best-effort — one failing target doesn't undo the source save */ }
        }
      }

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/:deployment/clone', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
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
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const file = path.join(dir, `${req.params.deployment}-values.yaml`)
    try {
      const folder = req.query.folder
      if (folder) {
        const registry = await readSyncRegistry(req.gitopsDir)
        if (isTarget(registry, folder)) {
          applyUnlink(registry, folder)
          await writeSyncRegistry(req.gitopsDir, registry)
        }
      }
      await fs.rm(file, { force: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
