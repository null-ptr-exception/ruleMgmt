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
import { unwrapPath, wrapPath, replaceAtPath, resolveStack, stackValues } from './stack.js'
import { isInherited } from './deploymentWrite.js'
import { readSyncRegistry, isTarget, getSourceForTarget } from './sync.js'
import { findDeploymentsUsing } from './chartUsage.js'
import { valueProblems } from '../../src/utils/rulesFile.js'
import { selectorValueProblems } from '../../src/utils/selectorContract.js'
import { dumpForHelm } from '../../src/utils/yamlScalar.js'
import { loadValues } from '../../src/utils/valuesText.js'

// Everything a values save would refuse, both kinds at once (a save stops at
// the first kind). Each names its cell in its message.
function allProblems(bare, model) {
  return [...valueProblems(bare, model), ...selectorValueProblems(bare, model).problems]
}

// One problem as the same one before and after a change: its group, row,
// column and what it says, leaving out what it quotes in brackets — a
// row overlap names the selected values, which a new selector level adds to.
function problemKey(p) {
  return [p.group, p.row, p.column, String(p.message || '').replace(/\([^)]*\)/g, '()')].join('|')
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
  const found = await findDeploymentsUsing(gitopsDir, chart, deploymentsDirEnv)
  const registry = await readSyncRegistry(gitopsDir)

  const deployments = []
  const writes = []
  const texts = new Map()   // deployment path → the migrated file text
  const files = new Map()   // deployment path → its values file
  const befores = new Map() // deployment path → its rows before
  const afters = new Map()  // deployment path → its rows after
  const missing = new Set() // deployments with no values file yet
  const docs = new Map()    // deployment path → the migrated file, parsed
  const kinds = new Map()   // deployment path → 'common' for a _common chart
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

    // Only a missing file is empty. One that cannot be read or parsed stops
    // the plan: migrating `{}` would write an empty file over its data.
    let parsed = {}
    try {
      parsed = loadValues(await fs.readFile(valuesFile, 'utf-8')) || {}
    } catch (err) {
      // Only checking (#176): one that cannot be read is left out, the rest
      // are still checked; its own save says what is wrong with it.
      if (checkOnly && err?.code !== 'ENOENT') {
        console.error(`Template save check: ${dep.path} values cannot be read`, err.message)
        continue
      }
      if (err?.code !== 'ENOENT') throw new Error(`${dep.path}: values cannot be read (${err.message})`, { cause: err })
      missing.add(dep.path)
    }
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
    kinds.set(dep.path, dep.kind)

    // Only the chart's own block is replaced; anything else at the top of a
    // folder deployment's values.yaml (global:, other dependencies) stays.
    // On a stack, everything beside the chart's rows stays too, wherever it is.
    const wrapped = keys.length > 1 || (keys.length && parsed && typeof parsed === 'object' && keys[0] in parsed)
    const doc = wrapped ? replaceAtPath(parsed, keys, after) : wrapPath(after, keys)
    docs.set(dep.path, doc)
    texts.set(dep.path, dumpForHelm(doc, { lineWidth: -1 }))
    files.set(dep.path, valuesFile)
    befores.set(dep.path, before)
    afters.set(dep.path, after)
  }

  // Each migrated file is checked as a values save checks it, on its stack:
  // what its _common layers give counts, migrated too when they are in this
  // plan; what is a layer's own is the layer's. A _common chart need not
  // give a required Common Value, its deployments may; its rows are whole.
  if (model) {
    for (const entry of deployments) {
      if (entry.noValues) continue
      const before = befores.get(entry.path)
      const after = afters.get(entry.path)
      const dir = path.join(gitopsDir, entry.path)
      const stack = docs.has(entry.path) && (await fs.stat(dir).then(s => s.isDirectory(), () => false)) ? await resolveStack(gitopsDir, dir) : null
      const onStack = stack && stack.layers.length
      const now = onStack ? stackValues(stack, { own: before }) : null
      const then = onStack
        ? stackValues({ ...stack, layers: stack.layers.map(l => (docs.has(l.path) ? { ...l, doc: docs.get(l.path) } : l)) }, { own: after })
        : null
      const keep = (p, own, values) => !(onStack && isInherited(p, own, values.layers)) && !(kinds.get(entry.path) === 'common' && p.required && p.group === '_common')
      // With no model to say what the values were valid against (rules/
      // that does not parse), nothing can be told to be new: none is refused.
      const had = beforeModel
        ? new Set(allProblems(onStack ? now.merged : before, beforeModel).filter(p => keep(p, before, now ?? {})).map(problemKey))
        : null
      entry.problems = allProblems(onStack ? then.merged : after, model).filter(p => keep(p, after, then ?? {}))
        .map(p => ({ ...p, before: had ? had.has(problemKey(p)) : true }))
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
