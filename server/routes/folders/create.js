/** Make a deployment in a folder (POST /init). */

import path from 'path'
import { getChartsDir } from '../../lib/chartDiscovery.js'
import { isSafeSyncPath } from '../../lib/sync.js'
import { z } from 'zod'
import { route, repoPath, repoName } from '../../http/route.js'
import { openRepo } from '../../repo/openRepo.js'
import { newDeploymentProblem } from '../../repo/walk.js'
import { planChange, applyChange } from '../../repo/changes/index.js'

function chartsDirName() {
  return process.env.CHARTS_DIR || 'charts'
}

// isSafeSyncPath's first-segment string check can be bypassed by an
// equivalent CHARTS_DIR spelling (e.g. './charts', 'charts/'), so also
// verify the resolved target isn't the charts dir or a descendant of it.
function isSafeFolderPath(candidate, gitopsDir) {
  if (!isSafeSyncPath(candidate, chartsDirName())) return false

  const targetDir = path.resolve(gitopsDir, candidate)
  const chartsDir = path.resolve(getChartsDir(gitopsDir, process.env.CHARTS_DIR))
  const relative = path.relative(chartsDir, targetDir)
  const isSameOrChild = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  return !isSameOrChild
}

// The folder made, and its Template: named like one (paths.js), not
// `.cache`, not a path.
const INIT_BODY = z.object({
  folder: repoPath('create', { what: 'folder path' }),
  chart: repoName('name', { what: 'chart name' }),
})

export function initRoutes(router) {
  // Its Chart.yaml and values.yaml, both or neither (repo/changes/create-deployment.js):
  // a refusal leaves no folder and no file.
  router.post('/init', route('folders.init', { body: INIT_BODY }, async ({ body }, { gitopsDir }) => {
    const folder = body.folder.rel
    const repo = openRepo(gitopsDir)
    // In the Templates folder: refused before anything is planned, in the
    // walk's words for it (which folder that is, and why not there).
    if (!isSafeFolderPath(folder, gitopsDir)) return { status: 400, body: { error: await newDeploymentProblem(repo, folder) || 'Invalid folder path' } }
    const plan = await planChange(repo, { kind: 'create-deployment', folder, chart: body.chart })
    return applyChange(plan)
  }))
}
