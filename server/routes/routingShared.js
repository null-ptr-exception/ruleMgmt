import express from 'express'
import { withSyncRegistryLock } from '../lib/sync.js'
import { regenerateRouting } from '../lib/commitChecks.js'
import {
  routingUsers, usageOf, overlapsOf, unreadableOf, staleUsers, writeShared, renameShared, SHARED_FILE,
} from '../lib/sharedConfigs.js'
import { openRepo } from '../repo/openRepo.js'
import { loadShared, loadSharedDir, sharedDirProblemOf, sharedForBuild } from '../repo/shared.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { answerRejections } from '../lib/answerRejections.js'

/**
 * The repo's shared notification configs (#123): read them with who uses
 * each, write them (every resource made from them is made again, all or
 * none), rename one everywhere, make again what is behind. Every write takes
 * the commit lock, as a routing save does.
 */
export default function routingSharedRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)

  // { file, exists, text, configs, errors, usage: { name: [{ deployment,
  // syncedFrom? }] }, overlaps: { overlaps: [{ config, count, deployments,
  // more }], unchecked, synced } (sharedOverlap.js), stale: [deployment], unreadable: [{ deployment, error }],
  // dirProblem }
  // A sync.yaml that cannot be read is named (409): who is whose target,
  // and so who uses what, cannot be told without it.
  router.get('/', async (req, res) => {
    try {
      const repo = openRepo(req.gitopsDir)
      const shared = sharedForBuild(await loadShared(repo))
      const { users, refusal } = await routingUsers(repo)
      if (refusal) return res.status(refusal.status).json(refusal.body)
      res.json({
        file: SHARED_FILE,
        exists: !!shared,
        text: shared?.text ?? null,
        configs: shared?.configs ?? {},
        errors: shared?.errors ?? [],
        warnings: shared?.warnings ?? [],
        usage: usageOf(users),
        overlaps: overlapsOf(users, shared),
        stale: staleUsers(users),
        unreadable: unreadableOf(users),
        dirProblem: sharedDirProblemOf(await loadSharedDir(repo)),
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
      // Text or the page's { configs }: one write, one answer (writeShared).
      const { status, body } = await withSyncRegistryLock(req.gitopsDir, () => writeShared(req.gitopsDir, input))
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

  return answerRejections(router)
}
