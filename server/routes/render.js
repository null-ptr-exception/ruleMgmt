import express from 'express'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { execFile } from 'child_process'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

// Build a temp directory that mirrors the gitops structure so helm dependency
// build writes Chart.lock and charts/ to /tmp instead of the real working tree.
// Top-level gitops dirs other than the source's own first path segment are
// symlinked so that file:// relative paths in Chart.yaml still resolve.
async function buildTempSourceDir(gitopsDir, sourceDir) {
  const sourceRelPath = path.relative(gitopsDir, sourceDir)
  const firstSeg = sourceRelPath.split(path.sep)[0]

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'alertforge-render-'))
  try {
    const tmpSourceDir = path.join(tmpRoot, sourceRelPath)
    await fs.mkdir(tmpSourceDir, { recursive: true })

    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (entry.name === 'charts' || entry.name === 'Chart.lock') continue
      const src = path.join(sourceDir, entry.name)
      const dst = path.join(tmpSourceDir, entry.name)
      if (entry.isDirectory()) {
        await fs.cp(src, dst, { recursive: true })
      } else {
        await fs.copyFile(src, dst)
      }
    }

    for (const entry of await fs.readdir(gitopsDir)) {
      if (entry === firstSeg) continue
      await fs.symlink(path.join(gitopsDir, entry), path.join(tmpRoot, entry))
    }

    return { tmpRoot, tmpSourceDir }
  } catch (e) {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    throw e
  }
}

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const { chart, deployment } = req.params
    const folder = req.query.folder
    const deploymentValid = folder
      ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
      : NAME_RE.test(deployment)
    if (!NAME_RE.test(chart) || !deploymentValid) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }

    let deploymentsDir
    if (folder) {
      if (folder.includes('..')) return res.status(400).json({ error: 'Invalid folder path' })
      deploymentsDir = path.join(req.gitopsDir, folder)
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    const chartDir = path.join(chartsDir, chart)
    const releaseName = `${chart}-${deployment}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const helm = process.env.HELM_BIN || 'helm'
    const sourceDir = folder ? deploymentsDir : chartDir

    let tmpRoot
    try {
      const { tmpRoot: root, tmpSourceDir } = await buildTempSourceDir(req.gitopsDir, sourceDir)
      tmpRoot = root

      await new Promise((resolve, reject) => {
        execFile(helm, ['dependency', 'build', tmpSourceDir], { timeout: 120000 }, (err) => {
          if (err) reject(new Error(err.message))
          else resolve()
        })
      })

      const templateArgs = folder
        ? ['template', releaseName, tmpSourceDir]
        : ['template', releaseName, tmpSourceDir, '-f', path.join(deploymentsDir, `${deployment}-values.yaml`)]

      const output = await new Promise((resolve, reject) => {
        execFile(helm, templateArgs, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || stdout || err.message))
          else resolve(stdout)
        })
      })
      res.json({ ok: true, output })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    } finally {
      if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  return router
}
