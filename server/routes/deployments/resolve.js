/** Where a deployment route's chart, folder and deployment name lead (routes/deployments.js). */

import path from 'path'
import { z } from 'zod'
import { isCommonChartPath, COMMON_DIR } from '../../../src/utils/reservedNames.js'
import { deploymentNameProblem, realPlace, PLACE_WHY } from '../../repo/paths.js'
import { repoName, repoPath } from '../../http/route.js'

/**
 * What every deployment route is asked with: the chart and the deployment
 * in the URL, and the deployment's folder (`?folder=`, a path the
 * 'deployment' intent takes: no link on the way). Without a folder (or with
 * an empty one) it is a legacy flat deployment, deployments/<chart>.
 *   GET /api/v2/deployments/demo/a?folder=deployments/team/a
 *     → { params: { chart: 'demo', deployment: 'a' },
 *         query: { folder: { rel: 'deployments/team/a', abs: '<repo>/deployments/team/a' } } }
 */
export const DEPLOYMENT_REQUEST = Object.freeze({
  params: z.object({ chart: repoName('name', { what: 'chart name' }), deployment: z.string() }),
  query: z.object({
    folder: z.preprocess(v => (v === '' ? undefined : v), repoPath('deployment', { what: 'folder path' }).optional()),
  }),
})

/**
 * The deployment a request names: `{ dir, folder, chart, deployment }`
 * (folder: the path in the repo as sync.yaml spells it, `a/./b/` is `a/b`;
 * undefined for a legacy flat one), or why it cannot be one, `{ error }`.
 * The deployment's name is one name: in a folder, a file name; else a
 * chart's name (paths.js).
 */
export async function deploymentAt({ params, query }, gitopsDir) {
  const { chart, deployment } = params
  const folder = query.folder?.rel
  let dir
  if (folder) {
    dir = query.folder.abs
  } else {
    // A legacy flat deployment's folder: never through a link out of the
    // repo or into git's own folder either.
    const rel = path.posix.join(process.env.DEPLOYMENTS_DIR || 'deployments', chart)
    const { target, why } = await realPlace(gitopsDir, rel)
    if (why) return { error: `${rel}: ${PLACE_WHY[why]}` }
    dir = target
  }
  const problem = deploymentNameProblem(deployment, folder)
  if (problem) return { error: `Invalid deployment name: ${problem.why}` }
  return { dir, folder, chart, deployment }
}

// A folder's _common chart (#101) opens in the editor and is saved there,
// and nothing else: it is removed with its plan (POST /api/v2/folders/common),
// which gives the deployments on it what they inherited first. The answer
// that says so, or null.
export function commonRefused(folder, what) {
  if (!folder || !isCommonChartPath(folder)) return null
  return { status: 400, body: { error: `${folder} is a ${COMMON_DIR} chart, not a deployment: it cannot be ${what} — remove it with "Remove this ${COMMON_DIR}" in the tree` } }
}
