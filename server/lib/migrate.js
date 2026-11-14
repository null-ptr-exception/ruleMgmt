/**
 * Rewriting every deployment's values.yaml when a chart's schema changes in a
 * breaking way — the write-back the design (issue #57, 收斂四 §六) needed.
 *
 * Detection (`diffSchema`), the affected-deployment list (`findDeploymentsUsing`)
 * and the row transform (`migrateValues` / `migrationLosses`) already exist;
 * this reads each deployment, applies the mapping and returns the files to
 * write. A sync follower gets its source's migrated file, the same copy a
 * values save makes, so the two stay identical (#175).
 */

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import { migrateValues, migrationLosses } from '../../src/utils/migration.js'
import { getDepName, wrapValues, unwrapValues } from './subchart.js'
import { readSyncRegistry, isTarget, getSourceForTarget } from './sync.js'
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
 * Writes nothing itself: a caller that ignores `writes` gets a preview —
 * every entry has `rowsChanged` and `losses` for the dialog.
 * @returns { deployments: [{ deployment, path, readonly, copiedFrom, rowsChanged, losses, orphaned }], writes: [[file, text]] }
 *          `copiedFrom` is the source a sync follower's file is copied from,
 *          or null when the follower is migrated on its own (its source is
 *          not among the deployments using this chart, or has no values.yaml
 *          to copy). A copied follower's `rowsChanged` compares its own rows
 *          with the source's migrated rows, which is what it ends up with;
 *          its `losses` and `orphaned` are the source's.
 */
export async function planDeploymentMigration(gitopsDir, chart, targetSchema, migration, { deploymentsDirEnv } = {}) {
  const found = await findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv)
  const registry = await readSyncRegistry(gitopsDir)

  const deployments = []
  const writes = []
  const texts = new Map()   // deployment path → the migrated file text
  const files = new Map()   // deployment path → its values file
  const befores = new Map() // deployment path → its rows before
  const afters = new Map()  // deployment path → its rows after
  const missing = new Set() // deployments with no values file yet
  for (const dep of found) {
    const readonly = isTarget(registry, dep.path)
    const { valuesFile, depName } = await locate(gitopsDir, dep.path)

    // Only a missing file is empty. One that cannot be read or parsed stops
    // the plan: migrating `{}` would write an empty file over its data.
    let parsed = {}
    try {
      parsed = yaml.load(await fs.readFile(valuesFile, 'utf-8')) || {}
    } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`${dep.path}: values cannot be read (${err.message})`, { cause: err })
      missing.add(dep.path)
    }
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

    // Only the chart's own block is replaced; anything else at the top of a
    // folder deployment's values.yaml (global:, other dependencies) stays.
    const doc = depName && parsed && typeof parsed === 'object' && depName in parsed
      ? { ...parsed, [depName]: after }
      : wrapValues(after, depName)
    texts.set(dep.path, yaml.dump(doc, { lineWidth: -1 }))
    files.set(dep.path, valuesFile)
    befores.set(dep.path, before)
    afters.set(dep.path, after)
  }

  // A sync follower is a copy of its source: it gets the source's migrated
  // text, as a values save would copy it. Left unwritten it would keep the
  // old columns and render no alerts until the source is saved again. A
  // follower whose source is not in this plan is migrated on its own, so it
  // still renders. So is one whose source has no values.yaml: a values save
  // copies only that file, and copying an empty one would wipe the follower.
  for (const entry of deployments) {
    const source = entry.readonly ? getSourceForTarget(registry, entry.path) : null
    entry.copiedFrom = source && texts.has(source) && !missing.has(source) && !isTarget(registry, source) ? source : null
    if (entry.copiedFrom) {
      const src = deployments.find(d => d.path === entry.copiedFrom)
      entry.rowsChanged = rowsChanged(befores.get(entry.path), afters.get(entry.copiedFrom))
      entry.losses = src.losses
      entry.orphaned = src.orphaned
    }
    writes.push([files.get(entry.path), texts.get(entry.copiedFrom ?? entry.path)])
  }

  return { deployments, writes }
}
