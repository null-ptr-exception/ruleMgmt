import express from 'express'
import path from 'path'
import { execFile } from 'child_process'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export default function renderRouter() {
  const router = express.Router()

  router.post('/:chart/:deployment', async (req, res) => {
    const chartsDir = path.join(req.gitopsDir, 'charts')
    const deploymentsDir = path.join(req.gitopsDir, 'deployments')
    const { chart, deployment } = req.params
    if (!NAME_RE.test(chart) || !NAME_RE.test(deployment)) {
      return res.status(400).json({ error: 'Invalid chart or deployment name' })
    }
    const chartDir = path.join(chartsDir, chart)
    const valuesFile = path.join(deploymentsDir, chart, `${deployment}-values.yaml`)
    const releaseName = `${chart}-${deployment}`
    const helm = process.env.HELM_BIN || 'helm'

    try {
      const output = await new Promise((resolve, reject) => {
        execFile(helm, ['template', releaseName, chartDir, '-f', valuesFile], { timeout: 120000 }, (err, stdout, stderr) => {
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
