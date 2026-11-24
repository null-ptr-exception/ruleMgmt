/** The folder tree and the flat list of deployments (sync's dialogs). */

import path from 'path'
import { walk, childEntries } from '../../repo/walk.js'
import { openRepo } from '../../repo/openRepo.js'
import { createLimit } from '../../lib/limit.js'
import { resolveStack, STACK_LINK } from '../../lib/stack.js'
import { folderCommonOf, folderCommons, inheritsFromOf } from '../../lib/commonEdit.js'
import { z } from 'zod'
import { isName } from '../../repo/paths.js'
import { route, repoPath } from '../../http/route.js'
import { loadDeployment, loadOwnValues, deployedRows } from '../../repo/deployment.js'

// One level of the tree: the walk's own folders (repo/walk.js), each with
// what the tree shows of it.
// How many entries are read at once: far below any open-files limit.
export const NODES_AT_ONCE = 16

async function listChildren(baseDir, parentPath) {
  const repo = openRepo(baseDir)
  // Every deployment in it has the same folders above it: each asked once.
  const folderCommonHere = folderCommons(baseDir, parentPath || '.', repo)
  // A few at a time, as the walk lists them (repo/walk.js): each node's
  // reads are its own.
  const limit = createLimit(NODES_AT_ONCE)
  const folders = await Promise.all((await childEntries(repo, parentPath)).map(e => limit(async () => {
    const nodePath = e.rel
    const absPath = path.join(baseDir, nodePath)
    const node = { name: e.name, path: nodePath }
    if (e.kind === 'common') {
      node.isCommon = true
      // The Template it is for, which its page opens (#101).
      const stack = await resolveStack(baseDir, absPath, { repo })
      node.chart = stack.chart || stack.claims || e.name
      if (stack.problems.length) node.problems = stack.problems.map(p => p.description)
    }
    // Helm deploys it with the Template's example rows: flagged, and
    // counted as using its Template (a breaking change, a chart's delete).
    if (e.chartOnly) {
      node.noValues = true
      node.chart = (await resolveStack(baseDir, absPath, { repo })).chart || (await repo.helmYaml(`${nodePath}/Chart.yaml`)).value.dependencies[0]?.name
    }
    if (e.kind === 'deployment') {
      node.isDeployment = true
      // Its values as Helm reads them, and their shape (repo/deployment.js,
      // no Template read): one Helm cannot read is marked, as a folder that
      // cannot be read is.
      const dep = await loadOwnValues(repo, nodePath)
      if (dep.state === 'unreadable') node.unreadable = `its values.yaml cannot be read (${dep.why})`
      else if (dep.state === 'invalid') node.unreadable = `its values.yaml cannot be used (${dep.findings.map(f => f.message).join('; ')})`
      // The Template at the bottom of its `_common` stack (#100), which
      // Preview and the editor open: not the `_common` chart it names.
      const stack = dep.state === 'ok' ? dep.value.stack : await resolveStack(baseDir, absPath, { repo })
      node.chart = stack.chart || stack.claims || (await repo.helmYaml(`${nodePath}/Chart.yaml`)).value.dependencies[0].name
      // A _common reached through a hand-made link is not followed: marked,
      // as Preview, the editor and Commit say it.
      const linked = stack.problems.find(p => p.kind === STACK_LINK)
      if (linked && !node.unreadable) node.unreadable = linked.description
      // The _common it renders on, and the one its folder has (#103): a sync
      // target follows its source's, which may be another.
      node.inheritsFrom = inheritsFromOf(stack)
      node.folderCommon = await folderCommonHere(stack.chart || stack.claims)
      // Where no new deployment can be made (inside another, inside a
      // _common folder): still shown and used, and flagged.
      if (e.nestedIn) node.nestedIn = e.nestedIn
      else if (e.inCommon) node.inCommon = true
    }
    node.isLeaf = !e.hasFolders
    // Nothing in it is listed, checked or migrated (or, for a Chart.yaml
    // that cannot be read, it is no deployment that can be): said in the tree.
    if (e.kind === 'unreadable') node.unreadable = e.why
    return node
  })))
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
  const repo = openRepo(baseDir)
  const deployments = (await walk(repo)).filter(e => e.kind === 'deployment')
  // A few at a time, in the walk's order: each one's reads are its own.
  const limit = createLimit(NODES_AT_ONCE)
  return Promise.all(deployments.map(e => limit(async () => {
    // Its values as Helm renders them (repo/deployment.js): the rows it
    // deploys, null when that cannot be said (unreadable, Helm stops on it).
    const dep = await loadDeployment(repo, e.rel)
    const stack = dep.state === 'ok' ? dep.value.stack : await resolveStack(baseDir, path.join(baseDir, e.rel), { repo })
    return {
      path: e.rel,
      chart: stack.chart,
      alertCount: deployedRows(dep),
      inheritsFrom: inheritsFromOf(stack),
      folderCommon: await folderCommonOf(baseDir, e.rel, chartFor || stack.chart || stack.claims, repo),
    }
  })))
}

// `?path=`: the folder whose children are listed; left out or empty, the
// repo's top.
const TREE_QUERY = z.object({
  path: z.preprocess(v => (v === '' ? undefined : v), repoPath('list', { what: 'path' }).optional()),
})
// `?chart=`: the Template whose _common is looked up; one that is no
// Template's name is none, as the dialogs ask before they have one.
const DEPLOYMENTS_QUERY = z.object({ chart: z.unknown().optional().transform(v => (isName(v) ? v : null)) })

export function treeRoutes(router) {
  router.get('/tree', route('folders.tree', { query: TREE_QUERY }, async ({ query }, { gitopsDir }) => (
    { status: 200, body: await listChildren(gitopsDir, query.path?.rel ?? '') }
  )))

  router.get('/deployments', route('folders.deployments', { query: DEPLOYMENTS_QUERY }, async ({ query }, { gitopsDir }) => (
    { status: 200, body: await collectDeployments(gitopsDir, query.chart) }
  )))
}
