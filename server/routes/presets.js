import express from 'express'
import fs from 'fs/promises'
import path from 'path'

export default function presetsRouter(gitopsDir) {
  const router = express.Router()
  const presetsFile = path.join(gitopsDir, 'charts', '_presets', 'presets.json')

  router.get('/', async (_req, res) => {
    try {
      const raw = await fs.readFile(presetsFile, 'utf-8')
      const presets = JSON.parse(raw)
      const list = Object.entries(presets).map(([id, p]) => ({
        id,
        name: p.name,
        description: p.description,
        forDuration: p.forDuration,
        fixedAlert: p.fixedAlert || false,
        fixedSeverity: p.fixedSeverity || null,
        vars: p.vars,
        tiers: p.tiers || null,
        promqlTemplate: p.promqlTemplate,
      }))
      res.json(list)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
