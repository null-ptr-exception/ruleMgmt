import express from 'express'
import yaml from 'js-yaml'
import { withSyncRegistryLock } from '../lib/sync.js'
import { regenerateRouting } from '../lib/commitChecks.js'
import {
  readSharedConfigs, routingUsers, usageOf, unreadableOf, staleUsers, sharedDirProblem, writeShared, renameShared, updateConfigsInText, SHARED_FILE,
} from '../lib/sharedConfigs.js'

/**
 * The repo's shared notification configs (#123): read them with who uses
 * each, write them (every resource made from them is made again, all or
 * none), rename one everywhere, make again what is behind. Every write takes
 * the commit lock, as a routing save does.
 */
export default function routingSharedRouter() {
  const router = express.Router()

  // { file, exists, text, configs, errors, usage: { name: [{ deployment,
  // syncedFrom? }] }, stale: [deployment], unreadable: [{ deployment, error }],
  // dirProblem }
  router.get('/', async (req, res) => {
    try {
      const shared = await readSharedConfigs(req.gitopsDir)
      const users = await routingUsers(req.gitopsDir)
      res.json({
        file: SHARED_FILE,
        exists: !!shared,
        text: shared?.text ?? null,
        configs: shared?.configs ?? {},
        errors: shared?.errors ?? [],
        warnings: shared?.warnings ?? [],
        usage: usageOf(users),
        stale: await staleUsers(req.gitopsDir, users, shared),
        unreadable: unreadableOf(users),
        dirProblem: await sharedDirProblem(req.gitopsDir),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // `shared` is the file's text, kept as written, or `{ configs }`.
  router.put('/', async (req, res) => {
    const input = req.body?.shared
    if (typeof input !== 'string' && (input === null || typeof input !== 'object' || Array.isArray(input))) {
      return res.status(400).json({ error: 'shared is required: the text of the shared configs, or { configs }' })
    }
    try {
      const { status, body } = await withSyncRegistryLock(req.gitopsDir, async () => {
        // The page sends { configs }: written into the file as it is, its
        // comments and layout kept (updateConfigsInText).
        let text = input
        if (typeof input !== 'string') {
          const current = await readSharedConfigs(req.gitopsDir)
          const configs = input.configs && typeof input.configs === 'object' && !Array.isArray(input.configs) ? input.configs : null
          text = (configs && current?.text && !current.errors.length && updateConfigsInText(current.text, configs)) ||
            yaml.dump(input, { lineWidth: -1 })
        }
        return writeShared(req.gitopsDir, text)
      })
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: err.code || err.message })
    }
  })

  router.post('/rename', async (req, res) => {
    const { from, to } = req.body || {}
    if (typeof from !== 'string' || typeof to !== 'string') return res.status(400).json({ error: 'from and to are required' })
    try {
      const { status, body } = await withSyncRegistryLock(req.gitopsDir, () => renameShared(req.gitopsDir, from, to))
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: err.code || err.message })
    }
  })

  // Every resource behind — the shared file edited with git, say — made again.
  router.post('/regenerate', async (req, res) => {
    try {
      res.json(await regenerateRouting(req.gitopsDir))
    } catch (err) {
      res.status(500).json({ error: err.code || err.message })
    }
  })

  return router
}
