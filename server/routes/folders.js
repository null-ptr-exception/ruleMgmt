import express from 'express'
import { holdSyncRegistryLock, withSyncRegistryLock } from '../lib/sync.js'
import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { getChartsDir, findAlertTemplateCharts } from '../lib/chartDiscovery.js'
import { wrapValues, countAlerts } from '../lib/subchart.js'
import { isDeploymentDir, isCommonChartDir, isSafeSyncPath } from '../lib/sync.js'
import { walkDeployments, skippedDir, placementOf, newDeploymentProblem } from '../lib/deploymentWalk.js'
import { resolveStack } from '../lib/stack.js'
import { newReservedSegment, reservedError } from '../lib/reservedNames.js'
import { inSharedDir, SHARED_DIR } from '../lib/sharedConfigs.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { planCreate, planDelete, applyPlan, commonUsers, deploymentOnCommon, folderCommonOf, folderCommons, inheritsFromOf, linkOnPath, ANY_VERSION } from '../lib/commonEdit.js'
import { withoutPath, answersWithoutPaths } from '../lib/answerPaths.js'
import { writeWhole } from '../lib/routingFiles.js'
import { parseIfThere } from '../lib/readIfThere.js'

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

async function listChildren(baseDir, parentPath) {
  const dir = parentPath ? path.join(baseDir, parentPath) : baseDir
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Inside a deployment or a `_common` chart, its own templates/ and
  // charts/ are no folders of the tree — the walk's rules (deploymentWalk).
  const inChart = parentPath ? (await isDeploymentDir(dir) || await isCommonChartDir(dir)) : false
  // The shared notification configs' folder (#123) is no folder of the tree
  // — unless it is one of the repo's own, with other things in it.
  const hideShared = !parentPath && await inSharedDir(baseDir, SHARED_DIR)

  // Every deployment in it has the same folders above it: each asked once.
  const folderCommonHere = folderCommons(baseDir, parentPath || '.')
  const folders = []
  for (const e of entries) {
    if (!e.isDirectory() || skippedDir(e.name, { inChart })) continue
    if (hideShared && e.name === SHARED_DIR) continue
    const nodePath = parentPath ? `${parentPath}/${e.name}` : e.name
    const absPath = path.join(baseDir, nodePath)

    const node = { name: e.name, path: nodePath }

    // Check if deployment (Chart.yaml + dependencies + values.yaml)
    let chartData = null
    try {
      const chartYaml = await fs.readFile(path.join(absPath, 'Chart.yaml'), 'utf-8')
      chartData = yaml.load(chartYaml) || {}
    } catch { /* no Chart.yaml */ }

    let hasValues = false
    try {
      await fs.access(path.join(absPath, 'values.yaml'))
      hasValues = true
    } catch { /* no values.yaml */ }

    const hasDeps = chartData && Array.isArray(chartData.dependencies) && chartData.dependencies.length > 0
    const isCommon = await isCommonChartDir(absPath)
    if (isCommon) {
      node.isCommon = true
      // The Template it is for, which its page opens (#101).
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || stack.claims || e.name
      if (stack.problems.length) node.problems = stack.problems.map(p => p.description)
    }
    // Helm deploys it with the Template's example rows: flagged, and
    // counted as using its Template (a breaking change, a chart's delete).
    if (chartData && hasDeps && !hasValues && !isCommon) {
      node.noValues = true
      node.chart = (await resolveStack(baseDir, absPath)).chart || chartData.dependencies[0]?.name
    }
    if (chartData && hasDeps && hasValues && !isCommon) {
      node.isDeployment = true
      // The Template at the bottom of its `_common` stack (#100), which
      // Preview and the editor open: not the `_common` chart it names.
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || chartData.dependencies[0].name
      // The _common it renders on, and the one its folder has (#103): a sync
      // target follows its source's, which may be another.
      node.inheritsFrom = inheritsFromOf(stack)
      node.folderCommon = await folderCommonHere(stack.chart || stack.claims)
      try {
        const valuesYaml = await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')
        node.alertCount = countAlerts(yaml.load(valuesYaml) || {}, stack.keys.length ? stack.keys : node.chart)
      } catch { node.alertCount = 0 }
      // Where no new deployment can be made (inside another, inside a
      // _common folder): still shown and used, and flagged.
      const placement = await placementOf(baseDir, nodePath)
      if (placement) Object.assign(node, placement)
    }

    // Check if has subdirectories
    try {
      const subEntries = await fs.readdir(absPath, { withFileTypes: true })
      node.isLeaf = !subEntries.some(s => s.isDirectory() && !skippedDir(s.name, { inChart: node.isDeployment || isCommon }))
    } catch (err) {
      node.isLeaf = true
      // Nothing in it is listed, checked or migrated: said in the tree.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') node.unreadable = err?.code || 'error'
    }

    folders.push(node)
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

// Every deployment in the repo, flat — the Sync to/from modals' candidate
// lists. The one walk (deploymentWalk), so one inside another, or deeper
// than a few folders, is a candidate like any other. Deliberately not
// cached: this only runs when a sync modal opens, so a fresh scan each time
// is simplest and cannot drift from the filesystem.
// `chart`: the folders' _common is looked up for it — the Sync to dialog's
// source's Template, which a target renders (#103) — else each one's own.
async function collectDeployments(baseDir, chartFor = null) {
  const results = []
  for (const d of await walkDeployments(baseDir)) {
    if (d.kind !== 'deployment') continue
    const absPath = path.join(baseDir, d.path)
    let chart = null
    // null when values.yaml cannot be read: unknown, not none.
    let alertCount = null
    let inheritsFrom = null
    let folderCommon = null
    try {
      const stack = await resolveStack(baseDir, absPath)
      chart = stack.chart
      inheritsFrom = inheritsFromOf(stack)
      folderCommon = await folderCommonOf(baseDir, d.path, chartFor || chart || stack.claims)
      const valuesYaml = yaml.load(await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')) || {}
      alertCount = countAlerts(valuesYaml, stack.keys)
    } catch { /* leave defaults */ }
    results.push({ name: path.basename(d.path), path: d.path, chart, alertCount, inheritsFrom, folderCommon })
  }
  return results
}

export default function foldersRouter() {
  const router = express.Router()
  router.use(answersWithoutPaths)
  // A _common's make or remove holds the commit lock itself, for as long
  // as it takes: it renders every deployment it touches twice, which in a
  // large repo outlasts the time limit the other writes are held to.
  router.use((req, res, next) => (req.method === 'POST' && req.path === '/common' ? next() : holdSyncRegistryLock(req, res, next)))

  router.get('/tree', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/deployments', async (req, res) => {
    try {
      const chart = typeof req.query.chart === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(req.query.chart) ? req.query.chart : null
      res.json(await collectDeployments(req.gitopsDir, chart))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/', async (req, res) => {
    const { path: folderPath } = req.body
    if (!isSafeFolderPath(folderPath, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    try {
      const reserved = await newReservedSegment(req.gitopsDir, folderPath)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      await fs.mkdir(path.join(req.gitopsDir, folderPath), { recursive: true })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // A folder's _common (#101): what making or removing one changes, listed
  // before anything is written; then all of it, or nothing.
  const planFor = (gitopsDir, q) => (q.action === 'delete' ? planDelete(gitopsDir, q.path) : planCreate(gitopsDir, q.folder, q.chart))

  router.get('/common/plan', async (req, res) => {
    try {
      const out = await planFor(req.gitopsDir, req.query)
      if (!out.plan) return res.status(out.status).json(out.body)
      res.json(out.plan)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  // Under the commit lock, for the whole plan, write and check. `expected`
  // is the plan's, as shown: a file changed since refuses it.
  router.post('/common', async (req, res) => {
    try {
      const { action, expected } = req.body || {}
      if (action !== 'create' && action !== 'delete') return res.status(400).json({ error: 'action is create or delete' })
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        return res.status(400).json({ error: 'expected is needed: the plan\'s expected, from GET /common/plan, as it was shown' })
      }
      const { status, body } = await withSyncRegistryLock(req.gitopsDir, async () => {
        const out = await planFor(req.gitopsDir, req.body)
        if (!out.plan) return out
        const same = JSON.stringify(Object.entries(expected).sort()) === JSON.stringify(Object.entries(out.plan.expected).sort())
        if (!same) return { status: 409, body: { error: 'The repo changed since the list was made: look at the changes again', plan: out.plan } }
        return applyPlan(req.gitopsDir, out)
      })
      res.status(status).json(body)
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.get('/common/users', async (req, res) => {
    try {
      const rel = String(req.query.path || '')
      if (rel.includes('..') || path.isAbsolute(rel)) return res.status(400).json({ error: 'Invalid path' })
      if (await linkOnPath(req.gitopsDir, rel)) return res.status(400).json({ error: `${rel} goes through a link` })
      res.json(await commonUsers(req.gitopsDir, rel.replace(/\/+$/, '')))
    } catch (err) {
      res.status(500).json({ error: await withoutPath(err.message, req.gitopsDir) })
    }
  })

  router.post('/init', async (req, res) => {
    const { folder, chart } = req.body
    if (!isSafeFolderPath(folder, req.gitopsDir)) {
      return res.status(400).json({ error: 'Invalid folder path' })
    }
    if (!chart || typeof chart !== 'string' || chart.includes('..') || path.isAbsolute(chart)) {
      return res.status(400).json({ error: 'Invalid chart name' })
    }

    const chartsDir = getChartsDir(req.gitopsDir, process.env.CHARTS_DIR)
    const deployDir = path.join(req.gitopsDir, folder)

    try {
      const reserved = await newReservedSegment(req.gitopsDir, folder)
      if (reserved) return res.status(400).json({ error: reservedError(reserved) })
      const misplaced = await newDeploymentProblem(req.gitopsDir, folder)
      if (misplaced) return res.status(400).json({ error: misplaced })
      // A deployment already there is never written over, whatever it
      // depends on: its Chart.yaml and values.yaml are someone's.
      if (await isDeploymentDir(deployDir)) {
        const existing = yaml.load(await fs.readFile(path.join(deployDir, 'Chart.yaml'), 'utf-8')) || {}
        const { chart: template } = await resolveStack(req.gitopsDir, deployDir)
        return res.json({ status: 'existing', chart: template ?? existing.dependencies?.[0]?.name ?? null })
      }
      // Asked before any folder is made: a refusal leaves the repo as it was.
      const onCommon = await deploymentOnCommon(req.gitopsDir, folder, chart)
      if (onCommon?.error) return res.status(409).json({ error: onCommon.error })
      await fs.mkdir(deployDir, { recursive: true })

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

      const chartDir = path.join(chartsDir, chart)
      // The Template has to be there, and readable; its version is not
      // copied (below).
      yaml.load(await fs.readFile(path.join(chartDir, 'Chart.yaml'), 'utf-8'))

      // The Template's groups, from its values.yaml: none when it has none;
      // one that cannot be read or parsed is said, not taken for none.
      const emptyValues = {}
      // Read before anything is written: a refusal leaves the folder as it was.
      const defaults = (await parseIfThere(path.join(chartDir, 'values.yaml'), yaml.load)) || {}
      for (const [key, val] of Object.entries(defaults)) {
        if (Array.isArray(val)) emptyValues[key] = []
      }

      // Under a folder with a _common for this Template (#102): on it, and
      // writing nothing of its own — it inherits everything, a group the
      // _common gets later too.
      if (onCommon) {
        await writeWhole(path.join(deployDir, 'Chart.yaml'), onCommon.chartYaml)
        await writeWhole(path.join(deployDir, 'values.yaml'), onCommon.valuesYaml)
        return res.json({ status: 'created', chart, folder, inheritsFrom: onCommon.inheritsFrom })
      }
      // Helm reads this as a URL, and the file is committed and rendered on
      // Linux even when it was written on Windows, so the separator has to be
      // a forward slash regardless of the platform that produced it.
      const relPath = path.relative(deployDir, chartDir).replace(/\\/g, '/')

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

      res.json({ status: 'created', chart, folder })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
