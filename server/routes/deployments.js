import express from 'express'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getDepName, wrapValues, unwrapValues, countAlerts } from '../lib/subchart.js'
import { valuesRefusal, saveValues, copyToTargets, okWith } from '../lib/deploymentWrite.js'
import { readSyncRegistry, writeSyncRegistry, withSyncRegistryLock, isTarget, applyUnlink, normalizeSyncPath, isDeploymentDir, getSourceForTarget } from '../lib/sync.js'
import { buildRouting, writeRouting, removeRouting, routingState, readRouting } from '../lib/routingFiles.js'
import { newReservedSegment, reservedError } from '../lib/reservedNames.js'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.{1,2}$)[^/\\]+$/

function isValidDeploymentParam(req) {
  const deployment = req.params.deployment
  return req.query.folder
    ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
    : NAME_RE.test(deployment)
}

// The folder as sync.yaml spells it: `a/src/`, `a/./src` and `a//src` are
// `a/src` to the registry, or a target spelled another way is not read-only
// and a deleted source keeps its sync link (#180).
const syncFolder = req => (req.query.folder ? normalizeSyncPath(req.query.folder) : req.query.folder)

function resolveDeploymentDir(req) {
  const folder = req.query.folder
  if (folder) {
    if (folder.includes('..')) return null
    return path.join(req.gitopsDir, folder)
  }
  const deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments')
  return path.join(deploymentsDir, req.params.chart)
}

