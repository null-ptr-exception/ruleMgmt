/**
 * Rewriting every deployment's values.yaml when a chart's schema changes in a
 * breaking way — the write-back the design (issue #57, 收斂四 §六) needed.
 *
 * Detection (`diffSchema`), the affected-deployment list (`findDeploymentsUsing`)
 * and the row transform (`migrateValues` / `migrationLosses`) already exist;
 * this reads each deployment, applies the mapping and (unless `dryRun`) writes
 * it back. A sync follower is left alone — it will follow its source.
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { migrateValues, migrationLosses } from '../../src/utils/migration.js'
import { getDepName, wrapValues, unwrapValues } from './subchart.js'
import { readSyncRegistry, isTarget } from './sync.js'
import { findDeploymentsUsing } from './chartUsage.js'

function rowsChanged(before, after) {
  let n = 0
  for (const [group, rows] of Object.entries(before || {})) {
    if (!Array.isArray(rows)) continue
    const next = after?.[group]
    if (!Array.isArray(next)) { n += rows.length; continue }
    for (let i = 0; i < rows.length; i++) {
      if (JSON.stringify(rows[i]) !== JSON.stringify(next[i])) n++
    }
  }
  return n
}

/** Where a deployment's values live, and whether it is a subchart wrap. */
async function locate(gitopsDir, relPath) {
  const abs = path.join(gitopsDir, relPath)
  let isFolder = false
  try { isFolder = (await fs.stat(abs)).isDirectory() } catch { /* a file */ }
  return {
    valuesFile: isFolder ? path.join(abs, 'values.yaml') : abs,
    depName: isFolder ? await getDepName(abs) : undefined,
  }
}

/**
 * @param dryRun  when true, nothing is written; every entry gets `rowsChanged`
 *                and `losses` so the dialog can preview them.
 * @returns { deployments: [{ deployment, path, readonly, rowsChanged, losses, orphaned }], writes: [[file, text]] }
 */
export async function planDeploymentMigration(gitopsDir, chart, targetSchema, migration, { deploymentsDirEnv } = {}) {
  const found = await findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv)
  const registry = await readSyncRegistry(gitopsDir)

  const deployments = []
  const writes = []
  for (const dep of found) {
    const readonly = isTarget(registry, dep.path)
    const { valuesFile, depName } = await locate(gitopsDir, dep.path)

    let parsed = {}
    try { parsed = yaml.load(await fs.readFile(valuesFile, 'utf-8')) || {} } catch { /* empty */ }
    const before = unwrapValues(parsed, depName)

    const { values: after, orphaned } = migrateValues(before, migration, targetSchema)
    deployments.push({
      deployment: dep.deployment,
      path: dep.path,
      readonly,
      rowsChanged: rowsChanged(before, after),
      losses: migrationLosses(before, migration, targetSchema),
      orphaned,
    })

    // A sync follower is written by its source's own save, not here.
    if (!readonly) writes.push([valuesFile, yaml.dump(wrapValues(after, depName), { lineWidth: -1 })])
  }

  return { deployments, writes }
}
