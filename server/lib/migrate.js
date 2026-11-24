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
import { migrateValues, migrationLosses } from '../../src/utils/migration.js'
import { getDepName } from './subchart.js'
import { unwrapPath, wrapPath, replaceAtPath } from './stack.js'
import { isTarget, getSourceForTarget } from './sync.js'
import { readRegistry } from '../repo/sync.js'
import { findDeploymentsUsing } from './chartUsage.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { openRepo } from '../repo/openRepo.js'
import { loadDeployment, isFlatFile } from '../repo/deployment.js'
import { findingsOf } from '../repo/loaded.js'
import { decide } from '../repo/policy.js'
import { schemaProblem, schemaValidator } from '../repo/schema.js'

// One problem as the same one before and after a change: its kind, cell and
// what it says, leaving out the file and line (the migrated file is written
// again) and what it quotes in brackets — a row overlap names the selected
// values, which a new selector level adds to.
function problemKey(f) {
  const { group, row, column } = f.detail ?? {}
  return [f.code, group, row, column, f.message.replace(/^\S+\.yaml( line \d+)?: /, '').replace(/\([^)]*\)/g, '()')].join('|')
}

// What a save would refuse in a deployment's values (policy.js, `migration`).
async function saveRefuses(repo, rel, chart, next) {
  const dep = await loadDeployment(repo, rel, { chart: isFlatFile(rel) ? chart : undefined, next })
  if (dep.state === 'unreadable') return [{ code: 'values.unreadable', message: `${dep.file} cannot be read: ${dep.why}` }]
  return decide(findingsOf(dep), 'migration').refuse
}

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

// Rows that differ between two whole value sets, in either direction: a
// follower that gets its source's file can gain rows and groups it never
// had, as well as lose or change its own.
function rowsReplaced(before, after) {
  let n = 0
  for (const group of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = Array.isArray(before?.[group]) ? before[group] : []
    const b = Array.isArray(after?.[group]) ? after[group] : []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) n++
    }
  }
  return n
}

/** Where a deployment's values live, and whether it is a subchart wrap. */
async function locate(gitopsDir, relPath, keys) {
  const abs = path.join(gitopsDir, relPath)
  let isFolder = false
  try { isFolder = (await fs.stat(abs)).isDirectory() } catch { /* a file */ }
  return {
    valuesFile: isFolder ? path.join(abs, 'values.yaml') : abs,
    // Every key of its `_common` stack (#100): the chart's rows are under
    // all of them, in a `_common` chart's values as in a deployment's.
    keys: isFolder ? keys ?? [await getDepName(abs)].filter(Boolean) : [],
  }
}

/**
 * Writes nothing itself: a caller that ignores `writes` gets a preview —
 * every entry has `rowsChanged` and `losses` for the dialog.
 * With `model` (the new Template's) each migrated file is checked as a
 * values save would check it (#176): `problems` lists what a save would
 * refuse. One the file had already, against `beforeModel`, before this
 * change is marked `before: true` — reported, but no reason to refuse it
 * (see problemKey for what counts as the same one); with no `beforeModel`
 * every one is. `checkOnly` leaves out a deployment whose values cannot be
 * read instead of failing the whole plan. A copied follower lists none: its
 * problems are its source's.
 * @returns { deployments: [{ deployment, path, readonly, copiedFrom, rowsChanged, losses, orphaned, problems: [{ message, before }] }], writes: [[file, text, isTarget, path]] }
 *          `copiedFrom` is the source a sync follower's file is copied from,
 *          or null when the follower is migrated on its own (its source is
 *          not among the deployments using this chart, or has no values.yaml
 *          to copy). A copied follower's `rowsChanged` compares its own rows
 *          with the source's migrated rows, which is what it ends up with;
 *          its `losses` and `orphaned` are the source's.
 */
