/** The folder tree and the flat list of deployments (sync's dialogs). */

import fs from 'fs/promises'
import path from 'path'
import { countAlerts } from '../../lib/subchart.js'
import { walk, childEntries } from '../../repo/walk.js'
import { openRepo } from '../../repo/openRepo.js'
import { resolveStack } from '../../lib/stack.js'
import { folderCommonOf, folderCommons, inheritsFromOf } from '../../lib/commonEdit.js'
import { isRepoPath } from '../../lib/safePath.js'
import { loadValues } from '../../../src/utils/valuesText.js'

// One level of the tree: the walk's own folders (repo/walk.js), each with
// what the tree shows of it.
async function listChildren(baseDir, parentPath) {
  const repo = openRepo(baseDir)
  // Every deployment in it has the same folders above it: each asked once.
  const folderCommonHere = folderCommons(baseDir, parentPath || '.', repo)
  const folders = []
  for (const e of await childEntries(repo, parentPath)) {
    const nodePath = e.rel
    const absPath = path.join(baseDir, nodePath)
    const node = { name: e.name, path: nodePath }
    if (e.kind === 'common') {
      node.isCommon = true
      // The Template it is for, which its page opens (#101).
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || stack.claims || e.name
      if (stack.problems.length) node.problems = stack.problems.map(p => p.description)
    }
    // Helm deploys it with the Template's example rows: flagged, and
    // counted as using its Template (a breaking change, a chart's delete).
    if (e.chartOnly) {
      node.noValues = true
      node.chart = (await resolveStack(baseDir, absPath)).chart || (await repo.helmYaml(`${nodePath}/Chart.yaml`)).value.dependencies[0]?.name
    }
    if (e.kind === 'deployment') {
      node.isDeployment = true
      // The Template at the bottom of its `_common` stack (#100), which
      // Preview and the editor open: not the `_common` chart it names.
      const stack = await resolveStack(baseDir, absPath)
      node.chart = stack.chart || (await repo.helmYaml(`${nodePath}/Chart.yaml`)).value.dependencies[0].name
      // The _common it renders on, and the one its folder has (#103): a sync
      // target follows its source's, which may be another.
      node.inheritsFrom = inheritsFromOf(stack)
      node.folderCommon = await folderCommonHere(stack.chart || stack.claims)
      try {
        const valuesYaml = await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')
        node.alertCount = countAlerts(loadValues(valuesYaml) || {}, stack.keys.length ? stack.keys : node.chart)
      } catch { node.alertCount = 0 }
      // Where no new deployment can be made (inside another, inside a
      // _common folder): still shown and used, and flagged.
      if (e.nestedIn) node.nestedIn = e.nestedIn
      else if (e.inCommon) node.inCommon = true
    }
    node.isLeaf = !e.hasFolders
    // Nothing in it is listed, checked or migrated (or, for a Chart.yaml
    // that cannot be read, it is no deployment that can be): said in the tree.
    if (e.kind === 'unreadable') node.unreadable = e.why
    folders.push(node)
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name))
}

// Every deployment in the repo, flat — the Sync to/from modals' candidate
// lists. The one walk (repo/walk.js), so one inside another, or deeper
// than a few folders, is a candidate like any other. Deliberately not
// cached: this only runs when a sync modal opens, so a fresh scan each time
// is simplest and cannot drift from the filesystem.
// `chart`: the folders' _common is looked up for it — the Sync to dialog's
// source's Template, which a target renders (#103) — else each one's own.
async function collectDeployments(baseDir, chartFor = null) {
  const results = []
  const repo = openRepo(baseDir)
  for (const e of await walk(repo)) {
    if (e.kind !== 'deployment') continue
    const d = { path: e.rel }
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
      folderCommon = await folderCommonOf(baseDir, d.path, chartFor || chart || stack.claims, repo)
      const valuesYaml = loadValues(await fs.readFile(path.join(absPath, 'values.yaml'), 'utf-8')) || {}
      alertCount = countAlerts(valuesYaml, stack.keys)
    } catch { /* leave defaults */ }
    results.push({ name: path.basename(d.path), path: d.path, chart, alertCount, inheritsFrom, folderCommon })
  }
  return results
}

export function treeRoutes(router) {
  router.get('/tree', async (req, res) => {
    try {
      const parentPath = req.query.path || ''
      if (parentPath && !isRepoPath(parentPath, { hidden: true })) {
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
      if (parentPath && !isRepoPath(parentPath, { hidden: true })) {
        return res.status(400).json({ error: 'Invalid path' })
      }
      const children = await listChildren(req.gitopsDir, parentPath)
      res.json(children)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
}
