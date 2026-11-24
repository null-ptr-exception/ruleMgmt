/** A folder's deployments, with their alert counts. */

import fs from 'fs/promises'
import path from 'path'
import { countAlerts } from '../../lib/subchart.js'
import { resolveStack } from '../../lib/stack.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { errorAnswer } from '../../lib/readIfThere.js'
import { loadValues } from '../../../src/utils/valuesText.js'

import { resolveDeploymentDir } from './resolve.js'
export function listRoutes(router) {
  router.get('/:chart', async (req, res) => {
    const dir = await resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    try {
      if (req.query.folder) {
        const reserved = await newReservedSegment(req.gitopsDir, req.query.folder)
        if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      }
      await fs.mkdir(dir, { recursive: true })
      const files = await fs.readdir(dir)
      const deployments = []
      const { keys } = await resolveStack(req.gitopsDir, dir)

      if (files.includes('values.yaml')) {
        const folderName = path.basename(dir)
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, 'values.yaml'), 'utf-8')
          alertCount = countAlerts(loadValues(raw) || {}, keys)
        } catch { /* skip unreadable */ }
        deployments.push({ name: folderName, file: 'values.yaml', alertCount })
      }

      for (const f of files) {
        if (!f.endsWith('-values.yaml')) continue
        const name = f.replace(/-values\.yaml$/, '')
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8')
          alertCount = countAlerts(loadValues(raw) || {}, keys)
        } catch { /* skip unreadable */ }
        deployments.push({ name, file: f, alertCount })
      }
      res.json(deployments)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })
}
