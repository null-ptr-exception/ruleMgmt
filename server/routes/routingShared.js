import express from 'express'
import {
  routingUsers, usageOf, overlapsOf, unreadableOf, staleUsers, SHARED_FILE,
} from '../lib/sharedConfigs.js'
import { loadShared, loadSharedDir, sharedDirProblemOf, sharedForBuild } from '../repo/shared.js'
import { answersWithoutPaths } from '../lib/answerPaths.js'
import { z } from 'zod'
import { openRepo } from '../repo/openRepo.js'
import { planChange, applyChange } from '../repo/changes/index.js'
import { route, declaredRoutes, map } from '../http/route.js'

// `shared` is the file's text, kept as written, or `{ configs }`.
const PUT_BODY = z.object({
  shared: z.union([z.string(), map()], { error: iss => (iss.input === undefined ? 'shared is required: the text of the shared configs, or { configs }' : 'shared must be the text of the shared configs, or { configs }') }),
})
// A config's name now and the one it is given (checked by planRename, lib/sharedConfigs.js).
const RENAME_BODY = z.object({ from: z.string().min(1), to: z.string().min(1) })

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
  router.get('/', route('shared.get', {}, async (_, { repo }) => {
    const shared = sharedForBuild(await loadShared(repo))
    const { users, refusal } = await routingUsers(repo)
    if (refusal) return refusal
    return { status: 200, body: {
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
    } }
  }))

  // Text or the page's { configs }: one change, all or none (changes/shared.js).
  router.put('/', route('shared.put', { body: PUT_BODY }, async ({ body }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'shared', shared: body.shared }))
  )))

  router.post('/rename', route('shared.rename', { body: RENAME_BODY }, async ({ body }, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'shared', rename: { from: body.from, to: body.to } }))
  )))

  // Every resource behind — the shared file edited with git, say — made again.
  router.post('/regenerate', route('shared.regenerate', {}, async (_, { gitopsDir }) => (
    applyChange(await planChange(openRepo(gitopsDir), { kind: 'regenerate-routing' }))
  )))

  return declaredRoutes(router)
}
