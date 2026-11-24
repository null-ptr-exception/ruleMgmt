/** A deployment's values: open and save. */

import fs from 'fs/promises'
import path from 'path'
import { resolveStack, unwrapPath, readStackValues, stackValues } from '../../lib/stack.js'
import { originsOf, folderCommonOf, inheritsFromOf } from '../../lib/commonEdit.js'
import { valuesWrite, saveValues, valuesVersion } from '../../lib/deploymentWrite.js'
import { withSyncRegistryLock, isTarget } from '../../lib/sync.js'
import { syncAnswer } from '../../repo/sync.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { writeWhole } from '../../lib/routingFiles.js'
import { UnreadableError, errorAnswer } from '../../lib/readIfThere.js'
import { openRepo } from '../../repo/openRepo.js'
import { loadDeployment } from '../../repo/deployment.js'

import { isValidDeploymentParam, syncFolder, resolveDeploymentDir, resolveValuesFile, exists, commonRefused } from './resolve.js'
/**
 * What a deployment on a `_common` stack inherits (#102): the values its
 * layers give one that writes nothing (`values`), and which layer gives each
 * group and Common Value (`from`: a `_common`'s path, or 'template' for a
 * group none gives). Its own values are not in it.
 */
async function inheritedOf(gitopsDir, dir, stack) {
  await readStackValues(gitopsDir, dir, stack)
  const bare = stackValues(stack, { own: {} })
  const { groups, common } = originsOf(bare, stack.groups)
  return { values: bare.merged, from: { groups, common } }
}

export function valuesRoutes(router) {
  router.get('/:chart/:deployment', async (req, res) => {
    const dir = await resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    try {
      const { file, direct, legacyFile } = await resolveValuesFile(dir, req.params.deployment)
      // Not there: not found. There and unreadable (no permission, a
      // folder, a link to nothing, not YAML): said, naming the file.
      // Read as Helm reads it (`010` is 8): the values shown are the ones deployed.
      const repo = openRepo(req.gitopsDir)
      const rel = path.relative(req.gitopsDir, file).replace(/\\/g, '/')
      const read = await repo.helmYaml(rel)
      if (read.state === 'absent') return res.status(404).json({ error: 'Not found' })
      if (read.state === 'unreadable') throw new UnreadableError(file, { reason: read.why })
      if (read.state === 'invalid') throw new UnreadableError(file, { reason: read.findings.map(f => f.message.replace(/^\S+ (line \d+: )?/, '')).join('; ') })
      const content = (await repo.file(rel)).value.text
      // Only the deployment's own values, under every key of its stack (#100).
      const stack = await resolveStack(req.gitopsDir, dir, { repo })
      const parsed = unwrapPath(read.value, stack.keys)
      // What Helm does with them, for the page to say (findings, policy.js: as a save would decide).
      const loadedDep = await loadDeployment(repo, direct ? path.relative(req.gitopsDir, dir).replace(/\\/g, '/') : rel, { chart: req.params.chart })
      const findings = loadedDep.state === 'ok' ? loadedDep.findings.map(f => ({ code: f.code, message: f.message, helm: f.helm, ...(f.at ? { at: f.at } : {}) })) : []
      // A leftover `<name>-values.yaml` beside `values.yaml` is not read by
      // anything; say so, or it looks like the file being edited.
      const unusedFile = direct && await exists(legacyFile) ? path.basename(legacyFile) : undefined
      // The _common it renders on and the one its folder has (#103), for a
      // sync target's page: it follows its source's.
      const stackOf = req.query.folder && direct
        ? { stack: { inheritsFrom: inheritsFromOf(stack), folderCommon: await folderCommonOf(req.gitopsDir, syncFolder(req), stack.chart || stack.claims) } }
        : {}
      // What it was loaded from: its save sends it back (#102).
      const version = req.query.folder && direct ? { version: await valuesVersion(req.gitopsDir, dir, stack) } : {}
      // A _common that cannot be read, a link gone: the deployment still
      // opens, and says what keeps Helm from rendering it.
      const problems = stack.problems.length ? { stackProblems: stack.problems.map(p => p.description) } : {}
      let inherited = {}
      if (direct && stack.layers.length) {
        try {
          inherited = { inherited: await inheritedOf(req.gitopsDir, dir, stack) }
        } catch (err) {
          problems.stackProblems = [...(problems.stackProblems || []), `what it inherits cannot be read (${err.code || err.message})`]
        }
      }
      res.json({ content, parsed, unusedFile, ...stackOf, ...version, ...problems, ...inherited, ...(findings.length ? { findings } : {}) })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const dir = await resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    // The text of values.yaml, or the values as a map: anything else (left
    // out, null, a number, a list) would be written as a file of no rows.
    const given = req.body?.values
    if (typeof given !== 'string' && (!given || typeof given !== 'object' || Array.isArray(given))) {
      return res.status(400).json({ error: 'values is required: the text of values.yaml, or the values as a map' })
    }
    const folder = syncFolder(req)
    try {
      const readOnly = () => ({ status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } })
      if (folder) {
        // A synced target is read-only server-side, not just in the UI —
        // the frontend's freeze can race (see AlertUserView's getSyncSource
        // call), so this must be enforced here too, not only by disabling
        // Save. Checked again under the lock below.
        const read = await syncAnswer(openRepo(req.gitopsDir))
        if (read.refusal) return res.status(read.refusal.status).json(read.refusal.body)
        if (isTarget(read.registry, folder)) {
          const { status, body } = readOnly()
          return res.status(status).json(body)
        }
        const reserved = await newReservedSegment(req.gitopsDir, folder)
        if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      }

      await fs.mkdir(dir, { recursive: true })
      const { file, direct } = await resolveValuesFile(dir, req.params.deployment)

      // The folder's own deployment: check, write, copy to its sync targets
      // and report the ones that could not be written (#180), all under the
      // registry lock.
      if (folder && direct) {
        const outcome = await withSyncRegistryLock(req.gitopsDir, async () => {
          const { registry, refusal } = await syncAnswer(openRepo(req.gitopsDir))
          if (refusal) return refusal
          if (isTarget(registry, folder)) return readOnly()
          return saveValues(req.gitopsDir, registry, folder, req.body.values, { chartName: req.params.chart, version: req.body.version })
        })
        return res.status(outcome.status).json(outcome.body)
      }

      // A legacy `<name>-values.yaml`: the same checks, and no sync.
      if (commonRefused(req, res, 'given another values file')) return
      const rel = path.relative(req.gitopsDir, file).replace(/\\/g, '/')
      const answer = await valuesWrite(req.gitopsDir, direct ? path.relative(req.gitopsDir, dir).replace(/\\/g, '/') : rel, req.body.values, { chartName: req.params.chart })
      if (answer.refusal) return res.status(answer.refusal.status).json(answer.refusal.body)
      await writeWhole(file, answer.text)

      res.json({ ok: true })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })
}