// Which file holds a deployment's values. The folder's own deployment —
// named after the folder, which is how the UI always calls it — is
// `values.yaml` when that exists, the same file Preview and sync use. Any
// other name is a legacy `<name>-values.yaml` sibling and never touches
// `values.yaml`, or saving it would overwrite the folder's deployment (#90).
async function resolveValuesFile(dir, deployment) {
  const legacyFile = path.join(dir, `${deployment}-values.yaml`)
  const directFile = path.join(dir, 'values.yaml')
  if (deployment === path.basename(dir)) {
    try {
      await fs.access(directFile)
      return { file: directFile, direct: true, legacyFile }
    } catch (err) {
      // Only a missing values.yaml means a legacy file named after the
      // folder; any other error must not quietly pick the other file.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
    }
  }
  return { file: legacyFile, direct: false, legacyFile }
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

export default function deploymentsRouter() {
  const router = express.Router()

  router.use('/:chart', (req, res, next) => {
    if (!NAME_RE.test(req.params.chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }
    next()
  })

  router.get('/:chart', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    try {
      if (req.query.folder) {
        const reserved = await newReservedSegment(req.gitopsDir, req.query.folder)
        if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      }
      await fs.mkdir(dir, { recursive: true })
      const files = await fs.readdir(dir)
      const deployments = []
      const depName = await getDepName(dir)

      if (files.includes('values.yaml')) {
        const folderName = path.basename(dir)
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, 'values.yaml'), 'utf-8')
          alertCount = countAlerts(yaml.load(raw) || {}, depName)
        } catch { /* skip unreadable */ }
        deployments.push({ name: folderName, file: 'values.yaml', alertCount })
      }

      for (const f of files) {
        if (!f.endsWith('-values.yaml')) continue
        const name = f.replace(/-values\.yaml$/, '')
        let alertCount = 0
        try {
          const raw = await fs.readFile(path.join(dir, f), 'utf-8')
          alertCount = countAlerts(yaml.load(raw) || {}, depName)
        } catch { /* skip unreadable */ }
        deployments.push({ name, file: f, alertCount })
      }
      res.json(deployments)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    try {
      const { file, direct, legacyFile } = await resolveValuesFile(dir, req.params.deployment)
      const content = await fs.readFile(file, 'utf-8')
      const parsed = unwrapValues(yaml.load(content) || {}, await getDepName(dir))
      // A leftover `<name>-values.yaml` beside `values.yaml` is not read by
      // anything; say so, or it looks like the file being edited.
      const unusedFile = direct && await exists(legacyFile) ? path.basename(legacyFile) : undefined
      res.json({ content, parsed, unusedFile })
    } catch {
      res.status(404).json({ error: 'Not found' })
    }
  })

  router.post('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    const folder = syncFolder(req)
    try {
      const readOnly = () => ({ status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } })
      if (folder) {
        // A synced target is read-only server-side, not just in the UI —
        // the frontend's freeze can race (see AlertUserView's getSyncSource
        // call), so this must be enforced here too, not only by disabling
        // Save. Checked again under the lock below.
        if (isTarget(await readSyncRegistry(req.gitopsDir), folder)) {
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
          const registry = await readSyncRegistry(req.gitopsDir)
          if (isTarget(registry, folder)) return readOnly()
          return saveValues(req.gitopsDir, registry, folder, req.body.values, { chartName: req.params.chart })
        })
        return res.status(outcome.status).json(outcome.body)
      }

      // A legacy `<name>-values.yaml`: the same checks, and no sync.
      const depName = await getDepName(dir)
      let values = req.body.values
      const refusal = await valuesRefusal(req.gitopsDir, depName || req.params.chart, depName, values)
      if (refusal) return res.status(400).json(refusal)
      if (typeof values !== 'string') {
        values = yaml.dump(wrapValues(values, depName), { lineWidth: -1 })
      }
      await fs.writeFile(file, values, 'utf-8')

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // A deployment's notification routing (#92): routing.yaml and the
  // AlertmanagerConfig generated from it, always written together. Only the
  // folder's own deployment has one — see routingFiles.js.
  async function routingTarget(req, res, { write = true } = {}) {
    const dir = resolveDeploymentDir(req)
    if (!dir) { res.status(400).json({ error: 'Invalid folder path' }); return null }
    if (!isValidDeploymentParam(req)) { res.status(400).json({ error: 'Invalid deployment name' }); return null }
    const folder = syncFolder(req)
    const { direct } = folder ? await resolveValuesFile(dir, req.params.deployment) : { direct: false }
    if (!direct) {
      res.status(400).json({ error: 'Only a folder deployment has notification routing' })
      return null
    }
    // A synced target is read-only: refused before its routing is checked,
    // and checked again under the lock when it is written.
    if (write && isTarget(await readSyncRegistry(req.gitopsDir), folder)) {
      res.status(409).json({ error: `${folder} is synced from another deployment and is read-only` })
      return null
    }
    return { dir, folder }
  }

  // Save or delete routing for the folder's own deployment, then give each
  // sync target the source's files and report the ones that could not be
  // written — under the registry lock, like the values save. A synced target
  // is read-only.
  function writeRoutingAndSync(req, { dir, folder }, write) {
    return withSyncRegistryLock(req.gitopsDir, async () => {
      const registry = await readSyncRegistry(req.gitopsDir)
      if (isTarget(registry, folder)) {
        return { status: 409, body: { error: `${folder} is synced from another deployment and is read-only` } }
      }
      await write(dir)
      const syncFailed = await copyToTargets(req.gitopsDir, registry, folder, { values: false, routing: true })
      return { status: 200, body: okWith(syncFailed) }
    })
  }

  // routing.yaml's text, its problems, and whether the AlertmanagerConfig is
  // out of date (`stale`) — saving the text again regenerates it. A synced
  // target can be read like any other.
  router.get('/:chart/:deployment/routing', async (req, res) => {
    try {
      const at = await routingTarget(req, res, { write: false })
      if (!at) return
      const state = await routingState(at.dir)
      if (!state) return res.status(404).json({ error: 'This deployment has no routing.yaml' })
      // A sync target is held to its source's files (#179): one that is not
      // its source's is behind as well, though its own two files agree.
      const source = getSourceForTarget(await readSyncRegistry(req.gitopsDir), syncFolder(req))
      if (source) {
        const [mine, theirs] = await Promise.all([readRouting(at.dir), readRouting(path.join(req.gitopsDir, source))])
        if (mine.text !== theirs.text || mine.cr !== theirs.cr) return res.json({ ...state, stale: true, differsFromSource: true })
      }
      res.json(state)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // The body's `routing` is routing.yaml's text, kept as written, or the
  // parsed table. A routing.yaml that does not pass the checks is refused
  // and neither file is written.
  router.put('/:chart/:deployment/routing', async (req, res) => {
    const input = req.body?.routing
    if (typeof input !== 'string' && (input === null || typeof input !== 'object')) {
      return res.status(400).json({ error: 'routing is required: the text of routing.yaml, or its table' })
    }
    try {
      const at = await routingTarget(req, res)
      if (!at) return
      const built = buildRouting(input)
      if (built.errors) {
        return res.status(400).json({ error: 'routing.yaml has problems', problems: built.errors })
      }
      const { status, body } = await writeRoutingAndSync(req, at, dir => writeRouting(dir, built))
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:chart/:deployment/routing', async (req, res) => {
    try {
      const at = await routingTarget(req, res)
      if (!at) return
      const { status, body } = await writeRoutingAndSync(req, at, removeRouting)
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/:chart/:deployment/clone', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    if (!req.body.newName || !NAME_RE.test(req.body.newName)) {
      return res.status(400).json({ error: 'Invalid newName' })
    }
    const dstFile = path.join(dir, `${req.body.newName}-values.yaml`)
    try {
      const { file: srcFile } = await resolveValuesFile(dir, req.params.deployment)
      await fs.copyFile(srcFile, dstFile)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.delete('/:chart/:deployment', async (req, res) => {
    const dir = resolveDeploymentDir(req)
    if (!dir) return res.status(400).json({ error: 'Invalid folder path' })
    if (!isValidDeploymentParam(req)) {
      return res.status(400).json({ error: 'Invalid deployment name' })
    }
    try {
      const { direct, legacyFile } = await resolveValuesFile(dir, req.params.deployment)
      const folder = syncFolder(req)
      // Deleting a legacy sibling leaves the folder's deployment, and so its
      // sync link, in place. A deleted target leaves its source; a deleted
      // source lets go of its targets, which keep what they have and become
      // editable again, instead of staying read-only with no source (#180).
      let unlinked = []
      if (folder && direct) {
        // Folder-mode deployment: the directory itself is the deployment
        // (Chart.yaml + values.yaml live directly inside it), so removing
        // just one file would leave an orphaned, half-deleted deployment.
        // Removed first, inside the lock: a removal that fails leaves the
        // sync links as they were, and no sync can be made to it meanwhile.
        await withSyncRegistryLock(req.gitopsDir, async () => {
          const registry = await readSyncRegistry(req.gitopsDir)
          await fs.rm(dir, { recursive: true, force: true })
          let changed = false
          if (isTarget(registry, folder)) {
            applyUnlink(registry, folder)
            changed = true
          }
          // Every entry, as a hand edit can list the same source twice.
          const entries = registry.syncs.filter(s => s.source === folder)
          if (entries.length) {
            registry.syncs = registry.syncs.filter(s => !entries.includes(s))
            changed = true
            // Listed as let go: on disk, and not still under another source.
            for (const t of new Set(entries.flatMap(e => e.targets))) {
              if (t !== folder && !isTarget(registry, t) && await isDeploymentDir(path.join(req.gitopsDir, t))) unlinked.push(t)
            }
          }
          if (changed) await writeSyncRegistry(req.gitopsDir, registry)
        })
      } else if (direct) {
        await fs.rm(dir, { recursive: true, force: true })
      } else {
        await fs.rm(legacyFile, { force: true })
      }
      res.json(unlinked.length ? { ok: true, unlinked } : { ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
