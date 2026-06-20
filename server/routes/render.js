import express from 'express'
import path from 'path'
import { execFile } from 'child_process'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/


export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, process.env.CHARTS_DIR || 'charts')
    const { chart, deployment } = req.params
    if (!NAME_RE.test(chart) || !NAME_RE.test(deployment)) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }

    let deploymentsDir
    const folder = req.query.folder
    if (folder) {
      if (folder.includes('..')) return res.status(400).json({ error: 'Invalid folder path' })
      deploymentsDir = path.join(req.gitopsDir, folder)
    } else {
      deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    }

    const chartDir = path.join(chartsDir, chart)
    const releaseName = `${chart}-${deployment}`
    const helm = process.env.HELM_BIN || 'helm'

    try {
      const templateDir = folder ? deploymentsDir : chartDir

      let templateArgs
      if (folder) {
        templateArgs = ['template', releaseName, deploymentsDir]
      } else {
        const valuesFile = path.join(deploymentsDir, `${deployment}-values.yaml`)
        templateArgs = ['template', releaseName, chartDir, '-f', valuesFile]
      }

      await new Promise((resolve, reject) => {
        execFile(helm, ['dependency', 'build', templateDir], { timeout: 120000 }, (err) => {
          if (err) reject(new Error(err.message))
          else resolve()
        })
      })

      const output = await new Promise((resolve, reject) => {
        execFile(helm, templateArgs, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || stdout || err.message))
          else resolve(stdout)
        })
      })
      res.json({ ok: true, output })
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
  })

  return router
}
