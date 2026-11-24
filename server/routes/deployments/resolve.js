/** Where a deployment route's chart, folder and deployment name lead (routes/deployments.js). */

import fs from 'fs/promises'
import path from 'path'
import { normalizeSyncPath } from '../../lib/sync.js'
import { isCommonChartPath, COMMON_DIR } from '../../../src/utils/reservedNames.js'
import { NAME_RE, isRepoPath, insideReal } from '../../lib/safePath.js'
import { isAbsent, UnreadableError } from '../../lib/readIfThere.js'
import { linkRefusal } from '../../repo/walk.js'
import { openRepo } from '../../repo/openRepo.js'

// One segment of a file name: not a path, not hidden.
const FOLDER_DEPLOYMENT_SEGMENT_RE = /^(?!\.)[^/\\\0]+$/

export function isValidDeploymentParam(req) {
  const deployment = req.params.deployment
  return req.query.folder
    ? FOLDER_DEPLOYMENT_SEGMENT_RE.test(deployment)
    : NAME_RE.test(deployment)
}

// The folder as sync.yaml spells it: `a/src/`, `a/./src` and `a//src` are
// `a/src` to the registry, or a target spelled another way is not read-only
// and a deleted source keeps its sync link (#180).
export const syncFolder = req => (req.query.folder ? normalizeSyncPath(req.query.folder) : req.query.folder)

export async function resolveDeploymentDir(req) {
  const folder = req.query.folder
  if (folder) {
    // A path in the repo, staying in it (safePath.js).
    if (!isRepoPath(folder)) return null
    // A folder that is a link (or is reached through one) is no deployment.
    if (await linkRefusal(openRepo(req.gitopsDir), folder)) return null
    return insideReal(req.gitopsDir, folder)
  }
  const deploymentsDir = path.join(req.gitopsDir, process.env.DEPLOYMENTS_DIR || 'deployments')
  return path.join(deploymentsDir, req.params.chart)
}

// Which file holds a deployment's values. The folder's own deployment —
// named after the folder, which is how the UI always calls it — is
// `values.yaml` when that exists, the same file Preview and sync use. Any
// other name is a legacy `<name>-values.yaml` sibling and never touches
// `values.yaml`, or saving it would overwrite the folder's deployment (#90).
export async function resolveValuesFile(dir, deployment) {
  const legacyFile = path.join(dir, `${deployment}-values.yaml`)
  const directFile = path.join(dir, 'values.yaml')
  if (deployment === path.basename(dir)) {
    try {
      await fs.access(directFile)
      return { file: directFile, direct: true, legacyFile }
    } catch (err) {
      // Only a missing values.yaml means a legacy file named after the
      // folder; any other error — a link to nothing among them — must not
      // quietly pick the other file.
      if (err.code !== 'ENOTDIR' && !(await isAbsent(directFile, err))) throw new UnreadableError(directFile, err.code === 'ENOENT' ? { reason: 'a link to a file that is not there' } : err)
    }
  }
  return { file: legacyFile, direct: false, legacyFile }
}

export async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

// A folder's _common chart (#101) opens in the editor and is saved there,
// and nothing else: it is removed with its plan (POST /api/v2/folders/common),
// which gives the deployments on it what they inherited first.
export function commonRefused(req, res, what) {
  if (!req.query.folder || !isCommonChartPath(req.query.folder)) return false
  res.status(400).json({ error: `${normalizeSyncPath(req.query.folder)} is a ${COMMON_DIR} chart, not a deployment: it cannot be ${what} — remove it with "Remove this ${COMMON_DIR}" in the tree` })
  return true
}
