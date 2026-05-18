import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'

export default function alertmanagerConfigsRouter(gitopsDir) {
  const router = Router()
  const configDir = path.join(gitopsDir, 'alertmanager-configs')

  router.get('/', async (req, res) => {
    try {
      await fs.mkdir(configDir, { recursive: true })
      const files = await fs.readdir(configDir)
      const configs = files
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => f.replace(/\.(yaml|yml)$/, ''))
      res.json(configs)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/:name', async (req, res) => {
    const filePath = path.join(configDir, `${req.params.name}.yaml`)
    try {
      const content = await fs.readFile(filePath, 'utf8')
      const parsed = yaml.load(content)
      res.json({ content, parsed })
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      res.status(500).json({ error: e.message })
    }
  })

  router.put('/:name', async (req, res) => {
    await fs.mkdir(configDir, { recursive: true })
    const filePath = path.join(configDir, `${req.params.name}.yaml`)
    const { content } = req.body
    if (!content) return res.status(400).json({ error: 'content required' })
    await fs.writeFile(filePath, content, 'utf8')
    res.json({ ok: true })
  })

  router.delete('/:name', async (req, res) => {
    const filePath = path.join(configDir, `${req.params.name}.yaml`)
    try {
      await fs.unlink(filePath)
      res.json({ ok: true })
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' })
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
