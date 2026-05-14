import express from 'express'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'

export default function renderRouter(gitopsDir) {
  const router = express.Router()
  const chartsDir = path.join(gitopsDir, 'charts')
  const deploymentsDir = path.join(gitopsDir, 'deployments')

  router.post('/:chart/:deployment', async (req, res) => {
    const { chart, deployment } = req.params
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
