/** Make a folder, and a deployment in one (POST /init). */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts, templateForNewDeployment } from '../../lib/chartDiscovery.js'
import { wrapValues } from '../../lib/subchart.js'
import { isSafeSyncPath } from '../../lib/sync.js'
import { newDeploymentProblem, isDeployment } from '../../repo/walk.js'
import { resolveStack } from '../../lib/stack.js'
import { newReservedSegment, reservedError } from '../../lib/reservedNames.js'
import { dumpForHelm } from '../../../src/utils/yamlScalar.js'
import { deploymentOnCommon, ANY_VERSION } from '../../lib/commonEdit.js'
import { writeWhole } from '../../lib/routingFiles.js'
import { parseIfThere, errorAnswer } from '../../lib/readIfThere.js'
import { repoPathProblem, isName, insideReal } from '../../lib/safePath.js'
import { openRepo } from '../../repo/openRepo.js'
import { loadDeployment } from '../../repo/deployment.js'
import { findingsOf } from '../../repo/loaded.js'
import { decide } from '../../repo/policy.js'
import { chartsDir as chartsRel } from '../../repo/template.js'

// What a new deployment asks of its Template's version: any.
export const ANY_TEMPLATE_VERSION = ANY_VERSION

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

export function createFolderRoutes(router) {
  router.post('/', async (req, res) => {
    const { path: folderPath } = req.body
    const pathWhy = repoPathProblem(folderPath)
    if (pathWhy) return res.status(400).json({ error: `Invalid folder path: ${pathWhy}` })
    if (!isSafeFolderPath(folderPath, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    try {
      const reserved = await newReservedSegment(req.gitopsDir, folderPath)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      // Where it really is, through a link: in the repo.
      if (!(await insideReal(req.gitopsDir, folderPath))) return res.status(400).json({ error: 'Invalid folder path: it leads outside the repo' })
      await fs.mkdir(path.join(req.gitopsDir, folderPath), { recursive: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}

export function initRoutes(router) {
  router.post('/init', async (req, res) => {
    const { folder, chart } = req.body
    const folderWhy = repoPathProblem(folder)
    if (folderWhy) return res.status(400).json({ error: `Invalid folder path: ${folderWhy}` })
    if (!isSafeFolderPath(folder, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    // A Template is named like one (safePath.js): not `.cache`, not a path.
    if (!isName(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)
    if (!(await insideReal(req.gitopsDir, folder))) return res.status(400).json({ error: 'Invalid folder path: it leads outside the repo' })

    try {
      const reserved = await newReservedSegment(req.gitopsDir, folder)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      const here = openRepo(req.gitopsDir)
      const misplaced = await newDeploymentProblem(here, folder)
      if (misplaced) return res.status(400).json({ error: misplaced })
      // A deployment already there is never written over, whatever it
      // depends on: its Chart.yaml and values.yaml are someone's.
      if (await isDeployment(here, folder)) {
        const existing = (await here.helmYaml(`${folder}/Chart.yaml`)).value || {}
        const { chart: template } = await resolveStack(req.gitopsDir, deployDir)
        return res.json({ status: 'existing', chart: template ?? existing.dependencies?.[0]?.name ?? null })
      }
      // Asked before any folder is made: a refusal leaves the repo as it was.
      const onCommon = await deploymentOnCommon(req.gitopsDir, folder, chart)
      if (onCommon?.error) return res.status(409).json({ error: onCommon.error })

      // A Chart.yaml there without a values.yaml: someone's. Read as it is,
      // or the init stops naming it — one that cannot be read or parsed is
      // not written over.
      const existing = await parseIfThere(path.join(deployDir, 'Chart.yaml'), yaml.load)
      if (existing && typeof existing === 'object') {
        if (Array.isArray(existing.dependencies)) {
          const alertCharts = await findAlertTemplateCharts(chartsDir)
          const alertChartNames = new Set(alertCharts.map(c => c.name))
          for (const dep of existing.dependencies) {
            if (alertChartNames.has(dep.name)) {
              return res.json({ status: 'existing', chart: dep.name })
            }
          }
        }
      }

      // The Template has to be there, readable, and render (chartDiscovery.js);
      // its version is not copied (below). Its values.yaml is read below.
      const template = await templateForNewDeployment(req.gitopsDir, chart, folder)
      if (template.error) return res.status(template.status).json({ error: template.error, ...(template.problems ? { problems: template.problems } : {}) })

      // The Template's groups, from its values.yaml: none when it has none;
      // one that cannot be read or parsed is said, not taken for none.
      // The Template's values, as Helm reads them: a group it has starts empty.
      const valuesFile = `${chartsRel()}/${chart}/values.yaml`
      const tplValues = await openRepo(req.gitopsDir).helmYaml(valuesFile)
      if (tplValues.state === 'unreadable') return res.status(409).json({ error: `Not made: ${valuesFile} cannot be read: ${tplValues.why}`, file: valuesFile })
      if (tplValues.state === 'invalid') {
        const what = findingsOf(tplValues).some(f => f.code === 'yaml.not-yaml') ? 'not valid YAML' : 'not values Helm reads'
        return res.status(409).json({ error: `Not made: ${valuesFile} cannot be read: ${what} (${findingsOf(tplValues).map(f => f.message).join('; ')})`, file: valuesFile })
      }
      const emptyValues = {}
      for (const [key, val] of Object.entries(tplValues.state === 'ok' ? tplValues.value : {})) {
        if (Array.isArray(val)) emptyValues[key] = []
      }

      // Everything is read: from here on it is written. A refusal above
      // made no folder; one below takes back what was made.
      // What is there now, to put back as it was: only what this request
      // made is removed.
      const was = {}
      const before = openRepo(req.gitopsDir)
      for (const f of ['Chart.yaml', 'values.yaml']) {
        const read = await before.file(`${folder}/${f}`)
        if (read.state === 'unreadable') return res.status(409).json({ error: `Not made: ${folder}/${f} cannot be read: ${read.why}`, file: `${folder}/${f}` })
        was[f] = read.state === 'ok' ? read.value.text : null
      }
      const made = await fs.mkdir(deployDir, { recursive: true })
      const takeBack = async () => {
        if (made) return fs.rm(made, { recursive: true, force: true })
        for (const [f, text] of Object.entries(was)) {
          if (text === null) await fs.rm(path.join(deployDir, f), { force: true })
          else await writeWhole(path.join(deployDir, f), text)
        }
      }
      // Loaded as Helm reads it, once written: what the Template or the
      // _common gives that Helm fails on is said, and nothing is kept.
      const notMade = async () => {
        const dep = await loadDeployment(openRepo(req.gitopsDir), folder)
        const problems = dep.state === 'unreadable' ? [`${dep.file} cannot be read: ${dep.why}`] : decide(findingsOf(dep), 'init').refuse.map(f => f.message)
        if (!problems.length) return false
        await takeBack()
        res.status(409).json({ error: `Not made: ${folder} would not deploy (${problems.join('; ')})`, problems })
        return true
      }

      // Under a folder with a _common for this Template (#102): on it, and
      // writing nothing of its own — it inherits everything, a group the
      // _common gets later too.
      if (onCommon) {
        await writeWhole(path.join(deployDir, 'Chart.yaml'), onCommon.chartYaml)
        await writeWhole(path.join(deployDir, 'values.yaml'), onCommon.valuesYaml)
        if (await notMade()) return
        return res.json({ status: 'created', chart, folder, inheritsFrom: onCommon.inheritsFrom })
      }
      // Helm reads this as a URL, and the file is committed and rendered on
      // Linux even when it was written on Windows, so the separator has to be
      // a forward slash regardless of the platform that produced it.
      const relPath = path.relative(deployDir, path.join(chartsDir, chart)).replace(/\\/g, '/')

      const deployChart = {
        apiVersion: 'v2',
        name: path.basename(folder),
        version: '0.1.0',
        // Any version of the Template, pre-releases too: there is one
        // copy of it, so an exact version only breaks every deployment the
        // day the Template's changes, by hand or by a pull. Read the same by
        // Helm 3.12 and 3.15 (one semver library).
        dependencies: [{
          name: chart,
          version: ANY_TEMPLATE_VERSION,
          repository: `file://${relPath}`,
        }]
      }
      await writeWhole(path.join(deployDir, 'Chart.yaml'), dumpForHelm(deployChart, { lineWidth: -1 }))

      const wrapped = wrapValues(emptyValues, chart)
      await writeWhole(path.join(deployDir, 'values.yaml'), dumpForHelm(wrapped, { lineWidth: -1 }))
      if (await notMade()) return

      res.json({ status: 'created', chart, folder })
    } catch (err) {
      const { status, body } = errorAnswer(err)
      res.status(status).json(body)
    }
  })
}
