/** A deployment's values: open and save. */

import { reasonOf } from '../../repo/finding.js'
import { z } from 'zod'
import { route, map } from '../../http/route.js'
import path from 'path'
import { resolveStack, unwrapPath, readStackValues, stackValues } from '../../lib/stack.js'
import { originsOf, folderCommonOf, inheritsFromOf } from '../../lib/commonEdit.js'
import { valuesVersion } from '../../lib/deploymentWrite.js'
import { isTarget } from '../../lib/sync.js'
import { syncAnswer } from '../../repo/sync.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { planChange, applyChange } from '../../repo/changes/index.js'
import { UnreadableError, errorAnswer } from '../../lib/readIfThere.js'
import { openRepo } from '../../repo/openRepo.js'
import { loadDeployment } from '../../repo/deployment.js'

import { DEPLOYMENT_REQUEST, deploymentAt, resolveValuesFile, exists, commonRefused } from './resolve.js'
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

// The text of values.yaml, or the values as a map: anything else (left
// out, null, a number, a list) would be written as a file of no rows.
// `version`: what the page was loaded from (#102), left out by a page that
// has none.
const SAVE_BODY = z.object({
  values: z.union([z.string(), map()], { error: iss => (iss.input === undefined ? 'values is required: the text of values.yaml, or the values as a map' : 'values must be the text of values.yaml, or the values as a map') }),
  version: z.string().optional(),
})

export function valuesRoutes(router) {
  router.get('/:chart/:deployment', route('deployments.get', DEPLOYMENT_REQUEST, async (input, { gitopsDir, repo }) => {
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return { status: 400, body: { error: at.error } }
    const { dir, folder, chart } = at
    const { file, direct, legacyFile } = await resolveValuesFile(dir, at.deployment)
    // Not there: not found. There and unreadable (no permission, a
    // folder, a link to nothing, not YAML): said, naming the file.
    // Read as Helm reads it (`010` is 8): the values shown are the ones deployed.
    const rel = path.relative(gitopsDir, file).replace(/\\/g, '/')
    const read = await repo.helmYaml(rel)
    if (read.state === 'absent') return { status: 404, body: { error: 'Not found' } }
    if (read.state === 'unreadable') throw new UnreadableError(file, { reason: read.why })
    if (read.state === 'invalid') throw new UnreadableError(file, { reason: read.findings.map(reasonOf).join('; ') })
    const content = (await repo.file(rel)).value.text
    // Only the deployment's own values, under every key of its stack (#100).
    const stack = await resolveStack(gitopsDir, dir, { repo })
    const parsed = unwrapPath(read.value, stack.keys)
    // What Helm does with them, for the page to say (findings, policy.js: as a save would decide).
    const loadedDep = await loadDeployment(repo, direct ? path.relative(gitopsDir, dir).replace(/\\/g, '/') : rel, { chart })
    const findings = loadedDep.state === 'ok' ? loadedDep.findings.map(f => ({ code: f.code, message: f.message, helm: f.helm, ...(f.at ? { at: f.at } : {}) })) : []
    // A leftover `<name>-values.yaml` beside `values.yaml` is not read by
    // anything; say so, or it looks like the file being edited.
    const unusedFile = direct && await exists(legacyFile) ? path.basename(legacyFile) : undefined
    // The _common it renders on and the one its folder has (#103), for a
    // sync target's page: it follows its source's.
    const stackOf = folder && direct
      ? { stack: { inheritsFrom: inheritsFromOf(stack), folderCommon: await folderCommonOf(gitopsDir, folder, stack.chart || stack.claims) } }
      : {}
    // What it was loaded from: its save sends it back (#102).
    const version = folder && direct ? { version: await valuesVersion(gitopsDir, dir, stack) } : {}
    // A _common that cannot be read, a link gone: the deployment still
    // opens, and says what keeps Helm from rendering it.
    const problems = stack.problems.length ? { stackProblems: stack.problems.map(p => p.description) } : {}
    let inherited = {}
    if (direct && stack.layers.length) {
      try {
        inherited = { inherited: await inheritedOf(gitopsDir, dir, stack) }
      } catch (err) {
        problems.stackProblems = [...(problems.stackProblems || []), `what it inherits cannot be read (${err.code || err.message})`]
      }
    }
    return { status: 200, body: { content, parsed, unusedFile, ...stackOf, ...version, ...problems, ...inherited, ...(findings.length ? { findings } : {}) } }
  }))

  router.post('/:chart/:deployment', route('deployments.save', { ...DEPLOYMENT_REQUEST, body: SAVE_BODY }, async (input, { gitopsDir, res }) => {
    const at = await deploymentAt(input, gitopsDir)
    if (at.error) return res.status(400).json({ error: at.error })
    const { dir, folder, chart, deployment } = at
    const { body: given } = input
    try {
      const readOnly = () => ({ status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } })
      if (folder) {
        // A synced target is read-only server-side, not just in the UI —
        // the frontend's freeze can race (see AlertUserView's getSyncSource
        // call), so this must be enforced here too, not only by disabling
        // Save. Checked again under the lock below.
        const read = await syncAnswer(openRepo(gitopsDir))
        if (read.refusal) return res.status(read.refusal.status).json(read.refusal.body)
        if (isTarget(read.registry, folder)) {
          const { status, body } = readOnly()
          return res.status(status).json(body)
        }
        const reserved = await newReservedSegment(gitopsDir, folder)
        if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      }

      const { file, direct } = await resolveValuesFile(dir, deployment)
      // The folder's own deployment: its values.yaml and its sync targets'
      // copies, written all or none (repo/changes/set-values.js). A legacy
      // `<name>-values.yaml`: the same checks, and no sync.
      const own = !!(folder && direct)
      const common = own ? null : commonRefused(folder, 'given another values file')
      if (common) return res.status(common.status).json(common.body)
      const rel = own ? folder : path.relative(gitopsDir, direct ? dir : file).replace(/\\/g, '/')
      const plan = await planChange(openRepo(gitopsDir), { kind: 'set-values', deployment: rel, values: given.values, chart, sync: own })
      const { status, body } = await applyChange(plan, { expect: own ? given.version : undefined })
      res.status(status).json(body)
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  }))
}