export async function planDeploymentMigration(gitopsDir, chart, targetSchema, migration, { deploymentsDirEnv, model, beforeModel, checkOnly = false } = {}) {
  const repo = openRepo(gitopsDir)
  const found = await findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv)
  const registry = await readRegistry(repo)

  const deployments = []
  const writes = []
  const texts = new Map()   // deployment path → the migrated file text
  const files = new Map()   // deployment path → its values file
  const befores = new Map() // deployment path → its rows before
  const afters = new Map()  // deployment path → its rows after
  const missing = new Set() // deployments with no values file yet
  for (const dep of found) {
    const readonly = isTarget(registry, dep.path)
    // A Chart.yaml with no values.yaml: Helm renders the Template's own
    // values, which the Template change carries. Listed, nothing written —
    // a values.yaml made here would make it a deployment.
    // A stack that does not reach its Template: where its rows are cannot
    // be told, so nothing is written, and the change waits until the stack
    // is fixed — written later, its old columns would render no alerts.
    // Only checking (a change that writes no deployment), it is only said.
    if (dep.broken) {
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], noValues: true,
        problems: [{ message: `${dep.path}: ${dep.broken} — fix its _common first`, before: checkOnly }] })
      continue
    }
    if (dep.kind === 'chart-only') {
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], problems: [], noValues: true })
      continue
    }
    const { valuesFile, keys } = await locate(gitopsDir, dep.path, dep.keys)

    // Read as Helm reads it (010 is 8, and is written back as 8). Only a
    // missing file is empty. One that cannot be read or is not values is not
    // migrated, and named: migrating `{}` would write an empty file over it.
    let parsed = {}
    const read = await repo.helmYaml(path.relative(gitopsDir, valuesFile).replace(/\\/g, '/'))
    if (read.state === 'absent') missing.add(dep.path)
    else if (read.state !== 'ok') {
      const why = read.state === 'unreadable' ? read.why : read.findings.map(f => f.message.replace(/^\S+ (line \d+: )?/, '')).join('; ')
      // Only checking (#176): one that cannot be read is left out, the rest
      // are still checked; its own save says what is wrong with it.
      if (checkOnly) {
        console.error(`Template save check: ${dep.path} values cannot be read: ${why}`)
        continue
      }
      // Not migrated, and said: a save of the Template that would migrate it
      // is refused naming it, as a save of its values would be.
      deployments.push({ deployment: dep.deployment, path: dep.path, readonly, rowsChanged: 0, losses: [], orphaned: [], noValues: true,
        problems: [{ message: `${dep.path}: its values cannot be read (${why}) — fix them first`, before: false }] })
      continue
    } else parsed = read.value
    const before = unwrapPath(parsed, keys)

    const { values: after, orphaned } = migrateValues(before, migration, targetSchema)
    deployments.push({
      deployment: dep.deployment,
      path: dep.path,
      readonly,
      rowsChanged: rowsChanged(before, after),
      losses: migrationLosses(before, migration, targetSchema),
      orphaned,
      problems: [],
    })

    // Only the chart's own block is replaced; anything else at the top of a
    // folder deployment's values.yaml (global:, other dependencies) stays.
    // On a stack, everything beside the chart's rows stays too, wherever it is.
    const wrapped = keys.length > 1 || (keys.length && parsed && typeof parsed === 'object' && keys[0] in parsed)
    const doc = wrapped ? replaceAtPath(parsed, keys, after) : wrapPath(after, keys)
    texts.set(dep.path, dumpForHelm(doc, { lineWidth: -1 }))
    files.set(dep.path, valuesFile)
    befores.set(dep.path, before)
    afters.set(dep.path, after)
  }

  // Each migrated file is checked as a values save checks it (#176): the
  // repo as it will be, every migrated file written, loaded with the new
  // Template's columns and schema, and decided by the migration's table
  // (policy.js). What a _common gives is the _common's; a _common need not
  // give a required Common Value, its deployments may (repo/deployment.js).
  if (model) {
    const rel = file => path.relative(gitopsDir, file).replace(/\\/g, '/')
    const after = repo.with([...texts.keys()].map(p => [rel(files.get(p)), texts.get(p)]))
    const problem = targetSchema && typeof targetSchema === 'object' ? schemaProblem(targetSchema) : 'no schema'
    const next = { model, every: true, ...(problem ? {} : { validate: schemaValidator(targetSchema, `${chart}/values.schema.json`) }) }
    for (const entry of deployments) {
      if (entry.noValues) continue
      // With no model to say what the values were valid against (rules/
      // that does not parse), nothing can be told to be new: none is refused.
      const had = beforeModel ? new Set((await saveRefuses(repo, entry.path, chart, { model: beforeModel, every: true })).map(problemKey)) : null
      entry.problems = (await saveRefuses(after, entry.path, chart, next)).map(f => {
        const { group, row, column } = f.detail ?? {}
        return { message: f.message, ...(group !== undefined ? { group, row: row ?? null } : {}), ...(column !== undefined ? { column } : {}), before: had ? had.has(problemKey(f)) : true }
      })
    }
  }

  // A sync follower is a copy of its source: it gets the source's migrated
  // text, as a values save would copy it. Left unwritten it would keep the
  // old columns and render no alerts until the source is saved again. A
  // follower whose source is not in this plan is migrated on its own, so it
  // still renders. So is one whose source has no values.yaml: a values save
  // copies only that file, and copying an empty one would wipe the follower.
  for (const entry of deployments) {
    if (entry.noValues) { entry.copiedFrom = null; continue }
    const source = entry.readonly ? getSourceForTarget(registry, entry.path) : null
    entry.copiedFrom = source && texts.has(source) && !missing.has(source) && !isTarget(registry, source) ? source : null
    if (entry.copiedFrom) {
      const src = deployments.find(d => d.path === entry.copiedFrom)
      entry.rowsChanged = rowsReplaced(befores.get(entry.path), afters.get(entry.copiedFrom))
      entry.losses = src.losses
      entry.orphaned = src.orphaned
      entry.problems = []
    }
    writes.push([files.get(entry.path), texts.get(entry.copiedFrom ?? entry.path), entry.readonly, entry.path])
  }

  return { deployments, writes }
}
